import type { Terminal } from "@earendil-works/pi-tui";

/**
 * Minimal SGR mouse support for the side chat overlay.
 *
 * pi-tui has no built-in mouse handling, so the extension enables
 * xterm mouse reporting (button-event tracking + SGR extended coordinates)
 * while the side chat is open and consumes the sequences before they
 * could leak into the editor as garbage input.
 *
 * Wheel events arrive as button 64 (scroll up) / 65 (scroll down)
 * with SGR encoding: ESC [ < B ; Cx ; Cy M (press) / m (release).
 */

export interface SgrMouseEvent {
  /** SGR button code (0 = left, 1 = middle, 2 = right, 64 = wheel up, 65 = wheel down, ...) */
  button: number;
  /** 1-based column */
  col: number;
  /** 1-based row */
  row: number;
  isRelease: boolean;
}

/** Button-event tracking + SGR extended coordinates */
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export const WHEEL_UP_BUTTON = 64;
export const WHEEL_DOWN_BUTTON = 65;

export function enableMouseReporting(terminal: Terminal): void {
  terminal.write(MOUSE_ENABLE);
}

export function disableMouseReporting(terminal: Terminal): void {
  terminal.write(MOUSE_DISABLE);
}

/** Parse an SGR mouse sequence (complete, as emitted by StdinBuffer). */
export function parseSgrMouseEvent(data: string): SgrMouseEvent | null {
  const match = SGR_MOUSE_RE.exec(data);
  if (!match) return null;
  return {
    button: parseInt(match[1], 10),
    col: parseInt(match[2], 10),
    row: parseInt(match[3], 10),
    isRelease: match[4] === "m",
  };
}
