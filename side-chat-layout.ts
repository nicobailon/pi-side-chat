import type { OverlayOptions } from "@mariozechner/pi-tui";

export type DisplayMode = "compact" | "fullscreen";

const FIXED_CHROME_LINES = 7;
const MIN_COMPACT_MESSAGE_LINES = 3;

export function getOverlayOptions(mode: DisplayMode): OverlayOptions {
  if (mode === "fullscreen") {
    return {
      width: "100%",
      maxHeight: "100%",
      anchor: "top-left",
      margin: 0,
      nonCapturing: true,
    };
  }

  return {
    width: "85%",
    maxHeight: "35%",
    anchor: "top-center",
    margin: { top: 1, left: 2, right: 2 },
    nonCapturing: true,
  };
}

export function getMaxMessageLines(
  terminalRows: number,
  mode: DisplayMode,
  editorLines: number,
): number {
  const targetHeight = mode === "fullscreen"
    ? terminalRows
    : Math.floor(terminalRows * 0.35);

  const minimum = mode === "fullscreen" ? 0 : MIN_COMPACT_MESSAGE_LINES;
  return Math.max(minimum, targetHeight - editorLines - FIXED_CHROME_LINES);
}
