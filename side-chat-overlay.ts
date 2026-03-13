import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  createCodingTools,
  createReadOnlyTools,
  getSelectListTheme,
  type ModelRegistry,
  type SessionManager,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Editor, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@mariozechner/pi-tui";
import type { FileActivityTracker } from "./file-activity-tracker.js";
import { SideChatMessages } from "./side-chat-messages.js";
import { wrapToolsWithOverlapDetection } from "./tool-wrapper.js";

export interface ForkContext {
  messages: AgentMessage[];
  model: Model<any>;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
}

interface SideChatOverlayOptions {
  tui: TUI;
  theme: Theme;
  forkContext: ForkContext;
  tracker: FileActivityTracker;
  modelRegistry: ModelRegistry;
  sessionManager: SessionManager;
  shortcut: string;
  onOverlapWarning: (path: string) => Promise<boolean>;
  onClose: () => void;
}

const SIDE_CHAT_PROMPT = `
---
## Side Chat

You're in a SIDE CHAT parallel to the main agent. Main is working independently and can't see this.

Use \`peek_main\` to see main's activity when user asks about progress or you need context.
Use \`peek_main({ since_fork: true })\` for activity since side chat opened.

Be concise - this is for quick questions. If user wants something main is doing, suggest waiting.`;

export class SideChatOverlay implements Component, Focusable {
  private agent: Agent;
  private messages: SideChatMessages;
  private editor: Editor;
  private isStreaming = false;
  private streamingContent = "";
  private toolMode: "full" | "read-only" = "read-only";
  private _focused = true;
  private disposed = false;
  private forkLeafId: string | null;
  private peekMainTool: AgentTool;

  get focused() { return this._focused; }
  set focused(v: boolean) { this._focused = v; this.editor.focused = v; }

  constructor(private options: SideChatOverlayOptions) {
    const { tui, theme, forkContext, modelRegistry, sessionManager } = options;
    const forkedMessages = JSON.parse(JSON.stringify(forkContext.messages)) as AgentMessage[];
    const initialTools = createReadOnlyTools(forkContext.cwd);

    this.forkLeafId = sessionManager.getLeafId();
    this.peekMainTool = this.createPeekMainTool(sessionManager);

    this.agent = new Agent({
      initialState: {
        systemPrompt: forkContext.systemPrompt + SIDE_CHAT_PROMPT,
        model: forkContext.model,
        thinkingLevel: forkContext.thinkingLevel,
        tools: [...initialTools, this.peekMainTool],
        messages: forkedMessages,
      },
      convertToLlm,
      getApiKey: async (provider) => {
        const key = await modelRegistry.getApiKeyForProvider(provider);
        if (!key) throw new Error("No API key available");
        return key;
      },
    });

    this.agent.subscribe((e) => this.handleAgentEvent(e));
    this.messages = new SideChatMessages(theme, 20);
    this.messages.setMessages(forkedMessages);
    this.editor = new Editor(tui, { borderColor: (t) => theme.fg("borderMuted", t), selectList: getSelectListTheme() }, { paddingX: 0 });
    this.editor.onSubmit = (text) => this.handleSubmit(text);
  }

  private createPeekMainTool(sessionManager: SessionManager): AgentTool {
    return {
      name: "peek_main",
      description: "View main agent's recent activity. Use when user asks about main's progress or status.",
      parameters: Type.Object({
        lines: Type.Optional(Type.Integer({ description: "Max items (default: 20)", minimum: 1, maximum: 50 })),
        since_fork: Type.Optional(Type.Boolean({ description: "Only show activity after side chat opened" })),
      }),
      execute: async (_id, args: { lines?: number; since_fork?: boolean }) => {
        const entries = sessionManager.getEntries();
        const context = buildSessionContext(entries, sessionManager.getLeafId());
        let msgs = context.messages;

        if (args.since_fork && this.forkLeafId) {
          const forkCtx = buildSessionContext(entries, this.forkLeafId);
          msgs = msgs.slice(forkCtx.messages.length);
        }

        const recent = msgs.slice(-(args.lines ?? 20));
        if (!recent.length) {
          return { content: [{ type: "text", text: args.since_fork ? "No new activity since fork." : "No recent activity." }] };
        }

        const formatted = recent.map((m) => this.formatMessage(m)).filter(Boolean).join("\n\n");
        return { content: [{ type: "text", text: `Main agent activity (${recent.length} items):\n\n${formatted}` }] };
      },
    };
  }

  private formatMessage(msg: AgentMessage): string {
    if (msg.role === "user") {
      const c = typeof msg.content === "string" ? msg.content : msg.content.map((b) => b.type === "text" ? b.text : "[image]").join("");
      return `[User]: ${c.slice(0, 300)}${c.length > 300 ? "..." : ""}`;
    }
    if (msg.role === "assistant") {
      const fullText = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const text = fullText.slice(0, 500);
      const tools = msg.content.filter((b) => b.type === "tool_call").map((t) => t.toolName);
      const parts = [text && (text + (fullText.length > 500 ? "..." : "")), tools.length && `[Calling: ${tools.join(", ")}]`].filter(Boolean);
      return parts.length ? `[Assistant]: ${parts.join("\n")}` : "";
    }
    if (msg.role === "toolResult") {
      const fullText = msg.content[0]?.type === "text" ? msg.content[0].text : "";
      const preview = fullText.slice(0, 150);
      return `[${msg.toolName}]: ${preview}${fullText.length > 150 ? "..." : ""}`;
    }
    return "";
  }

  private async handleSubmit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming || this.disposed) return;

    this.editor.setText("");
    this.isStreaming = true;
    this.streamingContent = "";
    this.messages.setStreamingContent("");
    this.messages.setErrorContent("");
    this.messages.setToolStatus("");
    this.options.tui.requestRender();

    try {
      await this.agent.prompt(trimmed);
    } catch (e) {
      this.streamingContent = "";
      if (!this.disposed) {
        this.messages.setErrorContent(e instanceof Error ? e.message : "Unknown error");
      }
    } finally {
      this.isStreaming = false;
      this.streamingContent = "";
      this.messages.setStreamingContent("");
      this.messages.setToolStatus("");
      this.messages.setMessages([...this.agent.state.messages]);
      if (!this.disposed) this.options.tui.requestRender();
    }
  }

  private handleAgentEvent(event: AgentEvent) {
    if (this.disposed) return;

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.streamingContent += event.assistantMessageEvent.delta;
      this.messages.setStreamingContent(this.streamingContent);
    } else if (event.type === "message_end") {
      this.messages.setMessages([...this.agent.state.messages]);
      this.messages.setStreamingContent("");
      this.messages.setToolStatus("");
      this.streamingContent = "";
    } else if (event.type === "tool_execution_start") {
      this.messages.setToolStatus(`Running ${event.toolName}...`);
    } else if (event.type === "tool_execution_end") {
      this.messages.setToolStatus("");
    }

    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 4) {
      return [" ".repeat(Math.max(0, width))];
    }

    const { theme, tracker } = this.options;
    const innerWidth = width - 4;
    const lines: string[] = [];
    const borderColor = this._focused ? "border" : "borderMuted";

    const title = "Side Chat";
    const focusHint = this._focused ? "" : " (unfocused)";
    const mainLabel = tracker.writeCount ? `${tracker.writeCount} file${tracker.writeCount > 1 ? "s" : ""}` : "idle";
    const modeLabel = this.toolMode === "full" ? "Edit" : "Read-only";
    const modeColor = this.toolMode === "full" ? "warning" : "dim";
    const status = theme.fg("dim", `[Main: ${mainLabel}] `) + theme.fg(modeColor, `[${modeLabel}]`);
    const stream = this.isStreaming ? theme.fg("warning", " ●") : "";
    const left = theme.fg(this._focused ? "accent" : "dim", title) + theme.fg("dim", focusHint) + stream;
    const leftWidth = Math.max(1, innerWidth - visibleWidth(status) - 1);
    const headerLeft = truncateToWidth(left, leftWidth);
    const headerGap = " ".repeat(Math.max(1, innerWidth - visibleWidth(headerLeft) - visibleWidth(status)));

    lines.push(theme.fg(borderColor, "┌" + "─".repeat(width - 2) + "┐"));
    lines.push(this.frameLine(`${headerLeft}${headerGap}${status}`, innerWidth, theme, borderColor));
    lines.push(theme.fg(borderColor, "├" + "─".repeat(width - 2) + "┤"));

    const maxLines = Math.max(3, Math.floor(this.options.tui.terminal.rows * 0.35) - 8);
    this.messages.setMaxVisibleLines(maxLines);
    const msgLines = this.messages.render(innerWidth);
    for (const line of msgLines) lines.push(this.frameLine(line, innerWidth, theme, borderColor));
    for (let i = msgLines.length; i < maxLines; i++) lines.push(this.frameLine("", innerWidth, theme, borderColor));

    lines.push(theme.fg(borderColor, "├" + "─".repeat(width - 2) + "┤"));
    for (const line of this.editor.render(innerWidth)) {
      lines.push(this.frameLine(line, innerWidth, theme, borderColor));
    }

    const shortcutLabel = this.options.shortcut.replace(/ctrl/i, "Ctrl").replace(/shift/i, "Shift").replace(/alt/i, "Alt");
    const modeHint = this.toolMode === "read-only" ? "Ctrl+T → edit mode" : "Ctrl+T → read-only";
    const hints = this._focused
      ? `Esc close · Enter send · Shift+↑/↓ scroll · ${shortcutLabel} → unfocus · ${modeHint}`
      : `${shortcutLabel} → focus side chat`;
    lines.push(theme.fg(borderColor, "├" + "─".repeat(width - 2) + "┤"));
    lines.push(this.frameLine(theme.fg("dim", hints), innerWidth, theme, borderColor));
    lines.push(theme.fg(borderColor, "└" + "─".repeat(width - 2) + "┘"));

    return lines;
  }

  private frameLine(line: string, width: number, theme: Theme, borderColor: string): string {
    return theme.fg(borderColor, "│ ") + truncateToWidth(line, width, "...", true) + theme.fg(borderColor, " │");
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.dispose(); return; }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.toolMode = this.toolMode === "full" ? "read-only" : "full";
      const { forkContext, tracker, onOverlapWarning } = this.options;
      const tools = this.toolMode === "read-only"
        ? createReadOnlyTools(forkContext.cwd)
        : wrapToolsWithOverlapDetection(createCodingTools(forkContext.cwd), tracker, forkContext.cwd, onOverlapWarning);
      this.agent.setTools([...tools, this.peekMainTool]);
      this.options.tui.requestRender();
      return;
    }
    if (this.messages.handleInput(data)) { this.options.tui.requestRender(); return; }
    this.editor.handleInput(data);
    this.options.tui.requestRender();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.agent.abort();
    this.options.onClose();
  }

  invalidate() {
    this.messages.invalidate();
    this.editor.invalidate();
  }
}
