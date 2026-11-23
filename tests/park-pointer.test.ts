import { describe, expect, it } from "vitest";
import { type PointerScreen, parkPointer } from "../scripts/park-pointer.ts";

// The Linux journeys' virtual screen parks the pointer on its last pixel
// before any journey (docs/testing.md, "The Linux source desktop"). It does
// so through the X library rather than xdotool, which GitHub's hosted Ubuntu
// images lack, so preparing the screen downloads nothing from Ubuntu's
// mirrors: a refresh of their lists for xdotool fell back to the main archive
// while the machines' own mirrors stopped answering.

/**
 * A stand-in screen: each connection records its calls, and the pointer
 * lands where it was sent, or at `lands`. With `resets`, the screen puts the
 * pointer back at its centre when its last connection closes, as an Xvfb
 * without -noreset does.
 */
function screen({
  lands,
  resets = false,
}: {
  lands?: { x: number; y: number };
  resets?: boolean;
} = {}) {
  const calls: string[] = [];
  let at = { x: 1280, y: 800 };
  let open = 0;
  const connect = (): PointerScreen => {
    const id = ++open;
    return {
      warp(x, y) {
        calls.push(`${id} warp ${x},${y}`);
        at = lands ?? { x, y };
      },
      where() {
        calls.push(`${id} where`);
        return at;
      },
      close() {
        calls.push(`${id} close`);
        if (resets) at = { x: 1280, y: 800 };
      },
    };
  };
  return { connect, calls };
}

describe("parkPointer", () => {
  it("moves the pointer on one connection and reads it back on the next", () => {
    const { connect, calls } = screen();
    expect(parkPointer(connect, 2559, 1599)).toBe(
      "park-pointer: the pointer stays on the pixel at 2559,1599",
    );
    expect(calls).toEqual(["1 warp 2559,1599", "1 close", "2 where", "2 close"]);
  });

  it("stops when the pointer lands anywhere else", () => {
    // X moves a pointer sent off the screen to the screen's nearest edge.
    const { connect, calls } = screen({ lands: { x: 2559, y: 1599 } });
    expect(() => parkPointer(connect, 5000, 5000)).toThrow(
      "The pointer is not on the pixel at 5000,5000: it is at 2559,1599",
    );
    expect(calls.at(-1)).toBe("2 close");
  });

  it("stops when the screen puts the pointer back as its last client leaves", () => {
    const { connect } = screen({ resets: true });
    expect(() => parkPointer(connect, 2559, 1599)).toThrow(
      "The pointer is not on the pixel at 2559,1599: it is at 1280,800",
    );
  });
});
