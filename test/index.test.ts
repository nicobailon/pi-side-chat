import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import type { OverlayOptions } from "@mariozechner/pi-tui";
import sideChatExtension from "../index.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-side-chat-test-"));

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

const COMPACT_OPTIONS = {
  width: "85%",
  maxHeight: "35%",
  anchor: "top-center",
  margin: { top: 1, left: 2, right: 2 },
  nonCapturing: true,
};
const FULLSCREEN_OPTIONS = {
  width: "100%",
  maxHeight: "100%",
  anchor: "top-left",
  margin: 0,
  nonCapturing: true,
};

type TestOverlay = {
  focused: boolean;
  handleInput: (data: string) => void;
  render: (width: number) => string[];
  dispose: () => void;
  ownsOverlayFocusTarget?: (component: unknown) => boolean;
};
type Focusable = { focused: boolean; handleInput: (data: string) => void };

function createMainEditor(text: string) {
  return {
    focused: true,
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
  const fullscreenShortcut = shortcuts.get("alt+shift+m");
  assert.ok(command);
  assert.ok(toggleShortcut);
  assert.ok(fullscreenShortcut);
  return { command, toggleShortcut, fullscreenShortcut };
}

function createContext(
  custom: (
    factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: string) => void) => TestOverlay,
    options: { overlayOptions: OverlayOptions; onHandle: (overlayHandle: unknown) => void },
  ) => Promise<string>,
  notifications: Array<{ message: string; level: string }> = [],
) {
  return {
    model: {
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
    },
    cwd: "/tmp",
    getSystemPrompt: () => "test",
    modelRegistry: { getApiKeyForProvider: async () => "test" },
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    ui: {
      notify: (message: string, level: string) => { notifications.push({ message, level }); },
      confirm: async () => true,
      custom,
    },
  };
}

const theme = { fg: (_color: string, text: string) => text };
// Kitty keyboard protocol encoding of alt+/.
const ALT_SLASH = "\x1b[47;3u";

test("Pi overlay handles keep owning focus even when the TUI exposes focus accessors", async () => {
  const { command, toggleShortcut, fullscreenShortcut } = registerExtension();
  const calls: string[] = [];
  let handleFocused = false;
  const tui = {
    terminal: { rows: 40, columns: 120 },
    hasOverlay: () => false,
    requestRender: () => { calls.push("requestRender"); },
    getFocused: () => { calls.push("tui.getFocused"); return null; },
    setFocus: () => { calls.push("tui.setFocus"); },
  };
  const handle = {
    focus: function (this: unknown) {
      assert.equal(this, handle);
      calls.push("handle.focus");
      handleFocused = true;
    },
    unfocus: function (this: unknown) {
      assert.equal(this, handle);
      calls.push("handle.unfocus");
      handleFocused = false;
    },
    isFocused: function (this: unknown) {
      assert.equal(this, handle);
      calls.push("handle.isFocused");
      return handleFocused;
    },
  };

  const context = createContext(async (factory, options) => {
    const originalOptions = options.overlayOptions;
    let completed = false;
    const overlay = factory(tui, theme, {}, () => { completed = true; });
    options.onHandle(handle);

    assert.equal(overlay.ownsOverlayFocusTarget, undefined);
    assert.equal(handleFocused, true);

    await toggleShortcut.handler(context);
    assert.equal(handleFocused, false);
    await toggleShortcut.handler(context);
    assert.equal(handleFocused, true);
    overlay.handleInput(ALT_SLASH);
    assert.equal(handleFocused, false);

    fullscreenShortcut.handler(context);
    assert.equal(options.overlayOptions, originalOptions);
    assert.deepEqual(originalOptions, FULLSCREEN_OPTIONS);
    fullscreenShortcut.handler(context);
    assert.equal(options.overlayOptions, originalOptions);
    assert.deepEqual(originalOptions, COMPACT_OPTIONS);

    assert.equal(calls.includes("tui.setFocus"), false);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("handle.")),
      [
        "handle.focus",
        "handle.isFocused", "handle.unfocus",
        "handle.isFocused", "handle.focus",
        "handle.unfocus",
      ],
    );

    overlay.dispose();
    assert.equal(completed, true);
    return "close";
  });

  await command.handler("", context);
});

test("OMP-style hosts route side chat focus through the TUI and keep both drafts", async () => {
  const { command, toggleShortcut, fullscreenShortcut } = registerExtension();
  const mainEditor = createMainEditor("main draft");
  let focused: Focusable | null = mainEditor;
  let visibleOverlay: TestOverlay | undefined;
  let renderRequests = 0;
  const focusTargets: unknown[] = [];

  // Mirrors OMP: while an overlay is visible, focus may only move to the overlay
  // or to a target the overlay claims through ownsOverlayFocusTarget.
  const setFocus = (component: Focusable | null) => {
    if (visibleOverlay && component !== visibleOverlay && !visibleOverlay.ownsOverlayFocusTarget?.(component)) return;
    focusTargets.push(component);
    if (focused) focused.focused = false;
    focused = component;
    if (component) component.focused = true;
  };
  const type = (data: string) => focused?.handleInput(data);
  const tui = {
    terminal: { rows: 40, columns: 120 },
    hasOverlay: () => false,
    requestRender: () => { renderRequests++; },
    getFocused: () => focused,
    setFocus,
  };
  const sideText = (overlay: TestOverlay) => overlay.render(100).join("\n");

  const context = createContext(async (factory, options) => {
    const originalOptions = options.overlayOptions;
    let completed = false;
    const overlay = factory(tui, theme, {}, () => { completed = true; });
    // OMP focuses a newly shown overlay itself, before the extension sees the handle.
    visibleOverlay = overlay;
    setFocus(overlay);
    options.onHandle({});

    assert.equal(focused, overlay);
    assert.equal(overlay.ownsOverlayFocusTarget?.(mainEditor), true);
    assert.equal(overlay.ownsOverlayFocusTarget?.(createMainEditor("other")), false);
    assert.equal(overlay.ownsOverlayFocusTarget?.(overlay), false);
    const rendersAfterOpen = renderRequests;
    assert.ok(rendersAfterOpen > 0);

    type("side draft");
    assert.match(sideText(overlay), /side draft/);
    assert.equal(mainEditor.text, "main draft");

    await toggleShortcut.handler(context);
    assert.equal(focused, mainEditor);
    assert.equal(mainEditor.focused, true);
    assert.equal(overlay.focused, false);
    assert.ok(renderRequests > rendersAfterOpen);
    type(" main more");
    assert.equal(mainEditor.text, "main draft main more");
    assert.match(sideText(overlay), /side draft/);
    assert.doesNotMatch(sideText(overlay), /main more/);

    await toggleShortcut.handler(context);
    assert.equal(focused, overlay);
    assert.equal(overlay.focused, true);
    assert.equal(mainEditor.focused, false);
    type(" side more");
    assert.match(sideText(overlay), /side draft side more/);
    assert.equal(mainEditor.text, "main draft main more");

    // The overlay's own shortcut handler unfocuses through the same TUI route.
    type(ALT_SLASH);
    assert.equal(focused, mainEditor);
    assert.equal(overlay.focused, false);
    await toggleShortcut.handler(context);
    assert.equal(focused, overlay);

    fullscreenShortcut.handler(context);
    assert.equal(options.overlayOptions, originalOptions);
    assert.deepEqual(originalOptions, FULLSCREEN_OPTIONS);
    assert.match(sideText(overlay), /side draft side more/);
    fullscreenShortcut.handler(context);
    assert.equal(options.overlayOptions, originalOptions);
    assert.deepEqual(originalOptions, COMPACT_OPTIONS);
    assert.match(sideText(overlay), /side draft side more/);
    assert.equal(mainEditor.text, "main draft main more");

    assert.deepEqual(focusTargets, [overlay, overlay, mainEditor, overlay, mainEditor, overlay]);

    overlay.dispose();
    assert.equal(completed, true);
    return "close";
  });

  await command.handler("", context);
});

test("OMP-style hosts capture the parent focus before the overlay is created", async () => {
  const { command, toggleShortcut } = registerExtension();
  const mainEditor = createMainEditor("main draft");
  let focused: Focusable | null = mainEditor;
  let visibleOverlay: TestOverlay | undefined;
  const tui = {
    terminal: { rows: 40, columns: 120 },
    hasOverlay: () => false,
    requestRender: () => {},
    getFocused: () => focused,
    setFocus: (component: Focusable | null) => {
      if (visibleOverlay && component !== visibleOverlay && !visibleOverlay.ownsOverlayFocusTarget?.(component)) return;
      if (focused) focused.focused = false;
      focused = component;
      if (component) component.focused = true;
    },
  };

  const context = createContext(async (factory, options) => {
    const overlay = factory(tui, theme, {}, () => {});
    visibleOverlay = overlay;
    // Some other component takes focus between creation and the handle callback.
    const interloper = createMainEditor("other");
    focused = interloper;
    options.onHandle({});
    assert.equal(focused, overlay);

    await toggleShortcut.handler(context);
    assert.equal(focused, mainEditor);
    assert.equal(overlay.ownsOverlayFocusTarget?.(interloper), false);

    overlay.dispose();
    return "close";
  });

  await command.handler("", context);
});

test("hosts without handle or TUI focus support close the side chat with an error", async () => {
  const { command, toggleShortcut } = registerExtension();
  const notifications: Array<{ message: string; level: string }> = [];
  const tui = {
    terminal: { rows: 40, columns: 120 },
    hasOverlay: () => false,
    requestRender: () => {},
    setFocus: () => { assert.fail("setFocus must not be used without getFocused"); },
  };
  let completedWith: string | undefined;

  const context = createContext(async (factory, options) => {
    factory(tui, theme, {}, (result) => { completedWith = result; });
    assert.doesNotThrow(() => options.onHandle({}));
    assert.equal(completedWith, "close");
    return completedWith;
  }, notifications);

  await command.handler("", context);
  assert.deepEqual(notifications, [{
    message: "Cannot open side chat: this host does not support overlay focus switching",
    level: "error",
  }]);

  // The failed overlay is fully released, so the shortcut opens a fresh one.
  let reopened = false;
  const reopenContext = createContext(async (factory) => {
    reopened = true;
    const overlay = factory({ ...tui, hasOverlay: () => false }, theme, {}, () => {});
    overlay.dispose();
    return "close";
  });
  await toggleShortcut.handler(reopenContext);
  assert.equal(reopened, true);
});
