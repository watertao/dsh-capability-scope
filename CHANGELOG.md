# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.3] - 2026-11-22

### Fixed

- The composer triggers disappeared on DSH 0.2.2: the browser half positioned
  its panel with `useAnchoredPosition`, which the platform removed when it moved
  floating panels to CSS anchors, so the slot component threw on its first
  render and its entry retired from the composer row. The panel now positions
  itself with `anchor-name` / `position-anchor` / `anchor()`, plus
  `@position-try` fallbacks that flip it below the trigger near the top of the
  window and pin it to both margins when the window is too narrow. No platform
  JavaScript positioning API is used any more, so the bundle keeps working on
  the versions that still have the old hook.

## [1.0.2] - 2026-10-26

### Fixed

- The directory preset is no longer selected while the host is still creating
  the session, which could switch the preset too early.

## [1.0.1] - 2026-10-23

### Fixed

- A session restored from disk with no running agent no longer shows the `MCP`
  and `Skill` loading placeholders forever. After an 8-second grace the
  placeholders are hidden and the retry slows from every 2 seconds to every 6,
  so the triggers still come back within seconds once a message resumes the
  agent.

## [1.0.0] - 2026-10-23

First public release.

### Added

- Composer buttons `MCP n/m` and `Skill n/m` with per-session panels.
- MCP server switches covering profile and agent-preset servers; hidden tools are
  restricted and guarded, and the server's prompt sections are removed.
- Per-server MCP tool filter, falling back to the row's `toolFilter`.
- Skill switches through session-scoped shadow skills, with the `/` menu refreshed
  on change.
- Per-workspace memory of switches, tool filters, and the last selected preset.
- `rules`, `defaultOff`, `remember`, `locked`, `enforceGuard`, `memoryPath`, and
  `echoToConsole` configuration.
- Bundle patch for `dsh plugin add`, Plugin Manager title, description, and icon.

### Changed

- While a session's agent is still resuming, the composer shows greyed-out
  `MCP` and `Skill` placeholders with a loading spinner instead of nothing, so
  the row no longer jumps when the counts arrive.

[1.0.3]: https://github.com/watertao/dsh-capability-scope/releases/tag/v1.0.3
[1.0.2]: https://github.com/watertao/dsh-capability-scope/releases/tag/v1.0.2
[1.0.1]: https://github.com/watertao/dsh-capability-scope/releases/tag/v1.0.1
[1.0.0]: https://github.com/watertao/dsh-capability-scope/releases/tag/v1.0.0
