<p>
  <img src="banner.png" alt="pi-side-chat" width="1100">
</p>

# pi-side-chat

A Pi extension that forks the current conversation into a temporary side chat while the main agent keeps working.

```typescript
/side
```

Open the overlay, ask a quick question, close it, and go back to what the main agent was already doing.

## Why

This exists for the annoying in-between moments. You're in the middle of a longer task and want to ask something small without derailing the main thread: check an API detail, sanity-check an approach, inspect recent progress, or make a tiny edit off to the side.

Without a side chat, you either interrupt the main agent, open a completely separate Pi session with no context, or context-switch out to the browser. None of those feel great.

`pi-side-chat` gives you a fork of the current conversation in an overlay. It starts with the same context, stays separate from the main thread, and disappears when you're done.

## Install

The extension lives in `/Users/nicobailon/.pi/agent/extensions/pi-side-chat`.

Restart Pi and it will be auto-discovered.

## Quick Start

Open side chat with `Alt+/` or `/side`.

Ask a question and press `Enter`.

Press `Esc` to close it.

**Toggle focus**: Press `Alt+/` again to switch back to the main editor without closing the overlay. The side chat stays visible but unfocused. Press `Alt+/` once more to refocus it.

**Toggle mode**: Press `Ctrl+T` to switch from read-only mode to edit mode if you need write access.

## What it does

### Forks the current conversation

The overlay starts with a copy of the current branch context, so the side agent already knows what you've been working on. It does not write anything back into the main conversation history.

### Starts in read-only mode

The safe default is read-only. That makes it useful for quick questions, code reading, and checking progress without risking accidental edits.

Press `Ctrl+T` to switch between:
- **read-only mode** — safe for quick questions and code reading
- **edit mode** — enables write, edit, and bash tools

The header shows the current mode (`[Read-only]` or `[Edit]`), and the footer shows what `Ctrl+T` will do next.

### Warns on file overlap

If the side chat tries to modify a file that the main agent has already touched, it asks before proceeding.

```text
File Overlap

Main agent has modified:
  src/api/handler.ts

Editing may cause conflicts. Proceed?
```

It does not block automatically. It just makes the conflict explicit.

### Can peek at the main agent

The side agent gets a `peek_main` tool for reading recent activity from the main session.

Useful prompts:

```text
What is the main agent doing right now?
What changed since I opened this side chat?
Show me the last 10 things main did.
```

### Stays out of the way

The overlay is non-capturing, so you can leave it visible and switch focus back to the main editor.

It opens near the top of the screen so the main editor stays visible underneath.

## Controls

| Key | Action |
|-----|--------|
| `Alt+/` | Open side chat. When already open, toggles focus between side chat and main editor. |
| `Enter` | Send message |
| `Esc` | Close side chat |
| `Ctrl+T` | Toggle between read-only mode and edit mode (enables write/edit/bash) |
| `PgUp` / `Shift+↑` | Scroll up |
| `PgDn` / `Shift+↓` | Scroll down |

## Command reference

### `/side`

Opens the side chat overlay.

### `peek_main`

Available to the side agent only.

Parameters:

| Param | Type | Description |
|------|------|-------------|
| `lines` | integer | Max number of recent items to inspect, default `20`, max `50` |
| `since_fork` | boolean | If `true`, only show activity after the side chat was opened |

## Configuration

Create `/Users/nicobailon/.pi/agent/extensions/pi-side-chat/config.json` if you want a different shortcut.

```json
{
  "shortcut": "alt+/"
}
```

## How it works

When you open side chat, the extension clones the current session context, creates a separate agent instance, and renders it in a TUI overlay. The main agent keeps running on its own branch.

The extension also listens for main-agent tool execution events and keeps a small in-memory set of paths that have been written. When side chat is in edit mode, its write-capable tools are wrapped so they can warn before touching one of those paths.

`peek_main` reads the current session branch on demand, formats the recent messages, and returns a compact summary back to the side agent.

## File layout

```text
pi-side-chat/
├── index.ts
├── side-chat-overlay.ts
├── side-chat-messages.ts
├── file-activity-tracker.ts
├── tool-wrapper.ts
├── banner.png
└── README.md
```

## Limitations

- Only one side chat can be open at a time.
- Side chat will not open on top of another visible overlay.
- The conversation is ephemeral. Closing the overlay discards it.
- Side chat does not merge messages back into the main thread.
- Bash overlap detection is heuristic. It catches common write cases, not every possible shell write.
- `peek_main` is on-demand, not a live streaming view.
