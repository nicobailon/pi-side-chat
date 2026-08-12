import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext,
  convertToLlm,
  createCodingTools,
  createReadOnlyTools,
  getSelectListTheme,
  type ModelRegistry,
  type SessionEntry,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Editor, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { FileActivityTracker } from "./file-activity-tracker.ts";
import { forkSurgery } from "./fork-surgery.ts";
import { exportChatHistoryToFile } from "./side-chat-export.ts";
import { substituteTemplate, type PromptPack } from "./prompt-pack.ts";
import { markFramingMessage, SideChatMessages } from "./side-chat-messages.ts";
import { wrapToolsWithOverlapDetection } from "./tool-wrapper.ts";

export interface ForkContext {
  messages: AgentMessage[];
  model: Model<any>;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  extensionTools: AgentTool[];
}

/** Minimal session view used by the side chat (getEntries + getLeafId). */
type SessionView = { getEntries(): SessionEntry[]; getLeafId(): string | null };

interface SideChatOverlayOptions {
  tui: TUI;
  theme: Theme;
  forkContext: ForkContext;
  tracker: FileActivityTracker;
  modelRegistry: ModelRegistry;
  sessionManager: SessionView;
  shortcut: KeyId;
  /** Prompt texts resolved from config.json `promptPack` (fresh per fork). */
  promptPack: PromptPack;
  /** Extension tools allowed in read-only mode (config.json, git-untracked). */
  readOnlyExtensionAllowlist: string[];
  onOverlapWarning: (path: string) => Promise<boolean>;
  onUnfocus: () => void;
  onBackground: () => void;
  onClose: (action: "close" | "refork" | "clear", messages: AgentMessage[]) => void;
  /** Alt+E export written to $CWD/.agents/eval/ — called with the written path. */
  onExport: (path: string) => void;
}

/** Overlay max-height used for the side chat (adapted for small terminals at render time). */
export const SIDE_CHAT_OVERLAY_MAX_HEIGHT = "88%";
export const SIDE_CHAT_OVERLAY_MARGIN_TOP = 1;

/**
 * Chat area height (message lines): 2.5x the original (~0.35 * rows - 10),
 * adapted to small terminals so the overlay never overflows the screen and
 * always leaves a few rows of the main editor visible.
 */
export function computeSideChatHeight(rows: number): number {
  const original = Math.max(3, Math.floor(rows * 0.35) - 10);
  const desired = Math.round(original * 2.5);
  // 7 fixed rows (borders, header, editor, hints) around the message area.
  const overlayCap = Math.max(9, Math.min(Math.floor(rows * 0.88), rows - 4));
  return Math.max(3, Math.min(desired, overlayCap - 7));
}

/**
 * Shared-prefix layout (#9, reverses decision #6): the main lane's system
 * prompt stays in the system slot (verbatim, token-identical request head),
 * and the fork snapshot is injected verbatim below it — main and btw share
 * the gateway's cached prefix. The btw identity/instruction texts live in
 * the prompt pack (framing block message + per-turn focus anchor).
 */

// --- Lane enforcement (prototype for #8, texts from the prompt pack #13) ---
// Trigger points only: transformContext (reminder injection) / beforeToolCall
// (block reason) / afterToolCall (failed-note). UI copy stays in code.

const LANE_BLOCKED_STATUS = "🚧 lane blocked";
const PRE_ABORT_TEXT = "Turn stopped after repeated out-of-lane attempts.";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
  private spinnerInterval: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private lastRenderHeight = 0;
  /** Leading messages injected from the main lane at fork time (context cite). */
  private forkedMessageCount: number;
  /** Tool names allowed in the read-only lane (builtins + allowlist + peek_main). */
  private readOnlyToolNames = new Set<string>();
  /** Out-of-lane attempts in the current turn (reset on each new user message). */
  private laneViolations = 0;
  /** Reminder queued for injection by transformContext before the next LLM call. */
  private pendingReminder: string | null = null;
  /** When true, the turn is aborted right after the escalated reminder is injected. */
  private abortAfterInject = false;

  /**
   * Chat area height (message lines): 2.5x the original (~0.35 * rows - 10),
   * adapted to small terminals so the overlay never overflows the screen and
   * always leaves a few rows of the main editor visible.
   */
  private computeChatHeight(): number {
    return computeSideChatHeight(this.options.tui.terminal.rows);
  }

  /**
   * Screen region occupied by the overlay (0-based rows), used to route mouse
   * wheel events to the chat. Returns null when the overlay is gone.
   */
  getViewport(): { topRow: number; height: number } | null {
    if (this.disposed) return null;
    const rows = this.options.tui.terminal.rows;
    const maxHeight = Math.max(
      1,
      Math.min(parsePercent(SIDE_CHAT_OVERLAY_MAX_HEIGHT, rows), Math.max(1, rows - SIDE_CHAT_OVERLAY_MARGIN_TOP)),
    );
    return {
      topRow: SIDE_CHAT_OVERLAY_MARGIN_TOP,
      height: Math.min(this.lastRenderHeight, maxHeight),
    };
  }

  /** Scroll the message area (positive = toward older content). Mouse wheel handler. */
  scrollByLines(lines: number): boolean {
    const changed = this.messages.scrollBy(lines);
    if (changed) this.options.tui.requestRender();
    return changed;
  }

  get focused() { return this._focused; }
  set focused(v: boolean) { this._focused = v; this.editor.focused = v; }

  constructor(private options: SideChatOverlayOptions) {
    const { tui, theme, forkContext, modelRegistry, sessionManager, promptPack } = options;
    // Fork surgery (#12): make the trailing tool exchange gateway-legal on a
    // clone of the fork snapshot (synthesize missing results, drop orphans).
    const forkedMessages = forkSurgery(structuredClone(forkContext.messages));

    this.forkLeafId = sessionManager.getLeafId();
    this.forkedMessageCount = forkedMessages.length;
    this.peekMainTool = this.createPeekMainTool(sessionManager);
    // Strip philosophy (#7): read-only lane = builtins + allowlisted extension
    // tools + peek_main. Everything else is absent from the list → attempts
    // surface as "Tool X not found" errors (the detection signal).
    this.readOnlyToolNames = new Set(this.buildReadOnlyTools().map((t) => t.name));

    // Framing block (#9): between the cite and the user's first btw message.
    // User-role fallback placement (#11) — the request path keeps only
    // user/assistant/toolResult roles (convertToLlm + openai-completions
    // buildRequest), so trailing-system placement is not reachable through
    // the standard pipeline (ADR-0001 prototype implementation note). The
    // message is marked so the render path never shows it as a chat bubble.
    const framingMessage = markFramingMessage({
      role: "user",
      content: substituteTemplate(promptPack.framing, { cwd: forkContext.cwd, model: forkContext.model.id }),
      timestamp: Date.now(),
    });

    this.agent = new Agent({
      streamFn: streamSimple,
      initialState: {
        // Shared-prefix layout (#9): the MAIN persona stays in the system
        // slot so the request head matches the main lane token-for-token.
        systemPrompt: forkContext.systemPrompt,
        model: forkContext.model,
        thinkingLevel: forkContext.thinkingLevel,
        tools: this.buildReadOnlyTools(),
        messages: [...forkedMessages, framingMessage],
      },
      convertToLlm,
      getApiKey: async (provider) => {
        const key = await modelRegistry.getApiKeyForProvider(provider);
        if (!key) throw new Error("No API key available");
        return key;
      },
      // Transient tail injections (present in the LLM request only, never
      // stored in the transcript), texts from the prompt pack:
      // - focus anchor: every turn, both modes (recency position);
      // - lane preamble: read-only lane only (full mode stays untouched);
      // - pending lane reminder: after an out-of-lane attempt; escalated
      //   violations abort the turn right after the reminder is queued.
      transformContext: async (messages) => {
        const additions: AgentMessage[] = [
          { role: "user", content: promptPack.focusAnchor, timestamp: Date.now() },
        ];
        if (this.toolMode === "read-only") {
          additions.push({ role: "user", content: promptPack.laneReminders.preamble, timestamp: Date.now() });
        }
        if (this.pendingReminder) {
          const reminder = this.pendingReminder;
          this.pendingReminder = null;
          if (this.abortAfterInject) {
            this.abortAfterInject = false;
            this.messages.setErrorContent(PRE_ABORT_TEXT);
            setTimeout(() => this.agent.abort(), 0);
          }
          additions.push({ role: "user", content: reminder, timestamp: Date.now() });
        }
        return [...messages, ...additions];
      },
      // Belt-and-braces: block any residual present-but-disallowed tool with
      // the base reminder as the reason (blocked calls never reach afterToolCall).
      beforeToolCall: async (ctx) => {
        if (this.toolMode !== "read-only") return undefined;
        if (this.readOnlyToolNames.has(ctx.toolCall.name)) return undefined;
        return {
          block: true,
          reason: substituteTemplate(promptPack.laneReminders.base, { tool: ctx.toolCall.name }),
        };
      },
      // Layer 2: re-ground executed-but-failed read-only calls (never fires
      // for blocked/absent tools). Not a violation — no escalation count.
      afterToolCall: async (ctx) => {
        if (this.toolMode !== "read-only" || !ctx.isError) return undefined;
        const content = [...ctx.result.content];
        if (!content.some((c) => c.type === "text" && c.text.includes("🚧"))) {
          content.push({ type: "text", text: promptPack.laneReminders.failedNote });
        }
        return { content };
      },
    });

    this.agent.subscribe((e) => this.handleAgentEvent(e));
    this.messages = new SideChatMessages(theme, 20);
    // The whole forked batch (main-session context or reopened history) is
    // injected at open time: render it as one collapsed cite line, not as
    // full history. New messages appended after the fork render normally.
    // The framing block message is marked and skipped by the render path.
    this.messages.setInjectedMessageCount(forkedMessages.length);
    this.messages.setMessages(forkedMessages);
    this.editor = new Editor(tui, { borderColor: (t) => theme.fg("borderMuted", t), selectList: getSelectListTheme() }, { paddingX: 0 });
    this.editor.onSubmit = (text) => this.handleSubmit(text);
  }

  private createPeekMainTool(sessionManager: SessionView): AgentTool {
    return {
      name: "peek_main",
      label: "peek_main",
      description: "View main agent's recent activity. Use when user asks about main's progress or status.",
      parameters: Type.Object({
        lines: Type.Optional(Type.Integer({ description: "Max items (default: 20)", minimum: 1, maximum: 50 })),
        since_fork: Type.Optional(Type.Boolean({ description: "Only show activity after side chat opened" })),
      }),
      execute: async (_id, params) => {
        const args = (params ?? {}) as { lines?: number; since_fork?: boolean };
        const entries = sessionManager.getEntries();
        const context = buildSessionContext(entries, sessionManager.getLeafId());
        let msgs = context.messages;

        if (args.since_fork && this.forkLeafId) {
          const forkCtx = buildSessionContext(entries, this.forkLeafId);
          msgs = msgs.slice(forkCtx.messages.length);
        }

        const recent = msgs.slice(-(args.lines ?? 20));
        if (!recent.length) {
          return {
            content: [{ type: "text", text: args.since_fork ? "No new activity since fork." : "No recent activity." }],
            details: undefined,
          };
        }

        const formatted = recent.map((m) => this.formatMessage(m)).filter(Boolean).join("\n\n");
        return {
          content: [{ type: "text", text: `Main agent activity (${recent.length} items):\n\n${formatted}` }],
          details: undefined,
        };
      },
    };
  }

  /**
   * Read-only lane tool list (strip philosophy, #7): builtin read tools +
   * allowlisted extension tools (config.json `readOnlyExtensionAllowlist`,
   * git-untracked) + peek_main. Everything else is stripped from the list.
   */
  private buildReadOnlyTools(): AgentTool[] {
    const { forkContext } = this.options;
    const allowlisted = forkContext.extensionTools.filter((t) =>
      this.options.readOnlyExtensionAllowlist.includes(t.name),
    );
    return [...createReadOnlyTools(forkContext.cwd), ...allowlisted, this.peekMainTool];
  }

  /**
   * 1st violation → base reminder; 2nd → escalated wording + turn abort.
   * Texts come from the prompt pack (#13); the reminder is injected by
   * transformContext before the next LLM call.
   */
  private registerLaneViolation(toolName: string) {
    this.laneViolations += 1;
    // Stop the spinner first: the lane-blocked status would otherwise be
    // overwritten by the 80ms spinner tick.
    this.stopSpinner();
    if (this.laneViolations === 1) {
      this.pendingReminder = substituteTemplate(this.options.promptPack.laneReminders.base, { tool: toolName });
      this.messages.setToolStatus(LANE_BLOCKED_STATUS);
    } else {
      this.pendingReminder = substituteTemplate(this.options.promptPack.laneReminders.escalated, {
        tool: toolName,
        count: this.laneViolations,
      });
      this.abortAfterInject = true;
      this.messages.setToolStatus(`${LANE_BLOCKED_STATUS} — escalating`);
    }
    this.options.tui.requestRender();
  }

  private formatMessage(msg: AgentMessage): string {
    if (msg.role === "user") {
      const c = typeof msg.content === "string" ? msg.content : msg.content.map((b) => b.type === "text" ? b.text : "[image]").join("");
      return `[User]: ${c.slice(0, 300)}${c.length > 300 ? "..." : ""}`;
    }
    if (msg.role === "assistant") {
      const fullText = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const text = fullText.slice(0, 500);
      const tools = msg.content.filter((b) => b.type === "toolCall").map((t) => t.name);
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

  private startSpinner() {
    this.stopSpinner();
    this.spinnerFrame = 0;
    this.messages.setToolStatus(`${SPINNER[0]} Working...`);
    this.options.tui.requestRender();
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.messages.setToolStatus(`${SPINNER[this.spinnerFrame]} Working...`);
      this.options.tui.requestRender();
    }, 80);
  }

  private stopSpinner() {
    if (!this.spinnerInterval) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = null;
    this.messages.setToolStatus("");
  }

  private async handleSubmit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming || this.disposed) return;

    // New user message: reset the per-turn lane counter.
    this.laneViolations = 0;
    this.pendingReminder = null;
    this.abortAfterInject = false;

    this.editor.setText("");
    this.isStreaming = true;
    this.streamingContent = "";
    // A new user message resumes bottom-following even if the view was frozen.
    this.messages.resumeFollowing();
    this.messages.setStreamingContent("");
    this.messages.setErrorContent("");
    this.startSpinner();

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
      this.stopSpinner();
      this.messages.setStreamingContent("");
      this.messages.setToolStatus("");
      this.messages.setMessages([...this.agent.state.messages]);
      if (!this.disposed) this.options.tui.requestRender();
    }
  }

  private handleAgentEvent(event: AgentEvent) {
    if (this.disposed) return;

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.stopSpinner();
      this.streamingContent += event.assistantMessageEvent.delta;
      this.messages.setStreamingContent(this.streamingContent);
    } else if (event.type === "message_end") {
      this.messages.setMessages([...this.agent.state.messages]);
      this.messages.setStreamingContent("");
      this.streamingContent = "";
    } else if (event.type === "tool_execution_start") {
      this.stopSpinner();
      this.messages.setToolStatus(`Running ${event.toolName}...`);
    } else if (event.type === "tool_execution_end") {
      this.startSpinner();
      // Detection signal: an error result for a tool that is not in the
      // read-only lane (absent tools produce "Tool X not found" errors).
      if (this.toolMode === "read-only" && event.isError && !this.readOnlyToolNames.has(event.toolName)) {
        this.registerLaneViolation(event.toolName);
      }
    }

    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 4) {
      return [" ".repeat(Math.max(0, width))];
    }

    const { theme, tracker } = this.options;
    const innerWidth = width - 4;
    const borderColor: ThemeColor = this._focused ? "border" : "borderMuted";

    const title = "Side Chat";
    const focusHint = this._focused ? "" : " (unfocused)";
    const mainLabel = tracker.writeCount ? `${tracker.writeCount} file${tracker.writeCount > 1 ? "s" : ""}` : "idle";
    const modeLabel = this.toolMode === "full" ? "Edit" : "Read-only";
    const modeColor: ThemeColor = this.toolMode === "full" ? "warning" : "dim";
    const scrollMark = this.messages.isAtBottom()
      ? ""
      : theme.fg("warning", ` [↑${this.messages.getScrollOffset()}]`);
    const status = theme.fg("dim", `[Main: ${mainLabel}] `) + theme.fg(modeColor, `[${modeLabel}]`) + scrollMark;
    const stream = this.isStreaming ? theme.fg("warning", " ●") : "";
    const left = theme.fg(this._focused ? "accent" : "dim", title) + theme.fg("dim", focusHint) + stream;

    const shortcutLabel = this.options.shortcut.replace(/ctrl/i, "Ctrl").replace(/shift/i, "Shift").replace(/alt/i, "Alt");
    const escHint = this.isStreaming ? "Esc stop" : "Esc close";
    const modeHint = this.toolMode === "read-only" ? "Ctrl+T edit" : "Ctrl+T readonly";
    const scrolled = !this.messages.isAtBottom();
    const scrollHint = scrolled
      ? theme.fg("warning", `↑${this.messages.getScrollOffset()} · PgDn/Wheel ↓ latest`)
      : "PgUp/PgDn/Wheel scroll";
    // Wrap the hint bar onto a second line on narrow terminals so no key hint
    // gets cut off; one message row is traded for the extra hint row then.
    const hintLines = this._focused
      ? buildSideChatHintLines({ innerWidth, scrollHint, escHint, shortcutLabel, modeHint })
      : [`${scrollHint} · ${shortcutLabel} focus · Alt+Q bg`];
    const maxLines = Math.max(3, this.computeChatHeight() - (hintLines.length - 1));
    this.messages.setMaxVisibleLines(maxLines);
    const msgLines = this.messages.render(innerWidth);
    for (let i = msgLines.length; i < maxLines; i++) msgLines.push("");

    const lines = renderSideChatFrame({
      width,
      theme,
      borderColor,
      headerLeft: left,
      headerRight: status,
      msgLines,
      editorLines: this.editor.render(innerWidth),
      hints: hintLines,
    });
    this.lastRenderHeight = lines.length;
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.isStreaming) {
        this.agent.abort();
      } else {
        this.dispose();
      }
      return;
    }
    if (matchesKey(data, Key.alt("q"))) { this.options.onBackground(); return; }
    if (matchesKey(data, this.options.shortcut)) { this.options.onUnfocus(); return; }
    if (matchesKey(data, Key.alt("r"))) { this.dispose("refork"); return; }
    if (matchesKey(data, Key.alt("n"))) { this.dispose("clear"); return; }
    if (matchesKey(data, Key.alt("e"))) { this.exportChatHistory(); return; }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.toolMode = this.toolMode === "full" ? "read-only" : "full";
      // Read-only lane keeps the strip philosophy; edit mode stays untouched
      // (enforcement out of scope until the crash bug is understood, #4).
      const { forkContext, tracker, onOverlapWarning } = this.options;
      this.agent.state.tools = this.toolMode === "read-only"
        ? this.buildReadOnlyTools()
        : [...wrapToolsWithOverlapDetection(createCodingTools(forkContext.cwd), tracker, forkContext.cwd, onOverlapWarning), ...forkContext.extensionTools, this.peekMainTool];
      this.options.tui.requestRender();
      return;
    }
    if (this.messages.handleInput(data)) { this.options.tui.requestRender(); return; }
    this.editor.handleInput(data);
    this.options.tui.requestRender();
  }

  /**
   * Alt+E: export the btw transcript to `$CWD/.agents/eval/pi-side-chat-<ts>.md`
   * as a markdown diagnostic artifact (feature/debug work). The snapshot is
   * taken from the agent state at the moment of the keypress.
   */
  private exportChatHistory() {
    try {
      const path = exportChatHistoryToFile({
        messages: [...this.agent.state.messages],
        streamingContent: this.streamingContent,
        cwd: this.options.forkContext.cwd,
        modelId: this.options.forkContext.model.id,
        toolMode: this.toolMode,
        forkedMessageCount: this.forkedMessageCount,
        streaming: this.isStreaming,
      });
      // Status line feedback inside the overlay + a toast in the main session.
      this.stopSpinner();
      this.messages.setToolStatus(`✓ exported → ${path}`);
      this.options.onExport(path);
    } catch (error) {
      this.messages.setErrorContent(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.options.tui.requestRender();
  }

  dispose(action: "close" | "refork" | "clear" = "close") {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSpinner();
    const messages = [...this.agent.state.messages];
    this.agent.abort();
    this.options.onClose(action, messages);
  }

  invalidate() {
    this.messages.invalidate();
    this.editor.invalidate();
  }
}

function parsePercent(value: string, reference: number): number {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (!match) return reference;
  return Math.floor((reference * parseFloat(match[1])) / 100);
}

/**
 * Pure side chat frame renderer: borders, header, messages, editor, hints.
 * Kept separate so previews/tests can render the exact same frame without a TUI.
 */
export interface SideChatFrameOptions {
  width: number;
  theme: Theme;
  borderColor: ThemeColor;
  headerLeft: string;
  headerRight: string;
  msgLines: string[];
  editorLines: string[];
  hints: string[];
}

export function renderSideChatFrame(opts: SideChatFrameOptions): string[] {
  const { theme, width, borderColor } = opts;
  const innerWidth = width - 4;
  const lines: string[] = [];

  const headerLeftWidth = Math.max(1, innerWidth - visibleWidth(opts.headerRight) - 1);
  const headerLeft = truncateToWidth(opts.headerLeft, headerLeftWidth);
  const headerGap = " ".repeat(Math.max(1, innerWidth - visibleWidth(headerLeft) - visibleWidth(opts.headerRight)));

  lines.push(theme.fg(borderColor, "┌" + "─".repeat(width - 2) + "┐"));
  lines.push(frameLine(theme, borderColor, `${headerLeft}${headerGap}${opts.headerRight}`, innerWidth));
  lines.push(theme.fg(borderColor, "├" + "─".repeat(width - 2) + "┤"));
  for (const line of opts.msgLines) lines.push(frameLine(theme, borderColor, line, innerWidth));
  lines.push(theme.fg(borderColor, "├" + "─".repeat(width - 2) + "┤"));
  for (const line of opts.editorLines) lines.push(frameLine(theme, borderColor, line, innerWidth));
  lines.push(theme.fg(borderColor, "├" + "─".repeat(width - 2) + "┤"));
  for (const line of opts.hints) lines.push(frameLine(theme, borderColor, theme.fg("dim", line), innerWidth));
  lines.push(theme.fg(borderColor, "└" + "─".repeat(width - 2) + "┘"));

  return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
}

function frameLine(theme: Theme, borderColor: ThemeColor, line: string, width: number): string {
  return theme.fg(borderColor, "│ ") + truncateToWidth(line, width, "...", true) + theme.fg(borderColor, " │");
}

/**
 * Build the key-hint bar for the focused overlay. Fits everything on one line
 * when possible, otherwise splits into two lines (scroll hints stay first).
 */
export function buildSideChatHintLines(options: {
  innerWidth: number;
  scrollHint: string;
  escHint: string;
  shortcutLabel: string;
  modeHint: string;
}): string[] {
  const { innerWidth, scrollHint, escHint, shortcutLabel, modeHint } = options;
  const primary = `${scrollHint} · ${escHint} · Enter send`;
  const secondary = `Alt+R fork · Alt+N new · Alt+E export · ${shortcutLabel} main · ${modeHint} · Alt+Q bg`;
  if (visibleWidth(`${primary} · ${secondary}`) <= innerWidth) {
    return [`${primary} · ${secondary}`];
  }
  return [primary, secondary];
}
