import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Key, matchesKey, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Marker for the framing block message (#9): it lives in the LLM context
// (user-role fallback placement) but must never render as a chat bubble.
const FRAMING_MARKER = Symbol("btw-framing-message");

/** Mark a message as the framing block so the render path skips it. */
export function markFramingMessage<T extends AgentMessage>(message: T): T {
  (message as T & { [FRAMING_MARKER]?: boolean })[FRAMING_MARKER] = true;
  return message;
}

/** True for framing-block messages (marked at construction). */
export function isFramingMessage(message: AgentMessage): boolean {
  return (message as AgentMessage & { [FRAMING_MARKER]?: boolean })[FRAMING_MARKER] === true;
}

export class SideChatMessages implements Component {
  private messages: AgentMessage[] = [];
  private streamingContent = "";
  private errorContent = "";
  private toolStatus = "";
  private scrollOffset = 0;
  private totalLines = 0;
  /**
   * Number of leading messages injected at open time (fork context, reopened
   * history, refork). They render as ONE collapsed, non-expandable cite line
   * instead of full history. UI-only: the messages themselves stay in the
   * agent's LLM context untouched.
   */
  private injectedCount = 0;
  /**
   * While the user has scrolled away from the bottom, the content line index
   * pinned to the viewport bottom. New lines appended below it (streamed
   * output) grow the scroll offset instead of sliding the visible content.
   * Null while following the bottom.
   */
  private frozenAnchor: number | null = null;

  constructor(private theme: Theme, private maxVisibleLines: number) {}

  /**
   * Mark the first `count` messages as injected context: they render as a
   * single cite line (e.g. `[Context] 36 msgs`) rather than full history.
   * Anything appended after the injected batch renders normally. Pass 0
   * (Alt+N empty start) for no cite. UI-only — LLM context is unaffected.
   */
  setInjectedMessageCount(count: number) {
    this.injectedCount = Math.max(0, count);
  }

  setMessages(messages: AgentMessage[]) {
    this.messages = messages;
    if (this.frozenAnchor === null) {
      // Following: snap the viewport to the bottom.
      this.scrollOffset = 0;
    } else {
      // Frozen: keep the anchored content line at the viewport bottom. The
      // message list only grows, so the anchor stays valid across re-renders
      // (streaming block -> completed message, tool status coming/going).
      this.scrollOffset = Math.max(0, this.totalLines - this.frozenAnchor);
    }
  }

  setStreamingContent(content: string) {
    this.streamingContent = content;
    if (content) this.errorContent = "";
  }

  setErrorContent(content: string) {
    this.errorContent = content;
    if (content) this.streamingContent = "";
  }

  setToolStatus(status: string) {
    this.toolStatus = status;
  }

  setMaxVisibleLines(max: number) {
    this.maxVisibleLines = Math.max(1, max);
    if (this.frozenAnchor === null) {
      this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.totalLines - this.maxVisibleLines));
    } else {
      this.scrollOffset = Math.max(0, this.totalLines - this.frozenAnchor);
    }
  }

  /**
   * Scroll by a number of lines. Positive = toward older content (like PgUp),
   * negative = toward the latest message. Clamped to the scrollable range.
   */
  scrollBy(lines: number) {
    if (lines === 0) return false;
    const maxOffset = Math.max(0, this.totalLines - this.maxVisibleLines);
    const next = Math.max(0, Math.min(this.scrollOffset + lines, maxOffset));
    if (next === this.scrollOffset) return false;
    this.scrollOffset = next;
    if (next === 0) {
      // Scrolled back to the bottom: resume following.
      this.frozenAnchor = null;
    } else {
      // Pin the new viewport position so arriving lines don't slide it.
      this.frozenAnchor = Math.max(0, this.totalLines - next);
    }
    return true;
  }

  /**
   * Snap to the bottom and resume bottom-following. Called when the user
   * sends a new message (the conversation restarts from the bottom).
   */
  resumeFollowing() {
    this.frozenAnchor = null;
    this.scrollOffset = 0;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  isAtBottom(): boolean {
    return this.scrollOffset <= 0;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const injected = Math.min(this.injectedCount, this.messages.length);

    if (injected > 0) {
      // One collapsed, non-expandable cite line for the injected batch
      // (fresh fork context, reopened history, refork) instead of the full
      // history. The visible conversation starts after it.
      lines.push(...wrapTextWithAnsi(this.theme.fg("muted", `[Context] ${injected} msg${injected === 1 ? "" : "s"}`), width));
      lines.push("");
    }

    for (let i = injected; i < this.messages.length; i++) {
      // Framing-block messages are part of the LLM context but never render
      // as chat bubbles (#9 fallback placement).
      if (isFramingMessage(this.messages[i])) continue;
      const messageLines = this.renderMessage(this.messages[i], width);
      if (messageLines.length) {
        lines.push(...messageLines, "");
      }
    }

    if (this.errorContent) {
      lines.push(...wrapTextWithAnsi(this.theme.fg("error", "[Error]: ") + this.errorContent, width));
    } else if (this.streamingContent) {
      lines.push(...wrapTextWithAnsi(this.theme.fg("text", "[Assistant]: ") + this.streamingContent + "▌", width));
    }

    if (this.toolStatus) {
      if (lines.length) lines.push("");
      lines.push(...wrapTextWithAnsi(this.theme.fg("muted", `[Tool]: ${this.toolStatus}`), width));
    }

    this.totalLines = lines.length;
    // Freeze: while the user has scrolled away, grow the offset by the lines
    // appended at the end, so the anchored content stays put instead of being
    // pushed up by new streamed output.
    if (this.frozenAnchor !== null) {
      this.scrollOffset = Math.max(0, this.totalLines - this.frozenAnchor);
    }
    const start = Math.max(0, lines.length - this.maxVisibleLines - this.scrollOffset);
    const end = Math.max(0, lines.length - this.scrollOffset);
    return lines.slice(start, end);
  }

  private renderMessage(msg: AgentMessage, width: number): string[] {
    const { theme } = this;

    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : msg.content.map((b) => b.type === "text" ? b.text : "[image]").join("");
      return wrapTextWithAnsi(theme.fg("accent", "[You]: ") + content, width);
    }

    if (msg.role === "assistant") {
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) return wrapTextWithAnsi(theme.fg("text", "[Assistant]: ") + text, width);
      if ("errorMessage" in msg && msg.errorMessage) {
        return wrapTextWithAnsi(theme.fg("error", "[Error]: ") + String(msg.errorMessage), width);
      }
      return [];
    }

    if (msg.role === "toolResult") {
      const fullText = msg.content[0]?.type === "text" ? msg.content[0].text : "";
      const preview = fullText.slice(0, 100);
      return wrapTextWithAnsi(theme.fg("muted", `[${msg.toolName}]: ${preview}${fullText.length > 100 ? "..." : ""}`), width);
    }

    if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
      return wrapTextWithAnsi(theme.fg("muted", `[Summary]: ${msg.summary}`), width);
    }

    if (msg.role === "bashExecution") {
      return wrapTextWithAnsi(theme.fg("muted", `[Bash]: ${msg.command}`), width);
    }

    if (msg.role === "custom" && msg.display) {
      const content = typeof msg.content === "string" ? msg.content : msg.content.map((b) => b.type === "text" ? b.text : "[image]").join("");
      return wrapTextWithAnsi(theme.fg("muted", "[Context]: ") + content, width);
    }

    return [];
  }

  handleInput(data: string): boolean {
    // PgUp / PgDn scroll by a full page; Shift+Up / Shift+Down by a few lines.
    if (matchesKey(data, Key.pageUp)) {
      return this.scrollBy(this.maxVisibleLines);
    }
    if (matchesKey(data, Key.pageDown)) {
      return this.scrollBy(-this.maxVisibleLines);
    }
    if (matchesKey(data, Key.shift("up"))) {
      return this.scrollBy(3);
    }
    if (matchesKey(data, Key.shift("down"))) {
      return this.scrollBy(-3);
    }
    return false;
  }

  invalidate() {}
}
