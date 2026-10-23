// dsh-capability-scope — BROWSER half.
//
// One seat, `conversation.input.left`, which the composer renders right after
// the permission and plan controls. It holds two triggers, `MCP 3/12` and
// `Skill 4/5`, each opening its own panel:
//
//   MCP     — one switch per server (profile rows and the session preset's
//             rows); a server row expands into its tools, each a checkbox of
//             the per-workspace tool filter.
//   Skill   — one switch per skill (name, the source its provider reported,
//             description, and folder).
//
// A list longer than 13 rows gets a filter box under the title divider, using
// the same Input search as the tool pane.
//
// Every change posts to the host and re-renders from the response, so the
// panel always shows what the host installed. The host also records the change
// as the workspace's memory, which the next session there starts from.
//
// Visual language follows the native composer controls: a trigger copies the
// permission-mode trigger (28px capsule, 13px/500, hover fill) and shows its
// count in the caption tone of the model trigger's effort text; the panel
// copies the Menu card (16px radius, no border, menu surface + backdrop blur,
// prominent elevation). Controls are the shared primitives (Switch, Checkbox,
// Input, Tag, StateDot, Button, Tooltip), reached through the platform
// module table. Hover text uses the Tooltip bubble the composer's "+" uses,
// not the browser's native title box.
//
window.__ModuleLoader__.load({
  id: 'dsh-capability-scope',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const {
      Button, Checkbox, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
      IconSearchOutlineRegular,
      Input, StateDot, Switch, Tag, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    const NS = 'capability-scope'
    const API = '/dsh-capability-scope'
    const POLL_MS = 30000
    // A freshly started GUI restores the default session on the client before
    // the host resumes its agent, so the first read answers live:false. Retry
    // at this pace until the agent appears, then fall back to the slow poll.
    const PENDING_RETRY_MS = 2000
    // A list longer than this gets a filter box under the title divider.
    const LIST_FILTER_AT = 13

    // ---------------------------------------------------------------- i18n

    const zh = {
      mcp: 'MCP',
      skill: 'Skill',
      mcpTitle: '选择注入本会话的 MCP 服务器与工具',
      skillTitle: '选择注入本会话的 Skill',
      noServers: '当前 profile 与 preset 都没有配置 MCP 服务器。',
      noSkills: '没有可用的 Skill。',
      skillsUnavailable: '当前会话没有 Skill 服务。',
      originProfile: 'profile',
      originPreset: 'preset',
      originInferred: '未登记',
      stateConnected: '已连接',
      stateStarting: '启动中',
      stateNoTools: '已启动，未连接',
      stateFailed: '挂载失败',
      stateDisabled: '已停用',
      stateUnmounted: '未挂载',
      toolsKept: '{kept}/{total} 个工具',
      filterConfig: '使用配置中的 toolFilter',
      filterWorkspace: '使用本工作区的过滤规则',
      expand: '查看工具',
      back: '返回',
      search: '搜索工具',
      filterMcp: '过滤 MCP 服务器',
      filterSkill: '过滤 Skill',
      noMatches: '没有匹配的条目。',
      selectAll: '全选',
      selectNone: '全不选',
      resetFilter: '恢复默认',
      allOn: '全部开启',
      allOff: '全部关闭',
      resetDefault: '恢复默认',
      switchServer: '为本会话开启或关闭 {name}',
      switchSkill: '为本会话开启或关闭 Skill {name}',
      disabledRow: '该服务器的配置行已停用，无法开启',
      notLive: '会话尚未运行。',
      lockedMcp: '已锁定：只显示，不能改。MCP 工具由配置的 toolFilter 决定。',
      lockedSkill: '已锁定：只显示，不能改。有哪些 Skill 由配置的 skill 目录决定。',
    }
    const en = {
      mcp: 'MCP',
      skill: 'Skill',
      mcpTitle: 'Choose the MCP servers and tools injected into this session',
      skillTitle: 'Choose the skills injected into this session',
      noServers: 'Neither the profile nor the preset configures an MCP server.',
      noSkills: 'No skills available.',
      skillsUnavailable: 'This session has no skill service.',
      originProfile: 'profile',
      originPreset: 'preset',
      originInferred: 'unlisted',
      stateConnected: 'connected',
      stateStarting: 'starting',
      stateNoTools: 'up, not connected',
      stateFailed: 'mount failed',
      stateDisabled: 'disabled',
      stateUnmounted: 'not mounted',
      toolsKept: '{kept}/{total} tools',
      filterConfig: 'Using the toolFilter from configuration',
      filterWorkspace: "Using this workspace's filter",
      expand: 'Show tools',
      back: 'Back',
      search: 'Search tools',
      filterMcp: 'Filter MCP servers',
      filterSkill: 'Filter skills',
      noMatches: 'No matches.',
      selectAll: 'Select all',
      selectNone: 'Select none',
      resetFilter: 'Reset',
      allOn: 'All on',
      allOff: 'All off',
      resetDefault: 'Back to default',
      switchServer: 'Switch {name} on or off for this session',
      switchSkill: 'Switch skill {name} on or off for this session',
      disabledRow: "This server's configuration row is disabled",
      notLive: 'The session is not running yet.',
      lockedMcp: 'Locked: shown read-only. MCP tools come from the configured toolFilter.',
      lockedSkill: 'Locked: shown read-only. Skills come from the configured skill directories.',
    }

    const STATE_KEY = {
      connected: 'stateConnected', starting: 'stateStarting', 'no-tools': 'stateNoTools',
      failed: 'stateFailed', disabled: 'stateDisabled', unmounted: 'stateUnmounted',
    }
    const STATE_DOT = {
      connected: 'done', starting: 'idle', 'no-tools': 'warning', failed: 'error', disabled: 'idle', unmounted: 'idle',
    }
    const ORIGIN_KEY = { profile: 'originProfile', preset: 'originPreset', inferred: 'originInferred' }

    // ----------------------------------------------------------------- api

    async function request(url, init) {
      const res = await fetch(url, Object.assign({ cache: 'no-store' }, init))
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
      return data
    }

    // -------------------------------------------------------------- styles

    const STYLE_ID = 'dsh-capability-scope-style'
    const CSS = `
.dcs-trigger {
  display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 260px;
  height: 28px; padding: 0 4px 0 8px; border: none; border-radius: 24px; outline: none;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; cursor: pointer; white-space: nowrap;
}
.dcs-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dcs-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.dcs-triggers { display: inline-flex; align-items: center; gap: 2px; }
/* The count takes the caption tone of the model trigger's effort text. */
.dcs-trigger-num { color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.dcs-chevron { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }
.dcs-chevron-open { transform: rotate(180deg); }

.dcs-panel {
  position: fixed; z-index: 1100; box-sizing: border-box; width: 400px; max-width: calc(100vw - 16px);
  display: flex; flex-direction: column; padding: 6px; border: 0; border-radius: 16px;
  background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px;
}
.dcs-head { display: flex; align-items: baseline; gap: 6px; padding: 4px 8px 2px; font-weight: 500; }
/* Same rule as the footer's top border. */
.dcs-divider { height: 0; margin: 4px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dcs-body { overflow-y: auto; max-height: min(52vh, 440px); }
.dcs-row {
  display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 8px; border-radius: 8px;
  box-sizing: border-box;
}
.dcs-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dcs-row-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
.dcs-row-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dcs-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcs-name-off { color: var(--dsw-alias-label-tertiary); }
.dcs-sub { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcs-count { flex: 0 0 auto; font-size: 12px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dcs-sub-warn { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-tertiary)); }
.dcs-expander {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-caption); cursor: pointer;
}
.dcs-expander:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dcs-back {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; align-self: center;
  width: 22px; height: 22px; margin-left: -4px; padding: 0; border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dcs-back:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dcs-search { padding: 2px 4px 4px; }
.dcs-search > * { width: 100%; box-sizing: border-box; }
.dcs-search-note { padding: 0 8px 4px; }
.dcs-tools-list { display: flex; flex-direction: column; gap: 2px; padding: 0 8px; }
.dcs-tool { display: flex; align-items: center; min-height: 26px; font-size: 12px; }
.dcs-foot {
  display: flex; flex-direction: column; gap: 6px; margin-top: 4px; padding: 8px 8px 4px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dcs-foot-actions { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.dcs-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
/* The locked notice sits under the footer buttons and must not outweigh them:
   one size down and one tone down (tertiary → caption). */
.dcs-note-locked { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); }
/* The skill's folder, under its description. */
.dcs-path { color: var(--dsw-alias-label-caption); }
/* A disabled control gets no hover events, so its bubble anchors on this
   wrapper and the control lets the pointer through. */
.dcs-tip-anchor { display: inline-flex; flex: 0 0 auto; }
.dcs-tip-anchor > :disabled { pointer-events: none; }
.dcs-note-error { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); }
.dcs-empty { padding: 10px 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dcs-busy { opacity: .6; pointer-events: none; }
`

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return () => {}
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
      return () => el.remove()
    }

    // ------------------------------------------------------------- tooltip

    /**
     * Put DSH's hover bubble on an element. Inside the panel the bubble must
     * portal: the panel's backdrop-filter makes it the containing block of
     * fixed-position children, so an in-place bubble would land offset by the
     * panel's own position.
     * @param {string | undefined} label - bubble text; none leaves the element bare.
     * @param child - one element that takes a ref and mouse handlers.
     * @param options - Tooltip props overriding the defaults (above, 500ms, portal).
     */
    function tip(label, child, options) {
      if (!label) return child
      // An older platform without the primitive keeps the native box.
      if (Tooltip === undefined) return React.cloneElement(child, { title: label })
      return h(Tooltip, Object.assign({ label, side: 'top', delayMs: 500, portal: true }, options), child)
    }

    /** `tip` for a Switch or button that may be disabled (see .dcs-tip-anchor). */
    const tipControl = (label, control) => tip(label, h('span', { className: 'dcs-tip-anchor' }, control))

    // --------------------------------------------------------------- parts

    /**
     * The drilled pane of one server: its tools as filter checkboxes. It
     * replaces the server list inside the same card, like the model menu's
     * second level, and `<` returns to the list.
     */
    function ToolPane({ server, t, apply, busy, locked, error, onBack }) {
      const [query, setQuery] = useState('')
      const needle = query.trim().toLowerCase()
      const shown = needle === ''
        ? server.tools
        : server.tools.filter((tool) => tool.short.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle))
      const kept = server.tools.filter((tool) => tool.kept).map((tool) => tool.name)
      const post = (allow) => apply({ filter: { server: server.serverName, allow } })
      const setMany = (names, on) => {
        const next = new Set(kept)
        for (const toolName of names) {
          if (on) next.add(toolName)
          else next.delete(toolName)
        }
        post([...next].sort())
      }
      return h(React.Fragment, null,
        h('div', { className: 'dcs-head' },
          tip(t('back'), h('button', { type: 'button', className: 'dcs-back', 'aria-label': t('back'), onClick: onBack },
            h(IconChevronLeftOutlineRegular, null))),
          h('span', { className: 'dcs-name' }, server.serverName),
          tip(t('toolsKept', { kept: kept.length, total: server.tools.length }), h('span', { className: 'dcs-trigger-num' },
            '(' + kept.length + '/' + server.tools.length + ')')),
        ),
        h('div', { className: 'dcs-divider', role: 'separator' }),
        h('div', { className: 'dcs-search' },
          h(Input, {
            icon: h(IconSearchOutlineRegular, null),
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
        server.filterSource !== null
          ? h('div', { className: 'dcs-note dcs-search-note' }, t(server.filterSource === 'workspace' ? 'filterWorkspace' : 'filterConfig'))
          : null,
        h('div', { className: 'dcs-body dcs-tools-list' + (busy ? ' dcs-busy' : '') },
          shown.map((tool) => h(React.Fragment, { key: tool.name }, tip(tool.description || tool.short, h('div', { className: 'dcs-tool' },
            h(Checkbox, {
              checked: tool.kept,
              disabled: locked,
              label: tool.short,
              onChange: (next) => setMany([tool.name], next),
            }),
          ), { maxWidth: 320 }))),
        ),
        h('div', { className: 'dcs-foot' },
          h('div', { className: 'dcs-foot-actions' },
            h(Button, { size: 'sm', disabled: busy || locked, onClick: () => setMany(shown.map((tool) => tool.name), true) }, t('selectAll')),
            h(Button, { size: 'sm', disabled: busy || locked, onClick: () => setMany(shown.map((tool) => tool.name), false) }, t('selectNone')),
            h(Button, { size: 'sm', disabled: busy || locked || server.filterSource !== 'workspace', onClick: () => post(null) }, t('resetFilter')),
          ),
          locked ? h('div', { className: 'dcs-note dcs-note-locked' }, t('lockedMcp')) : null,
          error ? h('div', { className: 'dcs-note dcs-note-error' }, error) : null,
        ),
      )
    }

    function ServerRow({ server, t, apply, locked, onDrill }) {
      const keptCount = server.tools.filter((tool) => tool.kept).length
      const total = server.tools.length
      const usable = server.state === 'connected'
      // One line per server: the kept/total count, or the state when the
      // server cannot serve tools, follows the origin tag in parentheses.
      const detail = usable ? keptCount + '/' + total : t(STATE_KEY[server.state] || 'stateUnmounted')
      const canSwitch = !locked && (server.enabled || server.on)
      return h('div', { className: 'dcs-row' },
        total > 0
          ? tip(t('expand'), h('button', {
              type: 'button', className: 'dcs-expander',
              'aria-label': t('expand'),
              onClick: onDrill,
            }, h(IconChevronRightOutlineRegular, null)))
          : h('span', { className: 'dcs-expander', 'aria-hidden': 'true' }),
        h('div', { className: 'dcs-row-main' },
          h('div', { className: 'dcs-row-title' },
            h(StateDot, { state: STATE_DOT[server.state] || 'idle', size: 8 }),
            h('span', { className: 'dcs-name' + (server.on ? '' : ' dcs-name-off') }, server.serverName),
            h(Tag, { tone: server.origin === 'preset' ? 'info' : 'neutral' }, t(ORIGIN_KEY[server.origin] || 'originInferred')),
            tip(usable ? t('toolsKept', { kept: keptCount, total }) : undefined, h('span', {
              className: 'dcs-count' + (usable || !server.enabled ? '' : ' dcs-sub-warn'),
            }, '(' + detail + ')')),
          ),
        ),
        tipControl(locked ? t('lockedMcp') : canSwitch ? t('switchServer', { name: server.serverName }) : t('disabledRow'), h(Switch, {
          checked: server.on && server.enabled,
          disabled: !canSwitch,
          label: t('switchServer', { name: server.serverName }),
          onChange: (next) => apply({ toggleServer: { name: server.serverName, on: next } }),
        })),
      )
    }

    // Three lines: name, description, and the folder it was loaded from (none
    // for a runtime skill). Both lower lines truncate; the bubble has them whole.
    function SkillRow({ skill, t, apply, locked }) {
      const whole = [skill.description, skill.path].filter(Boolean).join('\n')
      return tip(whole, h('div', { className: 'dcs-row' },
        h('div', { className: 'dcs-row-main' },
          h('div', { className: 'dcs-row-title' },
            h('span', { className: 'dcs-name' + (skill.on ? '' : ' dcs-name-off') }, skill.name),
            skill.source ? h(Tag, { tone: 'neutral' }, skill.source) : null,
          ),
          skill.description ? h('span', { className: 'dcs-sub' }, skill.description) : null,
          skill.path ? h('span', { className: 'dcs-sub dcs-path' }, skill.path) : null,
        ),
        tipControl(locked ? t('lockedSkill') : t('switchSkill', { name: skill.name }), h(Switch, {
          checked: skill.on,
          disabled: locked,
          label: t('switchSkill', { name: skill.name }),
          onChange: (next) => apply({ toggleSkill: { name: skill.name, on: next } }),
        })),
      ), { maxWidth: 360 })
    }

    function Panel({ view, t, kind, apply, busy, error, panelRef, style }) {
      // The server whose tools are drilled into; null shows the list.
      const [drilled, setDrilled] = useState(null)
      const [query, setQuery] = useState('')
      const mcp = view.mcp
      const drilledServer = drilled === null ? undefined : mcp.servers.find((server) => server.serverName === drilled)
      // Escape backs out of the drilled pane first; the trigger's own Escape
      // handler closes the panel from the list.
      useEffect(() => {
        if (drilledServer === undefined) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopImmediatePropagation()
          setDrilled(null)
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [drilledServer])
      const skills = view.skills
      const locked = view.locked === true
      const counts = kind === 'mcp' ? mcp.counts : skills.counts
      // 13 rows fit without a filter; longer lists get one under the divider.
      const filterable = (kind === 'mcp' ? mcp.servers.length : skills.items.length) > LIST_FILTER_AT
      const needle = filterable ? query.trim().toLowerCase() : ''
      const match = (...values) => needle === ''
        || values.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
      const shownServers = mcp.servers.filter((server) => match(server.serverName))
      const shownSkills = skills.items.filter((skill) => match(skill.name, skill.description, skill.path, skill.source))
      // The footer acts on what the filter shows, like the tool pane's buttons.
      const shownServerNames = new Set(shownServers.map((server) => server.serverName))
      const enabledShownServers = shownServers.filter((server) => server.enabled).map((server) => server.serverName)
      const shownSkillNames = new Set(shownSkills.map((skill) => skill.name))
      const offServers = mcp.servers.filter((server) => !server.on).map((server) => server.serverName)
      const offSkills = skills.items.filter((skill) => !skill.on).map((skill) => skill.name)
      const turnOn = (off, shown) => off.filter((name) => !shown.has(name)).sort()
      const turnOff = (off, add) => [...new Set([...off, ...add])].sort()
      const actions = kind === 'mcp'
        ? [
            [t('allOn'), { mcpOff: turnOn(offServers, shownServerNames) }],
            [t('allOff'), { mcpOff: turnOff(offServers, enabledShownServers) }],
            [t('resetDefault'), { mcpOff: null }],
          ]
        : [
            [t('allOn'), { skillsOff: turnOn(offSkills, shownSkillNames) }],
            [t('allOff'), { skillsOff: turnOff(offSkills, shownSkillNames) }],
            [t('resetDefault'), { skillsOff: null }],
          ]

      const card = (children) => h('div', {
        ref: panelRef, className: 'dcs-panel', role: 'dialog', 'aria-label': t(kind === 'mcp' ? 'mcpTitle' : 'skillTitle'), style,
      }, children)

      if (kind === 'mcp' && drilledServer !== undefined) {
        return card(h(ToolPane, { server: drilledServer, t, apply, busy, locked, error, onBack: () => setDrilled(null) }))
      }

      return card(h(React.Fragment, null,
        h('div', { className: 'dcs-head' },
          h('span', null, t(kind === 'mcp' ? 'mcp' : 'skill')),
          h('span', { className: 'dcs-trigger-num' }, counts.on + '/' + counts.total),
        ),
        h('div', { className: 'dcs-divider', role: 'separator' }),
        filterable
          ? h('div', { className: 'dcs-search' },
              h(Input, {
                icon: h(IconSearchOutlineRegular, null),
                placeholder: t(kind === 'mcp' ? 'filterMcp' : 'filterSkill'),
                value: query,
                onChange: (event) => setQuery(event.target.value),
              }))
          : null,
        h('div', { className: 'dcs-body' + (busy ? ' dcs-busy' : '') },
          kind === 'mcp'
            ? (mcp.servers.length === 0
                ? h('div', { className: 'dcs-empty' }, t('noServers'))
                : shownServers.length === 0
                  ? h('div', { className: 'dcs-empty' }, t('noMatches'))
                  : shownServers.map((server) => h(ServerRow, {
                      key: server.serverName, server, t, apply, locked,
                      onDrill: () => setDrilled(server.serverName),
                    })))
            : (!skills.available
                ? h('div', { className: 'dcs-empty' }, t('skillsUnavailable'))
                : skills.items.length === 0
                  ? h('div', { className: 'dcs-empty' }, t('noSkills'))
                  : shownSkills.length === 0
                    ? h('div', { className: 'dcs-empty' }, t('noMatches'))
                    : shownSkills.map((skill) => h(SkillRow, { key: skill.name, skill, t, apply, locked }))),
        ),
        h('div', { className: 'dcs-foot' },
          h('div', { className: 'dcs-foot-actions' },
            actions.map(([label, body]) => h(Button, { key: label, size: 'sm', disabled: busy || locked, onClick: () => apply(body) }, label)),
          ),
          locked ? h('div', { className: 'dcs-note dcs-note-locked' }, t(kind === 'mcp' ? 'lockedMcp' : 'lockedSkill')) : null,
          // Shown only when the host refuses a change, so a failed switch is not silent.
          error ? h('div', { className: 'dcs-note dcs-note-error' }, error) : null,
        ),
      ))
    }

    let warnedMissingSessionId = false

    function CapabilityScope(props) {
      const t = props.t || ((key) => key)
      const sessionId = props.sessionId || (props.session && props.session.id) || null
      if (!sessionId && !warnedMissingSessionId) {
        warnedMissingSessionId = true
        console.warn('[dsh-capability-scope] no sessionId in slot props', Object.keys(props))
      }
      const [view, setView] = useState(null)
      // Which panel is open: null, 'mcp', or 'skills'.
      const [open, setOpen] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const rootRef = useRef(null)
      const mcpRef = useRef(null)
      const skillRef = useRef(null)
      const panelRef = useRef(null)
      const latest = useRef(0)

      const refresh = useCallback(async () => {
        if (!sessionId) return
        const at = ++latest.current
        try {
          const next = await request(API + '/session?id=' + encodeURIComponent(sessionId))
          if (at === latest.current) setView(next)
        } catch {
          // The host half may not be installed; render nothing.
          if (at === latest.current) setView(null)
        }
      }, [sessionId])

      const post = useCallback(async (body) => {
        if (!sessionId) return
        const at = ++latest.current
        setBusy(true)
        setError(null)
        try {
          const next = await request(API + '/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({ id: sessionId }, body)),
          })
          if (at === latest.current) setView(next)
        } catch (e) {
          if (at === latest.current) setError(String(e.message || e))
        } finally {
          if (at === latest.current) setBusy(false)
        }
      }, [sessionId])

      // Row switches post the whole resulting off list, computed from the view.
      const apply = useCallback((body) => {
        if (view === null || !view.live || view.locked === true) return
        if (body.toggleServer) {
          const off = new Set(view.mcp.servers.filter((server) => !server.on).map((server) => server.serverName))
          if (body.toggleServer.on) off.delete(body.toggleServer.name)
          else off.add(body.toggleServer.name)
          return post({ mcpOff: [...off].sort() })
        }
        if (body.toggleSkill) {
          const off = new Set(view.skills.items.filter((skill) => !skill.on).map((skill) => skill.name))
          if (body.toggleSkill.on) off.delete(body.toggleSkill.name)
          else off.add(body.toggleSkill.name)
          return post({ skillsOff: [...off].sort() })
        }
        return post(body)
      }, [view, post])

      useEffect(() => {
        refresh()
        const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
        const timer = setInterval(onVisible, POLL_MS)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [refresh])

      // While the session's agent is not live yet — a restored default session
      // at startup, or a host half still mounting — every answered read swaps
      // `view` for a fresh object, re-arming this effect; once live, the slow
      // poll above carries on alone.
      useEffect(() => {
        if (view !== null && view.live) return undefined
        const timer = setTimeout(refresh, PENDING_RETRY_MS)
        return () => clearTimeout(timer)
      }, [view, refresh])

      // A preset switch recomposes the agent, so its servers and skills change,
      // and the new preset's MCP servers take seconds to connect. The session
      // projection announces the switch; re-read then and while they come up.
      const agentPreset = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined
      const seenPreset = useRef(agentPreset)
      useEffect(() => {
        if (seenPreset.current === agentPreset) return undefined
        seenPreset.current = agentPreset
        refresh()
        const timers = [1500, 4000, 10000].map((ms) => setTimeout(refresh, ms))
        return () => timers.forEach(clearTimeout)
      }, [agentPreset, refresh])

      const close = useCallback(() => setOpen(null), [])
      const dismiss = useCallback((next) => { if (!next) setOpen(null) }, [])
      useDismissOnOutsidePointer(rootRef, open !== null, dismiss, panelRef)
      const position = useAnchoredPosition({
        open: open !== null,
        anchorRef: open === 'skills' ? skillRef : mcpRef,
        panelRef, side: 'top', align: 'start', gap: 6, margin: 8,
      })
      useEffect(() => {
        if (open === null) return undefined
        const onKey = (event) => { if (event.key === 'Escape') close() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, close])

      if (view === null || !view.live) return null

      const toggle = (kind) => {
        if (open === kind) {
          setOpen(null)
          return
        }
        refresh()
        setError(null)
        setOpen(kind)
      }

      // Same bubble as the composer's "+": above, after 500ms, in place (the
      // composer row is not inside the panel), and quiet while a panel is open.
      const trigger = (kind, ref, label, counts, title) => tip(title,
        h('button', {
          ref,
          type: 'button',
          className: 'dcs-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open === kind ? 'true' : 'false',
          onClick: () => toggle(kind),
        },
          h('span', null, label),
          h('span', { className: 'dcs-trigger-num' }, counts.on + '/' + counts.total),
          h('span', { className: 'dcs-chevron' + (open === kind ? ' dcs-chevron-open' : ''), 'aria-hidden': 'true' },
            h(IconChevronDownOutlineRegular, null)),
        ), { portal: false, disabled: open !== null })

      return h('div', { ref: rootRef, className: 'dcs-triggers' },
        trigger('mcp', mcpRef, t('mcp'), view.mcp.counts, t('mcpTitle')),
        view.skills.available ? trigger('skills', skillRef, t('skill'), view.skills.counts, t('skillTitle')) : null,
        open !== null
          ? createPortal(h(Panel, {
              // Keyed by kind so switching panels starts on the list pane.
              key: open,
              view, t, kind: open, apply, busy, error, panelRef,
              // Hidden until measured, so the panel never flashes at 0,0.
              style: position === null ? { visibility: 'hidden', left: 0, top: 0 } : position,
            }), document.body)
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(installStyle, 'dsh-capability-scope: styles')
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-capability-scope: dictionaries')
          ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
            name: 'conversation.input.left',
            id: 'capability-scope',
            order: 0,
            locale: NS,
          }, CapabilityScope))
        } catch (e) {
          console.error('[dsh-capability-scope] apply failed:', e)
        }
      },
    }
  },
})
