import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import type { OverlayOptions } from "@mariozechner/pi-tui";
import sideChatExtension from "../index.ts";

test("extension updates the live overlay options object in place", async () => {
  const commands = new Map<string, { handler: (args: string, context: unknown) => unknown }>();
  const shortcuts = new Map<string, { handler: (context: unknown) => unknown }>();
  let focusCalls = 0;
  let unfocusCalls = 0;

  const pi = {
    on: () => {},
    getThinkingLevel: () => "off",
    registerCommand: (name: string, definition: unknown) => {
      commands.set(name, definition as { handler: (args: string, context: unknown) => unknown });
    },
    registerShortcut: (name: string, definition: unknown) => {
      shortcuts.set(name, definition as { handler: (context: unknown) => unknown });
    },
  };

  sideChatExtension(pi as never);

  const command = commands.get("side");
  const fullscreenShortcut = shortcuts.get("alt+shift+m");
  assert.ok(command);
  assert.ok(fullscreenShortcut);

  const model = {
    id: "test",
    name: "test",
    api: "openai-completions",
    provider: "test",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  const sessionManager = {
    getEntries: () => [],
    getLeafId: () => null,
  };
  const tui = {
    terminal: { rows: 40, columns: 120 },
    hasOverlay: () => false,
    requestRender: () => {},
  };
  const theme = { fg: (_color: string, text: string) => text };
  const handle = {
    focus: () => { focusCalls++; },
    unfocus: () => { unfocusCalls++; },
    isFocused: () => true,
  };

  const context = {
    model,
    cwd: "/tmp",
    getSystemPrompt: () => "test",
    modelRegistry: { getApiKeyForProvider: async () => "test" },
    sessionManager,
    ui: {
      notify: () => {},
      confirm: async () => true,
      custom: async (
        factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: string) => void) => {
          handleInput: (data: string) => void;
          dispose: () => void;
        },
        options: { overlayOptions: OverlayOptions; onHandle: (overlayHandle: unknown) => void },
      ) => {
        const originalOptions = options.overlayOptions;
        let completed = false;
        const overlay = factory(tui, theme, {}, () => { completed = true; });
        options.onHandle(handle);

        assert.deepEqual(originalOptions, {
          width: "85%",
          maxHeight: "35%",
          anchor: "top-center",
          margin: { top: 1, left: 2, right: 2 },
          nonCapturing: true,
        });

        overlay.handleInput("\x1b[77;4u");
        assert.equal(options.overlayOptions, originalOptions);
        assert.deepEqual(originalOptions, {
          width: "100%",
          maxHeight: "100%",
          anchor: "top-left",
          margin: 0,
          nonCapturing: true,
        });

        fullscreenShortcut.handler(context);
        assert.equal(options.overlayOptions, originalOptions);
        assert.deepEqual(originalOptions, {
          width: "85%",
          maxHeight: "35%",
          anchor: "top-center",
          margin: { top: 1, left: 2, right: 2 },
          nonCapturing: true,
        });
        assert.equal(focusCalls, 1);
        assert.equal(unfocusCalls, 0);

        overlay.dispose();
        assert.equal(completed, true);
        return "close";
      },
    },
  };

  await command.handler("", context);
});

test("loads shortcuts from the agent dir config before the module-local config", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-side-chat-test-"));
  writeFileSync(
    join(agentDir, "pi-side-chat.json"),
    JSON.stringify({ shortcut: "ctrl+\\", fullscreenShortcut: "ctrl+space" }),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const shortcuts = new Map<string, unknown>();
    const pi = {
      on: () => {},
      getThinkingLevel: () => "off",
      registerCommand: () => {},
      registerShortcut: (name: string, definition: unknown) => {
        shortcuts.set(name, definition);
      },
    };

    sideChatExtension(pi as never);

    assert.ok(shortcuts.has("ctrl+\\"));
    assert.ok(shortcuts.has("ctrl+space"));
    assert.equal(shortcuts.has("alt+/"), false);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    rmSync(agentDir, { recursive: true, force: true });
  }
});
