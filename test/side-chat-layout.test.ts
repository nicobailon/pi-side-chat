import assert from "node:assert/strict";
import test from "node:test";
import {
  getMaxMessageLines,
  getOverlayOptions,
  type DisplayMode,
} from "../side-chat-layout.ts";

const cases: Array<{ mode: DisplayMode; rows: number; editorLines: number; expected: number }> = [
  { mode: "compact", rows: 40, editorLines: 1, expected: 6 },
  { mode: "compact", rows: 40, editorLines: 4, expected: 3 },
  { mode: "fullscreen", rows: 40, editorLines: 1, expected: 32 },
  { mode: "fullscreen", rows: 40, editorLines: 4, expected: 29 },
  { mode: "compact", rows: 10, editorLines: 4, expected: 3 },
  { mode: "fullscreen", rows: 10, editorLines: 4, expected: 0 },
];

for (const value of cases) {
  test(`${value.mode} budget at ${value.rows} rows with ${value.editorLines} editor lines`, () => {
    assert.equal(getMaxMessageLines(value.rows, value.mode, value.editorLines), value.expected);
  });
}

test("display options toggle from compact to fullscreen and back", () => {
  const compact = getOverlayOptions("compact");
  const fullscreen = getOverlayOptions("fullscreen");

  assert.deepEqual(compact, {
    width: "85%",
    maxHeight: "35%",
    anchor: "top-center",
    margin: { top: 1, left: 2, right: 2 },
    nonCapturing: true,
  });
  assert.deepEqual(fullscreen, {
    width: "100%",
    maxHeight: "100%",
    anchor: "top-left",
    margin: 0,
    nonCapturing: true,
  });
  assert.deepEqual(getOverlayOptions("compact"), compact);
  assert.notEqual(getOverlayOptions("compact"), compact);
});
