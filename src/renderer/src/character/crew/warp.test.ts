// The crew's ride through the warp fidgets (INF-1750's recorded spec: "a
// shared warp level ... that the orbit reads, with every crewmate ending on
// its own seat"; the captain's answer on who rides: "Only the crew circling
// the first mate").
import { describe, expect, it } from "vitest";
import { WARP, WARP_VARIANTS, type WarpVariant } from "../warp";
import { CrewOrbit, DEFAULT_ORBIT, type OrbitFrame } from "./orbit";
import { CrewWarp, WARP_RELEASE_MS } from "./warp";

const FRAME_MS = 16;
/** Long enough for every spawn to land and every spring to come to rest. */
const SETTLE_MS = 4000;

function seeded() {
  let s = 11;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function formation(count: number, projection?: ConstructorParameters<typeof CrewOrbit>[4]) {
  const model = new CrewOrbit(0, { ...DEFAULT_ORBIT }, seeded(), "adaptive", projection);
  for (let i = 0; i < count; i++) model.spawn(`crew-${i}`, "working", 0);
  for (let t = 0; t <= SETTLE_MS; t += FRAME_MS) model.update(t);
  return model;
}

/**
 * Fly one warp that begins at `start`, frame by frame, until `until`; returns
 * the extra travel the crew covered (ms of their own pace), the largest move
 * any crewmate made between two frames, and the frames on the way.
 */
function fly(model: CrewOrbit, variant: WarpVariant, start: number, until: number) {
  const warp = new CrewWarp();
  let lead = 0;
  let largestStep = 0;
  let previous: OrbitFrame | null = null;
  const frames: OrbitFrame[] = [];
  for (let t = start; t <= until; t += FRAME_MS) {
    if (t < start + WARP.durationMs) warp.playing(variant, start, 81, 0);
    else warp.stopped(t);
    const frame = model.update(t, false, 0, warp.frame(t));
    lead += (frame.travel - 1) * FRAME_MS;
    if (previous) {
      for (const c of frame.crew) {
        const before = previous.crew.find((p) => p.id === c.id);
        if (before && before.alpha > 0.01 && c.alpha > 0.01)
          largestStep = Math.max(largestStep, Math.hypot(c.x - before.x, c.y - before.y));
      }
    }
    previous = frame;
    frames.push(frame);
  }
  return { lead, largestStep, frames };
}

function calm(model: CrewOrbit, from: number, until: number): OrbitFrame {
  let frame = model.update(from);
  for (let t = from + FRAME_MS; t <= until; t += FRAME_MS) frame = model.update(t);
  return frame;
}

describe("the crew's warp", () => {
  for (const count of [3, 30]) {
    for (const variant of WARP_VARIANTS) {
      it(`brings each of ${count} crew home to its own seat after the ${variant}`, () => {
        const warped = formation(count);
        const twin = formation(count);
        const end = SETTLE_MS + WARP.durationMs + 1500;
        const { lead, frames } = fly(warped, variant, SETTLE_MS, end);
        const mid = frames[Math.round(frames.length * 0.45)] as OrbitFrame;
        const seatAtMid = calm(formation(count), SETTLE_MS, SETTLE_MS + WARP.durationMs * 0.45);
        const moved = mid.crew.some((c) => {
          const seat = seatAtMid.crew.find((s) => s.id === c.id);
          return seat && Math.hypot(c.x - seat.x, c.y - seat.y) > 10;
        });
        expect(moved).toBe(true);
        expect(lead).toBeGreaterThan(1000);
        const after = frames[frames.length - 1] as OrbitFrame;
        // The twin never warped; ahead by the same lead, its crew sit where
        // the warped crew now sit, as they look and on the same canvas.
        const home = calm(twin, SETTLE_MS, end + lead);
        expect(after.travel).toBe(1);
        expect(after.crew).toHaveLength(count);
        for (const c of after.crew) {
          const seat = home.crew.find((s) => s.id === c.id);
          expect(seat, c.id).toBeDefined();
          if (!seat) continue;
          expect(Math.hypot(c.x - seat.x, c.y - seat.y), c.id).toBeLessThan(0.5);
          // The lead is summed a frame at a time, so the twin can sit a
          // fraction of a frame apart: within half a pixel, a hundredth in size.
          expect(c.depth).toBeCloseTo(seat.depth, 2);
          expect(c.size).toBeCloseTo(seat.size, 2);
          expect(c.alpha).toBeCloseTo(seat.alpha, 2);
          expect(c.streak).toBeUndefined();
        }
      });
    }
  }

  it("never jumps a rider while it is shown, from the first frame to the last", () => {
    for (const variant of WARP_VARIANTS) {
      const model = formation(8);
      const { largestStep } = fly(model, variant, SETTLE_MS, SETTLE_MS + WARP.durationMs + 500);
      // A rider travels fast at warp speed, but always along a path: no
      // single 16 ms frame carries it across the formation.
      expect(largestStep, variant).toBeLessThan(DEFAULT_ORBIT.radius * 0.5);
    }
  });

  it("leaves a remote computer's group in place", () => {
    // A remote cluster's orbit is the one given a projection (./computers.ts).
    const beside = (scene: { x: number; y: number; depth: number }) => ({
      x: scene.x * 0.5 + 400,
      y: scene.y * 0.5,
      depth: scene.depth,
    });
    const remote = formation(5, beside);
    const twin = formation(5, beside);
    const warp = new CrewWarp();
    for (let t = SETTLE_MS; t <= SETTLE_MS + WARP.durationMs / 2; t += FRAME_MS) {
      warp.playing("tunnel", SETTLE_MS, 81, 0);
      const frame = remote.update(t, false, 0, warp.frame(t));
      const same = twin.update(t);
      expect(frame.travel).toBe(1);
      expect(frame.crew.map((c) => [c.x, c.y])).toEqual(same.crew.map((c) => [c.x, c.y]));
    }
  });
});

describe("the shared warp", () => {
  it("is absent before a warp, follows the one playing, and ends with it", () => {
    const warp = new CrewWarp();
    expect(warp.frame(0)).toBeNull();
    warp.playing("sphere", 1000, 81, 0.4);
    const mid = warp.frame(1000 + WARP.durationMs / 2);
    expect(mid).toMatchObject({ variant: "sphere", heat: 0.4, coreR: 81 });
    expect(mid?.et).toBeCloseTo(0.5, 12);
    expect(mid?.k).toBe(1);
    // Ending on its own leaves nothing to let go of.
    warp.stopped(1000 + WARP.durationMs);
    expect(warp.frame(1000 + WARP.durationMs)).toBeNull();
  });

  it("lets the crew go home over a short release when a warp is cut short", () => {
    const warp = new CrewWarp();
    warp.playing("corkscrew", 0, 81, 0);
    const at = WARP.durationMs / 2;
    expect(warp.frame(at)?.k).toBe(1);
    warp.stopped(at);
    expect(warp.frame(at)?.k).toBe(1);
    expect(warp.frame(at + WARP_RELEASE_MS / 2)?.k).toBeCloseTo(0.5, 12);
    expect(warp.frame(at + WARP_RELEASE_MS)).toBeNull();
    expect(warp.frame(at + WARP_RELEASE_MS + 1000)).toBeNull();
  });
});
