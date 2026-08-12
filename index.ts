import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId, OverlayHandle, Terminal, TUI } from "@earendil-works/pi-tui";
import { buildSessionContext, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FileActivityTracker } from "./file-activity-tracker.ts";
import { getExtensionDir, loadPromptPack, type PromptPackManifest } from "./prompt-pack.ts";
import { SideChatOverlay, SIDE_CHAT_OVERLAY_MARGIN_TOP, SIDE_CHAT_OVERLAY_MAX_HEIGHT, type ForkContext } from "./side-chat-overlay.ts";
import { disableMouseReporting, enableMouseReporting, parseSgrMouseEvent, WHEEL_DOWN_BUTTON, WHEEL_UP_BUTTON } from "./side-chat-mouse.ts";
import { extractWritePaths } from "./tool-wrapper.ts";

// Patch to capture the runner instance for extension tool access in side chat.
let capturedRunner: ExtensionRunner | null = null;
const origGetAllRegisteredTools = ExtensionRunner.prototype.getAllRegisteredTools;
ExtensionRunner.prototype.getAllRegisteredTools = function () {
  capturedRunner = this;
  return origGetAllRegisteredTools.call(this);
};

function getExtensionAgentTools(): AgentTool[] {
  if (!capturedRunner) return [];
  return capturedRunner.getAllRegisteredTools().map((rt): AgentTool => {
    const { definition } = rt;
    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      execute: (toolCallId, params, signal, onUpdate) =>
        definition.execute(toolCallId, params, signal, onUpdate, capturedRunner!.createContext()),
    };
  });
}

const DEFAULT_SHORTCUT = "alt+/";
const BACKGROUND_SHORTCUT: KeyId = "alt+q";
const OVERLAY_BLOCKED_ERROR = "PI_SIDE_CHAT_OVERLAY_BLOCKED";

/** Extension directory: base for config.json and prompt-pack paths. */
const extensionDir = getExtensionDir();

function loadConfig(): { shortcut: string; readOnlyExtensionAllowlist: string[]; promptPack: PromptPackManifest | undefined } {
  const configPath = join(extensionDir, "config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const shortcut = typeof config.shortcut === "string" ? config.shortcut.trim() : "";
    // Read-only lane allowlist (#7): extension tools kept in read-only mode.
    // Absent/empty/invalid ⇒ builtins-only.
    const raw = config.readOnlyExtensionAllowlist;
    const readOnlyExtensionAllowlist = Array.isArray(raw)
      ? raw.filter((n: unknown): n is string => typeof n === "string" && n.length > 0)
      : [];
    // Prompt-pack manifest (#13): per-key md paths relative to the extension
    // dir or absolute; absent keys fall back to the bundled prompts/ defaults.
    const rawPack = config.promptPack;
    const promptPack =
      rawPack && typeof rawPack === "object" && !Array.isArray(rawPack)
        ? (rawPack as PromptPackManifest)
        : undefined;
    return { shortcut: shortcut || DEFAULT_SHORTCUT, readOnlyExtensionAllowlist, promptPack };
  } catch {
    return { shortcut: DEFAULT_SHORTCUT, readOnlyExtensionAllowlist: [], promptPack: undefined };
  }
}

export default function sideChatExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const tracker = new FileActivityTracker();
  let activeOverlay: SideChatOverlay | null = null;
  let overlayHandle: OverlayHandle | null = null;
  let lastMessages: AgentMessage[] | null = null;
  let mouseTerminal: Terminal | null = null;
  let removeMouseListener: (() => void) | null = null;

  /**
   * Enable xterm mouse reporting + SGR while the side chat is open and route
   * wheel events over the overlay to the chat scroll. Mouse sequences are always
   * consumed so they never leak into the editor as garbage input.
   */
  const installMouseHandler = (tui: TUI) => {
    if (removeMouseListener) return;
    enableMouseReporting(tui.terminal);
    mouseTerminal = tui.terminal;
    removeMouseListener = tui.addInputListener((data) => {
      const event = parseSgrMouseEvent(data);
      if (!event) return undefined;
      const overlay = activeOverlay;
      if (overlay && !overlayHandle?.isHidden()) {
        const viewport = overlay.getViewport();
        const overOverlay =
          viewport !== null && event.row >= viewport.topRow && event.row < viewport.topRow + viewport.height;
        if (overOverlay) {
          if (event.button === WHEEL_UP_BUTTON) overlay.scrollByLines(3);
          else if (event.button === WHEEL_DOWN_BUTTON) overlay.scrollByLines(-3);
        }
      }
      return { consume: true };
    });
  };

  const uninstallMouseHandler = () => {
    if (!removeMouseListener) return;
    removeMouseListener();
    removeMouseListener = null;
    if (mouseTerminal) {
      disableMouseReporting(mouseTerminal);
      mouseTerminal = null;
    }
  };

  /** Background the side chat (hide it) or restore it from the main session. */
  const backgroundSideChat = async (ctx: ExtensionContext) => {
    if (!activeOverlay) return openSideChat(ctx);
    const handle = overlayHandle;
    if (!handle) return;
    if (handle.isHidden()) {
      handle.setHidden(false);
      handle.focus();
    } else {
      handle.unfocus();
      handle.setHidden(true);
    }
  };

  pi.on("tool_execution_start", (event, ctx) => {
    if (["write", "edit", "bash"].includes(event.toolName)) {
      const paths = extractWritePaths(event.toolName, event.args);
      paths.forEach((p) => tracker.trackWrite(p, ctx.cwd));
    }
  });

  const toggleSideChat = async (ctx: ExtensionContext) => {
    if (activeOverlay) {
      const handle = overlayHandle;
      if (!handle) return;
      if (handle.isHidden()) {
        // Hidden in the background: restore and focus.
        handle.setHidden(false);
        handle.focus();
        return;
      }
      if (handle.isFocused()) {
        handle.unfocus();
      } else {
        handle.focus();
      }
      return;
    }
    return openSideChat(ctx);
  };

  const openSideChat = async (ctx: ExtensionContext, clear = false) => {
    if (!ctx.model) {
      ctx.ui.notify("Cannot open side chat: no model configured", "error");
      return;
    }

    const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    // Prompt pack (#13): read fresh at every fork (no cache) so edits to the
    // manifest files apply on the next fork; per-key fallback + notify.
    const promptPack = loadPromptPack(config.promptPack, {
      extensionDir,
      notify: (message) => ctx.ui.notify(message, "warning"),
    });
    const forkContext: ForkContext = {
      messages: clear ? [] : (lastMessages ?? sessionContext.messages),
      model: ctx.model,
      systemPrompt: ctx.getSystemPrompt(),
      thinkingLevel: pi.getThinkingLevel(),
      cwd: ctx.cwd,
      extensionTools: getExtensionAgentTools(),
    };

    try {
      const action = await ctx.ui.custom<"close" | "refork" | "clear">(
        (tui, theme, _keybindings, done) => {
          if (tui.hasOverlay()) {
            setTimeout(() => {
              ctx.ui.notify("Close or background the current overlay first", "warning");
            }, 0);
            throw new Error(OVERLAY_BLOCKED_ERROR);
          }

          activeOverlay = new SideChatOverlay({
            tui,
            theme,
            forkContext,
            tracker,
            modelRegistry: ctx.modelRegistry,
            sessionManager: ctx.sessionManager,
            shortcut: config.shortcut as KeyId,
            promptPack,
            readOnlyExtensionAllowlist: config.readOnlyExtensionAllowlist,
            onOverlapWarning: (path) => showOverlapWarning(ctx.ui, path),
            onUnfocus: () => overlayHandle?.unfocus(),
            onBackground: () => {
              overlayHandle?.unfocus();
              overlayHandle?.setHidden(true);
            },
            onExport: (path) => ctx.ui.notify(`btw chat exported → ${path}`, "info"),
            onClose: (action, messages) => {
              lastMessages = action === "close" ? messages : null;
              activeOverlay = null;
              overlayHandle = null;
              uninstallMouseHandler();
              done(action);
            },
          });
          installMouseHandler(tui);
          return activeOverlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "85%",
            maxHeight: SIDE_CHAT_OVERLAY_MAX_HEIGHT,
            anchor: "top-center",
            margin: { top: SIDE_CHAT_OVERLAY_MARGIN_TOP, left: 2, right: 2 },
            nonCapturing: true,
          },
          onHandle: (handle) => {
            overlayHandle = handle;
            handle.focus();
          },
        },
      );
      if (action === "refork") return openSideChat(ctx);
      if (action === "clear") return openSideChat(ctx, true);
    } catch (error) {
      if (error instanceof Error && error.message === OVERLAY_BLOCKED_ERROR) {
        return;
      }
      activeOverlay = null;
      overlayHandle = null;
      uninstallMouseHandler();
      throw error;
    }
  };

  pi.registerShortcut(config.shortcut as KeyId, {
    description: "Toggle side chat focus (open if closed)",
    handler: toggleSideChat,
  });

  pi.registerShortcut(BACKGROUND_SHORTCUT, {
    description: "Background or restore the side chat (keeps it running)",
    handler: backgroundSideChat,
  });

  pi.registerCommand("side", {
    description: "Open side chat (fork conversation)",
    handler: (_, ctx) => toggleSideChat(ctx),
  });

  pi.registerCommand("btw", {
    description: "Open side chat (fork conversation) — alias for /side",
    handler: (_, ctx) => toggleSideChat(ctx),
  });
}

function showOverlapWarning(ui: ExtensionUIContext, path: string): Promise<boolean> {
  return ui.confirm(
    "File Overlap",
    `Main agent has modified:\n  ${path}\n\nEditing may cause conflicts. Proceed?`
  );
}
