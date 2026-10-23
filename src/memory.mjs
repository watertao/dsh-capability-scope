// Per-workspace memory, persisted as the profile's `.capability-scope.json`.
//
//   {
//     "version": 1,
//     "workspaces": {
//       "<canonical cwd>": {
//         "preset": "backend-tools",
//         "mcpOff": ["tdoc"],
//         "skillsOff": ["pdf"],
//         "toolFilters": { "tdoc": ["mcp__tdoc__get_content", "..."] },
//         "skills": {
//           "pdf": { "description": "...", "path": "~/.dsh/skills/pdf/SKILL.md", "source": "user-dsh" }
//         }
//       }
//     }
//   }
//
// Off lists rather than on lists, so a server or skill added later starts on.
// A tool filter is an explicit allow-list of public names: a tool the server
// adds later stays hidden until it is ticked. A workspace's `skills` keeps
// what the panel knows about a skill this plugin hides — description,
// instruction file, and provider source — because a hidden skill's original
// entry cannot be read back through the session's own view. It is stored per
// workspace: two projects can each own a `.dsh/skills/<name>`.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const VERSION = 1

/**
 * @typedef {object} SkillMemory
 * @property {string} [description]
 * @property {string} [path]
 * @property {string} [source]
 */

/**
 * @typedef {object} WorkspaceMemory
 * @property {string} [preset]
 * @property {string[]} [mcpOff]
 * @property {string[]} [skillsOff]
 * @property {Record<string, string[]>} [toolFilters]
 * @property {Record<string, SkillMemory>} [skills]
 */

/**
 * @typedef {object} Memory
 * @property {string | undefined} path - the JSON file; undefined when nothing is remembered.
 * @property {(cwd: string) => WorkspaceMemory} get - what is remembered for exactly that directory.
 * @property {(cwd: string, patch: Partial<WorkspaceMemory>) => boolean} update - merge fields; `undefined` removes one.
 * @property {(cwd: string | undefined, name: string) => SkillMemory | undefined} skill - one directory's record of a skill.
 * @property {(cwd: string | undefined, entries: Iterable<[string, SkillMemory]>) => boolean} rememberSkills - merge skill records.
 */

/** @returns {string[] | undefined} a clean string list, or undefined. */
function stringList(value) {
  return Array.isArray(value) ? [...new Set(value.filter((entry) => typeof entry === 'string' && entry !== ''))].sort() : undefined
}

/** @returns {SkillMemory | undefined} the readable part of one skill record. */
function readSkill(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const meta = {}
  for (const field of ['description', 'path', 'source']) {
    if (typeof raw[field] === 'string' && raw[field] !== '') meta[field] = raw[field]
  }
  return Object.keys(meta).length === 0 ? undefined : meta
}

/** @returns {WorkspaceMemory} the readable part of one stored workspace entry. */
function readWorkspace(raw) {
  if (raw === null || typeof raw !== 'object') return {}
  const entry = {}
  if (typeof raw.preset === 'string' && raw.preset !== '') entry.preset = raw.preset
  const mcpOff = stringList(raw.mcpOff)
  if (mcpOff !== undefined) entry.mcpOff = mcpOff
  const skillsOff = stringList(raw.skillsOff)
  if (skillsOff !== undefined) entry.skillsOff = skillsOff
  if (raw.toolFilters !== null && typeof raw.toolFilters === 'object') {
    const filters = {}
    for (const [server, names] of Object.entries(raw.toolFilters)) {
      const list = stringList(names)
      if (list !== undefined) filters[server] = list
    }
    if (Object.keys(filters).length > 0) entry.toolFilters = filters
  }
  if (raw.skills !== null && typeof raw.skills === 'object') {
    const skills = {}
    for (const [name, value] of Object.entries(raw.skills)) {
      const meta = readSkill(value)
      if (meta !== undefined) skills[name] = meta
    }
    if (Object.keys(skills).length > 0) entry.skills = skills
  }
  return entry
}

/**
 * The memory of a deployment that remembers nothing (`remember: false` or `locked: true`).
 * @returns {Memory} reads answer empty, writes change nothing.
 */
export function noMemory() {
  return { path: undefined, get: () => ({}), update: () => false, skill: () => undefined, rememberSkills: () => false }
}

/**
 * Open the memory document. An unreadable file is reported and starts empty.
 * @param {string} path - the JSON file.
 * @param {(level: 'info' | 'warn' | 'error', message: string) => void} log - diagnostics.
 * @param {(cwd: string) => string} canonical - directory key normalization.
 * @returns {Memory} the memory.
 */
export function openMemory(path, log, canonical) {
  /** @type {Record<string, WorkspaceMemory>} */
  let workspaces = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.workspaces !== null && typeof parsed?.workspaces === 'object') {
      for (const [dir, raw] of Object.entries(parsed.workspaces)) workspaces[dir] = readWorkspace(raw)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') log('warn', `ignoring unreadable ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const save = () => {
    // Same-directory temp file plus rename: a crash mid-write cannot leave a
    // truncated document behind.
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: VERSION, workspaces }, null, 2) + '\n')
    renameSync(temp, path)
  }

  /** Replace one directory's entry; writes only when it changed. */
  const put = (key, next) => {
    if (next.toolFilters !== undefined && Object.keys(next.toolFilters).length === 0) delete next.toolFilters
    if (next.skills !== undefined && Object.keys(next.skills).length === 0) delete next.skills
    if (JSON.stringify(next) === JSON.stringify(workspaces[key] ?? {})) return false
    workspaces = { ...workspaces, [key]: next }
    save()
    return true
  }

  return {
    path,
    get: (cwd) => workspaces[canonical(cwd)] ?? {},
    update: (cwd, patch) => {
      const key = canonical(cwd)
      const next = { ...(workspaces[key] ?? {}) }
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) delete next[field]
        else next[field] = value
      }
      return put(key, next)
    },
    skill: (cwd, name) => (cwd === undefined ? undefined : workspaces[canonical(cwd)]?.skills?.[name]),
    rememberSkills: (cwd, entries) => {
      if (cwd === undefined) return false
      const key = canonical(cwd)
      const current = workspaces[key] ?? {}
      const skills = { ...(current.skills ?? {}) }
      for (const [name, raw] of entries) {
        const meta = readSkill(raw)
        if (meta !== undefined) skills[name] = { ...(skills[name] ?? {}), ...meta }
      }
      return put(key, { ...current, skills })
    },
  }
}
