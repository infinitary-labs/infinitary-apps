// Fixed stars (INF-3634): the captain's Approve and build of "Try the fixed
// stars with a new look and new places" - the constellation in the upper-left
// sky, the glint in the crewmate's own light, every crewmate the Tasks panel
// lists under Pinned, with the settings staged on that plan
// (tests/fixtures/crew-orbits/fixed-stars-settings.json).

import type { TaskView } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import staged from "../../../../../tests/fixtures/crew-orbits/fixed-stars-settings.json";
import { pinnedCrewOf } from "./crewSignal";
import { FIXED_STARS, type StarOrbit, skyPlaces } from "./fixedStars";
import { CrewOrbit, DEFAULT_ORBIT, type OrbitFrame } from "./orbit";
import { CROWDED_PLANES, planeRadius } from "./orbitalPlanes";

const DEG = Math.PI / 180;

/** The occupied orbits for `n` crew, as the orbit hands them to the stars. */
function orbitsFor(n: number): StarOrbit[] {
  const first = Math.min(n, 24);
  const second = n - first;
  const counts = n > 48 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [first, second];
  return counts.flatMap((c, plane) =>
    c > 0 ? [{ plane, radius: planeRadius(plane, counts) * (1 + DEFAULT_ORBIT.idleOffset) }] : [],
  );
}

/** How far an orbit reaches toward `theta` on screen, read off its projected circle. */
function reachOf(o: StarOrbit, theta: number): number {
  const p = CROWDED_PLANES[o.plane];
  if (!p) throw new Error("no plane");
  let best = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.002) {
    const u = o.radius * Math.cos(a);
    const v = o.radius * Math.sin(a) * Math.cos(p.inclination * DEG);
    const x = u * Math.cos(p.node) - v * Math.sin(p.node);
    const y = u * Math.sin(p.node) + v * Math.cos(p.node);
    const off = Math.abs(Math.atan2(y, x) - theta);
    if (Math.min(off, Math.PI * 2 - off) < 0.004) best = Math.max(best, Math.hypot(x, y));
  }
  return best;
}

const corner = (p: { x: number; y: number }) =>
  Math.round((Math.atan2(p.y, p.x) / DEG - 45) / 90) * 90 + 45;

describe("the constellation's places", () => {
  it("holds the look and room the captain staged", () => {
    const product = staged.pinned_crew_look.product;
    expect(staged.answers).toEqual({
      place: "sky",
      star: "glint",
      who: "listed",
      summary: "glyph",
    });
    expect(product.color).toBe("own");
    expect(FIXED_STARS.rays).toBe(product.rays);
    expect(FIXED_STARS.twinkle).toBe(product.twinkle);
    expect(FIXED_STARS.joined).toBe(product.joined);
    expect(FIXED_STARS.clearOfOrbitPx).toBe(product.clearOfOrbitPx);
  });

  it("starts in the upper-left sky and stays clear of both orbits and inside the stage at every crew size", () => {
    for (const crew of [1, 5, 11, 24, 30, 48, 72]) {
      const orbits = orbitsFor(crew);
      for (const pinned of [1, 3, 7, 12, 24]) {
        const { points } = skyPlaces(pinned, orbits);
        expect(points).toHaveLength(pinned);
        const first = points[0];
        expect(first && first.x < 0 && first.y < 0).toBe(true);
        for (const p of points) {
          expect(Math.abs(p.x)).toBeLessThanOrEqual(FIXED_STARS.edgePx + 0.01);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(FIXED_STARS.edgePx + 0.01);
          const theta = Math.atan2(p.y, p.x);
          const reach = Math.max(...orbits.map((o) => reachOf(o, theta)));
          expect(Math.hypot(p.x, p.y)).toBeGreaterThan(reach + FIXED_STARS.clearOfOrbitPx - 1);
        }
      }
    }
  });

  it("joins neighbours within a corner and never runs a hairline between two corners", () => {
    const { points, joins } = skyPlaces(12, orbitsFor(30));
    const corners = new Set(points.map(corner));
    expect(corners.size).toBeGreaterThan(1);
    expect(joins).toHaveLength(points.length - corners.size);
    for (const [a, b] of joins) {
      const from = points[a];
      const to = points[b];
      if (!from || !to) throw new Error("join names no star");
      expect(corner(from)).toBe(corner(to));
    }
  });
});

const adaptive = () => new CrewOrbit(0, { ...DEFAULT_ORBIT }, () => 0.37, "adaptive");

function crewOf(frame: OrbitFrame, id: string) {
  const c = frame.crew.find((each) => each.id === id);
  if (!c) throw new Error(`no ${id}`);
  return c;
}

/** The angular gaps between the seated crew on the first orbit, in its own plane. */
function seatGaps(frame: OrbitFrame, ids: string[]): number[] {
  const p = CROWDED_PLANES[0];
  if (!p) throw new Error("no plane");
  const angles = ids
    .map((id) => {
      const c = crewOf(frame, id);
      const x = c.x * Math.cos(-p.node) - c.y * Math.sin(-p.node);
      const y = (c.x * Math.sin(-p.node) + c.y * Math.cos(-p.node)) / Math.cos(p.inclination * DEG);
      return (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
    })
    .sort((a, b) => a - b);
  return angles.map(
    (a, i) => ((angles[(i + 1) % angles.length] ?? 0) - a + Math.PI * 2) % (Math.PI * 2),
  );
}

describe("a fixed star on the stage", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const seeded = () => {
    const m = adaptive();
    for (const id of ids) m.spawn(id, id === "b" ? "working" : "idle", 0, true);
    m.settleBootRoster(0);
    return m;
  };

  it("leaves its seat for its place in pin order, and the others close the gap", () => {
    const m = seeded();
    m.setPinned(["c", "a"]);
    const frame = m.update(16, true);
    const places = skyPlaces(2, orbitsFor(6)).points;
    for (const [i, id] of ["c", "a"].entries()) {
      const star = crewOf(frame, id);
      expect(star.star).toBe(1);
      expect(star.twinkle).toBeUndefined();
      expect(star.x).toBeCloseTo(places[i]?.x ?? Number.NaN, 5);
      expect(star.y).toBeCloseTo(places[i]?.y ?? Number.NaN, 5);
    }
    expect(frame.starJoins).toEqual([{ fromId: "c", toId: "a" }]);
    for (const gap of seatGaps(frame, ["b", "d", "e", "f"]))
      expect(gap).toBeCloseTo(Math.PI / 2, 2);
  });

  it("eases there, holds still through the rush, and returns to a seat when unpinned", () => {
    const m = seeded();
    m.setPinned(["d"]);
    const first = m.update(16);
    expect(crewOf(first, "d").star ?? 0).toBeLessThan(0.2);
    let frame = first;
    for (let t = 32; t <= 3000; t += 16) frame = m.update(t);
    const held = crewOf(frame, "d");
    expect(held.star).toBeGreaterThan(0.99);
    expect(held.twinkle).toBeDefined();
    const other = crewOf(frame, "e");
    for (let t = 3016; t <= 4000; t += 16) frame = m.update(t, false, 1);
    const raced = crewOf(frame, "d");
    expect(Math.hypot(raced.x - held.x, raced.y - held.y)).toBeLessThan(0.5);
    expect(raced.streak).toBeUndefined();
    expect(crewOf(frame, "e").streak).toBeDefined();
    expect(
      Math.hypot(crewOf(frame, "e").x - other.x, crewOf(frame, "e").y - other.y),
    ).toBeGreaterThan(5);
    m.setPinned([]);
    const back = m.update(4016, true);
    expect(crewOf(back, "d").star).toBeUndefined();
    expect(back.starJoins).toBeUndefined();
    for (const gap of seatGaps(back, ids)) expect(gap).toBeCloseTo(Math.PI / 3, 2);
  });
});

function task(id: string, patch: Partial<TaskView> = {}): TaskView {
  return {
    id,
    key: id.toUpperCase(),
    projectId: "scratch",
    parentId: null,
    kind: "work",
    title: id,
    goal: null,
    priority: 2,
    status: "active",
    activity: "running",
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: "crewmate 1",
    model: null,
    tier: null,
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    closedAt: null,
    ...patch,
  } as TaskView;
}

describe("who becomes a fixed star", () => {
  it("is every crewmate the Tasks panel lists under Pinned, oldest pin first with its parts under it", () => {
    const tasks = [
      task("late", { pinnedAt: 20 }),
      task("plan", { pinnedAt: 10, status: "open", activity: "idle" }),
      task("part-two", { parentId: "plan", priority: 2, createdAt: 1 }),
      task("part-one", { parentId: "plan", priority: 1, createdAt: 2 }),
      task("closed-part", { parentId: "plan", status: "done", closedAt: 3 }),
      task("unpinned"),
    ];
    expect(pinnedCrewOf(tasks)).toEqual(["part-one", "part-two", "late"]);
  });

  it("leaves a program's running part on its branch", () => {
    const tasks = [task("ring", { pinnedAt: 5 }), task("branch", { parentId: "ring" })];
    expect(pinnedCrewOf(tasks, new Set(["branch"]))).toEqual(["ring"]);
  });
});
