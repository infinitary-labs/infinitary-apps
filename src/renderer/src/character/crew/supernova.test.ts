// The crew's part in the supernova fidget (the captain's ask: "one more
// fidget animation added to the pool for the first mate character that's
// somewhat like a supernova explosion"; the approved preview reaches through
// the crew with a 40 px kick).
import { describe, expect, it } from "vitest";
import { SN_SCHEDULE, SUPERNOVA } from "../supernova";
import { CrewOrbit, DEFAULT_ORBIT, type OrbitFrame } from "./orbit";
import { CrewSupernova } from "./supernova";
import { WARP_RELEASE_MS } from "./warp";

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
 * Play one supernova from `start`, cut at `cutAt` (or played whole), beside
 * a twin that never sees it, until `until`. Returns each crewmate's largest
 * kick and light, the largest jump of any kick between two frames after
 * the cut, and the last frames of both.
 */
function burst(count: number, until: number, cutAt = SETTLE_MS + SUPERNOVA.durationMs) {
  const model = formation(count);
  const twin = formation(count);
  const supernova = new CrewSupernova();
  const kicked = new Map<string, number>();
  const lit = new Map<string, number>();
  const shown = new Map<string, number>();
  let jump = 0;
  let last: OrbitFrame | null = null;
  let still: OrbitFrame | null = null;
  for (let t = SETTLE_MS; t <= until; t += FRAME_MS) {
    if (t < cutAt) supernova.playing(SETTLE_MS, 81, 0);
    else supernova.stopped(t);
    last = model.update(t, false, 0, null, supernova.frame(t));
    still = twin.update(t);
    for (const c of last.crew) {
      const seat = still.crew.find((s) => s.id === c.id);
      if (!seat) continue;
      const off = Math.hypot(c.x - seat.x, c.y - seat.y);
      if (t > cutAt) jump = Math.max(jump, Math.abs(off - (shown.get(c.id) ?? 0)));
      shown.set(c.id, off);
      kicked.set(c.id, Math.max(kicked.get(c.id) ?? 0, off));
      lit.set(c.id, Math.max(lit.get(c.id) ?? 0, c.flash));
    }
  }
  return { kicked, lit, jump, last: last as OrbitFrame, still: still as OrbitFrame };
}

function expectSeated(after: OrbitFrame, home: OrbitFrame, count: number) {
  expect(after.crew).toHaveLength(count);
  for (const c of after.crew) {
    const seat = home.crew.find((s) => s.id === c.id);
    expect(seat, c.id).toBeDefined();
    if (!seat) continue;
    expect(Math.hypot(c.x - seat.x, c.y - seat.y), c.id).toBeLessThan(0.5);
    expect(c.flash, c.id).toBe(seat.flash);
  }
}

describe("the crew's supernova", () => {
  for (const count of [3, 30]) {
    it(`lights and kicks each of ${count} crew, then leaves each on its own seat`, () => {
      const { kicked, lit, last, still } = burst(count, SETTLE_MS + SUPERNOVA.durationMs + 500);
      for (const [id, k] of kicked) {
        // The front reaches every orbit, and its swing is at most the whole kick.
        expect(k, id).toBeGreaterThan(5);
        expect(k, id).toBeLessThanOrEqual(SUPERNOVA.crewKickPx + 0.5);
        expect(lit.get(id), id).toBeGreaterThan(0.5);
      }
      expectSeated(last, still, count);
    });
  }

  it("moves no crewmate before the bounce", () => {
    const { kicked } = burst(8, SETTLE_MS + SUPERNOVA.durationMs * SN_SCHEDULE.bounceAt - FRAME_MS);
    for (const [id, k] of kicked) expect(k, id).toBe(0);
  });

  it("lets the crew go home when a supernova is cut short mid-kick", () => {
    const cutAt = SETTLE_MS + SUPERNOVA.durationMs * (SN_SCHEDULE.bounceAt + 0.1);
    const { kicked, jump, last, still } = burst(8, cutAt + WARP_RELEASE_MS + 100, cutAt);
    expect(Math.max(...kicked.values())).toBeGreaterThan(5);
    // Over the release no crewmate snaps: a 16 ms frame moves it at most a few px.
    expect(jump).toBeLessThan(3);
    expectSeated(last, still, 8);
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
    const supernova = new CrewSupernova();
    for (let t = SETTLE_MS; t <= SETTLE_MS + SUPERNOVA.durationMs / 2; t += FRAME_MS) {
      supernova.playing(SETTLE_MS, 81, 0);
      const frame = remote.update(t, false, 0, null, supernova.frame(t));
      const same = twin.update(t);
      expect(frame.crew.map((c) => [c.x, c.y, c.flash])).toEqual(
        same.crew.map((c) => [c.x, c.y, c.flash]),
      );
    }
  });
});

describe("the shared supernova", () => {
  it("is absent before one, follows the one playing, and ends with it", () => {
    const supernova = new CrewSupernova();
    expect(supernova.frame(0)).toBeNull();
    supernova.playing(1000, 81, 0.4);
    const mid = supernova.frame(1000 + SUPERNOVA.durationMs / 2);
    expect(mid).toMatchObject({ heat: 0.4, coreR: 81, release: 1 });
    expect(mid?.et).toBeCloseTo(0.5, 12);
    supernova.stopped(1000 + SUPERNOVA.durationMs);
    expect(supernova.frame(1000 + SUPERNOVA.durationMs)).toBeNull();
  });

  it("lets go over a warp's release when cut short", () => {
    const supernova = new CrewSupernova();
    supernova.playing(0, 81, 0);
    const at = SUPERNOVA.durationMs / 3;
    supernova.stopped(at);
    expect(supernova.frame(at)?.release).toBe(1);
    expect(supernova.frame(at + WARP_RELEASE_MS / 2)?.release).toBeCloseTo(0.5, 12);
    expect(supernova.frame(at + WARP_RELEASE_MS / 2)?.et).toBeCloseTo(1 / 3, 12);
    expect(supernova.frame(at + WARP_RELEASE_MS)).toBeNull();
  });
});
