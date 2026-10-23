// dsh-capability-scope — HOST half.
//
// Decides, per session, which MCP servers, which MCP tools, and which skills
// reach the model, and remembers those choices per workspace directory, together
// with the agent preset last selected there.
//
//   MCP servers   — the roster is the profile's `@deepseek-ai/dsh-mcp-client`
//                   rows (host Loader tree) plus the rows of the session's
//                   preset. A switched-off server's tools are hidden with
//                   `agent.ctx.tools.restrict({ deny })`, which masks tools the
//                   agent inherits from the global layer AND from its preset's
//                   scope, and its calls are refused by `agent.ctx.tools.guard()`
//                   (the resource tools by their `server` argument). Its system
//                   prompt text is removed by same-name agent-layer sections
//                   (see `refreshPrompt`).
//   MCP tools     — a per-workspace allow-list of public tool names per server;
//                   without one, the row's own `toolFilter` config applies;
//                   without that, every tool is visible. Same restrict + guard.
//   Skills        — the skill registry merges layers nearest-last, so a
//                   same-name runtime skill registered through `agent.ctx`
//                   shadows the real one for that agent alone. The shadow is
//                   neither model- nor user-invocable, so it leaves the catalog,
//                   the `skill` tool, and `/name` invocation.
//   Presets       — a blank top-level session is switched with
//                   `agentPresets.select()` to the preset last selected in its
//                   directory, else to the preset of the longest matching
//                   `rules` path. Every committed `agent-preset/selected` event
//                   of a top-level session is remembered for its directory.
//
// Panel edits apply to the session immediately and become the directory's
// memory, so the next session opened there starts the same way. Memory lives in
// `.capability-scope.json` in the profile directory, beside cordis.yml.
//
// No runtime dependencies: host services are used structurally and read
// defensively, so an internal change degrades a feature instead of the mount.

import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { noMemory, openMemory } from './memory.mjs'
import { MCP_TOOL_PREFIX, attributeServer, compileToolFilter, serverPrefix } from './names.mjs'

/** Plugin display name, shown in loader diagnostics. */
export const name = 'dsh-capability-scope'

/** Without the tool registry there is nothing to scope. */
export const inject = ['tools']

/** Module name every MCP server row is an instance of, in either source. */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Route prefix owned by this plugin; the browser half reads the same base. */
const API_BASE = '/dsh-capability-scope'

/** Memory filename inside the profile directory. */
const MEMORY_FILENAME = '.capability-scope.json'

/** Coalescing window for `tools/change` bursts (one event per registered tool). */
const REFRESH_DEBOUNCE_MS = 50

/** How long one visibility decision is reused; the guard asks on every call. */
const DECISION_TTL_MS = 1000

/** Cordis fiber states, as numbers on `entry.fiber.state`. */
const FIBER_PHASE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading' }

/** Description carried by a shadow skill; never shown to the model. */
const SHADOW_DESCRIPTION = 'Switched off for this session by dsh-capability-scope.'

/** Source label of a shadow skill, used to recognize it in a snapshot. */
const SHADOW_SOURCE = 'capability-scope'

/** Resource tools addressed to a server through their `server` argument. */
const RESOURCE_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])

/** Largest accepted `POST /session` body. */
const MAX_BODY_BYTES = 256 * 1024

// ── helpers ─────────────────────────────────────────────────────────────────

/** @returns {string} the message of anything thrown. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Canonicalize a directory for comparison and as a memory key.
 * @param {string} path - absolute path, `~/` allowed.
 * @returns {string} resolved path, through symlinks when it exists.
 */
function canonical(path) {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
  let result = resolve(expanded)
  try {
    result = realpathSync(result)
  } catch {
    // A directory that does not exist yet still matches by its literal path.
  }
  return process.platform === 'win32' ? result.toLowerCase() : result
}

/**
 * The profile directory: app-boot sets the root context's `baseUrl` to the
 * directory holding the profile's cordis.yml.
 * @param {any} ctx - plugin context.
 * @returns {string} an absolute directory.
 */
function profileDir(ctx) {
  if (typeof ctx.baseUrl === 'string' && ctx.baseUrl.startsWith('file:')) return fileURLToPath(new URL('.', ctx.baseUrl))
  throw new Error(`${name}: cannot locate the profile directory (ctx.baseUrl is ${String(ctx.baseUrl)}); set config.memoryPath`)
}

/** A panel write refused because the deployment set `locked: true`. */
class LockedError extends Error {
  constructor() { super(`${name} is locked by configuration: the panel is read-only; change the profile configuration instead (MCP toolFilter, skill roots)`) }
}

/**
 * Where a skill lives, for the panel: the folder holding its instruction file,
 * with the home directory shortened to `~`.
 * @param {unknown} file - the provider's absolute instruction file path; absent for runtime skills.
 * @returns {string | null} the display path, or null when the skill has no file.
 */
function skillDir(file) {
  if (typeof file !== 'string' || file === '') return null
  const dir = basename(file) === 'SKILL.md' ? dirname(file) : file
  const home = homedir()
  return dir === home ? '~' : dir.startsWith(home + sep) ? '~' + dir.slice(home.length) : dir
}

/** @returns {{ description?: string, path?: string, source?: string }} the fields of a skill worth keeping. */
function skillMeta(skill) {
  const meta = {}
  for (const field of ['description', 'path', 'source']) {
    if (typeof skill[field] === 'string') meta[field] = skill[field]
  }
  return meta
}

// ── config ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Config
 * @property {{ path: string, preset: string }[]} rules - directory → preset, longest path first.
 * @property {{ mcp: string[], skills: string[] }} defaultOff - off lists for a directory with no memory.
 * @property {boolean} locked - the panel shows the tool surface but cannot change it; directory memory is neither read nor written.
 * @property {boolean} remember - record panel edits and preset selections per directory.
 * @property {string | undefined} memoryPath - the memory document; undefined when nothing is remembered.
 * @property {boolean} enforceGuard - also refuse calls to hidden tools.
 * @property {boolean} echoToConsole - mirror diagnostics to stdout/stderr.
 */

/**
 * Validate the plugin `config` block. Misconfiguration fails at load.
 * @param {any} ctx - plugin context, for the profile directory.
 * @param {unknown} raw - the block from cordis.patch.yml.
 * @returns {Config} the validated config.
 */
function resolveConfig(ctx, raw) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {}
  const fail = (message) => { throw new Error(`${name}: config.${message}`) }
  const bool = (key, fallback) => {
    const value = source[key] ?? fallback
    if (typeof value !== 'boolean') fail(`${key} must be a boolean`)
    return value
  }
  const names = (value, key) => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) fail(`${key} must be an array of names`)
    return [...new Set(value)].sort()
  }
  const absolute = (path) => isAbsolute(path) || path.startsWith('~')

  const rawRules = source.rules ?? []
  if (!Array.isArray(rawRules)) fail('rules must be an array')
  const rules = rawRules.map((rule, index) => {
    if (rule === null || typeof rule !== 'object') fail(`rules[${index}] must be an object`)
    if (typeof rule.path !== 'string' || !absolute(rule.path)) fail(`rules[${index}].path must be an absolute directory`)
    if (typeof rule.preset !== 'string' || rule.preset === '') fail(`rules[${index}].preset must be a preset id`)
    return { path: canonical(rule.path), preset: rule.preset }
  })
  const seen = new Set()
  for (const rule of rules) {
    if (seen.has(rule.path)) fail(`rules names ${rule.path} twice`)
    seen.add(rule.path)
  }

  const defaultOff = source.defaultOff ?? {}
  if (defaultOff === null || typeof defaultOff !== 'object' || Array.isArray(defaultOff)) fail('defaultOff must be { mcp: [...], skills: [...] }')

  const memoryPath = source.memoryPath ?? ''
  if (typeof memoryPath !== 'string') fail('memoryPath must be a string')
  if (memoryPath !== '' && !absolute(memoryPath)) fail(`memoryPath must be absolute: ${memoryPath}`)

  // A locked deployment's tool surface is exactly its configuration: a memory
  // written before the lock (or by hand) would otherwise still override toolFilter.
  const locked = bool('locked', false)
  const remember = locked ? false : bool('remember', true)
  return {
    rules: rules.sort((left, right) => right.path.length - left.path.length),
    defaultOff: { mcp: names(defaultOff.mcp, 'defaultOff.mcp'), skills: names(defaultOff.skills, 'defaultOff.skills') },
    locked,
    remember,
    memoryPath: !remember ? undefined : memoryPath === '' ? join(profileDir(ctx), MEMORY_FILENAME) : canonical(memoryPath),
    enforceGuard: bool('enforceGuard', true),
    echoToConsole: bool('echoToConsole', true),
  }
}

/**
 * The rule governing a directory: the longest configured ancestor-or-self.
 * @param {Config['rules']} rules - longest path first.
 * @param {string} cwd - the session directory.
 * @returns {{ path: string, preset: string } | undefined} the matching rule.
 */
function matchRule(rules, cwd) {
  const dir = canonical(cwd)
  return rules.find((rule) => dir === rule.path || dir.startsWith(rule.path.endsWith(sep) ? rule.path : rule.path + sep))
}

// ── roster reading ──────────────────────────────────────────────────────────

/**
 * @typedef {object} ServerRow
 * @property {string} serverName
 * @property {boolean} enabled - false when its row is disabled.
 * @property {string | null} phase - fiber phase, null when not mounted.
 * @property {'profile' | 'preset' | 'inferred'} origin - which source declared it.
 * @property {unknown[] | undefined} toolFilter - the row's `toolFilter` config.
 */

/** @returns {ServerRow[]} one row per mcp-client entry in a Loader tree. */
function rowsOfTree(entries, origin) {
  const rows = []
  for (const entry of entries) {
    if (entry?.options?.group === true || entry?.options?.name !== MCP_CLIENT_MODULE) continue
    const config = entry.fiber?.config ?? entry.options?.config
    if (typeof config?.serverName !== 'string') continue
    const state = entry.fiber?.state
    rows.push({
      serverName: config.serverName,
      enabled: entry.disabled !== true,
      phase: typeof state === 'number' ? (FIBER_PHASE[state] ?? null) : null,
      origin,
      toolFilter: Array.isArray(config.toolFilter) ? config.toolFilter : entry.options?.config?.toolFilter,
    })
  }
  return rows
}

/** @returns {ServerRow[]} mcp-client rows in a preset's declared plugin list. */
function rowsOfDeclaration(plugins, parentDisabled = false) {
  const rows = []
  for (const row of plugins ?? []) {
    const disabled = parentDisabled || row?.disabled === true
    if (row?.group === true && Array.isArray(row.config)) {
      rows.push(...rowsOfDeclaration(row.config, disabled))
      continue
    }
    if (row?.name !== MCP_CLIENT_MODULE || typeof row.config?.serverName !== 'string') continue
    rows.push({ serverName: row.config.serverName, enabled: !disabled, phase: null, origin: 'preset', toolFilter: row.config.toolFilter })
  }
  return rows
}

/** @returns {any} a host service, or undefined while its provider is inactive. */
function optionalService(ctx, serviceName) {
  try {
    return ctx.reflect.get(serviceName) ?? undefined
  } catch {
    // reflect throws for an unregistered name; that is the "absent" answer.
    return undefined
  }
}

/**
 * The preset a session runs, with its display name, MCP rows, and standing
 * scope key.
 *
 * The preset registry has no public read of a definition's rows with their
 * config, so this reads its `definitions` map (TypeScript-private, a plain
 * field at runtime). The mounted tree carries fiber state and resolved config;
 * the declaration is the fallback for a preset that failed to mount. Should the
 * registry change, this degrades to "no preset rows" and the preset's tools
 * still appear through the agent view as `inferred` servers.
 * @returns {{ id: string, name: string | null, rows: ServerRow[], scopeKey: object | undefined } | null}
 *   the preset, or null.
 */
function readPreset(ctx, presetId) {
  if (typeof presetId !== 'string') return null
  const record = optionalService(ctx, 'agentPresets')?.definitions?.get?.(presetId)
  let rows = []
  let scopeKey
  try {
    const mount = record?.generation?.mount
    const tree = mount?.tree
    rows = tree !== undefined ? rowsOfTree(tree.entries(), 'preset') : rowsOfDeclaration(record?.config?.plugins)
    // The standing scope the preset's subtree registers under: a registry
    // read through it merges the preset's layer over the global one.
    if (mount?.key !== null && typeof mount?.key === 'object') scopeKey = mount.key
  } catch {
    // An unreadable record means the registry changed its internals; see above.
    rows = []
  }
  return { id: presetId, name: typeof record?.config?.name === 'string' ? record.config.name : null, rows, scopeKey }
}

/** @returns {string} the verdict the UI renders for one server. */
function serverState(row, toolCount) {
  if (!row.enabled) return 'disabled'
  if (row.phase === 'failed') return 'failed'
  if (row.phase === 'pending' || row.phase === 'loading') return 'starting'
  if (toolCount > 0) return 'connected'
  // A mounted row (or one known only by its tools) is up but serves nothing.
  return row.phase === 'active' || row.origin === 'inferred' ? 'no-tools' : 'unmounted'
}

// ── per-session state ───────────────────────────────────────────────────────

/**
 * @typedef {object} SessionState
 * @property {Set<string>} mcpOff - switched-off servers.
 * @property {Set<string>} skillsOff - switched-off skills.
 * @property {Map<string, Set<string>>} toolFilters - per-server allow-lists set in the panel.
 */

/**
 * @typedef {object} SessionEntry
 * @property {any} agent
 * @property {string | undefined} cwd
 * @property {boolean} topLevel - neither a subagent nor a seeded session; only these are remembered.
 * @property {SessionState} state
 * @property {string[]} applied - the deny list currently installed, sorted.
 * @property {string | undefined} appliedPreset - the preset `applied` was computed under.
 * @property {(() => void) | undefined} lift - removes the installed restriction.
 * @property {(() => void) | undefined} disposeGuard
 * @property {Map<string, () => void>} skillShadows - per hidden skill.
 * @property {Map<string, () => void>} promptShadows - per switched-off server.
 * @property {(() => void) | undefined} resourceListShadow
 * @property {Map<string, { description?: string, path?: string, source?: string }>} seenSkills -
 *   what this session's view showed of each skill, kept because a shadow carries none of it.
 */

/** @returns {SessionState} a deep copy. */
function cloneState(state) {
  return {
    mcpOff: new Set(state.mcpOff),
    skillsOff: new Set(state.skillsOff),
    toolFilters: new Map([...state.toolFilters].map(([server, names]) => [server, new Set(names)])),
  }
}

/** @returns {boolean} whether two sets hold the same names. */
function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

/**
 * Parse one `POST /session` body into a state change.
 * @param {Record<string, unknown>} input - the body.
 * @returns {{ mcpOff?: string[] | null, skillsOff?: string[] | null, filter?: { server: string, allow: string[] | null } }}
 *   `null` means "back to the default" for that part.
 */
function parsePatch(input) {
  const list = (value, field) => {
    if (value === null) return null
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
      throw new Error(`"${field}" must be an array of names or null`)
    }
    return [...new Set(value)]
  }
  const patch = {}
  if ('mcpOff' in input) patch.mcpOff = list(input.mcpOff, 'mcpOff')
  if ('skillsOff' in input) patch.skillsOff = list(input.skillsOff, 'skillsOff')
  if ('filter' in input) {
    const filter = input.filter
    if (filter === null || typeof filter !== 'object' || typeof filter.server !== 'string' || filter.server === '') {
      throw new Error('"filter" must be { server, allow }')
    }
    const allow = list(filter.allow, 'filter.allow')
    if (allow !== null && allow.some((toolName) => !toolName.startsWith(serverPrefix(filter.server)))) {
      throw new Error(`"filter.allow" may only name tools of server "${filter.server}"`)
    }
    patch.filter = { server: filter.server, allow }
  }
  if (Object.keys(patch).length === 0) throw new Error('body must carry "mcpOff", "skillsOff", or "filter"')
  return patch
}

// ── plugin entry ────────────────────────────────────────────────────────────

/**
 * Scope MCP servers, MCP tools, skills, and presets per session and workspace.
 * @param {any} ctx - plugin context carrying the tool registry.
 * @param {unknown} rawConfig - profile-supplied config block.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(ctx, rawConfig)
  const log = (level, message) => {
    ctx.logger[level](`${name}: ${message}`)
    if (config.echoToConsole) (level === 'info' ? console.log : console.error)(`[${name}] ${message}`)
  }
  const memory = config.memoryPath === undefined ? noMemory() : openMemory(config.memoryPath, log, canonical)
  /** Run one memory write; a failed write is reported, never thrown at the caller. */
  const persist = (write) => {
    try {
      return write()
    } catch (error) {
      log('warn', `could not write ${memory.path}: ${messageOf(error)}`)
      return false
    }
  }

  /** @type {Map<string, SessionEntry>} */
  const live = new Map()
  /** Set while this plugin changes restrictions itself, so its own `tools/change` echoes are ignored. */
  let restricting = false
  /** Set while `announceSkills` re-emits a preset nobody picked; see there. */
  let reannouncing = false

  // ── host reads

  const presetIdOf = (agent) => {
    try {
      const id = optionalService(ctx, 'agentPresets')?.composedPreset?.(agent.ctx)
      if (typeof id === 'string') return id
    } catch {
      // composedPreset throws for a torn-down agent; fall back to the header.
    }
    return agent.session.header?.agentPreset
  }

  const projectedPreset = (agent) =>
    optionalService(ctx, 'sessionProjections')?.stateOf?.(agent.session, 'agentPreset') ?? agent.session.header?.agentPreset

  const isBlank = (session) => {
    const boundary = optionalService(ctx, 'sessionProjections')?.stateOf?.(session, 'turnBoundary')
    return boundary === undefined || (boundary.openTurnStartSeq === null && boundary.lastTurn === 0)
  }

  /**
   * A host service as seen from one agent, bound to the agent's context.
   *
   * A preset may mount its own instance of a service inside an isolated group;
   * `agentPresets.serviceFor()` finds that instance (the same lookup the
   * session skill catalog Remote uses), otherwise the host instance answers.
   *
   * Registries such as `skills` and `systemPrompt` file a registration into the
   * scope of `this.ctx`, and the instance `serviceFor()` returns is still bound
   * to the preset's own context — a shadow registered through it would reach
   * every session on that preset. The returned object therefore overlays `ctx`
   * with the agent's context, which is how Cordis binds a service to its caller.
   * @param {any} agent - the agent.
   * @param {string} serviceName - Cordis service name.
   * @returns {any} the bound service, or undefined when neither source has one.
   */
  const agentService = (agent, serviceName) => {
    let isolated
    try {
      isolated = optionalService(ctx, 'agentPresets')?.serviceFor?.(agent, serviceName)
    } catch {
      // A torn-down agent has no standing mount; fall through to the host instance.
    }
    if (isolated === undefined) {
      try {
        // `get()` reads without an inject declaration and binds to the agent's context.
        return agent.ctx.get(serviceName) ?? undefined
      } catch {
        // The agent context rejected the read (no such service).
        return undefined
      }
    }
    const bound = Object.create(isolated)
    Object.defineProperty(bound, 'ctx', { value: agent.ctx })
    return bound
  }

  // ── rosters and the visibility decision

  const profileRows = () => {
    try {
      return rowsOfTree(optionalService(ctx, 'loader')?.entries() ?? [], 'profile')
    } catch {
      // A loader read racing a reload; the next read answers.
      return []
    }
  }

  /** Configured rows for one agent: profile first, then its preset; first declaration of a name wins. */
  const declaredRows = (agent) => {
    const rows = []
    for (const row of [...profileRows(), ...(readPreset(ctx, presetIdOf(agent))?.rows ?? [])]) {
      if (!rows.some((existing) => existing.serverName === row.serverName)) rows.push(row)
    }
    return rows
  }

  /** Compiled `toolFilter` configs, keyed by server; a broken filter is reported once and ignored. */
  const reportedFilterErrors = new Set()
  const configFilters = (rows) => {
    const filters = new Map()
    for (const row of rows) {
      if (!Array.isArray(row.toolFilter) || row.toolFilter.length === 0) continue
      try {
        filters.set(row.serverName, compileToolFilter(row.serverName, row.toolFilter))
      } catch (error) {
        const message = messageOf(error)
        if (!reportedFilterErrors.has(message)) {
          reportedFilterErrors.add(message)
          log('error', `${message}; the filter is ignored`)
        }
      }
    }
    return filters
  }

  /**
   * Every tool name the agent could see unrestricted. A restricted name is
   * absent from `schemas(agent)`, so the applied deny list stands in for it —
   * but only under the preset it was computed for: another preset may not
   * provide those tools at all.
   */
  const inheritedNames = (entry) => {
    const names = new Set(entry.appliedPreset === presetIdOf(entry.agent) ? entry.applied : [])
    for (const schema of ctx.tools.schemas()) names.add(schema.name)
    for (const schema of ctx.tools.schemas(entry.agent)) names.add(schema.name)
    return names
  }

  /**
   * @typedef {object} Policy
   * @property {ServerRow[]} rows - the configured roster.
   * @property {Map<string, (toolName: string) => boolean>} filters - compiled config filters.
   * @property {(toolName: string) => { server: string | undefined, kept: boolean, visible: boolean, why?: 'server' | 'filter' }} decide -
   *   `kept` is the filter's answer alone; `visible` also applies the server switch.
   */

  /** One agent's visibility policy, reused for `DECISION_TTL_MS` while its state and preset hold. */
  const policyCache = new WeakMap()
  /** @returns {Policy} */
  const policyFor = (entry) => {
    const presetId = presetIdOf(entry.agent)
    const cached = policyCache.get(entry)
    if (cached !== undefined && performance.now() - cached.at < DECISION_TTL_MS && cached.state === entry.state && cached.presetId === presetId) {
      return cached.policy
    }
    const rows = declaredRows(entry.agent)
    const known = rows.map((row) => row.serverName)
    const filters = configFilters(rows)
    const decide = (toolName) => {
      const server = attributeServer(toolName, known)
      if (server === undefined) return { server, kept: true, visible: true }
      const explicit = entry.state.toolFilters.get(server)
      const configured = filters.get(server)
      const kept = explicit !== undefined ? explicit.has(toolName) : configured !== undefined ? configured(toolName) : true
      if (entry.state.mcpOff.has(server)) return { server, kept, visible: false, why: 'server' }
      return { server, kept, visible: kept, why: kept ? undefined : 'filter' }
    }
    const policy = { rows, filters, decide }
    policyCache.set(entry, { at: performance.now(), state: entry.state, presetId, policy })
    return policy
  }

  // ── tools

  /** Run `fn` with this plugin's own `tools/change` echoes ignored. */
  const quietly = (fn) => {
    restricting = true
    try {
      return fn()
    } finally {
      restricting = false
    }
  }

  const refreshTools = (entry) => {
    if (restricting) return
    const presetId = presetIdOf(entry.agent)
    if (entry.appliedPreset !== presetId) {
      // A restriction computed under another preset can mask a same-name tool
      // of this one, which would then read as absent below; lift it first.
      if (entry.lift !== undefined) quietly(entry.lift)
      entry.lift = undefined
      entry.applied = []
      entry.appliedPreset = presetId
    }
    const { decide } = policyFor(entry)
    const desired = [...inheritedNames(entry)].filter((toolName) => !decide(toolName).visible).sort()
    if (desired.length === entry.applied.length && desired.every((toolName, index) => toolName === entry.applied[index])) return
    quietly(() => {
      try {
        entry.lift?.()
        entry.lift = undefined
        entry.applied = []
        if (desired.length === 0) return
        try {
          entry.lift = entry.agent.ctx.tools.restrict({ deny: desired })
          entry.applied = desired
        } catch (error) {
          // restrict() rejects a name the scope no longer inherits (a server
          // unloaded between the read and this call); retry with what is live.
          const present = new Set([...ctx.tools.schemas(), ...ctx.tools.schemas(entry.agent)].map((schema) => schema.name))
          const narrowed = desired.filter((toolName) => present.has(toolName))
          if (narrowed.length === 0) return
          entry.lift = entry.agent.ctx.tools.restrict({ deny: narrowed })
          entry.applied = narrowed
          log('warn', `session ${entry.agent.session.id}: retried restriction without vanished tools (${messageOf(error)})`)
        }
      } catch (error) {
        log('error', `failed to restrict MCP tools for session ${entry.agent.session.id}; they stay visible` +
          `${config.enforceGuard ? ' but calls are refused' : ''}: ${messageOf(error)}`)
      }
    })
  }

  const installGuard = (entry) => {
    if (!config.enforceGuard) return
    entry.disposeGuard = entry.agent.ctx.tools.guard((execution) => {
      if (RESOURCE_TOOLS.has(execution.name)) {
        const server = execution.arguments?.server
        return typeof server === 'string' && entry.state.mcpOff.has(server)
          ? `MCP server "${server}" is switched off for this session (${name})`
          : undefined
      }
      const verdict = policyFor(entry).decide(execution.name)
      if (verdict.visible) return undefined
      return verdict.why === 'server'
        ? `MCP server "${verdict.server}" is switched off for this session (${name})`
        : `MCP tool "${execution.name}" is filtered out for this session (${name})`
    })
  }

  // ── skills

  const refreshSkills = (entry) => {
    for (const [skillName, dispose] of [...entry.skillShadows]) {
      if (entry.state.skillsOff.has(skillName)) continue
      dispose()
      entry.skillShadows.delete(skillName)
    }
    const registry = agentService(entry.agent, 'skills')
    if (registry === undefined) return
    for (const skillName of entry.state.skillsOff) {
      if (entry.skillShadows.has(skillName)) continue
      try {
        entry.skillShadows.set(skillName, registry.register({
          name: skillName,
          description: SHADOW_DESCRIPTION,
          content: '',
          source: SHADOW_SOURCE,
          invocation: { modelInvocable: false, userInvocable: false },
        }))
      } catch (error) {
        log('warn', `session ${entry.agent.session.id}: cannot hide skill "${skillName}": ${messageOf(error)}`)
      }
    }
  }

  /**
   * Tell browsers that a session's skill catalog changed.
   *
   * The composer's `/` menu caches each session's catalog (`skills/list`) and
   * drops it only on `agent-preset/selected`, a host event forwarded to every
   * client; there is no skill-change event. So a skill switch re-announces the
   * preset the session already runs: clients drop that session's catalog (and
   * command directory), and an open `/` menu reloads at once. Nothing is
   * appended to the session, and this plugin's own preset memory skips it.
   */
  const announceSkills = (entry) => {
    const presetId = projectedPreset(entry.agent)
    if (typeof presetId !== 'string') return
    reannouncing = true
    try {
      ctx.emit('agent-preset/selected', entry.agent.session.id, presetId)
    } catch (error) {
      log('warn', `session ${entry.agent.session.id}: could not refresh the / menu's skills: ${messageOf(error)}`)
    } finally {
      reannouncing = false
    }
  }

  // ── system prompt

  /**
   * Servers registered with the resource runtime in one scope chain.
   *
   * Reads the runtime's `layers` (TypeScript-private, a plain field at
   * runtime); should that change, the configured roster answers instead.
   */
  const resourceServerNames = (entry, scope) => {
    try {
      const runtime = optionalService(ctx, 'agentPresets')?.serviceFor?.(entry.agent, 'mcpResources') ?? optionalService(ctx, 'mcpResources')
      const merged = runtime?.layers?.merge?.(scope, (layer) => layer.servers)
      if (merged !== undefined) return [...merged.keys()]
    } catch {
      // Fall back to the roster below.
    }
    return declaredRows(entry.agent).filter((row) => row.enabled).map((row) => row.serverName)
  }

  /**
   * Keep a switched-off server out of the system prompt.
   *
   * `dsh-mcp-client` contributes one section per server, `mcp:<server>`, with
   * the server's own instructions, and `dsh-mcp-resources` contributes one
   * `mcp-resource-servers` section naming every server usable with the resource
   * tools. Prompt sections shadow by name along the scope chain, nearest layer
   * last, so an empty `mcp:<server>` in the agent's layer removes that server's
   * instructions, and an agent-layer `mcp-resource-servers` restates the list
   * without the switched-off servers.
   */
  const refreshPrompt = (entry) => {
    for (const [serverName, dispose] of [...entry.promptShadows]) {
      if (entry.state.mcpOff.has(serverName)) continue
      dispose()
      entry.promptShadows.delete(serverName)
    }
    if (entry.state.mcpOff.size === 0) {
      entry.resourceListShadow?.()
      entry.resourceListShadow = undefined
      return
    }
    const prompt = agentService(entry.agent, 'systemPrompt')
    if (prompt === undefined) return
    let order
    try {
      order = prompt.getSectionOrder('MCP_SERVERS')
    } catch (error) {
      log('warn', `session ${entry.agent.session.id}: no MCP_SERVERS prompt order (${messageOf(error)}); server instructions stay in the prompt`)
      return
    }
    const register = (section) => {
      try {
        return prompt.section({ order, interpolate: false, ...section })
      } catch (error) {
        log('warn', `session ${entry.agent.session.id}: cannot shadow prompt section "${section.name}": ${messageOf(error)}`)
        return undefined
      }
    }
    for (const serverName of entry.state.mcpOff) {
      if (entry.promptShadows.has(serverName)) continue
      const dispose = register({ name: `mcp:${serverName}`, text: '' })
      if (dispose !== undefined) entry.promptShadows.set(serverName, dispose)
    }
    if (entry.resourceListShadow === undefined) {
      entry.resourceListShadow = register({
        name: 'mcp-resource-servers',
        text: ({ scope }) => {
          const names = resourceServerNames(entry, scope).filter((serverName) => !entry.state.mcpOff.has(serverName)).sort()
          // Same wording as dsh-mcp-resources, minus the switched-off servers.
          return names.length === 0 ? '' : '## MCP resource servers\n\n'
            + 'Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names '
            + `as the server argument: ${JSON.stringify(names)}.`
        },
      })
    }
  }

  /** Bring the session's tools, skills, and prompt in line with its state. */
  const refreshAll = (entry) => {
    refreshTools(entry)
    refreshSkills(entry)
    refreshPrompt(entry)
  }

  // ── lifecycle

  const initialState = (agent, cwd) => {
    const parent = live.get(agent.session.header?.parentSession)
    if (parent !== undefined) return cloneState(parent.state)
    const remembered = cwd !== undefined ? memory.get(cwd) : {}
    return {
      mcpOff: new Set(remembered.mcpOff ?? config.defaultOff.mcp),
      skillsOff: new Set(remembered.skillsOff ?? config.defaultOff.skills),
      toolFilters: new Map(Object.entries(remembered.toolFilters ?? {}).map(([server, names]) => [server, new Set(names)])),
    }
  }

  /** Switch a blank top-level session to its directory's preset. */
  const choosePreset = (agent, cwd) => {
    const registry = optionalService(ctx, 'agentPresets')
    if (registry === undefined) return
    const header = agent.session.header
    const remembered = memory.get(cwd).preset
    const target = remembered ?? matchRule(config.rules, cwd)?.preset
    if (target === undefined) return
    const current = projectedPreset(agent)
    if (current === target) return
    // Explicitly requested (Creator mode's `cordis`), or already picked by hand.
    if (header.agentPreset !== registry.defaultId || current !== header.agentPreset) return
    if (!isBlank(agent.session)) return
    // Deferred past the creating call, which still attaches the session to its
    // workspace; a pick staged on the new-task screen may land first and wins.
    setTimeout(() => {
      if (projectedPreset(agent) !== current || !isBlank(agent.session)) return
      const why = remembered !== undefined ? 'last selected here' : 'workspace rule'
      registry.select(agent, target).then(
        (selected) => log('info', `session ${agent.session.id} (${cwd}) — preset ${current} → ${selected} (${why})`),
        (error) => log('warn', `session ${agent.session.id} (${cwd}) — could not switch to preset "${target}" (${why}): ${messageOf(error)}`),
      )
    }, 0)
  }

  // `agent/created` is awaited while the session is published: nothing here may throw.
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent?.session === undefined) return
    try {
      const header = agent.session.header ?? {}
      const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
      const topLevel = header.parentSession === undefined && header.origin !== 'subagent' && header.isSeeded !== true
      const sessionId = agent.session.id
      /** @type {SessionEntry} */
      const entry = {
        agent, cwd, topLevel, state: initialState(agent, cwd),
        applied: [], appliedPreset: undefined, lift: undefined, disposeGuard: undefined,
        skillShadows: new Map(), promptShadows: new Map(), resourceListShadow: undefined,
        seenSkills: new Map(),
      }
      live.set(sessionId, entry)
      agent.ctx.effect(() => () => {
        live.delete(sessionId)
        entry.lift?.()
        entry.disposeGuard?.()
        for (const dispose of [...entry.skillShadows.values(), ...entry.promptShadows.values()]) dispose()
        entry.resourceListShadow?.()
        entry.lift = entry.disposeGuard = entry.resourceListShadow = undefined
        entry.skillShadows.clear()
        entry.promptShadows.clear()
      }, `${name}.session`)
      installGuard(entry)
      refreshAll(entry)
      if (topLevel && cwd !== undefined) choosePreset(agent, cwd)
    } catch (error) {
      log('error', `session ${agent.session.id}: setup failed: ${error instanceof Error ? error.stack : String(error)}`)
    }
  })

  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    if (reannouncing) return
    const entry = live.get(sessionId)
    if (entry === undefined || !entry.topLevel || entry.cwd === undefined) return
    if (persist(() => memory.update(entry.cwd, { preset: agentPreset }))) log('info', `remembered preset ${agentPreset} for ${entry.cwd}`)
  })

  let settleTimer
  ctx.on('tools/change', () => {
    if (restricting || settleTimer !== undefined) return
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      for (const entry of [...live.values()]) refreshTools(entry)
    }, REFRESH_DEBOUNCE_MS)
  })
  ctx.effect(() => () => {
    if (settleTimer !== undefined) clearTimeout(settleTimer)
    settleTimer = undefined
  }, `${name}.settleTimer`)

  // ── panel reads and writes

  const changeSession = (sessionId, patch) => {
    if (config.locked) throw new LockedError()
    const entry = live.get(sessionId)
    if (entry === undefined) throw new Error(`session ${sessionId} has no running agent — its capabilities cannot be changed`)
    const state = cloneState(entry.state)
    const remembered = {}
    if (patch.mcpOff !== undefined) {
      state.mcpOff = new Set(patch.mcpOff ?? config.defaultOff.mcp)
      remembered.mcpOff = [...state.mcpOff].sort()
    }
    if (patch.skillsOff !== undefined) {
      state.skillsOff = new Set(patch.skillsOff ?? config.defaultOff.skills)
      remembered.skillsOff = [...state.skillsOff].sort()
    }
    if (patch.filter !== undefined) {
      if (patch.filter.allow === null) state.toolFilters.delete(patch.filter.server)
      else state.toolFilters.set(patch.filter.server, new Set(patch.filter.allow))
      remembered.toolFilters = Object.fromEntries([...state.toolFilters].map(([server, names]) => [server, [...names].sort()]))
    }
    const skillsChanged = !sameSet(state.skillsOff, entry.state.skillsOff)
    if (skillsChanged) {
      // Keep what the panel knows about every skill being hidden: once
      // shadowed, the session's own view can no longer show the original.
      const hidden = [...entry.seenSkills].filter(([skillName]) => state.skillsOff.has(skillName))
      persist(() => memory.rememberSkills(entry.cwd, hidden))
    }
    entry.state = state
    refreshAll(entry)
    if (skillsChanged) announceSkills(entry)
    if (entry.topLevel && entry.cwd !== undefined) persist(() => memory.update(entry.cwd, remembered))
  }

  /**
   * Fill in a hidden skill the panel has never seen.
   *
   * A skill switched off before this plugin displayed it exists only as a
   * shadow: description, instruction file, and source are all gone from the
   * session's view. A registry snapshot read through the session preset's
   * standing scope still answers for every provider the preset mounts —
   * project roots for `cwd`, plus user, custom, and bundled skills — because
   * the shadow lives in the agent's own layer, outside that chain. The preset
   * scope matters: web and desktop compositions disable the host-level
   * `skill-filesystem` row ("presets own local discovery"), so the global
   * layer alone is empty there. Without a mounted generation the read degrades
   * to the global layer alone; a preset that mounts its own isolated skills
   * registry stays invisible to it either way — switching one on for a moment
   * records it.
   * @param {SessionEntry} entry - the session entry.
   * @param {{ name: string, description: string, on: boolean, source: string | null, path: string | null }[]} skills - the panel's rows, filled in place.
   */
  const fillHiddenSkillDetails = async (entry, skills) => {
    // A remembered record without a source is incomplete; look it up again.
    const unseen = skills.filter((skill) => !skill.on
      && !entry.seenSkills.has(skill.name)
      && memory.skill(entry.cwd, skill.name)?.source === undefined)
    if (unseen.length === 0) return
    const registry = optionalService(ctx, 'skills')
    if (typeof registry?.snapshot !== 'function') return
    let snapshot
    try {
      snapshot = await registry.snapshot({ cwd: entry.cwd, scope: readPreset(ctx, presetIdOf(entry.agent))?.scopeKey })
    } catch (error) {
      log('warn', `session ${entry.agent.session.id}: could not look up hidden skills: ${messageOf(error)}`)
      return
    }
    const learned = []
    for (const item of unseen) {
      const found = (snapshot?.skills ?? []).find((candidate) => candidate.name === item.name && candidate.source !== SHADOW_SOURCE)
      if (found === undefined) continue
      const meta = skillMeta(found)
      entry.seenSkills.set(found.name, meta)
      learned.push([found.name, meta])
      if (meta.description !== undefined) item.description = meta.description
      item.source = meta.source ?? null
      item.path = skillDir(meta.path)
    }
    persist(() => memory.rememberSkills(entry.cwd, learned))
  }

  /** The panel's skill rows: the agent's own view, where hidden skills appear as shadows. */
  const describeSkills = async (entry) => {
    const registry = agentService(entry.agent, 'skills')
    if (registry === undefined) return { available: false, items: [] }
    try {
      const snapshot = await registry.snapshot({ cwd: entry.cwd, scope: entry.agent })
      const real = new Map()
      for (const skill of snapshot.skills) {
        if (skill.source === SHADOW_SOURCE) continue
        real.set(skill.name, skill)
        entry.seenSkills.set(skill.name, skillMeta(skill))
      }
      const names = new Set([...snapshot.skills.map((skill) => skill.name), ...entry.state.skillsOff])
      const items = [...names].sort().map((skillName) => {
        const known = real.get(skillName) ?? entry.seenSkills.get(skillName) ?? memory.skill(entry.cwd, skillName)
        return {
          name: skillName,
          description: known?.description ?? '',
          on: !entry.state.skillsOff.has(skillName),
          source: typeof known?.source === 'string' ? known.source : null,
          path: skillDir(known?.path),
        }
      })
      await fillHiddenSkillDetails(entry, items)
      return { available: true, items }
    } catch (error) {
      log('warn', `session ${entry.agent.session.id}: skill snapshot failed: ${messageOf(error)}`)
      return { available: false, items: [] }
    }
  }

  /** The panel's MCP rows: every configured or inferred server with its tools, hidden ones included. */
  const describeServers = (entry) => {
    const { agent, state } = entry
    // The panel reads the roster fresh (fiber phases move); only the guard needs the cache.
    policyCache.delete(entry)
    const policy = policyFor(entry)
    const rows = [...policy.rows]
    const known = rows.map((row) => row.serverName)
    const descriptions = new Map()
    for (const schema of [...ctx.tools.schemas(), ...ctx.tools.schemas(agent)]) {
      if (typeof schema.description === 'string') descriptions.set(schema.name, schema.description)
    }
    const toolsByServer = new Map()
    for (const toolName of inheritedNames(entry)) {
      const server = attributeServer(toolName, known)
      if (server === undefined) continue
      toolsByServer.set(server, [...(toolsByServer.get(server) ?? []), toolName])
    }
    for (const serverName of toolsByServer.keys()) {
      if (!known.includes(serverName)) rows.push({ serverName, enabled: true, phase: null, origin: 'inferred', toolFilter: undefined })
    }
    return rows
      .map((row) => {
        const toolNames = (toolsByServer.get(row.serverName) ?? []).sort()
        return {
          serverName: row.serverName,
          origin: row.origin,
          enabled: row.enabled,
          on: !state.mcpOff.has(row.serverName),
          state: serverState(row, toolNames.length),
          filterSource: state.toolFilters.has(row.serverName) ? 'workspace' : policy.filters.has(row.serverName) ? 'config' : null,
          tools: toolNames.map((toolName) => ({
            name: toolName,
            short: toolName.slice(serverPrefix(row.serverName).length),
            description: (descriptions.get(toolName) ?? '').slice(0, 240),
            kept: policy.decide(toolName).kept,
          })),
        }
      })
      .sort((left, right) => left.serverName.localeCompare(right.serverName))
  }

  const describeSession = async (sessionId) => {
    const entry = live.get(sessionId)
    if (entry === undefined) return { sessionId, live: false }
    // Settle a preset switch the debounced `tools/change` refresh has not reached yet.
    refreshTools(entry)
    const { agent } = entry
    const servers = describeServers(entry)
    const skills = await describeSkills(entry)
    const enabled = servers.filter((server) => server.enabled)
    const preset = readPreset(ctx, presetIdOf(agent))
    return {
      sessionId,
      live: true,
      locked: config.locked,
      started: !isBlank(agent.session),
      cwd: entry.cwd ?? null,
      remembered: config.remember && entry.topLevel && entry.cwd !== undefined,
      preset: preset === null ? null : { id: preset.id, name: preset.name },
      mcp: {
        servers,
        counts: { on: enabled.filter((server) => server.on).length, total: enabled.length },
        visibleTools: ctx.tools.schemas(agent).filter((schema) => schema.name.startsWith(MCP_TOOL_PREFIX)).length,
        hiddenTools: entry.applied.length,
      },
      skills: {
        ...skills,
        counts: { on: skills.items.filter((skill) => skill.on).length, total: skills.items.length },
      },
    }
  }

  // ── HTTP face (absent in headless profiles; the scoping itself still runs)

  const readJson = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('request body too large')
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return body !== null && typeof body === 'object' ? body : {}
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_BASE,
      handler: async (req, res) => {
        const send = (status, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(API_BASE.length) || '/'
        try {
          if (req.method === 'GET' && route === '/session') {
            const sessionId = url.searchParams.get('id')
            if (!sessionId) return send(400, { error: 'id is required' })
            return send(200, await describeSession(sessionId))
          }
          if (req.method === 'POST' && route === '/session') {
            const input = await readJson(req)
            if (typeof input.id !== 'string' || input.id === '') return send(400, { error: 'id is required' })
            changeSession(input.id, parsePatch(input))
            return send(200, await describeSession(input.id))
          }
          return send(404, { error: `no route ${req.method ?? '?'} ${route}` })
        } catch (error) {
          if (error instanceof LockedError) return send(403, { error: error.message, locked: true })
          // Every throw here is a rejected payload or a session with no agent.
          return send(400, { error: messageOf(error) })
        }
      },
    }), `${name}.httpApi`)
  })

  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  log('info', `mounted v${version}; ${config.rules.length} preset rule(s); memory ${memory.path ?? 'off'}${config.locked ? '; locked (panel is read-only)' : ''}`)
}
