import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Key, matchesKey, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

export class SideChatMessages implements Component {
  private messages: AgentMessage[] = [];
  private streamingContent = "";
  private errorContent = "";
  private toolStatus = "";
  private scrollOffset = 0;
  private totalLines = 0;

  constructor(private theme: Theme, private maxVisibleLines: number) {}

  setMessages(messages: AgentMessage[]) {
    this.messages = messages;
    this.scrollOffset = 0;
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
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.totalLines - this.maxVisibleLines));
  }

  render(width: number): string[] {
    const lines: string[] = [];

    for (const msg of this.messages) {
      const messageLines = this.renderMessage(msg, width);
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
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.shift("up"))) {
      this.scrollOffset = Math.min(this.scrollOffset + 5, Math.max(0, this.totalLines - this.maxVisibleLines));
      return true;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.shift("down"))) {
      this.scrollOffset = Math.max(this.scrollOffset - 5, 0);
      return true;
    }
    return false;
  }

  invalidate() {}
}
