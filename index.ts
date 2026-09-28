import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@mariozechner/pi-tui";
import { buildSessionContext, ExtensionRunner, getAgentDir } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FileActivityTracker } from "./file-activity-tracker.ts";
import { getOverlayOptions } from "./side-chat-layout.ts";
import { SideChatOverlay, type ForkContext } from "./side-chat-overlay.ts";
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
const DEFAULT_FULLSCREEN_SHORTCUT = "alt+shift+m";
const OVERLAY_BLOCKED_ERROR = "PI_SIDE_CHAT_OVERLAY_BLOCKED";

type OverlayFocus = Pick<OverlayHandle, "focus" | "unfocus" | "isFocused">;
// OMP exposes the focused component on the TUI instead of focus methods on the overlay handle.
type FocusTUI = TUI & { getFocused?: () => Component | null };

function hasHandleFocus(handle: Partial<OverlayFocus>): handle is OverlayFocus {
  return typeof handle.focus === "function"
    && typeof handle.unfocus === "function"
    && typeof handle.isFocused === "function";
}

function getOverlayFocus(
  handle: OverlayHandle,
  tui: FocusTUI,
  overlay: SideChatOverlay,
  parent: Component | null,
): OverlayFocus {
  // Pi: keep using the host's overlay handle unchanged.
  if (hasHandleFocus(handle)) return handle;
  if (typeof tui.getFocused !== "function") {
    throw new Error("Side chat needs overlay handle focus methods or tui.getFocused()");
  }

  // OMP only lets focus leave a visible overlay for targets the overlay claims.
  // Claim the component that was focused before the side chat opened so it can
  // be refocused while the side chat stays visible.
  Object.assign(overlay, {
    ownsOverlayFocusTarget: (component: Component | null) => component === parent,
  });
  const getFocused = tui.getFocused.bind(tui);
  return {
    focus: () => {
      tui.setFocus(overlay);
      tui.requestRender();
    },
    unfocus: () => {
      tui.setFocus(parent);
      tui.requestRender();
    },
    isFocused: () => getFocused() === overlay,
  };
}

function loadConfig(): { shortcut: string; fullscreenShortcut: string } {
  const configPath = join(getAgentDir(), "pi-side-chat.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const shortcut = typeof config.shortcut === "string" ? config.shortcut.trim() : "";
    const fullscreenShortcut = typeof config.fullscreenShortcut === "string"
      ? config.fullscreenShortcut.trim()
      : "";
    return {
      shortcut: shortcut || DEFAULT_SHORTCUT,
      fullscreenShortcut: fullscreenShortcut || DEFAULT_FULLSCREEN_SHORTCUT,
    };
  } catch {
    return {
      shortcut: DEFAULT_SHORTCUT,
      fullscreenShortcut: DEFAULT_FULLSCREEN_SHORTCUT,
    };
  }
}

export default function sideChatExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const tracker = new FileActivityTracker();
  let activeOverlay: SideChatOverlay | null = null;
  let overlayFocus: OverlayFocus | null = null;
  let lastMessages: AgentMessage[] | null = null;

  pi.on("tool_execution_start", (event, ctx) => {
    if (["write", "edit", "bash"].includes(event.toolName)) {
      const paths = extractWritePaths(event.toolName, event.args);
      paths.forEach((p) => tracker.trackWrite(p, ctx.cwd));
    }
  });

  const toggleSideChat = async (ctx: ExtensionContext) => {
    if (activeOverlay) {
      if (overlayFocus?.isFocused()) {
        overlayFocus.unfocus();
      } else {
        overlayFocus?.focus();
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
      restored: !clear && lastMessages !== null,
      model: ctx.model,
      systemPrompt: ctx.getSystemPrompt(),
      thinkingLevel: pi.getThinkingLevel(),
      cwd: ctx.cwd,
      extensionTools: getExtensionAgentTools(),
    };
    const overlayOptions = getOverlayOptions("compact");
    let overlayTui: FocusTUI | null = null;
    let parentFocus: Component | null = null;

    try {
      const action = await ctx.ui.custom<"close" | "refork" | "clear">(
        (tui, theme, _keybindings, done) => {
          if (tui.hasOverlay()) {
            setTimeout(() => {
              ctx.ui.notify("Close or background the current overlay first", "warning");
            }, 0);
            throw new Error(OVERLAY_BLOCKED_ERROR);
          }

          overlayTui = tui;
          // Capture before the overlay exists so OMP can hand focus back to it.
          parentFocus = overlayTui.getFocused?.() ?? null;
          activeOverlay = new SideChatOverlay({
            tui,
            theme,
            forkContext,
            tracker,
            modelRegistry: ctx.modelRegistry,
            sessionManager: ctx.sessionManager,
            shortcut: config.shortcut,
            fullscreenShortcut: config.fullscreenShortcut,
            onDisplayModeChange: (mode) => {
              // pi-tui retains this object and reads its fields on each render.
              Object.assign(overlayOptions, getOverlayOptions(mode));
            },
            onOverlapWarning: (path) => showOverlapWarning(ctx.ui, path),
            onUnfocus: () => overlayFocus?.unfocus(),
            onClose: (action, messages) => {
              lastMessages = action === "close" ? messages : null;
              activeOverlay = null;
              overlayFocus = null;
              done(action);
            },
          });
          return activeOverlay;
        },
        {
          overlay: true,
          overlayOptions,
          onHandle: (handle) => {
            if (!activeOverlay || !overlayTui) return;
            overlayFocus = getOverlayFocus(handle, overlayTui, activeOverlay, parentFocus);
            overlayFocus.focus();
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
      overlayFocus = null;
      throw error;
    }
  };

  pi.registerShortcut(config.shortcut, {
    description: "Toggle side chat focus (open if closed)",
    handler: toggleSideChat,
  });

  pi.registerShortcut(config.fullscreenShortcut, {
    description: "Toggle side chat fullscreen mode",
    handler: () => activeOverlay?.toggleDisplayMode(),
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
