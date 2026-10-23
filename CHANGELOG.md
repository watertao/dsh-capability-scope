# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/watertao/dsh-capability-scope/releases/tag/v1.0.0
