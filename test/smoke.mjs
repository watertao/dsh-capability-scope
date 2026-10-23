// Smoke test for the host half, driven by a fake harness.
//
// The fake keeps the host behaviours the plugin depends on:
//   * tools: `schemas()` is the root view; `schemas(agent)` adds the agent's
//     preset tools minus that agent's restriction; `restrict()` throws on a
//     name the agent does not inherit; restrict and its disposer emit
//     `tools/change`.
//   * skills: runtime skills registered through `agent.ctx.skills` land in the
//     agent's layer, and the nearest layer wins a same-name merge.
//   * presets: `select()` records `agent-preset/selected`, which the plugin
//     observes like the registry's host event.
//
// Run: node test/smoke.mjs

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import { apply } from '../src/index.mjs'
import { openMemory } from '../src/memory.mjs'
import { compileToolFilter, publicToolName } from '../src/names.mjs'

const golden = JSON.parse(readFileSync(new URL('./golden-names.json', import.meta.url), 'utf8'))
const WS = '/tmp/dcs-ws'

function createHarness({ config = {}, profileServers = [], presets = {}, globalSkills = [], presetSkills = {}, profile } = {}) {
  const profileDir = profile ?? mkdtempSync(join(tmpdir(), 'dcs-profile-'))
  const rootTools = new Set()
  const presetTools = new Map(Object.keys(presets).map((id) => [id, new Set()]))
  const listeners = new Map()
  const routes = []
  const emit = (event, ...args) => { for (const listener of [...(listeners.get(event) ?? [])]) listener(...args) }
  const on = (event, listener) => {
    const bucket = listeners.get(event) ?? new Set()
    bucket.add(listener)
    listeners.set(event, bucket)
    return () => bucket.delete(listener)
  }
  const restrictions = new Map()
  const guards = new Map()
  const agentPreset = new Map()
  const projections = new Map()
  const agentSkillLayers = new Map()
  const inherited = (agent) => [...rootTools, ...(presetTools.get(agentPreset.get(agent)) ?? [])]
  const visibleTo = (agent) => inherited(agent).filter((toolName) => !(restrictions.get(agent)?.has(toolName)))

  // Preset standing-scope keys, as the real definitions' generation.mount.key.
  const presetKeys = new Map()
  const definitions = new Map(Object.entries(presets).map(([id, preset]) => {
    const key = { preset: id }
    presetKeys.set(key, id)
    return [id, {
      config: { id, name: preset.name, plugins: preset.plugins },
      generation: { mount: { key, tree: { entries: () => preset.plugins.map((row) => ({
        disabled: row.disabled === true, options: { name: row.name, config: row.config }, fiber: { state: 2 },
      })) } } },
    }]
  }))

  // Like the real registry: register() files into the layer of `this.ctx`,
  // and the instance a preset mounts is bound to the preset's own context.
  const leakedSkills = new Map()
  const skillsService = {
    ctx: { owner: undefined },
    register(skill) {
      const layer = this.ctx.owner === undefined ? leakedSkills : agentSkillLayers.get(this.ctx.owner)
      layer.set(skill.name, skill)
      return () => layer.delete(skill.name)
    },
    snapshot: async ({ scope }) => {
      const merged = new Map()
      // Global-layer providers merge under every scope. A web/desktop
      // composition disables the host skill-filesystem row, leaving this
      // empty — the preset layer below then owns local discovery.
      for (const skill of globalSkills) merged.set(skill.name, skill)
      // A preset's providers appear under the preset's standing scope (and
      // under every agent composed on it), never under a scope-less read.
      const presetId = agentPreset.get(scope) ?? presetKeys.get(scope)
      for (const skill of presetSkills[presetId] ?? []) merged.set(skill.name, skill)
      for (const skill of leakedSkills.values()) merged.set(skill.name, skill)
      for (const skill of agentSkillLayers.get(scope)?.values() ?? []) merged.set(skill.name, skill)
      return { skills: [...merged.values()], complete: true }
    },
  }
  // Prompt sections: global/preset contributions plus agent-layer shadows,
  // merged nearest-last by name like the real registry.
  const agentSections = new Map()
  const baseSections = new Map([
    ['mcp-resource-servers', { name: 'mcp-resource-servers', text: ({ scope }) => `resources: ${JSON.stringify(resourceServers(scope))}` }],
  ])
  const resourceServers = (scope) => [...(presets[agentPreset.get(scope)]?.plugins ?? []), ...profileServers.map((serverName) => ({ config: { serverName } }))]
    .map((row) => row.config.serverName).sort()
  const systemPromptService = {
    ctx: { owner: undefined },
    getSectionOrder: () => 50,
    section(section) {
      const layer = agentSections.get(this.ctx.owner)
      if (layer === undefined) throw new Error('section registered outside an agent layer')
      if (layer.has(section.name)) throw new Error(`duplicate ${section.name}`)
      layer.set(section.name, section)
      return () => layer.delete(section.name)
    },
  }
  const assemble = (agent) => {
    const merged = new Map(baseSections)
    for (const serverName of resourceServers(agent)) merged.set(`mcp:${serverName}`, { name: `mcp:${serverName}`, text: `about ${serverName}` })
    for (const [sectionName, section] of agentSections.get(agent) ?? []) merged.set(sectionName, section)
    return [...merged.values()]
      .map((section) => (typeof section.text === 'function' ? section.text({ scope: agent }) : section.text))
      .filter((text) => text !== '')
  }
  const selected = []
  const services = {
    loader: { entries: () => profileServers.map((serverName) => (typeof serverName === 'string'
      ? { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName } }, fiber: { state: 2 } }
      : serverName)) },
    agentPresets: {
      definitions,
      defaultId: 'standard',
      composedPreset: (agentCtx) => agentPreset.get(agentCtx.owner),
      serviceFor: (agent, serviceName) => (serviceName === 'skills' && agentPreset.get(agent) === 'mp-tools' ? skillsService : undefined),
      select: async (agent, id) => {
        agentPreset.set(agent, id)
        projections.get(agent.session.id).agentPreset = id
        selected.push([agent.session.id, id])
        emit('agent-preset/selected', agent.session.id, id)
        emit('tools/change')
        return id
      },
    },
    sessionProjections: { stateOf: (session, key) => projections.get(session.id)?.[key] },
    skills: skillsService,
    mcpResources: { layers: { merge: (scope) => new Map(resourceServers(scope).map((serverName) => [serverName, {}])) } },
  }

  // Events the plugin emits itself, in order.
  const emitted = []
  const ctx = {
    baseUrl: pathToFileURL(profileDir).href + '/',
    logger: { info() {}, warn() {}, error() {} },
    tools: { schemas: (scope) => (scope === undefined ? [...rootTools] : visibleTo(scope)).map((toolName) => ({ name: toolName, description: `about ${toolName}` })) },
    reflect: { get: (serviceName) => services[serviceName] },
    on,
    emit: (event, ...args) => { emitted.push([event, ...args]); emit(event, ...args) },
    effect: (callback) => { const dispose = callback(); return () => dispose?.() },
    inject: (_deps, callback) => callback({ ...ctx, webServer: { register: (route) => { routes.push(route); return () => {} } } }),
  }

  const createAgent = (id, { preset = 'standard', cwd = WS, header = {}, turns = 0 } = {}) => {
    const agent = { id, session: { id, header: { cwd, agentPreset: preset, ...header } } }
    agentPreset.set(agent, preset)
    projections.set(id, { turnBoundary: { openTurnStartSeq: null, lastTurn: turns }, agentPreset: preset })
    const layer = new Map()
    agentSkillLayers.set(agent, layer)
    agentSections.set(agent, new Map())
    const disposers = []
    agent.ctx = {
      owner: agent,
      get(serviceName) {
        const service = { skills: skillsService, systemPrompt: systemPromptService }[serviceName]
        return service === undefined ? undefined : Object.assign(Object.create(service), { ctx: this })
      },
      effect: (callback) => { disposers.push(callback()) },
      tools: {
        restrict: ({ deny }) => {
          const available = new Set(inherited(agent))
          for (const toolName of deny) if (!available.has(toolName)) throw new Error(`unknown tool ${toolName}`)
          const set = new Set(deny)
          restrictions.set(agent, set)
          emit('tools/change')
          return () => {
            if (restrictions.get(agent) === set) restrictions.delete(agent)
            emit('tools/change')
          }
        },
        guard: (fn) => { guards.set(agent, fn); return () => guards.delete(agent) },
      },
    }
    emit('agent/created', { agent })
    return { agent, dispose: () => disposers.forEach((dispose) => dispose?.()), catalog: async () => (await skillsService.snapshot({ scope: agent })).skills.filter((skill) => skill.invocation?.modelInvocable !== false).map((skill) => skill.name).sort() }
  }

  const call = async (method, path, body) => {
    let status
    let payload
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = path
    await routes[0].handler(req, { writeHead: (code) => { status = code }, end: (buffer) => { payload = JSON.parse(buffer.toString('utf8')) } })
    return { status, payload }
  }

  apply(ctx, { echoToConsole: false, ...config })
  return {
    profileDir, createAgent, call, visibleTo, guards, selected, emit, emitted, assemble, services,
    memory: () => JSON.parse(readFileSync(join(profileDir, '.capability-scope.json'), 'utf8')),
    addRootTool: (toolName) => { rootTools.add(toolName); emit('tools/change') },
    addPresetTool: (presetId, toolName) => { presetTools.get(presetId).add(toolName); emit('tools/change') },
  }
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))
const cases = []
const test = (title, fn) => cases.push([title, fn])

const MP_PRESET = {
  name: '业务中台 MCP',
  plugins: [
    { id: 'mcp-mp-db', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'mp-db' } },
    { id: 'mcp-tdoc', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'tdoc', toolFilter: ['sheet.*', 'get_content'] } },
  ],
}
// `path` is the provider's instruction file; runtime skills have none.
const skill = (name, path) => ({ name, description: `does ${name}`, source: 'user-dsh', invocation: { modelInvocable: true, userInvocable: true }, ...(path ? { path } : {}) })

function mpHarness(options = {}) {
  const harness = createHarness({
    profileServers: ['filesystem'],
    presets: { 'mp-tools': MP_PRESET, standard: { plugins: [] } },
    globalSkills: [skill('pdf', join(homedir(), '.dsh/skills/pdf/SKILL.md')), skill('docx')],
    presetSkills: { 'mp-tools': [skill('mp-query', '/srv/skills/mp-query/SKILL.md')] },
    ...options,
  })
  harness.addRootTool('mcp__filesystem__read')
  harness.addRootTool('fs_read')
  harness.addPresetTool('mp-tools', 'mcp__mp-db__query')
  harness.addPresetTool('mp-tools', 'mcp__mp-db__tables')
  for (const raw of ['sheet.get_cell_data', 'sheet.set_range_value', 'get_content', 'doc.insert_text']) {
    harness.addPresetTool('mp-tools', publicToolName('tdoc', raw))
  }
  return harness
}

test('public tool names match the golden set generated from the harness', () => {
  for (const [server, raw, expected] of golden.cases) assert.equal(publicToolName(server, raw), expected, `${server}/${raw}`)
  const keep = compileToolFilter('tdoc', ['sheet.*', 'get_content'])
  assert.equal(keep(publicToolName('tdoc', 'sheet.get_cell_data')), true)
  assert.equal(keep(publicToolName('tdoc', 'doc.insert_text')), false)
  assert.throws(() => compileToolFilter('tdoc', ['*']), /trailing/)
})

test('the view joins profile and preset servers, skills, and the config toolFilter', async () => {
  const harness = mpHarness()
  const { agent } = harness.createAgent('s1', { preset: 'mp-tools' })
  const { payload } = await harness.call('GET', '/dsh-capability-scope/session?id=s1')
  assert.deepEqual(payload.mcp.servers.map((server) => [server.serverName, server.origin, server.tools.length, server.filterSource]), [
    ['filesystem', 'profile', 1, null],
    ['mp-db', 'preset', 2, null],
    ['tdoc', 'preset', 4, 'config'],
  ])
  assert.deepEqual(payload.mcp.counts, { on: 3, total: 3 })
  // The config filter hides doc.insert_text and nothing else.
  assert.equal(harness.visibleTo(agent).includes(publicToolName('tdoc', 'doc.insert_text')), false)
  assert.equal(payload.mcp.hiddenTools, 1)
  assert.deepEqual(payload.skills.items.map((item) => [item.name, item.on]), [['docx', true], ['mp-query', true], ['pdf', true]])
  // Each skill's folder, home shortened to ~; a runtime skill has no file.
  assert.deepEqual(payload.skills.items.map((item) => [item.name, item.path]), [['docx', null], ['mp-query', '/srv/skills/mp-query'], ['pdf', '~/.dsh/skills/pdf']])
  // The panel tags each skill with the source its provider reported.
  assert.deepEqual(payload.skills.items.map((item) => [item.name, item.source]), [['docx', 'user-dsh'], ['mp-query', 'user-dsh'], ['pdf', 'user-dsh']])
  assert.deepEqual(payload.preset, { id: 'mp-tools', name: '业务中台 MCP' })
})

test('switching a server off hides it, refuses calls, and is remembered for the workspace', async () => {
  const harness = mpHarness()
  const { agent } = harness.createAgent('s2', { preset: 'mp-tools' })
  const { payload } = await harness.call('POST', '/dsh-capability-scope/session', { id: 's2', mcpOff: ['mp-db'] })
  assert.equal(harness.visibleTo(agent).some((toolName) => toolName.startsWith('mcp__mp-db__')), false)
  assert.match(harness.guards.get(agent)({ name: 'mcp__mp-db__query' }), /switched off/)
  assert.deepEqual(payload.mcp.counts, { on: 2, total: 3 })
  assert.deepEqual(harness.memory().workspaces[WS].mcpOff, ['mp-db'])
  // The next session in the same directory starts with mp-db off.
  const next = harness.createAgent('s3', { preset: 'mp-tools' })
  assert.equal(harness.visibleTo(next.agent).some((toolName) => toolName.startsWith('mcp__mp-db__')), false)
  // Another directory is unaffected.
  const elsewhere = harness.createAgent('s4', { preset: 'mp-tools', cwd: '/tmp/dcs-other' })
  assert.equal(harness.visibleTo(elsewhere.agent).includes('mcp__mp-db__query'), true)
})

test('a workspace tool filter overrides the config filter and is remembered per workspace', async () => {
  const harness = mpHarness()
  const { agent } = harness.createAgent('f1', { preset: 'mp-tools' })
  const keep = publicToolName('tdoc', 'doc.insert_text')
  const { payload } = await harness.call('POST', '/dsh-capability-scope/session', { id: 'f1', filter: { server: 'tdoc', allow: [keep] } })
  const tdocVisible = harness.visibleTo(agent).filter((toolName) => toolName.startsWith('mcp__tdoc__'))
  assert.deepEqual(tdocVisible, [keep])
  assert.equal(payload.mcp.servers.find((server) => server.serverName === 'tdoc').filterSource, 'workspace')
  assert.match(harness.guards.get(agent)({ name: publicToolName('tdoc', 'get_content') }), /filtered out/)
  assert.deepEqual(harness.memory().workspaces[WS].toolFilters, { tdoc: [keep] })
  // A tool registered later by that server stays hidden.
  harness.addPresetTool('mp-tools', publicToolName('tdoc', 'sheet.new_tool'))
  await settle()
  assert.equal(harness.visibleTo(agent).includes(publicToolName('tdoc', 'sheet.new_tool')), false)
  // Reset returns to the config filter.
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'f1', filter: { server: 'tdoc', allow: null } })
  assert.equal(harness.visibleTo(agent).includes(publicToolName('tdoc', 'get_content')), true)
  assert.equal(harness.memory().workspaces[WS].toolFilters, undefined)
})

test('a filter naming another server is rejected', async () => {
  const harness = mpHarness()
  harness.createAgent('f2', { preset: 'mp-tools' })
  const { status, payload } = await harness.call('POST', '/dsh-capability-scope/session', { id: 'f2', filter: { server: 'tdoc', allow: ['mcp__mp-db__query'] } })
  assert.equal(status, 400)
  assert.match(payload.error, /only name tools of server "tdoc"/)
})

test('switching a skill off shadows it for that session only, and remembers it', async () => {
  const harness = mpHarness()
  const first = harness.createAgent('k1', { preset: 'mp-tools' })
  const other = harness.createAgent('k2', { preset: 'mp-tools', cwd: '/tmp/dcs-other' })
  await harness.call('GET', '/dsh-capability-scope/session?id=k1')
  const { payload } = await harness.call('POST', '/dsh-capability-scope/session', { id: 'k1', skillsOff: ['mp-query'] })
  assert.deepEqual(await first.catalog(), ['docx', 'pdf'])
  assert.deepEqual(await other.catalog(), ['docx', 'mp-query', 'pdf'])
  // The panel still lists the hidden skill with its original description and folder.
  assert.deepEqual(payload.skills.items.find((item) => item.name === 'mp-query'), { name: 'mp-query', description: 'does mp-query', on: false, source: 'user-dsh', path: '/srv/skills/mp-query' })
  assert.deepEqual(payload.skills.counts, { on: 2, total: 3 })
  // A new session in the same directory starts with the skill hidden, and
  // still knows everything the panel showed: the switch-off wrote description,
  // folder, and source to the memory file.
  const again = harness.createAgent('k3', { preset: 'mp-tools' })
  assert.deepEqual(await again.catalog(), ['docx', 'pdf'])
  const view = (await harness.call('GET', '/dsh-capability-scope/session?id=k3')).payload
  assert.deepEqual(view.skills.items.find((item) => item.name === 'mp-query'),
    { name: 'mp-query', description: 'does mp-query', on: false, source: 'user-dsh', path: '/srv/skills/mp-query' })
  // Switching it back on removes the shadow.
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'k3', skillsOff: [] })
  assert.deepEqual(await again.catalog(), ['docx', 'mp-query', 'pdf'])
})

test('a skill switch re-announces the preset so clients reload the / menu, without remembering it', async () => {
  const harness = mpHarness()
  harness.createAgent('m1', { preset: 'mp-tools' })
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'm1', skillsOff: ['pdf'] })
  assert.deepEqual(harness.emitted, [['agent-preset/selected', 'm1', 'mp-tools']])
  // Nobody picked mp-tools here, so it is not the directory's preset.
  assert.equal(harness.memory().workspaces[WS].preset, undefined)
  // Server switches and unchanged skill lists leave the catalog alone.
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'm1', mcpOff: ['tdoc'] })
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'm1', skillsOff: ['pdf'] })
  assert.equal(harness.emitted.length, 1)
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'm1', skillsOff: [] })
  assert.deepEqual(harness.emitted, [['agent-preset/selected', 'm1', 'mp-tools'], ['agent-preset/selected', 'm1', 'mp-tools']])
  // A real selection is still remembered.
  harness.emit('agent-preset/selected', 'm1', 'standard')
  assert.equal(harness.memory().workspaces[WS].preset, 'standard')
})

test('a switched-off server leaves the system prompt and the resource tools', async () => {
  const harness = mpHarness()
  const { agent } = harness.createAgent('sp1', { preset: 'mp-tools' })
  assert.deepEqual(harness.assemble(agent), ['resources: ["filesystem","mp-db","tdoc"]', 'about filesystem', 'about mp-db', 'about tdoc'])
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'sp1', mcpOff: ['mp-db', 'tdoc'] })
  assert.deepEqual(harness.assemble(agent), ['## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: ["filesystem"].', 'about filesystem'])
  const guard = harness.guards.get(agent)
  assert.match(guard({ name: 'read_mcp_resource', arguments: { server: 'mp-db', uri: 'x' } }), /switched off/)
  assert.equal(guard({ name: 'read_mcp_resource', arguments: { server: 'filesystem', uri: 'x' } }), undefined)
  // Another session on the same preset keeps its full prompt.
  const other = harness.createAgent('sp2', { preset: 'mp-tools', cwd: '/tmp/dcs-other' })
  assert.equal(harness.assemble(other.agent).length, 4)
  // Switching back on removes every shadow.
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'sp1', mcpOff: [] })
  assert.deepEqual(harness.assemble(agent), ['resources: ["filesystem","mp-db","tdoc"]', 'about filesystem', 'about mp-db', 'about tdoc'])
})

test('defaultOff applies to a directory with no memory; reset returns to it', async () => {
  const harness = mpHarness({ config: { defaultOff: { mcp: ['tdoc'], skills: ['pdf'] } } })
  const { agent, catalog } = harness.createAgent('d1', { preset: 'mp-tools' })
  assert.equal(harness.visibleTo(agent).some((toolName) => toolName.startsWith('mcp__tdoc__')), false)
  assert.deepEqual(await catalog(), ['docx', 'mp-query'])
  // pdf has never been on in this session, so its shadow is all the agent
  // view has; the unscoped registry still names its file and source, and the
  // lookup is remembered for later sessions.
  const view = (await harness.call('GET', '/dsh-capability-scope/session?id=d1')).payload
  assert.deepEqual(view.skills.items.find((item) => item.name === 'pdf'),
    { name: 'pdf', description: 'does pdf', on: false, source: 'user-dsh', path: '~/.dsh/skills/pdf' })
  assert.deepEqual(harness.memory().workspaces[WS].skills.pdf,
    { description: 'does pdf', path: join(homedir(), '.dsh/skills/pdf/SKILL.md'), source: 'user-dsh' })
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'd1', mcpOff: [] })
  assert.equal(harness.visibleTo(agent).some((toolName) => toolName.startsWith('mcp__tdoc__')), true)
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'd1', mcpOff: null })
  assert.equal(harness.visibleTo(agent).some((toolName) => toolName.startsWith('mcp__tdoc__')), false)
})

test('a default-off skill owned by the preset layer still shows its source and folder', async () => {
  // A web/desktop composition disables the host skill-filesystem row, so the
  // registry's global layer is empty and the preset's own provider is the only
  // place the real skill exists; the fallback read must go through the session
  // preset's standing scope to find it.
  const harness = mpHarness({
    globalSkills: [],
    config: { defaultOff: { mcp: [], skills: ['mp-query'] } },
  })
  harness.createAgent('pl1', { preset: 'mp-tools' })
  const view = (await harness.call('GET', '/dsh-capability-scope/session?id=pl1')).payload
  assert.deepEqual(view.skills.items.find((item) => item.name === 'mp-query'),
    { name: 'mp-query', description: 'does mp-query', on: false, source: 'user-dsh', path: '/srv/skills/mp-query' })
  // The lookup is remembered, so the next session there starts knowing it.
  assert.deepEqual(harness.memory().workspaces[WS].skills['mp-query'],
    { description: 'does mp-query', path: '/srv/skills/mp-query/SKILL.md', source: 'user-dsh' })
})

test('a blank session takes the preset last selected in its directory, over the rule', async () => {
  const harness = mpHarness({ config: { rules: [{ path: WS, preset: 'mp-tools' }] } })
  harness.createAgent('p1')
  await settle(10)
  assert.deepEqual(harness.selected, [['p1', 'mp-tools']])
  // A person picks `standard` back in a later blank session.
  harness.createAgent('p2')
  await settle(10)
  await harness.emit('agent-preset/selected', 'p2', 'standard')
  assert.equal(harness.memory().workspaces[WS].preset, 'standard')
  harness.createAgent('p3')
  await settle(10)
  assert.deepEqual(harness.selected.map(([id]) => id), ['p1', 'p2'])
})

test('switching presets drops servers hidden under the previous preset from the view', async () => {
  const harness = mpHarness()
  const { agent } = harness.createAgent('w1', { preset: 'mp-tools' })
  await harness.call('POST', '/dsh-capability-scope/session', { id: 'w1', mcpOff: ['mp-db', 'tdoc'] })
  const servers = async () => (await harness.call('GET', '/dsh-capability-scope/session?id=w1')).payload.mcp
  await harness.services.agentPresets.select(agent, 'standard')
  await settle()
  const onStandard = await servers()
  assert.deepEqual(onStandard.servers.map((server) => server.serverName), ['filesystem'])
  assert.equal(onStandard.hiddenTools, 0)
  // Back on mp-tools, the remembered switches apply again.
  await harness.services.agentPresets.select(agent, 'mp-tools')
  await settle()
  const onMp = await servers()
  assert.deepEqual(onMp.servers.map((server) => [server.serverName, server.on]), [['filesystem', true], ['mp-db', false], ['tdoc', false]])
  assert.equal(harness.visibleTo(agent).some((toolName) => toolName.startsWith('mcp__mp-db__') || toolName.startsWith('mcp__tdoc__')), false)
})

test('started, explicit-preset, and subagent sessions keep their preset', async () => {
  const harness = mpHarness({ config: { rules: [{ path: WS, preset: 'mp-tools' }] } })
  harness.createAgent('x1', { turns: 1 })
  harness.createAgent('x2', { preset: 'cordis' })
  harness.createAgent('x3', { header: { origin: 'subagent', parentSession: 'x1' } })
  await settle(10)
  assert.deepEqual(harness.selected, [])
})

test('memory survives a restart and lives in the profile directory as a dotfile', async () => {
  const first = mpHarness()
  first.createAgent('r1', { preset: 'mp-tools' })
  await first.call('POST', '/dsh-capability-scope/session', { id: 'r1', mcpOff: ['tdoc'] })
  const second = mpHarness({ profile: first.profileDir })
  const { agent } = second.createAgent('r2', { preset: 'mp-tools' })
  assert.equal(second.visibleTo(agent).some((toolName) => toolName.startsWith('mcp__tdoc__')), false)
})

test('skill metadata is remembered per workspace', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dcs-memory-'))
  const path = join(profile, '.capability-scope.json')
  const memory = openMemory(path, () => {}, (cwd) => cwd)
  // Two projects can each own `.dsh/skills/review`; the folder must not cross over.
  memory.rememberSkills('/w/a', [['review', { description: 'reviews A', path: '/w/a/.dsh/skills/review/SKILL.md', source: 'project-dsh' }]])
  memory.rememberSkills('/w/b', [['review', { description: 'reviews B', path: '/w/b/.dsh/skills/review/SKILL.md', source: 'project-agents' }]])
  const reopened = openMemory(path, () => {}, (cwd) => cwd)
  assert.deepEqual(reopened.skill('/w/a', 'review'), { description: 'reviews A', path: '/w/a/.dsh/skills/review/SKILL.md', source: 'project-dsh' })
  assert.deepEqual(reopened.skill('/w/b', 'review'), { description: 'reviews B', path: '/w/b/.dsh/skills/review/SKILL.md', source: 'project-agents' })
  assert.equal(reopened.skill(undefined, 'review'), undefined)
  // An unchanged record does not rewrite the file.
  assert.equal(reopened.rememberSkills('/w/a', [['review', { description: 'reviews A' }]]), false)
})

test('remember: false applies panel edits to the session but writes no memory file', async () => {
  const harness = mpHarness({ config: { remember: false } })
  const { agent } = harness.createAgent('n1', { preset: 'mp-tools' })
  await harness.call('GET', '/dsh-capability-scope/session?id=n1')
  const { payload } = await harness.call('POST', '/dsh-capability-scope/session', { id: 'n1', mcpOff: ['mp-db'], skillsOff: ['pdf'] })
  assert.equal(harness.visibleTo(agent).includes('mcp__mp-db__query'), false)
  assert.equal(payload.remembered, false)
  harness.emit('agent-preset/selected', 'n1', 'standard')
  assert.throws(() => harness.memory(), /ENOENT/)
})

test('a broken memory file is ignored, not fatal', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'dcs-profile-'))
  writeFileSync(join(profile, '.capability-scope.json'), '{ not json')
  const harness = mpHarness({ profile })
  const { agent } = harness.createAgent('b1', { preset: 'mp-tools' })
  assert.equal(harness.visibleTo(agent).includes('mcp__mp-db__query'), true)
})

test('writing a session with no running agent is refused', async () => {
  const harness = mpHarness()
  const { status, payload } = await harness.call('POST', '/dsh-capability-scope/session', { id: 'ghost', mcpOff: [] })
  assert.equal(status, 400)
  assert.match(payload.error, /no running agent/)
})

test('locked: the panel shows the surface, refuses writes, and ignores directory memory', async () => {
  // A memory written before the lock widens tdoc past its config toolFilter.
  const profile = mkdtempSync(join(tmpdir(), 'dcs-profile-'))
  const widened = publicToolName('tdoc', 'doc.insert_text')
  const before = JSON.stringify({ workspaces: { [WS]: { mcpOff: ['mp-db'], toolFilters: { tdoc: [widened] } } } })
  writeFileSync(join(profile, '.capability-scope.json'), before)
  const harness = mpHarness({ profile, config: { locked: true } })
  const { agent } = harness.createAgent('l1', { preset: 'mp-tools' })
  // The config filter rules, not the memory: mp-db stays on, the write tool stays hidden.
  assert.equal(harness.visibleTo(agent).includes('mcp__mp-db__query'), true)
  assert.equal(harness.visibleTo(agent).includes(widened), false)
  const view = await harness.call('GET', '/dsh-capability-scope/session?id=l1')
  assert.equal(view.payload.locked, true)
  assert.equal(view.payload.mcp.servers.find((server) => server.serverName === 'tdoc').filterSource, 'config')
  for (const body of [{ mcpOff: ['tdoc'] }, { skillsOff: ['pdf'] }, { filter: { server: 'tdoc', allow: [widened] } }]) {
    const { status, payload } = await harness.call('POST', '/dsh-capability-scope/session', { id: 'l1', ...body })
    assert.equal(status, 403)
    assert.equal(payload.locked, true)
  }
  assert.equal(harness.visibleTo(agent).includes(widened), false)
  assert.equal(readFileSync(join(profile, '.capability-scope.json'), 'utf8'), before)
  assert.throws(() => createHarness({ config: { locked: 'yes' } }), /locked/)
})

test('the browser half declares its services and registers one composer slot', () => {
  // A factory that does not declare a service it touches fails to activate.
  let loaded
  const window = { __ModuleLoader__: { load: (module) => { loaded = module } } }
  new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window)
  assert.equal(loaded.id, 'dsh-capability-scope')
  const stub = new Proxy({}, { get: () => () => {} })
  const plugin = loaded.factory((request) => (request === 'react' ? { createElement() {} } : request === 'react-dom' ? {} : stub))
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  const slots = []
  const effects = []
  plugin.apply({
    effect: (fn, label) => effects.push(label),
    locale: {},
    slots: { inject: (name, register) => { slots.push(name); register() }, register: (descriptor) => slots.push(descriptor.id) },
  })
  assert.deepEqual(slots, ['conversation.input.left', 'capability-scope'])
  assert.equal(effects.length, 2)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(manifest.dsh.client.inject))
})

test('invalid config fails at load', () => {
  assert.throws(() => createHarness({ config: { rules: [{ path: 'rel', preset: 'x' }] } }), /absolute/)
  assert.throws(() => createHarness({ config: { defaultOff: ['tdoc'] } }), /defaultOff/)
  assert.throws(() => createHarness({ config: { remember: 'yes' } }), /remember/)
})

let failed = 0
for (const [title, fn] of cases) {
  try {
    await fn()
    console.log(`ok   ${title}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${title}\n${error.stack}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed === 0 ? 0 : 1)
