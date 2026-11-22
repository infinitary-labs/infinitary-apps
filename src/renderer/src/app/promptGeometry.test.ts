import { describe, expect, it } from "vitest";
import {
  MATE_FRAME,
  PROMPT_FLOOR,
  PROMPT_HEIGHT,
  promptShellMax,
  STAGE_LIFT,
} from "./promptGeometry";

function edges(height: number, shell: number) {
  const rise = shell - PROMPT_HEIGHT;
  return {
    frameBottom: height / 2 - STAGE_LIFT - rise / 2 + MATE_FRAME / 2,
    shellTop: height - PROMPT_FLOOR - shell,
  };
}

describe("promptShellMax", () => {
  it("lets the shell grow exactly to the Firstmate's frame and no further", () => {
    for (const height of [640, 800, 1080]) {
      const max = promptShellMax(height);
      const at = edges(height, max);
      expect(at.shellTop).toBeCloseTo(at.frameBottom);
      const past = edges(height, max + 1);
      expect(past.shellTop).toBeLessThan(past.frameBottom);
    }
  });

  it("leaves room for eight lines at 800 and about six at the 640 minimum", () => {
    const line = 16 * 1.55;
    // The multi-line shell's chrome: border, the text row's padding, the foot row.
    const chrome = 2 + 24 + 40;
    expect(Math.floor((promptShellMax(800) - chrome) / line)).toBeGreaterThanOrEqual(8);
    expect(Math.floor((promptShellMax(640) - chrome) / line)).toBe(6);
  });
});
