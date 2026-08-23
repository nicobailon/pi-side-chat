import assert from "node:assert/strict";
import test from "node:test";
import { markFramingMessage, SideChatMessages } from "../side-chat-messages.ts";

const theme = { fg: (_color: string, text: string) => text };

test("viewport resize clamps scroll offset without resetting it", () => {
  const messages = new SideChatMessages(theme as never, 5);
  messages.setMessages(Array.from({ length: 20 }, (_, index) => ({
    role: "user" as const,
    content: `message ${index}`,
    timestamp: index,
  })));
  messages.render(40);

  const state = messages as unknown as { scrollOffset: number };
  messages.handleInput("\x1b[5~");
  messages.handleInput("\x1b[5~");
  assert.equal(state.scrollOffset, 10);

  messages.setMaxVisibleLines(10);
  assert.equal(state.scrollOffset, 10);
  messages.setMaxVisibleLines(35);
  assert.equal(state.scrollOffset, 5);
  messages.setMaxVisibleLines(5);
  assert.equal(state.scrollOffset, 5);
});

test("framing message is sent to the agent but not rendered as a chat bubble", () => {
  const messages = new SideChatMessages(theme as never, 10);
  messages.setMessages([
    markFramingMessage({ role: "user", content: "reference only", timestamp: 1 }),
    { role: "user", content: "latest side question", timestamp: 2 },
  ]);

  const rendered = messages.render(80).join("\n");
  assert.doesNotMatch(rendered, /reference only/);
  assert.match(rendered, /latest side question/);
});
