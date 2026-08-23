import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { visibleWidth } from "@mariozechner/pi-tui";
import { SideChatOverlay, type ForkContext } from "../side-chat-overlay.ts";
import type { DisplayMode } from "../side-chat-layout.ts";

function createOverlay(rows = 40) {
  let renderRequests = 0;
  const displayChanges: DisplayMode[] = [];
  const tui = {
    terminal: { rows, columns: 120 },
    requestRender: () => { renderRequests++; },
  };
  const theme = { fg: (_color: string, text: string) => text };
  const forkContext: ForkContext = {
    messages: [],
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
    systemPrompt: "test",
    thinkingLevel: "off",
    cwd: "/tmp",
    extensionTools: [],
  };
  const overlay = new SideChatOverlay({
    tui,
    theme,
    forkContext,
    tracker: { writeCount: 0, hasWritten: () => false },
    modelRegistry: { getApiKeyForProvider: async () => "test" },
    sessionManager: { getLeafId: () => null, getEntries: () => [] },
    shortcut: "alt+/",
    fullscreenShortcut: "alt+shift+f",
    onDisplayModeChange: (mode: DisplayMode) => { displayChanges.push(mode); },
    onOverlapWarning: async () => true,
    onUnfocus: () => {},
    onClose: () => {},
  } as unknown as ConstructorParameters<typeof SideChatOverlay>[0]);

  return {
    overlay,
    tui,
    displayChanges,
    get renderRequests() { return renderRequests; },
  };
}

function internals(overlay: SideChatOverlay) {
  return overlay as unknown as {
    agent: { abort: () => void; state: { tools: AgentTool[] } };
    editor: {
      getText: () => string;
      getCursor: () => { line: number; col: number };
      setText: (text: string) => void;
      handleInput: (data: string) => void;
    };
    messages: {
      scrollOffset: number;
      setMessages: (messages: unknown[]) => void;
      handleInput: (data: string) => boolean;
    };
    isStreaming: boolean;
  };
}

test("fullscreen toggle preserves live overlay state and consumes its key", () => {
  const state = createOverlay();
  const privateState = internals(state.overlay);
  const originalAgent = privateState.agent;
  let aborts = 0;
  originalAgent.abort = () => { aborts++; };

  privateState.editor.setText("draft text");
  privateState.editor.handleInput("\x1b[D");
  privateState.messages.setMessages(Array.from({ length: 30 }, (_, index) => ({
    role: "user",
    content: `message ${index}`,
    timestamp: index,
  })));
  state.overlay.render(120);
  privateState.messages.handleInput("\x1b[5~");
  privateState.messages.handleInput("\x1b[5~");
  privateState.isStreaming = true;
  const cursor = privateState.editor.getCursor();

  state.overlay.handleInput("\x1b[70;4u");

  assert.deepEqual(state.displayChanges, ["fullscreen"]);
  assert.equal(internals(state.overlay).agent, originalAgent);
  assert.equal(privateState.editor.getText(), "draft text");
  assert.deepEqual(privateState.editor.getCursor(), cursor);
  assert.equal(privateState.messages.scrollOffset, 10);
  assert.equal(state.overlay.focused, true);
  assert.equal(aborts, 0);
  assert.equal(state.renderRequests, 1);

  const fullscreenLines = state.overlay.render(120);
  assert.equal(fullscreenLines.length, 40);
  assert.match(fullscreenLines.join("\n"), /Alt\+Shift\+F restore/);
  assert.ok(fullscreenLines.every((line) => visibleWidth(line) <= 120));

  state.overlay.handleInput("\x1b[70;4u");

  assert.deepEqual(state.displayChanges, ["fullscreen", "compact"]);
  assert.equal(privateState.editor.getText(), "draft text");
  assert.deepEqual(privateState.editor.getCursor(), cursor);
  assert.equal(privateState.messages.scrollOffset, 10);
  assert.equal(aborts, 0);
  assert.equal(state.renderRequests, 2);

  const compactLines = state.overlay.render(120);
  assert.equal(compactLines.length, 14);
  assert.match(compactLines.join("\n"), /Alt\+Shift\+F fullscreen/);
  assert.ok(compactLines.every((line) => visibleWidth(line) <= 120));
});

test("resize recalculates both display modes without exceeding width", () => {
  const state = createOverlay(24);

  assert.equal(state.overlay.render(80).length, 13);
  state.overlay.handleInput("\x1b[70;4u");
  assert.equal(state.overlay.render(80).length, 24);

  state.tui.terminal.rows = 50;
  assert.equal(state.overlay.render(32).length, 50);
  assert.ok(state.overlay.render(16).every((line) => visibleWidth(line) <= 16));
});

test("fullscreen stays within terminal rows with a multiline editor", () => {
  const state = createOverlay(10);
  const privateState = internals(state.overlay);
  privateState.editor.setText("line one\nline two\nline three\nline four");

  state.overlay.handleInput("\x1b[70;4u");

  assert.equal(state.overlay.render(80).length, 10);
});

test("fullscreen stays within terminals shorter than its fixed chrome", () => {
  const state = createOverlay(5);

  state.overlay.handleInput("\x1b[70;4u");

  assert.equal(state.overlay.render(80).length, 5);
});
