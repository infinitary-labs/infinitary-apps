import { describe, expect, it } from "vitest";
import selected from "../../../../../tests/fixtures/crew-orbits/captain-selected-settings.json";
import { type CrewmateFrame, CrewOrbit, DEFAULT_ORBIT } from "./orbit";
import { CROWDED_PLANES, planePhase, projectPlane } from "./orbitalPlanes";
import { CREW_RUSH, streakArc } from "./rush";

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

describe("approved product formation", () => {
  it("projects the exact retained FI3-340 geometry and signed angular travel", () => {
    selected.orbit_settings.orbits.forEach((p, i) => {
      expect(CROWDED_PLANES[i]?.capacity).toBe(p.count);
      for (const angle of [0, Math.PI / 2, (p.phaseDeg * Math.PI) / 180]) {
        const point = projectPlane(i, angle);
        const u = p.radiusPx * Math.cos(angle);
        const v = p.radiusPx * Math.sin(angle) * Math.cos((p.tiltDeg * Math.PI) / 180);
        const node = (p.orientationDeg * Math.PI) / 180;
        expect(point.x).toBeCloseTo(u * Math.cos(node) - v * Math.sin(node), 12);
        expect(point.y).toBeCloseTo(u * Math.sin(node) + v * Math.cos(node), 12);
        expect(point.z).toBeCloseTo(
          p.radiusPx * Math.sin(angle) * Math.sin((p.tiltDeg * Math.PI) / 180),
          12,
        );
      }
      expect(planePhase(i, 1000)).toBeCloseTo((-p.speedDegPerSec * Math.PI) / 180, 12);
      expect(CROWDED_PLANES[i]?.phase).toBeCloseTo((p.phaseDeg * Math.PI) / 180, 12);
    });
  });

  it("paints the retained starting phases at full selected capacity", () => {
    const m = adaptive();
    seed(m, 40);
    const frame = m.update(0, true);
    let offset = 0;
    selected.orbit_settings.orbits.forEach((p, plane) => {
      for (let slot = 0; slot < p.count; slot++) {
        const c = frame.crew.find((c) => c.id === `c${offset + slot}`);
        if (!c) throw new Error("Missing selected crew");
        expect(c.plane).toBe(plane);
        expect(
          wrapped(angle(c) - ((p.phaseDeg * Math.PI) / 180 + (slot / p.count) * Math.PI * 2)),
        ).toBeCloseTo(0, 12);
      }
      offset += p.count;
    });
  });

  it.each([1, 6, 8])("uses the selected inner geometry even at %i crew", (count) => {
    const m = adaptive();
    seed(m, count);
    const f = m.update(0, true);
    expect(f.formation).toBe("planes");
    expect(f.crew.every((c) => c.plane === 0)).toBe(true);
    for (const c of f.crew) {
      const projected = projectPlane(0, angle(c));
      expect(c.x).toBeCloseTo(projected.x, 10);
      expect(c.y).toBeCloseTo(projected.y, 10);
    }
  });

  it("settles an asynchronous boot roster even after an empty frame", () => {
    const m = adaptive();
    m.update(0);
    seed(m, 40);
    const f = m.update(0);
    expect(f.planeBlend).toBe(1);
    expect(f.crew.every((c) => c.phase === "orbiting" && c.spark === 0)).toBe(true);
    expect(m.takeCues()).toEqual([]);
  });

  it.each([8, 9, 20, 21, 40, 41, 48, 60, 96])(
    "seeds %i crew on inner-first, depth-sorted planes",
    (count) => {
      const m = adaptive();
      seed(m, count);
      const f = m.update(0);
      expect(f.formation).toBe("planes");
      expect(f.planeBlend).toBe(1);
      expect(f.count).toBe(count);
      expect(f.crew).toHaveLength(count);
      const counts = CROWDED_PLANES.map((_, p) => f.crew.filter((c) => c.plane === p).length);
      const expected: Record<number, number[]> = {
        8: [8, 0, 0],
        9: [8, 1, 0],
        20: [8, 12, 0],
        21: [8, 12, 1],
        40: [8, 12, 20],
        41: [9, 12, 20],
        48: [14, 14, 20],
        60: [20, 20, 20],
        96: [32, 32, 32],
      };
      expect(counts).toEqual(expected[count]);
      expect(f.crew.map((c) => c.depth)).toEqual(f.crew.map((c) => c.depth).sort((a, b) => a - b));
      for (const c of f.crew) {
        const p = CROWDED_PLANES[c.plane ?? 0];
        const projected = projectPlane(c.plane ?? 0, angle(c));
        expect(c.x).toBeCloseTo(projected.x, 10);
        expect(c.y).toBeCloseTo(projected.y, 10);
        expect(c.depth).toBeCloseTo(0.5 + projected.z / 512, 10);
        expect(Math.hypot(c.x, c.y, projected.z)).toBeCloseTo(p?.radius ?? 0, 8);
        expect(Math.abs(c.x) + c.size / 2).toBeLessThan(280);
        expect(Math.abs(c.y) + c.size / 2).toBeLessThan(280);
        expect(c.phase).toBe("orbiting");
        expect(c.spark).toBe(0);
      }
      expect(m.takeCues()).toEqual([]);
    },
  );

  it("moves painted positions at +8, −20 and −4 degrees per second", () => {
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
    { starting: 9, remaining: [8, 0, 0], moved: ["c8"] },
    { starting: 20, remaining: [8, 11, 0], moved: ["c8"] },
    { starting: 40, remaining: [8, 12, 19], moved: ["c8", "c20"] },
  ])(
    "glides the oldest later crew inward at the $starting-crew boundary",
    ({ starting, remaining, moved }) => {
      const m = adaptive();
      seed(m, starting);
      const before = m.update(0);
      m.leave("c0", "home", 0);
      const immediate = m.update(0);
      expect(
        CROWDED_PLANES.map(
          (_, p) => immediate.crew.filter((c) => c.phase !== "leaving" && c.plane === p).length,
        ),
      ).toEqual(remaining);
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
      if (starting > 9) {
        for (const id of moved) {
          const current = frame.crew.find((c) => c.id === id);
          if (!current) throw new Error("Lost inward-moving member");
          const projected = projectPlane(current.plane ?? 0, angle(current));
          expect(Math.hypot(current.x - projected.x, current.y - projected.y)).toBeLessThan(0.1);
        }
      }
    },
  );

  it("takes the oldest member of the nearest occupied plane after heavy overflow churn", () => {
    const m = adaptive();
    seed(m, 60);
    // Exhaust the middle plane, then vacate an inner slot: outer's oldest moves in.
    const before = m.update(0);
    for (const c of before.crew.filter((c) => c.plane === 1)) m.leave(c.id, "home", 0);
    const outerOldest = before.crew
      .filter((c) => c.plane === 2)
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))[0];
    m.leave("c0", "home", 0);
    const f = m.update(0, true);
    expect(f.crew.find((c) => c.id === outerOldest?.id)?.plane).toBe(1);
    expect(f.count).toBe(39);
  });

  it("compacts survivors then regrows without sending them back outward", () => {
    const m = adaptive();
    seed(m, 20);
    for (let i = 0; i < 12; i++) m.leave(`c${i}`, "home", 0);
    const eight = advance(m, 0, 4000);
    expect(eight.crew.map((c) => c.plane)).toEqual(Array(8).fill(0));
    m.spawn("new", "working", 4000);
    const nine = m.update(4000);
    expect(nine.crew.filter((c) => c.plane === 0)).toHaveLength(8);
    expect(nine.crew.find((c) => c.id === "new")?.plane).toBe(1);
    for (const c of eight.crew) {
      const next = nine.crew.find((n) => n.id === c.id);
      expect(next?.x).toBe(c.x);
      expect(next?.y).toBe(c.y);
    }
  });

  it("does not send an inward-moving crewmate back out on a fast eight-to-nine bounce", () => {
    const m = adaptive();
    seed(m, 9);
    m.leave("c0", "home", 0);
    const shrinking = m.update(0);
    expect(shrinking.crew.find((c) => c.id === "c8")?.plane).toBe(0);
    m.spawn("new", "working", 0);
    const growing = m.update(0);
    expect(growing.crew.find((c) => c.id === "c8")?.plane).toBe(0);
    expect(growing.crew.find((c) => c.id === "new")?.plane).toBe(1);
    expect(growing.crew.find((c) => c.id === "c8")?.x).toBe(
      shrinking.crew.find((c) => c.id === "c8")?.x,
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
    for (const plane of [0, 1, 2]) {
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
      expect(cue.dx).toBeCloseTo(c.x / (CROWDED_PLANES[plane]?.radius ?? 1), 8);
      expect(cue.dy).toBeCloseTo(c.y / (CROWDED_PLANES[plane]?.radius ?? 1), 8);
    }
  });

  it("snaps an inward-moving member to the inner projection under reduced motion", () => {
    const m = adaptive();
    seed(m, 20);
    m.leave("c0", "home", 0);
    const c = m.update(0, true).crew.find((member) => member.id === "c8");
    if (!c) throw new Error("Inward-moving member missing");
    expect(c.plane).toBe(0);
    const projected = projectPlane(0, angle(c));
    expect(c.x).toBeCloseTo(projected.x, 10);
    expect(c.y).toBeCloseTo(projected.y, 10);
    expect(c.depth).toBeCloseTo(0.5 + projected.z / 512, 10);
  });

  it("settles threshold changes, arrivals, packets and departures under reduced motion", () => {
    const m = adaptive();
    seed(m, 8);
    m.update(0, true);
    m.spawn("new", "idle", 1);
    const crowded = m.update(1, true);
    expect(crowded.planeBlend).toBe(1);
    expect(crowded.crew.every((c) => c.spark === 0 && c.unfold === 1)).toBe(true);
    m.signal("new", "report", 2);
    m.leave("new", "home", 2);
    const small = m.update(2, true);
    expect(small.planeBlend).toBe(1);
    expect(small.count).toBe(8);
    expect(small.packets).toEqual([]);
  });
});

describe("the black hole's rush", () => {
  /** Frames 16 ms apart after `from`, through `until`, at one rush level. */
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
    seed(m, 40);
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
      // The arrival unfolds on the same schedule.
      expect(member(nextRacing, "new").phase).toBe(member(nextCalm, "new").phase);
      expect(member(nextRacing, "new").unfold).toBe(member(nextCalm, "new").unfold);
      calmFrame = nextCalm;
      racingFrame = nextRacing;
    }
    expect(member(racingFrame, "new").phase).toBe("orbiting");
  });

  it("trails each racing crewmate with a streak along its own orbit, and only while racing", () => {
    const m = adaptive();
    seed(m, 40);
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
