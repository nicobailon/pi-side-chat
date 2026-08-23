import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";

export const FORKED_MID_EXECUTION_TEXT =
  "[forked mid-execution — the main lane was still running this tool call when the side chat opened]";

export function forkSurgery(messages: AgentMessage[], forkTimestamp = Date.now()): AgentMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === "user") end--;

  let start = end;
  while (start > 0) {
    const message = messages[start - 1];
    if (message.role === "toolResult") {
      start--;
      continue;
    }
    if (message.role === "assistant" && hasToolCalls(message)) {
      start--;
      continue;
    }
    break;
  }

  const carryStart = start > 0 && messages[start - 1].role === "user" ? start - 1 : start;
  const region = messages.slice(start, end);
  const cut = end < messages.length || carryStart < start;
  if (!cut && region.length === 0) return messages;

  const callNames = new Map<string, string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") callNames.set(block.id, block.name);
      }
    } else if (message.role === "toolResult") {
      resultIds.add(message.toolCallId);
    }
  }

  const kept = region.filter((message) => message.role !== "toolResult" || callNames.has(message.toolCallId));
  const synthesized: ToolResultMessage[] = [];
  const regionCallIds = new Set<string>();
  for (const message of region) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall") regionCallIds.add(block.id);
    }
  }
  for (const id of regionCallIds) {
    if (resultIds.has(id)) continue;
    synthesized.push({
      role: "toolResult",
      toolCallId: id,
      toolName: callNames.get(id) ?? "unknown",
      content: [{ type: "text", text: FORKED_MID_EXECUTION_TEXT }],
      isError: false,
      timestamp: forkTimestamp,
    });
  }

  if (!cut && kept.length === region.length && synthesized.length === 0) return messages;
  return [...messages.slice(0, carryStart), ...kept, ...synthesized];
}

function hasToolCalls(message: AgentMessage): boolean {
  return message.role === "assistant" && message.content.some((block) => block.type === "toolCall");
}
