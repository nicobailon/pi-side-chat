# Changelog

## [Unreleased]

### btw aside-session self-cognition — prompt, context & tool harness (#5)

The btw side chat stays on its own lane: it never continues the main session's work, even when the fork happens while the main agent is mid-tool-call or mid-reasoning.

**Prompt — prompt pack** — all injected prompt text moved out of code into a multi-file prompt pack (`prompts/` directory + `config.json` `promptPack` manifest; per-key md paths relative to the extension dir or absolute; fresh read at every fork; per-key fallback to the bundled default with a notify).

- **framing block** — btw identity + "the cited context is reference only" + focus instruction (template vars `{{cwd}}`/`{{model}}`), injected after the cite as a marked user-role message (never rendered as a chat bubble)
- **per-turn focus anchor** — "answer only the latest user message in this btw conversation; the cited context's tool calls and answers were performed by the main agent, not you"
- **lane reminders** — base / escalated / failed-note / preamble (`{{tool}}`/`{{count}}`), injected only in the read-only lane

**Context — shared-prefix layout + fork surgery** — the main lane's system prompt stays in the system slot and the fork snapshot is injected verbatim, so the btw request head is a token prefix of the main request (gateway prefix-cache hits; `cacheRead` ≈ 1/50 of input price).

- fork surgery makes the trailing tool exchange gateway-legal: dangling `tool_calls` get one synthesized `toolResult` each (`[forked mid-execution — the main lane was still running this tool call when the btw side chat opened]`), orphan toolResults are dropped, real landed results are never touched
- S5 carry-cut: a trailing run of user messages is cut entirely, and the user message that triggered the trailing tool exchange is cut with it — the cite never ends on a user message (reverses the old S4 keep; the 2026-08-13 export showed the model answering the main lane's trailing question instead of the btw message). Shared-prefix caching is unaffected: the btw request stays a token prefix of the main request
- injected context renders as one collapsed `[Context] N msgs` cite line (UI-only; the LLM context is unchanged)

**Tool harness — lane enforcement** — the read-only lane strips the tool list to builtin read tools + the `config.json` `readOnlyExtensionAllowlist` + `peek_main` (absent tools surface as "not found" — the violation signal).

- `beforeToolCall` hard-blocks out-of-lane tools with the base reminder as the reason; `afterToolCall` re-grounds executed-but-failed read-only calls
- 1st violation → base reminder; 2nd → escalated wording + turn abort; `🚧 lane blocked` status line
- edit mode (Ctrl+T) stays untouched

### UI polish

- `Alt+Q` backgrounds the side chat without interrupting its running agent; `Alt+Q` in the main session restores it
- `PgUp`/`PgDn` scroll the history by a page; `Shift+↑`/`Shift+↓` scroll by a few lines; mouse wheel scrolls over the chat (SGR mouse reporting, consumed so it never leaks into the editor)
- Scroll-follow freeze: while streaming, the viewport follows the bottom until the user scrolls away, then freezes content-anchored (new streamed lines grow the scroll offset instead of sliding the visible content); following resumes on scroll-to-bottom or a new message
- Chat area is ~2.5x taller and adapts to small terminals; `[↑N]` scroll indicator in the header; key-hint bar wraps onto a second line on narrow terminals so no hint is clipped
- New `/btw` command alias for `/side`
- `Alt+E` exports the btw transcript to `$CWD/.agents/eval/pi-side-chat-<timestamp>.md` as a markdown diagnostic artifact (forked context, framing block, conversation, in-flight stream; git-ignored)
- Fixed Ctrl+T mode toggle (`agent.state.tools`) and `peek_main` tool-call display for the current pi API

### Dev

- Added MIT `LICENSE` retaining the original author's copyright with modifier attribution
- Added `tsconfig.json` (mirrors pi's extension-loader module aliases) and `npm run typecheck` so the extension typechecks in-tree
- Declared `@earendil-works/*` 0.74.0, `typebox` and `typescript` as devDependencies for the dev workspace

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
