import { describe, expect, it } from "vitest";
import { CINCH, CinchClock, cinchBody, cinchFrame, cinchMotes, cinchStill } from "./cinch";

// INF-3011: while the first mate shortens its conversation it plays the
// captain's pick, the cinch, for the whole time the shortening runs; a
// shortening only heard ending plays the start and the end back to back.

describe("the cinch's envelope", () => {
  it("draws tight over the start, holds while the shortening runs, and comes back to rest", () => {
    expect(cinchFrame(0, null)).toMatchObject({ phase: "in", k: 0 });
    expect(cinchFrame(CINCH.inMs - 1, null)?.k).toBeCloseTo(1, 3);
    // A long shortening holds tight for as long as it runs.
    const deep = cinchFrame(CINCH.inMs + 60_000, null);
    expect(deep?.phase).toBe("hold");
    expect(deep?.k).toBeGreaterThanOrEqual(1 - CINCH.pump);
    // It ended at 5 s: the end plays, springs back past its size, then is done.
    const endedAt = 5000;
    const out = [0.2, 0.5, 0.8].map((u) => cinchFrame(endedAt + u * CINCH.outMs, endedAt));
    for (const frame of out) expect(frame?.phase).toBe("out");
    expect(Math.min(...out.map((frame) => frame?.k ?? 0))).toBeLessThan(0);
    expect(cinchFrame(endedAt + CINCH.outMs, endedAt)).toBeNull();
  });

  it("loosens and tightens once per rhythm while it holds", () => {
    const at = (s: number) => cinchFrame(CINCH.inMs + s * 1000, null)?.k ?? Number.NaN;
    expect(at(0)).toBeCloseTo(1, 6);
    expect(at(CINCH.rhythmS / 2)).toBeCloseTo(1 - CINCH.pump, 6);
    expect(at(CINCH.rhythmS)).toBeCloseTo(1, 6);
    expect(at(0.3)).toBeCloseTo(at(0.3 + 3 * CINCH.rhythmS), 6);
  });

  it("plays a shortening only heard ending as the start then the end", () => {
    expect(cinchFrame(CINCH.inMs / 2, 0)?.phase).toBe("in");
    expect(cinchFrame(CINCH.inMs + 1, 0)?.phase).toBe("out");
    expect(cinchFrame(CINCH.inMs + CINCH.outMs - 1, 0)).not.toBeNull();
    expect(cinchFrame(CINCH.inMs + CINCH.outMs, 0)).toBeNull();
  });

  it("holds the tight pose still under Reduce Motion while the shortening runs", () => {
    expect(cinchStill(true)).toMatchObject({ phase: "hold", k: 1 });
    expect(cinchStill(false)).toBeNull();
  });

  it("draws the body to the captain's tightness and back", () => {
    expect(cinchBody(1).scale).toBeCloseTo(1 - (1 - CINCH.tightness), 6);
    expect(cinchBody(0)).toMatchObject({ scale: 1, spin: 1, lid: 0, outer: 1 });
    expect(cinchBody(-0.1).scale).toBeGreaterThan(1);
  });
});

describe("the cinch's motes", () => {
  it("stream in while it runs and stop being born once it ends", () => {
    expect(cinchMotes(cinchFrame(CINCH.inMs / 2, null) ?? fail()).motes.length).toBeGreaterThan(0);
    const endedAt = 4000;
    const late = cinchMotes(cinchFrame(endedAt + CINCH.outMs - 1, endedAt) ?? fail());
    expect(late.motes).toEqual([]);
    // No slot born after the end shows up during it.
    for (let t = endedAt; t < endedAt + CINCH.outMs; t += 50) {
      const { motes } = cinchMotes(cinchFrame(t, endedAt) ?? fail());
      for (const mote of motes) {
        const born =
          mote.slot >= 1000
            ? CINCH.inMs + (mote.slot - 1000) * CINCH.moteHoldMs
            : mote.slot * CINCH.moteInMs;
        expect(born).toBeLessThanOrEqual(endedAt);
      }
    }
  });

  it("are the same at the same moment", () => {
    const frame = cinchFrame(CINCH.inMs + 3333, null) ?? fail();
    expect(cinchMotes(frame)).toEqual(cinchMotes(frame));
  });
});

describe("the cinch's clock", () => {
  it("plays the whole span from the start it hears to the end it hears", () => {
    const clock = new CinchClock(0);
    clock.update(0, false, 0);
    expect(clock.frame(0)).toBeNull();
    clock.update(1000, true, 1);
    clock.update(9000, true, 1);
    expect(clock.frame(9000)?.phase).toBe("hold");
    clock.update(10_000, false, 1);
    expect(clock.frame(10_000 + CINCH.outMs / 2)?.phase).toBe("out");
    expect(clock.frame(10_000 + CINCH.outMs)).toBeNull();
  });

  it("plays the short version when the start and the end arrive in one frame", () => {
    const clock = new CinchClock(3);
    clock.update(500, false, 4);
    expect(clock.frame(500)?.phase).toBe("in");
    expect(clock.frame(500 + CINCH.inMs + 1)?.phase).toBe("out");
    expect(clock.frame(500 + CINCH.inMs + CINCH.outMs)).toBeNull();
  });

  it("plays nothing for the starts it was made with", () => {
    const clock = new CinchClock(7);
    clock.update(100, false, 7);
    expect(clock.frame(100)).toBeNull();
  });
});

function fail(): never {
  throw new Error("expected a frame");
}
