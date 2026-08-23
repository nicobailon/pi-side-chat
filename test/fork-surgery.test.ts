import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { forkSurgery, FORKED_MID_EXECUTION_TEXT } from "../fork-surgery.ts";

const assistantToolCall = (id: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "read", arguments: { path: "file.ts" } }],
  api: "openai-completions",
  provider: "test",
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse",
  timestamp: 1,
} as AgentMessage);

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 } as AgentMessage);

test("sanitizes a fork opened during a tool call", () => {
  const result = forkSurgery([
    user("main task"),
    assistantToolCall("call-1"),
  ], 42);

  assert.equal(result.length, 2);
  assert.equal(result[0]?.role, "assistant");
  assert.equal(result[1]?.role, "toolResult");
  assert.equal(result[1]?.toolCallId, "call-1");
  assert.equal(result[1]?.content[0]?.type, "text");
  assert.equal(result[1]?.content[0]?.type === "text" ? result[1].content[0].text : "", FORKED_MID_EXECUTION_TEXT);
});

test("cuts trailing main user messages and keeps answered history unchanged", () => {
  const answered = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } as AgentMessage;
  const result = forkSurgery([
    user("older task"),
    answered,
    user("pending main question"),
  ]);

  assert.deepEqual(result, [user("older task"), answered]);
});
