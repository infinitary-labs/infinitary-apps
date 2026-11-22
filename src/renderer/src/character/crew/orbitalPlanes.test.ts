import { describe, expect, it } from "vitest";
import staged from "../../../../../tests/fixtures/crew-orbits/growing-ring-settings.json";
import { type CrewmateFrame, CrewOrbit, DEFAULT_ORBIT } from "./orbit";
import { CROWDED_PLANES, planePhase, planeRadius, projectPlane } from "./orbitalPlanes";
import { CREW_RUSH, streakArc } from "./rush";

// The captain's accepted growing ring (INF-1179's orbit_layout and answers).
const ring = staged.orbit_layout.product;
const DEG = Math.PI / 180;
const cap = (k: number) => ring.capRadiusPx - k * ring.orbitStepPx;
/** The staged rule's radius for orbit k with n crew on it while it is the innermost. */
const grown = (k: number, n: number) =>
  Math.min(
    cap(k),
    ring.startRadiusPx + ((cap(k) - ring.startRadiusPx) * (n - 1)) / (ring.seatsPerOrbit - 1),
  );

const adaptive = () => new CrewOrbit(0, { ...DEFAULT_ORBIT }, () => 0.37, "adaptive");
function seed(m: CrewOrbit, count: number) {
  for (let i = 0; i < count; i++) m.spawn(`c${i}`, i % 2 ? "idle" : "working", 0, true);
  m.settleBootRoster(0);
}
function advance(m: CrewOrbit, from: number, until: number) {
  let f = m.update(from);
  for (let t = from + 16; t <= until; t += 16) f = m.update(t);
  return f;
}
function angle(f: CrewmateFrame) {
  const p = CROWDED_PLANES[f.plane ?? 0];
  if (!p) throw new Error("No plane");
  const u = f.x * Math.cos(p.node) + f.y * Math.sin(p.node);
  const v = -f.x * Math.sin(p.node) + f.y * Math.cos(p.node);
  return Math.atan2(v / Math.cos((p.inclination * Math.PI) / 180), u);
}
const wrapped = (n: number) => Math.atan2(Math.sin(n), Math.cos(n));
/** Crew on each orbit in a frame, departing crew not counted. */
const countsOf = (f: { crew: CrewmateFrame[] }) =>
  CROWDED_PLANES.map((_, p) => f.crew.filter((c) => c.phase !== "leaving" && c.plane === p).length);
/** Where a member's orbit puts it in this frame, at the radius its crew give the orbit. */
const onOrbit = (f: { crew: CrewmateFrame[] }, c: CrewmateFrame) =>
  projectPlane(c.plane ?? 0, angle(c), planeRadius(c.plane ?? 0, countsOf(f)));

describe("approved product formation", () => {
  it("projects the captain's staged two orbits with their tilts, turns and signed travel", () => {
    expect(CROWDED_PLANES).toHaveLength(ring.maxOrbits);
    CROWDED_PLANES.forEach((p, k) => {
      expect(p.radius).toBe(cap(k));
      expect(p.capacity).toBe(ring.seatsPerOrbit);
      const tilt = 8 + ((((ring.firstTiltDeg - 8 + k * ring.tiltStepDeg) % 74) + 74) % 74);
      const node = (ring.firstNodeDeg + k * ring.nodeStepDeg) * DEG;
      expect(p.inclination).toBe(tilt);
      expect(p.node).toBeCloseTo(node, 3);
      expect(p.phase).toBeCloseTo(k * ring.phaseStepRad, 12);
      const speed =
        ring.speedDegPerSec * (ring.alternateDirection && k % 2 ? -1 : 1) * (1 + 0.75 * k);
      expect(planePhase(k, 1000)).toBeCloseTo(-speed * DEG, 12);
      for (const a of [0, Math.PI / 2, p.phase]) {
        const point = projectPlane(k, a, 200);
        const u = 200 * Math.cos(a);
        const v = 200 * Math.sin(a) * Math.cos(tilt * DEG);
        expect(point.x).toBeCloseTo(u * Math.cos(p.node) - v * Math.sin(p.node), 12);
        expect(point.y).toBeCloseTo(u * Math.sin(p.node) + v * Math.cos(p.node), 12);
        expect(point.z).toBeCloseTo(200 * Math.sin(a) * Math.sin(tilt * DEG), 12);
      }
    });
    // The second orbit sits on today's middle plane's tilt, turned the other way and spinning back.
    expect(CROWDED_PLANES[1].inclination).toBe(65);
    expect(Math.sign(CROWDED_PLANES[1].speedDegPerSec)).toBe(
      -Math.sign(CROWDED_PLANES[0].speedDegPerSec),
    );
  });

  it("paints the starting phases with both orbits full", () => {
    const m = adaptive();
    seed(m, ring.maxOrbits * ring.seatsPerOrbit);
    const frame = m.update(0, true);
    CROWDED_PLANES.forEach((p, plane) => {
      for (let slot = 0; slot < p.capacity; slot++) {
        const c = frame.crew.find((c) => c.id === `c${plane * p.capacity + slot}`);
        if (!c) throw new Error("Missing seated crew");
        expect(c.plane).toBe(plane);
        expect(wrapped(angle(c) - (p.phase + (slot / p.capacity) * Math.PI * 2))).toBeCloseTo(
          0,
          12,
        );
      }
    });
  });

  it.each([1, 2, 9, 12, 23, 24])(
    "widens the first orbit a notch with every arrival, at %i crew",
    (count) => {
      const m = adaptive();
      seed(m, count);
      const f = m.update(0, true);
      expect(f.formation).toBe("planes");
      expect(f.crew.every((c) => c.plane === 0)).toBe(true);
      for (const c of f.crew) {
        const projected = projectPlane(0, angle(c), grown(0, count));
        expect(c.x).toBeCloseTo(projected.x, 10);
        expect(c.y).toBeCloseTo(projected.y, 10);
        expect(Math.hypot(c.x, c.y, projected.z)).toBeCloseTo(grown(0, count), 8);
      }
      expect(f.orbits).toHaveLength(1);
    },
  );

  it("settles an asynchronous boot roster even after an empty frame", () => {
    const m = adaptive();
    m.update(0);
    seed(m, 40);
    const f = m.update(0);
    expect(f.planeBlend).toBe(1);
    expect(f.crew.every((c) => c.phase === "orbiting" && c.spark === 0)).toBe(true);
    expect(m.takeCues()).toEqual([]);
  });

  it.each([
    { count: 24, counts: [24, 0], radii: [grown(0, 24)] },
    { count: 25, counts: [24, 1], radii: [cap(0), grown(1, 1)] },
    { count: 36, counts: [24, 12], radii: [cap(0), grown(1, 12)] },
    { count: 48, counts: [24, 24], radii: [cap(0), cap(1)] },
    // No third orbit: past 48 the orbit with fewer crew takes the arrival, the first on a tie.
    { count: 49, counts: [25, 24], radii: [cap(0), cap(1)] },
    { count: 50, counts: [25, 25], radii: [cap(0), cap(1)] },
    { count: 72, counts: [36, 36], radii: [cap(0), cap(1)] },
    { count: 96, counts: [48, 48], radii: [cap(0), cap(1)] },
  ])("seeds $count crew on two depth-sorted orbits", ({ count, counts, radii }) => {
    const m = adaptive();
    seed(m, count);
    const f = m.update(0);
    expect(f.formation).toBe("planes");
    expect(f.planeBlend).toBe(1);
    expect(f.count).toBe(count);
    expect(f.crew).toHaveLength(count);
    expect(countsOf(f)).toEqual(counts);
    expect(f.orbits).toHaveLength(radii.length);
    expect(f.crew.map((c) => c.depth)).toEqual(f.crew.map((c) => c.depth).sort((a, b) => a - b));
    for (const c of f.crew) {
      const radius = radii[c.plane ?? 0] ?? 0;
      const projected = projectPlane(c.plane ?? 0, angle(c), radius);
      expect(c.x).toBeCloseTo(projected.x, 10);
      expect(c.y).toBeCloseTo(projected.y, 10);
      expect(c.depth).toBeCloseTo(0.5 + projected.z / 512, 10);
      expect(Math.hypot(c.x, c.y, projected.z)).toBeCloseTo(radius, 8);
      expect(Math.abs(c.x) + c.size / 2).toBeLessThan(280);
      expect(Math.abs(c.y) + c.size / 2).toBeLessThan(280);
      expect(c.phase).toBe("orbiting");
      expect(c.spark).toBe(0);
    }
    expect(m.takeCues()).toEqual([]);
  });

  it("widens the orbit on its springs as a crewmate arrives, never snapping", () => {
    const m = adaptive();
    seed(m, 12);
    const before = advance(m, 0, 4000);
    m.spawn("new", "working", 4000);
    let frame = m.update(4000);
    for (const c of before.crew) {
      const next = frame.crew.find((n) => n.id === c.id);
      expect(next?.x).toBe(c.x);
      expect(next?.y).toBe(c.y);
    }
    for (let t = 4016; t <= 9000; t += 16) {
      const next = m.update(t);
      for (const c of before.crew) {
        const old = frame.crew.find((n) => n.id === c.id);
        const current = next.crew.find((n) => n.id === c.id);
        if (old && current)
          expect(Math.hypot(current.x - old.x, current.y - old.y)).toBeLessThan(8);
      }
      frame = next;
    }
    for (const c of frame.crew) {
      const projected = projectPlane(0, angle(c), grown(0, 13));
      expect(Math.hypot(c.x - projected.x, c.y - projected.y)).toBeLessThan(0.5);
    }
  });

  it("moves painted positions at +8 and −14 degrees per second", () => {
    const m = adaptive();
    seed(m, 40);
    const before = advance(m, 0, 20000);
    const after = advance(m, 20000, 22000);
    for (const c of before.crew) {
      const next = after.crew.find((n) => n.id === c.id);
      if (!next) throw new Error("Lost member");
      const p = c.plane ?? 0;
      expect(wrapped(angle(next) - angle(c))).toBeCloseTo(
        planePhase(p, 22000) - planePhase(p, 20000),
        4,
      );
    }
  });

  it.each([
    { starting: 25, remaining: [24, 0], moved: ["c24"] },
    { starting: 48, remaining: [24, 23], moved: ["c24"] },
  ])(
    "glides the inner orbit's oldest crewmate out to refill the first at $starting crew",
    ({ starting, remaining, moved }) => {
      const m = adaptive();
      seed(m, starting);
      const before = m.update(0);
      m.leave("c0", "home", 0);
      const immediate = m.update(0);
      expect(countsOf(immediate)).toEqual(remaining);
      for (const c of immediate.crew) {
        if (c.phase !== "leaving" && !moved.includes(c.id)) {
          const old = before.crew.find((previous) => previous.id === c.id);
          expect(c.plane).toBe(old?.plane);
          expect(c.x).toBe(old?.x);
          expect(c.y).toBe(old?.y);
        }
      }
      for (const id of moved) {
        const previous = before.crew.find((c) => c.id === id);
        const next = immediate.crew.find((c) => c.id === id);
        expect(next?.x).toBe(previous?.x);
        expect(next?.y).toBe(previous?.y);
      }
      let frame = immediate;
      let travelled = false;
      for (let t = 16; t <= 3000; t += 16) {
        const next = m.update(t);
        for (const id of moved) {
          const old = frame.crew.find((c) => c.id === id);
          const current = next.crew.find((c) => c.id === id);
          if (old && current) {
            const distance = Math.hypot(current.x - old.x, current.y - old.y);
            expect(distance).toBeLessThan(28);
            travelled ||= distance > 0;
          }
        }
        frame = next;
      }
      expect(travelled).toBe(true);
      expect(frame.crew.filter((c) => c.phase !== "leaving").length).toBe(starting - 1);
      for (const id of moved) {
        const current = frame.crew.find((c) => c.id === id);
        if (!current) throw new Error("Lost outward-moving member");
        expect(current.plane).toBe(0);
        const projected = onOrbit(frame, current);
        expect(Math.hypot(current.x - projected.x, current.y - projected.y)).toBeLessThan(0.1);
      }
    },
  );

  it("shrinks the inner orbit as it loses crew and closes it once empty", () => {
    const m = adaptive();
    seed(m, 30);
    m.leave("c29", "home", 0);
    const shrunk = m.update(0, true);
    expect(countsOf(shrunk)).toEqual([24, 5]);
    for (const c of shrunk.crew.filter((c) => c.plane === 1))
      expect(Math.hypot(c.x, c.y, onOrbit(shrunk, c).z)).toBeCloseTo(grown(1, 5), 8);
    for (const id of ["c24", "c25", "c26", "c27", "c28"]) m.leave(id, "home", 0);
    const closed = m.update(0, true);
    expect(countsOf(closed)).toEqual([24, 0]);
    expect(closed.orbits).toHaveLength(1);
  });

  it("refills the first orbit from the inner orbit's oldest after overflow churn", () => {
    const m = adaptive();
    seed(m, 60);
    const before = m.update(0);
    expect(countsOf(before)).toEqual([30, 30]);
    const innerOldest = before.crew
      .filter((c) => c.plane === 1)
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))[0];
    // Seven leave the first orbit: it falls below its seats, so the inner orbit's oldest glides out.
    const first = before.crew.filter((c) => c.plane === 0).slice(0, 7);
    for (const c of first) m.leave(c.id, "home", 0);
    const f = m.update(0, true);
    expect(f.crew.find((c) => c.id === innerOldest?.id)?.plane).toBe(0);
    expect(countsOf(f)).toEqual([24, 29]);
    expect(f.count).toBe(53);
  });

  it("compacts survivors then opens the inner orbit without sending them back", () => {
    const m = adaptive();
    seed(m, 30);
    for (let i = 0; i < 6; i++) m.leave(`c${i}`, "home", 0);
    const full = advance(m, 0, 4000);
    expect(full.crew.map((c) => c.plane)).toEqual(Array(24).fill(0));
    m.spawn("new", "working", 4000);
    const opened = m.update(4000);
    expect(opened.crew.filter((c) => c.plane === 0)).toHaveLength(24);
    expect(opened.crew.find((c) => c.id === "new")?.plane).toBe(1);
    for (const c of full.crew) {
      const next = opened.crew.find((n) => n.id === c.id);
      expect(next?.x).toBe(c.x);
      expect(next?.y).toBe(c.y);
    }
  });

  it("does not send an outward-moving crewmate back in on a fast 24-to-25 bounce", () => {
    const m = adaptive();
    seed(m, 25);
    m.leave("c0", "home", 0);
    const shrinking = m.update(0);
    expect(shrinking.crew.find((c) => c.id === "c24")?.plane).toBe(0);
    m.spawn("new", "working", 0);
    const growing = m.update(0);
    expect(growing.crew.find((c) => c.id === "c24")?.plane).toBe(0);
    expect(growing.crew.find((c) => c.id === "new")?.plane).toBe(1);
    expect(growing.crew.find((c) => c.id === "c24")?.x).toBe(
      shrinking.crew.find((c) => c.id === "c24")?.x,
    );
  });

  it("keeps crowded members on their slots through additions, status changes and departures", () => {
    const m = adaptive();
    seed(m, 40);
    const before = advance(m, 0, 10000);
    m.spawn("new", "working", 10000);
    const justAdded = m.update(10000);
    for (const c of before.crew) expect(justAdded.crew.find((n) => n.id === c.id)).toEqual(c);
    m.setStatus("c1", "working");
    m.leave("new", "home", 10000);
    const after = advance(m, 10000, 12000);
    expect(after.count).toBe(40);
    expect(m.has("new")).toBe(false);
    for (const c of before.crew) expect(after.crew.find((n) => n.id === c.id)?.plane).toBe(c.plane);
  });

  describe("even spacing on live joins and leaves", () => {
    const settle = (m: CrewOrbit, from: number) => advance(m, from, from + 8000);
    const gaps = (f: CrewmateFrame[]) => {
      const a = f
        .map((c) => ((angle(c) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
        .sort((x, y) => x - y);
      return a.map(
        (v, i) => ((a[(i + 1) % a.length] ?? 0) - v + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI,
      );
    };
    const expectEven = (f: CrewmateFrame[]) => {
      for (const g of gaps(f)) expect(g).toBeCloseTo((2 * Math.PI) / f.length, 2);
    };

    it("spaces six crew evenly when they arrive one at a time", () => {
      const m = adaptive();
      let t = 0;
      for (let i = 0; i < 6; i++) {
        m.spawn(`c${i}`, "idle", t);
        t += 2000;
        advance(m, t - 2000, t);
      }
      expectEven(settle(m, t).crew);
    });

    it("re-spaces the orbit when crew finish and others join", () => {
      const m = adaptive();
      seed(m, 7);
      m.leave("c2", "home", 0);
      expectEven(settle(m, 0).crew);
      m.leave("c4", "home", 8000);
      m.spawn("a", "working", 8000);
      m.spawn("b", "working", 8000);
      expectEven(settle(m, 8000).crew);
    });
  });

  it("projects packets and steer cues along the real plane rather than the old ring", () => {
    for (const plane of [0, 1]) {
      const m = adaptive();
      seed(m, 40);
      const f = advance(m, 0, 10000);
      m.takeCues();
      const c = f.crew.find((c) => c.plane === plane);
      if (!c) throw new Error("No member");
      m.signal(c.id, "report", 10000);
      const packet = m.update(10000).packets.at(-1);
      expect(packet?.x).toBeCloseTo(c.x, 8);
      expect(packet?.y).toBeCloseTo(c.y, 8);
      m.signal(c.id, "steer", 10000);
      const cue = m.takeCues().at(-1);
      if (cue?.kind !== "sendoff") throw new Error("Missing cue");
      const radius = planeRadius(plane, countsOf(f));
      expect(cue.dx).toBeCloseTo(c.x / radius, 8);
      expect(cue.dy).toBeCloseTo(c.y / radius, 8);
    }
  });

  it("snaps an outward-moving member to the first orbit's projection under reduced motion", () => {
    const m = adaptive();
    seed(m, 30);
    m.leave("c0", "home", 0);
    const c = m.update(0, true).crew.find((member) => member.id === "c24");
    if (!c) throw new Error("Outward-moving member missing");
    expect(c.plane).toBe(0);
    const projected = projectPlane(0, angle(c), cap(0));
    expect(c.x).toBeCloseTo(projected.x, 10);
    expect(c.y).toBeCloseTo(projected.y, 10);
    expect(c.depth).toBeCloseTo(0.5 + projected.z / 512, 10);
  });

  it("settles threshold changes, arrivals, packets and departures under reduced motion", () => {
    const m = adaptive();
    seed(m, 24);
    m.update(0, true);
    m.spawn("new", "idle", 1);
    const crowded = m.update(1, true);
    expect(countsOf(crowded)).toEqual([24, 1]);
    expect(crowded.planeBlend).toBe(1);
    expect(crowded.crew.every((c) => c.spark === 0 && c.unfold === 1)).toBe(true);
    m.signal("new", "report", 2);
    m.leave("new", "home", 2);
    const small = m.update(2, true);
    expect(small.planeBlend).toBe(1);
    expect(small.count).toBe(24);
    expect(small.orbits).toHaveLength(1);
    expect(small.packets).toEqual([]);
  });
});

describe("the black hole's rush", () => {
  function rushed(m: CrewOrbit, from: number, until: number, rush: number) {
    let f = m.update(from, false, rush);
    for (let t = from + 16; t <= until; t += 16) f = m.update(t, false, rush);
    return f;
  }
  const member = (f: { crew: CrewmateFrame[] }, id: string) => {
    const c = f.crew.find((c) => c.id === id);
    if (!c) throw new Error(`Lost ${id}`);
    return c;
  };

  it("races every orbit at the top speed in its own direction, evenly spaced on its slots", () => {
    const m = adaptive();
    seed(m, 48);
    const before = advance(m, 0, 20_000);
    expect(before.travel).toBe(1);
    // Six frames at the top of the rush: 96 ms of stage time, 36 times the travel.
    const after = rushed(m, 20_016, 20_096, 1);
    expect(after.travel).toBe(CREW_RUSH.peak);
    for (const c of before.crew) {
      const p = c.plane ?? 0;
      const next = member(after, c.id);
      expect(wrapped(angle(next) - angle(c))).toBeCloseTo(
        wrapped(planePhase(p, 96 * CREW_RUSH.peak) - planePhase(p, 0)),
        6,
      );
      const projected = projectPlane(p, angle(next));
      expect(next.x).toBeCloseTo(projected.x, 8);
      expect(next.y).toBeCloseTo(projected.y, 8);
    }
    CROWDED_PLANES.forEach((plane, p) => {
      const angles = after.crew
        .filter((c) => c.plane === p)
        .map((c) => (angle(c) + 2 * Math.PI) % (2 * Math.PI))
        .sort((a, b) => a - b);
      angles.forEach((a, i) => {
        const gap = ((angles[(i + 1) % angles.length] ?? 0) - a + 2 * Math.PI) % (2 * Math.PI);
        expect(gap).toBeCloseTo((2 * Math.PI) / plane.capacity, 6);
      });
    });
  });

  it("returns to the normal pace once it is over", () => {
    const m = adaptive();
    seed(m, 20);
    advance(m, 0, 10_000);
    rushed(m, 10_016, 12_000, 1);
    // Frames land every 16 ms: 12,992 ms, then 14,992 ms - two seconds apart.
    const before = rushed(m, 12_016, 12_992, 0);
    const after = rushed(m, 13_008, 14_992, 0);
    expect(after.travel).toBe(1);
    for (const c of before.crew) {
      const p = c.plane ?? 0;
      expect(wrapped(angle(member(after, c.id)) - angle(c))).toBeCloseTo(
        planePhase(p, 2000) - planePhase(p, 0),
        6,
      );
    }
  });

  it("lends the spin a quarter of its boost and keeps every clip's pace", () => {
    const calm = adaptive();
    const racing = adaptive();
    for (const m of [calm, racing]) {
      seed(m, 6);
      advance(m, 0, 10_000);
      m.spawn("new", "working", 10_000);
    }
    const spun = (f: { crew: CrewmateFrame[] }, g: { crew: CrewmateFrame[] }, id: string) =>
      member(g, id).spin - member(f, id).spin;
    let calmFrame = calm.update(10_000);
    let racingFrame = racing.update(10_000, false, 1);
    for (let t = 10_016; t <= 10_000 + DEFAULT_ORBIT.spawnMs + 32; t += 16) {
      const nextCalm = calm.update(t);
      const nextRacing = racing.update(t, false, 1);
      for (const id of ["c0", "c3", "new"]) {
        expect(spun(racingFrame, nextRacing, id) / spun(calmFrame, nextCalm, id)).toBeCloseTo(
          1 + (CREW_RUSH.peak - 1) * CREW_RUSH.spinShare,
          9,
        );
      }
      expect(member(nextRacing, "new").phase).toBe(member(nextCalm, "new").phase);
      expect(member(nextRacing, "new").unfold).toBe(member(nextCalm, "new").unfold);
      calmFrame = nextCalm;
      racingFrame = nextRacing;
    }
    expect(member(racingFrame, "new").phase).toBe("orbiting");
  });

  it("trails each racing crewmate with a streak along its own orbit, and only while racing", () => {
    const m = adaptive();
    seed(m, 48);
    advance(m, 0, 10_000);
    expect(m.update(10_016, false, 0).crew.some((c) => c.streak)).toBe(false);
    const f = rushed(m, 10_032, 10_200, 1);
    for (const c of f.crew) {
      const p = c.plane ?? 0;
      const speed = CROWDED_PLANES[p]?.speedDegPerSec ?? 0;
      const streak = c.streak;
      if (!streak) throw new Error(`${c.id} has no streak`);
      expect(streak[0]?.x).toBeCloseTo(c.x, 8);
      expect(streak[0]?.y).toBeCloseTo(c.y, 8);
      for (const point of streak) {
        const on = projectPlane(p, angle({ ...c, ...point }));
        expect(point.x).toBeCloseTo(on.x, 6);
        expect(point.y).toBeCloseTo(on.y, 6);
      }
      // Behind it: positive travel runs toward decreasing angle, so the tail
      // sits at a greater angle, by the arc swept in a moment.
      const tail = streak.at(-1);
      if (!tail) throw new Error("Empty streak");
      const behind = wrapped(angle({ ...c, ...tail }) - angle(c));
      expect(Math.sign(behind)).toBe(Math.sign(speed));
      expect(Math.abs(behind)).toBeCloseTo(
        streakArc(((speed * Math.PI) / 180) * CREW_RUSH.peak, 1),
        6,
      );
    }
    expect(rushed(m, 10_216, 13_000, 0).crew.some((c) => c.streak)).toBe(false);
  });

  it("plays nothing under reduced motion", () => {
    const calm = adaptive();
    const racing = adaptive();
    for (const m of [calm, racing]) seed(m, 21);
    const still = calm.update(5000, true);
    const rushedStill = racing.update(5000, true, 1);
    expect(rushedStill.travel).toBe(1);
    expect(rushedStill.crew.map(({ x, y, spin, streak }) => ({ x, y, spin, streak }))).toEqual(
      still.crew.map(({ x, y, spin, streak }) => ({ x, y, spin, streak })),
    );
  });
});
