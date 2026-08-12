import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

/** Approved wording (#12): synthesized result for a tool call that was still
 *  running on the main lane when the btw side chat forked. */
export const FORKED_MID_EXECUTION_TEXT =
  "[forked mid-execution — the main lane was still running this tool call when the btw side chat opened]";

/**
 * Fork surgery (#12/#16): make the trailing tool exchange gateway-legal on
 * the fork snapshot, tail-only, never rewriting existing messages.
 *
 * The gateway rejects any request with an unanswered `assistant.tool_calls`
 * (HTTP 400), and the fork snapshot can genuinely end mid-execution (the
 * main lane was still running the tool when the btw side chat opened). Rules:
 *
 * - S1/S2 dangling tool_calls (no matching toolResult in the kept list) get
 *   one synthesized toolResult each, appended after the trailing exchange.
 *   Real landed results are never touched.
 * - Orphan toolResults (no matching tool_call anywhere in the kept list) are
 *   defensively dropped.
 * - S5 carry-cut (#16, reverses S4): a trailing run of user messages is cut
 *   entirely, and the user message that triggered the trailing tool exchange
 *   is cut with it — the cite never ends on a user message. "The
 *   newest-looking question in the cite" is the lane-confusion source
 *   (2026-08-13 export: the model answered the main lane's trailing user
 *   message instead of the btw message). Tail cuts keep the btw request a
 *   token prefix of the main request, so shared-prefix caching is unaffected.
 * - branchSummary/compactionSummary, images and `excludeFromContext` messages
 *   pass through untouched (shared prefix).
 *
 * Matching against the whole kept list (not just the region) keeps valid
 * answered exchanges intact in pathological orderings; only true orphans and
 * true dangling calls are touched.
 */
export function forkSurgery(messages: AgentMessage[], forkTimestamp = Date.now()): AgentMessage[] {
  // (1) Locate the trailing exchange region with S5 carry-cut (#16):
  // - a trailing run of user messages is cut entirely (S4 reversal),
  // - the user message that triggered the trailing tool exchange is cut with
  //   it (carryStart), so the cite never ends on a user message.
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

  // (2) Index every tool_call in the whole list (id → tool name, for
  // synthesis) and every toolResult id.
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

  // (3) Orphan toolResults in the region are dropped; everything else in the
  // region passes through byte-identical.
  const kept = region.filter((message) => message.role !== "toolResult" || callNames.has(message.toolCallId));

  // (4) Dangling calls in the region get one synthesized toolResult each.
  const regionCallIds = new Set<string>();
  for (const message of region) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall") regionCallIds.add(block.id);
    }
  }
  const synthesized: ToolResultMessage[] = [];
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
