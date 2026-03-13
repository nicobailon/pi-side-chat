import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { OverlayHandle } from "@mariozechner/pi-tui";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileActivityTracker } from "./file-activity-tracker.js";
import { SideChatOverlay, type ForkContext } from "./side-chat-overlay.js";
import { extractWritePaths } from "./tool-wrapper.js";

const DEFAULT_SHORTCUT = "alt+/";
const OVERLAY_BLOCKED_ERROR = "PI_SIDE_CHAT_OVERLAY_BLOCKED";

function loadConfig(): { shortcut: string } {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const shortcut = typeof config.shortcut === "string" ? config.shortcut.trim() : "";
    return { shortcut: shortcut || DEFAULT_SHORTCUT };
  } catch {
    return { shortcut: DEFAULT_SHORTCUT };
  }
}

export default function sideChatExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const tracker = new FileActivityTracker();
  let activeOverlay: SideChatOverlay | null = null;
  let overlayHandle: OverlayHandle | null = null;

  pi.on("tool_execution_start", (event, ctx) => {
    if (["write", "edit", "bash"].includes(event.toolName)) {
      const paths = extractWritePaths(event.toolName, event.args);
      paths.forEach((p) => tracker.trackWrite(p, ctx.cwd));
    }
  });

  const toggleSideChat = async (ctx: ExtensionContext) => {
    if (activeOverlay) {
      if (overlayHandle?.isFocused()) {
        overlayHandle.unfocus();
      } else {
        overlayHandle?.focus();
      }
      return;
    }

    if (!ctx.model) {
      ctx.ui.notify("Cannot open side chat: no model configured", "error");
      return;
    }

    const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    const forkContext: ForkContext = {
      messages: sessionContext.messages,
      model: ctx.model,
      systemPrompt: ctx.getSystemPrompt(),
      thinkingLevel: pi.getThinkingLevel(),
      cwd: ctx.cwd,
    };

    try {
      await ctx.ui.custom(
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
            shortcut: config.shortcut,
            onOverlapWarning: (path) => showOverlapWarning(ctx.ui, path),
            onClose: () => {
              activeOverlay = null;
              overlayHandle = null;
              done(undefined);
            },
          });
          return activeOverlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "85%",
            maxHeight: "35%",
            anchor: "top-center",
            margin: { top: 1, left: 2, right: 2 },
            nonCapturing: true,
          },
          onHandle: (handle) => {
            overlayHandle = handle;
            handle.focus();
          },
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message === OVERLAY_BLOCKED_ERROR) {
        return;
      }
      activeOverlay = null;
      overlayHandle = null;
      throw error;
    }
  };

  pi.registerShortcut(config.shortcut, {
    description: "Toggle side chat focus (open if closed)",
    handler: toggleSideChat,
  });

  pi.registerCommand("side", {
    description: "Open side chat (fork conversation)",
    handler: (_, ctx) => toggleSideChat(ctx),
  });
}

function showOverlapWarning(ui: ExtensionUIContext, path: string): Promise<boolean> {
  return ui.confirm(
    "File Overlap",
    `Main agent has modified:\n  ${path}\n\nEditing may cause conflicts. Proceed?`
  );
}
