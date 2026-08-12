import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFramingMessage } from "./side-chat-messages.ts";

/**
 * Alt+E transcript export: dumps the btw session to
 * `$CWD/.agents/eval/pi-side-chat-<timestamp>.md` as a markdown diagnostic
 * artifact (feature/debug work). The forked main-lane context and the
 * framing block are included verbatim, labeled per segment, so the export
 * shows exactly what the btw session saw in its LLM context.
 */

export interface ExportSideChatOptions {
  messages: AgentMessage[];
  /** Current working directory — the `.agents/eval/` dir is created under it. */
  cwd: string;
  modelId: string;
  toolMode: "full" | "read-only";
  /** Number of leading messages injected from the main lane (fork context). */
  forkedMessageCount: number;
  /** Whether the agent was mid-stream when the export was requested. */
  streaming: boolean;
  /** In-flight assistant text at export time (included as a pseudo message). */
  streamingContent?: string;
  exportedAt?: Date;
}

/** Local `YYYY-MM-DD HH:mm:ss` for headers. */
function formatTimestamp(timestamp: number | Date): string {
  const d = typeof timestamp === "number" ? new Date(timestamp) : timestamp;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local `YYYYMMDD-HHmmss` for the export filename. */
function formatFileTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Cap a string with an ellipsis note (safety valve for huge payloads). */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated ${text.length - max} chars)` : text;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Content block union of the LLM message roles (text/thinking/image/toolCall). */
type ContentBlock = { type: string } & Record<string, unknown>;

/** Render one content block into markdown lines (text/thinking/image/toolCall). */
function formatBlock(block: ContentBlock, lines: string[]) {
  switch (block.type) {
    case "text":
      lines.push(String(block.text ?? ""));
      break;
    case "thinking":
      if (typeof block.thinking === "string" && block.thinking) {
        lines.push("", "_💭 thinking:_", "```text", block.thinking, "```");
      } else if (block.redacted) {
        lines.push("_💭 thinking redacted by safety filters_");
      }
      break;
    case "image":
      lines.push(`_🖼 image (${String(block.mimeType ?? "unknown")}), payload omitted — binary data not exported_`);
      break;
    case "toolCall":
      lines.push(`_🔧 tool call: ${String(block.name ?? "?")}_`);
      lines.push("```json");
      lines.push(cap(formatJson(block.arguments), 10_000));
      lines.push("```");
      break;
    default:
      lines.push(`_content block (${block.type})_`);
  }
}

/** Extract the text of a message content (string or blocks) as markdown lines. */
function formatContent(content: string | ContentBlock[], lines: string[]) {
  if (typeof content === "string") {
    lines.push(content);
    return;
  }
  for (const block of content) {
    formatBlock(block, lines);
  }
}

/** Role emoji + display label used in the message heading. */
function roleLabel(msg: AgentMessage): string {
  switch (msg.role) {
    case "user":
      return "👤 user";
    case "assistant":
      return "🤖 assistant";
    case "toolResult":
      return `🔧 toolResult: ${String((msg as { toolName?: unknown }).toolName ?? "?")}`;
    case "branchSummary":
    case "compactionSummary":
      return `🗜 ${msg.role}`;
    case "bashExecution":
      return "💻 bash";
    case "custom":
      return "🧩 custom";
    default:
      return `❔ ${String((msg as { role?: unknown }).role ?? "unknown")}`;
  }
}

function renderMessage(msg: AgentMessage, index: number, tag: string | null): string[] {
  const lines: string[] = [];
  const time = formatTimestamp(msg.timestamp);
  const tagText = tag ? ` · ${tag}` : "";
  lines.push(`### [#${index}] ${roleLabel(msg)} · ${time}${tagText}`);

  if (msg.role === "assistant") {
    const a = msg as AgentMessage & {
      model?: unknown;
      stopReason?: unknown;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      errorMessage?: unknown;
    };
    const meta: string[] = [];
    if (typeof a.model === "string" && a.model) meta.push(`model ${a.model}`);
    if (a.stopReason) meta.push(`stop ${String(a.stopReason)}`);
    const usage = a.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } | undefined;
    if (usage && typeof usage.totalTokens === "number") {
      meta.push(`tokens ${usage.input ?? 0}/${usage.output ?? 0} (cache ${(usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)})`);
    }
    if (a.errorMessage) meta.push(`error: ${String(a.errorMessage)}`);
    if (meta.length) lines.push(`_${meta.join(" · ")}_`);
    if (msg.content.length === 0 && a.errorMessage) {
      lines.push(String(a.errorMessage));
    }
  } else if (msg.role === "toolResult") {
    const t = msg as AgentMessage & { isError?: unknown; details?: unknown };
    lines.push(`_status: ${t.isError ? "ERROR" : "OK"}_`);
    if (t.details !== undefined) {
      lines.push("_details:_");
      lines.push("```json");
      lines.push(cap(formatJson(t.details), 100_000));
      lines.push("```");
    }
  }

  const content = (msg as AgentMessage & { content?: string | ContentBlock[] }).content;
  if (content !== undefined) {
    formatContent(content, lines);
  } else if (msg.role === "bashExecution") {
    const b = msg as AgentMessage & { command?: unknown };
    if (b.command !== undefined) lines.push(String(b.command));
  } else if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
    const s = msg as AgentMessage & { summary?: unknown; tokensBefore?: unknown };
    if (s.summary !== undefined) lines.push(String(s.summary));
    if (s.tokensBefore !== undefined) lines.push(`_tokens before: ${String(s.tokensBefore)}_`);
  }
  return lines;
}

/** Build the full markdown transcript document. */
export function buildExportMarkdown(opts: ExportSideChatOptions): string {
  const exportedAt = opts.exportedAt ?? new Date();
  const messages = opts.messages;
  const total = messages.length;

  // Segment split: forked main-lane context → framing block → btw conversation.
  const forked = messages.slice(0, Math.max(0, Math.min(opts.forkedMessageCount, total)));
  const rest = messages.slice(forked.length);
  const framingIdx = rest.findIndex(isFramingMessage);
  const framing = framingIdx >= 0 ? [rest[framingIdx]] : [];
  const conversation = framingIdx >= 0 ? [...rest.slice(0, framingIdx), ...rest.slice(framingIdx + 1)] : rest;

  const lines: string[] = [];
  lines.push("# btw Chat Export — pi-side-chat");
  lines.push("");
  lines.push("_Exported with `Alt+E` from the btw overlay — diagnostic artifact for feature work._");
  lines.push("");
  lines.push(`- exported at: ${formatTimestamp(exportedAt)}`);
  lines.push(`- model: ${opts.modelId}`);
  lines.push(`- tool mode: ${opts.toolMode}`);
  lines.push(`- cwd: \`${opts.cwd}\``);
  lines.push(
    `- transcript: ${total} messages (${forked.length} forked context · ${framing.length} framing · ${conversation.length} conversation)`,
  );
  lines.push(`- streaming at export: ${opts.streaming ? "yes" : "no"}`);

  const segments: { title: string; msgs: AgentMessage[]; tag: string | null }[] = [];
  if (forked.length) segments.push({ title: "forked context from main lane", msgs: forked, tag: "forked from main lane" });
  if (framing.length) segments.push({ title: "framing block", msgs: framing, tag: "framing block" });
  if (conversation.length) segments.push({ title: "btw conversation", msgs: conversation, tag: null });

  let globalIndex = 0;
  for (const segment of segments) {
    lines.push("", "---", "");
    lines.push(`## ${segment.title} (${segment.msgs.length} message${segment.msgs.length === 1 ? "" : "s"})`);
    lines.push("");
    for (const msg of segment.msgs) {
      globalIndex += 1;
      lines.push(...renderMessage(msg, globalIndex, segment.tag), "");
    }
  }

  // Mid-stream snapshot: append the in-flight assistant text as a pseudo message.
  if (opts.streaming && opts.streamingContent) {
    lines.push("---", "");
    lines.push(`## in-flight assistant response at export time (${opts.streamingContent.length} chars)`);
    lines.push("");
    lines.push(`### [#${globalIndex + 1}] 🤖 assistant · ${formatTimestamp(exportedAt)} · streamed, not committed`);
    lines.push(opts.streamingContent);
  }

  if (!segments.length && !(opts.streaming && opts.streamingContent)) {
    lines.push("", "_No messages to export._");
  }

  return lines.join("\n");
}

/**
 * Write the export to `<cwd>/.agents/eval/pi-side-chat-<YYYYMMDD-HHmmss>.md`.
 * Collisions get a `-2`, `-3`, … suffix. Returns the absolute written path.
 */
export function exportChatHistoryToFile(opts: ExportSideChatOptions): string {
  const exportedAt = opts.exportedAt ?? new Date();
  const dir = join(opts.cwd, ".agents", "eval");
  mkdirSync(dir, { recursive: true });

  const base = `pi-side-chat-${formatFileTimestamp(exportedAt)}`;
  let path = join(dir, `${base}.md`);
  let counter = 2;
  while (existsSync(path)) {
    path = join(dir, `${base}-${counter}.md`);
    counter += 1;
  }

  writeFileSync(path, buildExportMarkdown(opts), "utf-8");
  return path;
}
