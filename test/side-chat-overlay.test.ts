import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { SideChatOverlay, type ForkContext } from "../side-chat-overlay.ts";

const extensionTool: AgentTool = {
  name: "extension_tool",
  label: "extension_tool",
  description: "Test extension tool",
  parameters: { type: "object", properties: {} } as AgentTool["parameters"],
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

function createOverlay(modelRegistry: object = { getApiKeyForProvider: async () => "test" }) {
  let renderRequests = 0;
  let overlapWarnings = 0;
  const tui = {
    terminal: { rows: 40, columns: 120 },
    requestRender: () => { renderRequests++; },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
  };
  const forkContext: ForkContext = {
    messages: [],
    model: {
      id: "test",
      name: "test",
      api: "side-chat-test-api",
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
    extensionTools: [extensionTool],
  };
  const overlay = new SideChatOverlay({
    tui,
    theme,
    forkContext,
    tracker: {
      writeCount: 0,
      hasWritten: () => true,
    },
    modelRegistry,
    sessionManager: {
      getSessionId: () => "main-session",
      getLeafId: () => null,
      getEntries: () => [],
    },
    shortcut: "alt+/",
    fullscreenShortcut: "alt+shift+m",
    onDisplayModeChange: () => {},
    onOverlapWarning: async () => {
      overlapWarnings++;
      return false;
    },
    onUnfocus: () => {},
    onClose: () => {},
  } as unknown as ConstructorParameters<typeof SideChatOverlay>[0]);

  return {
    overlay,
    get renderRequests() { return renderRequests; },
    get overlapWarnings() { return overlapWarnings; },
  };
}

function activeTools(overlay: SideChatOverlay): AgentTool[] {
  return (overlay as unknown as { agent: { state: { tools: AgentTool[] } } }).agent.state.tools;
}

function toolNames(overlay: SideChatOverlay): string[] {
  return activeTools(overlay).map((tool) => tool.name);
}

function count(names: string[], name: string): number {
  return names.filter((candidate) => candidate === name).length;
}

test("Ctrl+T switches tool modes through the current Agent state API", async () => {
  const state = createOverlay();

  assert.match(state.overlay.render(100).join("\n"), /\[Read-only\]/);
  assert.deepEqual(toolNames(state.overlay), ["read", "grep", "find", "ls", "extension_tool", "peek_main"]);

  assert.doesNotThrow(() => state.overlay.handleInput("\x14"));

  const editNames = toolNames(state.overlay);
  assert.match(state.overlay.render(100).join("\n"), /\[Edit\]/);
  for (const name of ["read", "bash", "edit", "write", "extension_tool", "peek_main"]) {
    assert.ok(editNames.includes(name), `${name} should be active in edit mode`);
  }
  assert.equal(count(editNames, "extension_tool"), 1);
  assert.equal(count(editNames, "peek_main"), 1);

  const write = activeTools(state.overlay).find((tool) => tool.name === "write");
  assert.ok(write);
  const result = await write.execute("test-call", { path: "/tmp/file" }, undefined, undefined);
  assert.equal(state.overlapWarnings, 1);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Skipped/);
  assert.equal(state.renderRequests, 1);

  assert.doesNotThrow(() => state.overlay.handleInput("\x14"));

  const readOnlyNames = toolNames(state.overlay);
  assert.match(state.overlay.render(100).join("\n"), /\[Read-only\]/);
  assert.deepEqual(readOnlyNames, ["read", "grep", "find", "ls", "extension_tool", "peek_main"]);
  assert.equal(count(readOnlyNames, "extension_tool"), 1);
  assert.equal(count(readOnlyNames, "peek_main"), 1);
  assert.equal(state.renderRequests, 2);
});

test("Ctrl+T falls back to Agent.setTools on pi-agent-core before 0.65.0", () => {
  const state = createOverlay();
  const agent = (state.overlay as unknown as { agent: {
    state: { tools: AgentTool[] };
    setTools?: (tools: AgentTool[]) => void;
  } }).agent;
  let setToolsCalls = 0;
  agent.setTools = (tools) => {
    setToolsCalls++;
    agent.state.tools = [...tools];
  };

  assert.doesNotThrow(() => state.overlay.handleInput("\x14"));
  assert.equal(setToolsCalls, 1);
  assert.match(state.overlay.render(100).join("\n"), /\[Edit\]/);
  assert.ok(toolNames(state.overlay).includes("write"));

  assert.doesNotThrow(() => state.overlay.handleInput("\x14"));
  assert.equal(setToolsCalls, 2);
  assert.match(state.overlay.render(100).join("\n"), /\[Read-only\]/);
  assert.deepEqual(toolNames(state.overlay), ["read", "grep", "find", "ls", "extension_tool", "peek_main"]);
});

interface RegistryCall {
  sessionId?: string;
  apiKey?: string;
  lastRole?: string;
}

function assistantStream(content: unknown[], stopReason: "stop" | "toolUse") {
  const message = {
    role: "assistant",
    content,
    api: "side-chat-test-api",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: message };
      yield { type: "done", reason: stopReason, message };
    },
    result: async () => message,
  };
}

// Stands in for a provider registered by an extension: it exists only in the
// model registry, so the side chat must stream through modelRegistry.streamSimple.
function createStreamingRegistry() {
  const calls: RegistryCall[] = [];
  return {
    calls,
    registry: {
      streamSimple: (_model: unknown, context: { messages: Array<{ role: string }> }, options?: { sessionId?: string; apiKey?: string }) => {
        const lastRole = context.messages.at(-1)?.role;
        calls.push({ sessionId: options?.sessionId, apiKey: options?.apiKey, lastRole });
        return lastRole === "toolResult"
          ? assistantStream([{ type: "text", text: "side answer" }], "stop")
          : assistantStream([{ type: "toolCall", id: "peek-1", name: "peek_main", arguments: {} }], "toolUse");
      },
    },
  };
}

async function submit(overlay: SideChatOverlay, text: string) {
  await (overlay as unknown as { handleSubmit(text: string): Promise<void> }).handleSubmit(text);
}

test("side chat turns and tool round trips stream through the model registry with one side-chat session id", async () => {
  const first = createStreamingRegistry();
  const state = createOverlay(first.registry);

  await submit(state.overlay, "What is main doing?");

  assert.deepEqual(first.calls.map((call) => call.lastRole), ["user", "toolResult"]);
  const sessionId = first.calls[0]?.sessionId;
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId);
  assert.notEqual(sessionId, "main-session");
  assert.equal(first.calls[1]?.sessionId, sessionId);
  // Authentication is left to the registry so OAuth and header-based providers resolve per request.
  assert.deepEqual(first.calls.map((call) => call.apiKey), [undefined, undefined]);

  await submit(state.overlay, "And now?");
  assert.equal(first.calls.length, 4);
  assert.ok(first.calls.every((call) => call.sessionId === sessionId));

  const second = createStreamingRegistry();
  await submit(createOverlay(second.registry).overlay, "Another side chat");
  assert.equal(second.calls.length, 2);
  assert.ok(second.calls[0]?.sessionId);
  assert.notEqual(second.calls[0]?.sessionId, sessionId);
  assert.notEqual(second.calls[0]?.sessionId, "main-session");
});
