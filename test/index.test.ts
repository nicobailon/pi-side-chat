import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import type { OverlayOptions } from "@mariozechner/pi-tui";
import sideChatExtension from "../index.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-side-chat-test-"));

const TEST_MODEL = {
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
const TEST_THEME = { fg: (_color: string, text: string) => text };

test.before(() => {
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
});

test.after(() => {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  rmSync(testAgentDir, { recursive: true, force: true });
});

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
  assert.ok(shortcuts.get("alt+/"));
  assert.ok(fullscreenShortcut);

  const sessionManager = {
    getEntries: () => [],
    getLeafId: () => null,
  };
  const tui = {
    terminal: { rows: 40, columns: 120 },
    hasOverlay: () => false,
    requestRender: () => {},
  };
  const handle = {
    focus: () => { focusCalls++; },
    unfocus: () => { unfocusCalls++; },
    isFocused: () => true,
  };

  const context = {
    model: TEST_MODEL,
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
        const overlay = factory(tui, TEST_THEME, {}, () => { completed = true; });
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

test("loads custom shortcuts from the agent dir config", () => {
  writeFileSync(
    join(testAgentDir, "pi-side-chat.json"),
    JSON.stringify({ shortcut: "ctrl+\\", fullscreenShortcut: "ctrl+space" }),
  );

  const shortcuts = new Map<string, unknown>();
  const pi = {
    on: () => {},
    registerCommand: () => {},
    registerShortcut: (name: string, definition: unknown) => {
      shortcuts.set(name, definition);
    },
  };

  sideChatExtension(pi as never);

  assert.ok(shortcuts.has("ctrl+\\"));
  assert.ok(shortcuts.has("ctrl+space"));
  assert.equal(shortcuts.has("alt+/"), false);
  assert.equal(shortcuts.has("alt+shift+m"), false);
});

type TestOverlay = {
  focused: boolean;
  handleInput: (data: string) => void;
  render: (width: number) => string[];
  dispose: () => void;
  ownsOverlayFocusTarget?: (component: unknown) => boolean;
};
type Focusable = { focused: boolean; handleInput: (data: string) => void };
type CustomOverlay = (
  factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: string) => void) => TestOverlay,
  options: { onHandle: (overlayHandle: unknown) => void },
) => Promise<string>;

// Kitty keyboard protocol encoding of alt+/.
const ALT_SLASH = "\x1b[47;3u";

function createMainEditor(text: string) {
  return {
    focused: false,
    text,
    handleInput(data: string) { this.text += data; },
  };
}

function registerExtension() {
  // Use default shortcuts regardless of config written by earlier tests.
  rmSync(join(testAgentDir, "pi-side-chat.json"), { force: true });
  const commands = new Map<string, { handler: (args: string, context: unknown) => unknown }>();
  const shortcuts = new Map<string, { handler: (context: unknown) => unknown }>();
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
  const toggleShortcut = shortcuts.get("alt+/");
  assert.ok(command);
  assert.ok(toggleShortcut);
  return { command, toggleShortcut };
}

function createContext(custom: CustomOverlay) {
  return {
    model: TEST_MODEL,
    cwd: "/tmp",
    getSystemPrompt: () => "test",
    modelRegistry: { getApiKeyForProvider: async () => "test" },
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    ui: { notify: () => {}, confirm: async () => true, custom },
  };
}

test("Pi overlay handles keep owning focus even when the TUI exposes focus accessors", async () => {
  const { command, toggleShortcut } = registerExtension();
  let handleFocused = false;
  const tui = {
    terminal: { rows: 40, columns: 120 },
    hasOverlay: () => false,
    requestRender: () => {},
    getFocused: () => null,
    setFocus: () => assert.fail("Pi overlay handles must not route focus through the TUI"),
  };
  const handle = {
    focus: () => { handleFocused = true; },
    unfocus: () => { handleFocused = false; },
    isFocused: () => handleFocused,
  };

  const context = createContext(async (factory, options) => {
    const overlay = factory(tui, TEST_THEME, {}, () => {});
    options.onHandle(handle);
    assert.equal(handleFocused, true);
    assert.equal(overlay.ownsOverlayFocusTarget, undefined);

    await toggleShortcut.handler(context);
    assert.equal(handleFocused, false);
    await toggleShortcut.handler(context);
    assert.equal(handleFocused, true);
    overlay.handleInput(ALT_SLASH);
    assert.equal(handleFocused, false);

    overlay.dispose();
    return "close";
  });

  await command.handler("", context);
});

test("OMP-style hosts route focus through the TUI back to the original parent and keep both drafts", async () => {
  const { command, toggleShortcut } = registerExtension();
  const mainEditor = createMainEditor("main draft");
  let focused: Focusable | null = null;
  let visibleOverlay: TestOverlay | undefined;
  const moveFocus = (component: Focusable | null) => {
    if (focused) focused.focused = false;
    focused = component;
    if (component) component.focused = true;
  };
  moveFocus(mainEditor);
  const tui = {
    terminal: { rows: 40, columns: 120 },
    hasOverlay: () => false,
    requestRender: () => {},
    getFocused: () => focused,
    // Mirrors OMP: while an overlay is visible, focus may only move to the overlay
    // or to a target the overlay claims through ownsOverlayFocusTarget.
    setFocus: (component: Focusable | null) => {
      if (visibleOverlay && component !== visibleOverlay && !visibleOverlay.ownsOverlayFocusTarget?.(component)) return;
      moveFocus(component);
    },
  };
  const type = (data: string) => focused?.handleInput(data);
  const sideText = (overlay: TestOverlay) => overlay.render(100).join("\n");

  const context = createContext(async (factory, options) => {
    const overlay = factory(tui, TEST_THEME, {}, () => {});
    visibleOverlay = overlay;
    // Another component takes focus between overlay creation and the handle callback.
    moveFocus(createMainEditor("interloper"));
    options.onHandle({});
    assert.equal(focused, overlay);

    type("side draft");
    await toggleShortcut.handler(context);
    assert.equal(focused, mainEditor);
    type(" main more");
    await toggleShortcut.handler(context);
    assert.equal(focused, overlay);
    type(" side more");
    assert.match(sideText(overlay), /side draft side more/);
    assert.doesNotMatch(sideText(overlay), /main more/);
    assert.equal(mainEditor.text, "main draft main more");

    // The overlay's own shortcut unfocuses through the same TUI route.
    type(ALT_SLASH);
    assert.equal(focused, mainEditor);

    overlay.dispose();
    return "close";
  });

  await command.handler("", context);
});
