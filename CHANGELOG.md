# Changelog

## [Unreleased]

### Changed

- Changed the default fullscreen shortcut to `Alt+Shift+M` so it no longer conflicts with pi-interactive-shell's focus shortcut.

## [0.2.0] - 2026-08-23

### Highlights

- Open side chat in fullscreen when you need more room.
- Switch between read-only and edit mode reliably on current pi versions.
- Ask side questions while the main agent is busy without the side chat taking over the main task.

### Added

- Added configurable fullscreen toggling for the side-chat overlay. Thanks to [@johnrichardrinehart](https://github.com/johnrichardrinehart) for PR #3.

### Fixed

- Fixed Ctrl+T edit-mode toggling on current pi versions. Thanks to [@johnrichardrinehart](https://github.com/johnrichardrinehart) for PR #2.
- Fixed side chats opened during main-agent tool calls so copied main context is treated as background context, not as the side chat's own task. Thanks to [@yceachan](https://github.com/yceachan) for issue #5 and the PR #8 design.

## [0.1.4] - 2026-04-15

- Fixed npm packaging so pi installs the extension source files correctly
- Added pi package manifest metadata and corrected preview video metadata
- Switched local TypeScript imports to `.ts` specifiers for source-based loading

## [0.1.3] - 2026-03-15

- Added demo video to README and package.json

## [0.1.2] - 2026-03-15

- Updated README docs to match current behavior

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
