# Changelog

## [0.1.1] - 2026-03-14

- Extension tools (web_search, fetch_content, etc.) now available in side chat
- Animated spinner while waiting for response
- Escape interrupts streaming; closes when idle
- Reopening restores the previous side chat conversation
- Alt+R re-forks from latest main context; Alt+N starts empty
- Fixed footer hints clipped by overlay height

## [0.1.0] - 2026-03-12

Initial release.

- Fork current conversation into a temporary side chat overlay
- Read-only mode by default, toggle to edit mode with Ctrl+T
- `peek_main` tool to view main agent's recent activity
- File overlap warnings when side chat tries to modify files main has touched
- Keyboard shortcuts: Alt+/ to open/toggle focus, Esc to close
- Bash write path detection for overlap warnings
