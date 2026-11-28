// The crew's part in the meteor fidgets (the approved plan: only crewmates
// circling the first mate catch the light, by the captain's crew-light
// setting; nothing moves a crewmate; other computers' groups stay as they are).
import { describe, expect, it } from "vitest";
import { METEORS, type MeteorVariant } from "../meteors";
import { CrewMeteors } from "./meteors";
import { CrewOrbit, DEFAULT_ORBIT, type OrbitFrame } from "./orbit";
import { WARP_RELEASE_MS } from "./warp";

const FRAME_MS = 16;
/** Long enough for every spawn to land and every spring to come to rest. */
const SETTLE_MS = 4000;
const RANK = Array.from({ length: 16 }, (_, i) => i);
const HOME = new Float64Array(32).map((_, k) => {
  const a = (Math.floor(k / 2) / 16) * Math.PI * 2;
  return (k % 2 ? Math.sin(a) : Math.cos(a)) * 60;
});

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
 * Play one meteor fidget from SETTLE_MS beside a twin that never sees it,
 * cut at `cutAt` (or played whole), until `until`. Returns each crewmate's
 * largest light and largest move off its twin, and the last frames of both.
 */
function play(
  variant: MeteorVariant,
  count: number,
  until: number,
  cutAt = SETTLE_MS + METEORS[variant].durationMs,
  projection?: ConstructorParameters<typeof CrewOrbit>[4],
) {
  const model = formation(count, projection);
  const twin = formation(count, projection);
  const meteors = new CrewMeteors();
  const lit = new Map<string, number>();
  let moved = 0;
  let last: OrbitFrame | null = null;
  let still: OrbitFrame | null = null;
  for (let t = SETTLE_MS; t <= until; t += FRAME_MS) {
    if (t < cutAt) meteors.playing(variant, SETTLE_MS, 75.6, 0, HOME, RANK);
    else meteors.stopped(t);
    last = model.update(t, false, 0, null, null, meteors.frame(t));
    still = twin.update(t);
    for (const c of last.crew) {
      const seat = still.crew.find((s) => s.id === c.id);
      if (!seat) continue;
      moved = Math.max(moved, Math.hypot(c.x - seat.x, c.y - seat.y));
      lit.set(c.id, Math.max(lit.get(c.id) ?? 0, c.flash - seat.flash));
    }
  }
  return { lit, moved, last: last as OrbitFrame, still: still as OrbitFrame };
}

function expectAsTwin(after: OrbitFrame, twin: OrbitFrame) {
  expect(after.crew.map((c) => [c.id, c.x, c.y, c.flash])).toEqual(
    twin.crew.map((c) => [c.id, c.x, c.y, c.flash]),
  );
}

describe("the crew under the meteors", () => {
  for (const variant of ["shower", "storm", "fireball"] as const) {
    it(`${variant} lights crewmates it passes, moves none, and leaves each as it was`, () => {
      const { lit, moved, last, still } = play(
        variant,
        30,
        SETTLE_MS + METEORS[variant].durationMs + 100,
      );
      expect(moved).toBe(0);
      const lights = [...lit.values()];
      expect(Math.max(...lights)).toBeGreaterThan(0.3);
      // A meteor lights the crew it passes, not every crewmate at once.
      expect(lights.filter((v) => v < 0.05).length).toBeGreaterThan(0);
      expectAsTwin(last, still);
    });
  }

  it("lets the light go over a warp's release when a fidget is cut short", () => {
    const cutAt = SETTLE_MS + METEORS.fireball.durationMs * 0.4;
    const { last, still } = play("fireball", 30, cutAt + WARP_RELEASE_MS + 100, cutAt);
    expectAsTwin(last, still);
  });

  it("leaves a remote computer's group dark and in place", () => {
    // A remote cluster's orbit is the one given a projection (./computers.ts).
    const beside = (scene: { x: number; y: number; depth: number }) => ({
      x: scene.x * 0.5 + 400,
      y: scene.y * 0.5,
      depth: scene.depth,
    });
    const { lit, moved } = play(
      "fireball",
      8,
      SETTLE_MS + METEORS.fireball.durationMs,
      undefined,
      beside,
    );
    expect(moved).toBe(0);
    for (const [id, v] of lit) expect(v, id).toBe(0);
  });
});

describe("the shared meteor fidget", () => {
  it("is absent before one, follows the one playing, and ends with it", () => {
    const meteors = new CrewMeteors();
    expect(meteors.frame(0)).toBeNull();
    meteors.playing("storm", 1000, 75.6, 0.4, HOME, RANK);
    const mid = meteors.frame(1000 + METEORS.storm.durationMs / 2);
    expect(mid).toMatchObject({ variant: "storm", heat: 0.4, coreR: 75.6, release: 1 });
    expect(mid?.et).toBeCloseTo(0.5, 12);
    meteors.stopped(1000 + METEORS.storm.durationMs);
    expect(meteors.frame(1000 + METEORS.storm.durationMs)).toBeNull();
  });

  it("holds a cut-short fidget where it stopped while its sky fades", () => {
    const meteors = new CrewMeteors();
    meteors.playing("shower", 0, 75.6, 0, HOME, RANK);
    const at = METEORS.shower.durationMs / 3;
    meteors.stopped(at);
    expect(meteors.frame(at)?.release).toBe(1);
    expect(meteors.frame(at + WARP_RELEASE_MS / 2)?.release).toBeCloseTo(0.5, 12);
    expect(meteors.frame(at + WARP_RELEASE_MS / 2)?.et).toBeCloseTo(1 / 3, 12);
    expect(meteors.frame(at + WARP_RELEASE_MS)).toBeNull();
  });
});
