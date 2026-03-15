import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { OverlayHandle } from "@mariozechner/pi-tui";
import { buildSessionContext, ExtensionRunner } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileActivityTracker } from "./file-activity-tracker.js";
import { SideChatOverlay, type ForkContext } from "./side-chat-overlay.js";
import { extractWritePaths } from "./tool-wrapper.js";

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
  let lastMessages: AgentMessage[] | null = null;

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
    return openSideChat(ctx);
  };

  const openSideChat = async (ctx: ExtensionContext, clear = false) => {
    if (!ctx.model) {
      ctx.ui.notify("Cannot open side chat: no model configured", "error");
      return;
    }

    const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
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
            shortcut: config.shortcut,
            onOverlapWarning: (path) => showOverlapWarning(ctx.ui, path),
            onUnfocus: () => overlayHandle?.unfocus(),
            onClose: (action, messages) => {
              lastMessages = action === "close" ? messages : null;
              activeOverlay = null;
              overlayHandle = null;
              done(action);
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
      if (action === "refork") return openSideChat(ctx);
      if (action === "clear") return openSideChat(ctx, true);
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
