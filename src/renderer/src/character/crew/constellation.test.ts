import type { TaskView } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import {
  CONSTELLATION,
  layoutProgram,
  moonRings,
  type ProgramPart,
  programProgress,
  programsOf,
  ringPoint,
} from "./constellation";
import { applyCrewDependencies, seedCrew } from "./crewSignal";
import { crewHit } from "./hover";
import { stageMarks } from "./marks";
import { CrewOrbit, DEFAULT_ORBIT, type OrbitFrame } from "./orbit";
import { CROWDED_PLANES } from "./orbitalPlanes";
import { crewFacts } from "./useCrewBoard";

/**
 * The captain's INF-799 choice drew a program the host runs on the stage,
 * and INF-1037 drew only its running parts: "i feel 'not started' and
 * 'finished' parts should not be rendered there". INF-5365 then chose how:
 * "Moons. The parts circle the program as the crew circle the first mate",
 * with "a gem round it" that "gains wires as parts finish, and the gem is
 * whole when the program is done", and a wait between two parts drawn "with
 * the wait arrow that two ordinary crewmates already use". The board below
 * is a review program as the task graph records one.
 */

function view(patch: Partial<TaskView> & { id: string }): TaskView {
  return {
    key: `INF-${patch.id}`,
    projectId: "infinitary",
    parentId: "review",
    kind: "work",
    title: patch.id,
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
  };
}

/** Two finders done, a verifier on each underway, a synthesis waiting on both. */
function reviewBoard(): { tasks: TaskView[] } {
  return {
    tasks: [
      view({
        id: "review",
        parentId: null,
        status: "open",
        activity: null,
        startedAt: null,
        program: true,
      }),
      view({ id: "find-a", status: "done", closedReason: "answered", createdAt: 1 }),
      view({ id: "find-b", status: "done", closedReason: "answered", createdAt: 2 }),
      view({ id: "verify-a", createdAt: 3, activity: "idle" }),
      view({ id: "verify-b", createdAt: 4, activity: "idle" }),
      view({ id: "synthesize", status: "open", activity: null, startedAt: null, createdAt: 5 }),
    ],
  };
}

function adaptive(now = 0): CrewOrbit {
  return new CrewOrbit(now, { ...DEFAULT_ORBIT }, () => 0.5, "adaptive");
}

function run(model: CrewOrbit, from: number, until: number): OrbitFrame {
  let frame = model.update(from);
  for (let t = from + 16; t <= until; t += 16) frame = model.update(t);
  return frame;
}

describe("programsOf", () => {
  it("reads each part and its state in the order filed", () => {
    const { tasks } = reviewBoard();
    expect(programsOf(tasks)).toEqual([
      {
        id: "review",
        state: "live",
        parts: [
          { id: "find-a", state: "done" },
          { id: "find-b", state: "done" },
          { id: "verify-a", state: "live" },
          { id: "verify-b", state: "live" },
          { id: "synthesize", state: "open" },
        ],
      },
    ]);
  });

  // INF-999: INF-923, an umbrella task holding a plan and its build, drew as
  // a program though none ran; the captain chose "programs only".
  it("leaves a task that runs no program, and its children, as they orbit today", () => {
    const { tasks } = reviewBoard();
    const umbrella = tasks.map((task) => {
      if (task.id !== "review") return task;
      const { program: _program, ...rest } = task;
      return rest;
    });
    expect(programsOf(umbrella)).toEqual([]);
    const crewed = umbrella.map((task) =>
      task.id === "review"
        ? { ...task, status: "active" as const, activity: "running" as const }
        : task,
    );
    expect(programsOf(crewed)).toEqual([]);
  });

  it("draws no part for a review or a dropped part", () => {
    const { tasks } = reviewBoard();
    const board = [
      ...tasks.filter((task) => task.id !== "synthesize"),
      view({ id: "synthesize", status: "dropped", closedReason: "cancelled", createdAt: 5 }),
      view({ id: "reviewer", reviewOf: "verify-a", createdAt: 6 }),
      view({ id: "elsewhere", parentId: null }),
    ];
    const [program] = programsOf(board);
    expect(program?.parts.map((part) => part.id)).toEqual([
      "find-a",
      "find-b",
      "verify-a",
      "verify-b",
    ]);
  });
});

const live = (n: number): ProgramPart[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, state: "live" }));

describe("layoutProgram", () => {
  const root = { x: 0, y: 164 };
  const DEG = Math.PI / 180;

  // INF-5365, the captain's staged settings: a 40 px ring tilted 40 degrees,
  // turning 26 degrees a second.
  it("circles the parts evenly on one ring of the staged size, tilt and speed", () => {
    const [ring] = moonRings(4);
    expect(ring?.radius).toBe(CONSTELLATION.ringPx);
    expect(ring?.tilt).toBeCloseTo(CONSTELLATION.tiltDeg * DEG);
    if (!ring) throw new Error("No ring for four parts");
    for (const seconds of [0, 1, 2.5]) {
      const { places } = layoutProgram(live(4), root, CONSTELLATION.crewGapPx, seconds);
      for (let i = 0; i < 4; i++) {
        const at = ringPoint(ring, (i * Math.PI) / 2 + seconds * CONSTELLATION.speedDegS * DEG);
        const place = places.get(`p${i}`);
        expect(place?.x).toBeCloseTo(root.x + at.x);
        expect(place?.y).toBeCloseTo(root.y + at.y);
        expect(place?.z).toBeCloseTo(at.z);
      }
    }
    // The near half of the ring is the lower half on the screen, as on the crew's orbit.
    const near = ringPoint(ring, Math.PI / 2 - ring.node);
    expect(near.z).toBeGreaterThan(0);
  });

  // INF-1037: "Running crewmates keep full size and stay at least 25 px
  // apart"; INF-5365 opens a second ring past ten parts.
  it("keeps neighbours a glyph apart: the ring widens, then a second ring opens past ten", () => {
    for (const n of [2, 5, 10, 11, 16, 24, 40]) {
      const rings = moonRings(n);
      expect(rings).toHaveLength(n > CONSTELLATION.secondRingPastParts ? 2 : 1);
      expect(rings.reduce((sum, ring) => sum + ring.count, 0)).toBe(n);
      for (const ring of rings)
        if (ring.count > 1)
          expect(2 * ring.radius * Math.sin(Math.PI / ring.count)).toBeGreaterThanOrEqual(
            CONSTELLATION.crewGapPx,
          );
      const [first, second] = rings;
      if (first && second)
        expect(second.radius - first.radius).toBeGreaterThanOrEqual(
          CONSTELLATION.ringStepPx - 1e-9,
        );
      const { places } = layoutProgram(live(n), root);
      expect(places.size).toBe(n);
    }
    // A remote computer's group, at half the scene's size, asks for twice the room.
    expect(moonRings(5, CONSTELLATION.crewGapPx * 2)[0]?.radius).toBe(CONSTELLATION.ringPx * 2);
  });

  it("carries the whole ring with the mark wherever it rides", () => {
    for (const parts of [live(3), live(14)])
      for (const at of [
        { x: 120, y: -90 },
        { x: -150, y: 40 },
      ]) {
        const here = layoutProgram(parts, root, CONSTELLATION.crewGapPx, 3).places;
        const there = layoutProgram(parts, at, CONSTELLATION.crewGapPx, 3).places;
        for (const [id, place] of here) {
          expect((there.get(id)?.x ?? 0) - at.x).toBeCloseTo(place.x - root.x);
          expect((there.get(id)?.y ?? 0) - at.y).toBeCloseTo(place.y - root.y);
        }
      }
  });
});

describe("the program on the orbit", () => {
  // The captain's ask (INF-5726): no box holds a crewmate in. A task's moons
  // keep their rings' full size through a whole trip of its mark, even where
  // the outer ring passes the formation's square.
  it("keeps a task's rings at full size wherever its mark sits on its trip", () => {
    for (const n of [40, 60]) {
      // A crowded home, so the mark rides the full outer orbit.
      const model = adaptive();
      seedCrew(
        model,
        [
          view({ id: "survey", parentId: null, status: "open", activity: null, program: true }),
          ...live(n).map((part, i) => view({ id: part.id, parentId: "survey", createdAt: i })),
          ...Array.from({ length: 24 }, (_, i) =>
            view({ id: `crew-${i}`, parentId: null, createdAt: n + i }),
          ),
        ],
        0,
      );
      const outer = moonRings(n).at(-1)?.radius ?? 0;
      const tripMs = (360 / Math.abs(CROWDED_PLANES[0].speedDegPerSec)) * 1000;
      for (let t = 0; t <= tripMs; t += 250) {
        const program = model.update(t, true).programs[0];
        if (!program) throw new Error("No program drawn");
        // A ring's line reaches its full radius from the mark where it meets the line of nodes.
        const reach = Math.max(
          ...program.rings.flat().map((p) => Math.hypot(p.x - program.x, p.y - program.y)),
        );
        expect(reach, `${n} parts at ${t} ms`).toBeCloseTo(outer, 0);
      }
    }
  });

  it("draws only the running parts, each a crewmate circling the mark on one faint ring", () => {
    const { tasks } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0);
    const frame = model.update(0, true);
    const [program] = frame.programs;
    expect(program?.nodes.map((n) => n.id)).toEqual(["verify-a", "verify-b"]);
    expect(program?.rings).toHaveLength(1);
    for (const id of ["verify-a", "verify-b"]) {
      const node = program?.nodes.find((n) => n.id === id);
      const mate = frame.crew.find((c) => c.id === id);
      expect(mate?.x).toBeCloseTo(node?.x ?? Number.NaN);
      expect(mate?.y).toBeCloseTo(node?.y ?? Number.NaN);
      const reach = Math.hypot(
        (mate?.x ?? 0) - (program?.x ?? 0),
        (mate?.y ?? 0) - (program?.y ?? 0),
      );
      expect(reach).toBeGreaterThan(CONSTELLATION.ringPx * 0.5);
      expect(reach).toBeLessThan(CONSTELLATION.ringPx * 1.5);
    }
    // The ring line passes round the mark, nearer on its lower half.
    const line = program?.rings[0] ?? [];
    expect(line.some((p) => p.near)).toBe(true);
    expect(line.some((p) => !p.near)).toBe(true);
    // Without their parent the same two crewmates keep their slots.
    const plain = adaptive();
    seedCrew(
      plain,
      tasks.map((task) => ({ ...task, parentId: null })),
      0,
    );
    const alone = plain.update(0, true);
    expect(alone.programs).toEqual([]);
    expect(alone.crew.find((c) => c.id === "verify-a")?.x).not.toBeCloseTo(
      frame.crew.find((c) => c.id === "verify-a")?.x ?? Number.NaN,
    );
  });

  it("circles the parts round the mark as the stage's clock runs", () => {
    const { tasks } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0);
    const angle = (frame: OrbitFrame) => {
      const program = frame.programs[0];
      const mate = frame.crew.find((c) => c.id === "verify-a");
      return Math.atan2((mate?.y ?? 0) - (program?.y ?? 0), (mate?.x ?? 0) - (program?.x ?? 0));
    };
    const start = angle(run(model, 0, 2000));
    const later = angle(run(model, 2016, 4000));
    expect(Math.abs(later - start)).toBeGreaterThan(0.2);
  });

  // INF-5365, the captain's answer: a wait between two parts draws "with the
  // wait arrow that two ordinary crewmates already use".
  it("keeps the wait arrow between two parts", () => {
    const tasks = [
      view({ id: "review", parentId: null, status: "open", activity: null, program: true }),
      view({ id: "stage-1", createdAt: 1 }),
      view({
        id: "stage-2",
        createdAt: 2,
        activity: "idle",
        blockedBy: ["INF-stage-1"],
        workPosture: { state: "idle", reason: "dependency" },
      }),
    ];
    const model = adaptive();
    seedCrew(model, tasks, 0);
    const frame = model.update(0, true);
    expect(frame.links).toEqual([{ fromId: "stage-2", toId: "stage-1", kind: "wait" }]);
    expect(frame.programs[0]?.nodes.map((n) => n.id)).toEqual(["stage-1", "stage-2"]);
  });

  // INF-979, from INF-977's board: INF-869, a live part of INF-867 (open, no
  // crewmate, here a program), waits on INF-886 outside its parent and on a sibling part.
  it("keeps every wait arrow of a part, and circles the mark rather than its blocker", () => {
    const waiting = { state: "idle", reason: "dependency" } as const;
    const tasks = [
      view({
        id: "867",
        parentId: null,
        status: "open",
        activity: null,
        startedAt: null,
        program: true,
      }),
      view({ id: "868", parentId: "867", createdAt: 1 }),
      view({
        id: "869",
        parentId: "867",
        createdAt: 2,
        activity: "idle",
        blockedBy: ["INF-868", "INF-886"],
        workPosture: waiting,
      }),
      view({ id: "886", parentId: null, createdAt: 3 }),
      view({
        id: "911",
        parentId: null,
        createdAt: 4,
        activity: "idle",
        blockedBy: ["INF-886"],
        workPosture: waiting,
      }),
    ];
    const model = adaptive();
    seedCrew(model, tasks, 0);
    const frame = model.update(0, true);
    const [program] = frame.programs;
    expect(program?.nodes.map((n) => n.id)).toEqual(["868", "869"]);
    expect(frame.links.map((l) => `${l.kind}:${l.fromId}>${l.toId}`).sort()).toEqual([
      "wait:869>868",
      "wait:869>886",
      "wait:911>886",
    ]);
    const node = program?.nodes.find((n) => n.id === "869");
    const mate = frame.crew.find((c) => c.id === "869");
    expect(mate?.x).toBeCloseTo(node?.x ?? Number.NaN);
    expect(mate?.y).toBeCloseTo(node?.y ?? Number.NaN);
  });

  it("sends a part's report straight to the mark, never into the core", () => {
    const { tasks } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0);
    run(model, 0, 1500);
    model.takeCues();
    model.signal("verify-a", "report", 1500);
    const riding = run(model, 1500, 1700);
    expect(riding.packets).toHaveLength(1);
    const landed = run(model, 1716, 3000);
    expect(landed.packets).toEqual([]);
    expect(model.takeCues().filter((cue) => cue.kind === "receive")).toEqual([]);
    // The mark lit as the result landed on it, and has settled again since.
    expect(landed.programs[0]?.lit).toBe(0);
  });

  // INF-5365, the captain's answer: "The ring gains wires as parts finish,
  // and the gem is whole when the program is done."
  it("builds its gem as parts finish, whole once the program is done", () => {
    const { tasks } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0);
    // Two of five parts finished.
    expect(model.update(0, true).programs[0]?.gem).toBeCloseTo(2 / 5);
    const one = tasks.map((task) =>
      task.id === "verify-a"
        ? { ...task, status: "done" as const, closedReason: "answered" as const }
        : task,
    );
    applyCrewDependencies(model, one, 100);
    expect(model.update(100, true).programs[0]?.gem).toBeCloseTo(3 / 5);
    // A program with none finished draws the plain ring.
    const fresh = adaptive();
    seedCrew(
      fresh,
      tasks.map((task) => (task.status === "done" ? { ...task, status: "open" as const } : task)),
      0,
    );
    expect(fresh.update(0, true).programs[0]?.gem).toBe(0);
  });

  it("circles a part that starts after its finished parts, with nothing sent to it", () => {
    const { tasks } = reviewBoard();
    const model = adaptive();
    seedCrew(
      model,
      tasks.filter((task) => task.id !== "synthesize"),
      0,
    );
    run(model, 0, 1000);
    const next = tasks
      .filter((task) => task.id !== "synthesize")
      .map((task) =>
        task.id.startsWith("verify")
          ? { ...task, status: "done" as const, closedReason: "answered" as const }
          : task,
      );
    applyCrewDependencies(model, [...next, view({ id: "write-up", createdAt: 6 })], 1000);
    model.spawn("write-up", "working", 1000);
    const frame = run(model, 1000, 4000);
    expect(frame.programs[0]?.nodes.map((n) => n.id)).toEqual(["write-up"]);
    expect(frame.packets).toEqual([]);
    expect(frame.programs[0]?.gem).toBeCloseTo(4 / 5);
  });

  it("folds its rings into its mark on a done close, which then falls home as the one result", () => {
    const { tasks } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0);
    const open = run(model, 0, 1000);
    model.takeCues();
    const closed = tasks.map((task) =>
      task.status === "open" || task.status === "active"
        ? { ...task, status: "done" as const, closedReason: "answered" as const }
        : task,
    );
    applyCrewDependencies(model, closed, 1000);
    const folding = run(model, 1000, 1000 + DEFAULT_ORBIT.homeMs * 0.5);
    // Its parts have finished, so only the mark, its whole gem and its folding ring are left.
    expect(folding.programs.map((p) => [p.id, p.nodes, p.gem])).toEqual([["review", [], 1]]);
    const span = (frame: OrbitFrame) => {
      const program = frame.programs[0];
      const line = program?.rings[0] ?? [];
      return Math.max(
        ...line.map((p) => Math.hypot(p.x - (program?.x ?? 0), p.y - (program?.y ?? 0))),
      );
    };
    expect(span(folding)).toBeLessThan(span(open));
    const end = 1000 + DEFAULT_ORBIT.homeMs + DEFAULT_ORBIT.packetMs + 100;
    const after = run(model, 1000 + DEFAULT_ORBIT.homeMs * 0.5 + 16, end);
    expect(after.programs).toEqual([]);
    expect(model.takeCues().filter((cue) => cue.kind === "receive").length).toBeGreaterThan(0);
  });

  it("paints one settled frame under reduced motion: a closed program is simply gone", () => {
    const { tasks } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0);
    model.signal("verify-a", "report", 0);
    const still = model.update(0, true);
    expect(still.packets).toEqual([]);
    expect(still.programs[0]?.lit).toBe(0);
    const dropped = tasks.map((task) =>
      task.id === "review" ? { ...task, status: "dropped" as const } : task,
    );
    applyCrewDependencies(model, dropped, 0);
    expect(model.update(0, true).programs).toEqual([]);
  });
});

/**
 * INF-999, from the captain's board of 2026-10-23: four tasks with a live
 * part each (INF-505, INF-527, INF-867, INF-923) drew their roots on one
 * spot, beside a crewmate and under a seated part; the captain chose "a
 * seat per constellation". Here each is a program, so all four draw: eight
 * crewmates on this Mac's inner orbit, four of them parts, and each program
 * with a finished part that draws nothing (INF-1037).
 */
function captainsBoard(): { tasks: TaskView[] } {
  const tasks: TaskView[] = [];
  for (const solo of ["778", "643", "843", "930"])
    tasks.push(view({ id: solo, parentId: null, activity: "idle", createdAt: Number(solo) }));
  for (const [parent, done, live] of [
    ["505", "506", "507"],
    ["527", "528", "529"],
    ["867", "868", "869"],
    ["923", "924", "925"],
  ] as const) {
    tasks.push(
      view({
        id: parent,
        parentId: null,
        status: "open",
        activity: null,
        startedAt: null,
        program: true,
        createdAt: Number(parent),
      }),
      view({ id: done, parentId: parent, status: "done", createdAt: Number(done) }),
      view({ id: live, parentId: parent, activity: "idle", createdAt: Number(live) }),
    );
  }
  return { tasks };
}

/**
 * Every mark the inner orbit carries, by the task it stands for and the
 * program it belongs to: its crewmates, each root, and every part's
 * crewmate circling its root. Crew on the other planes cross it on screen by
 * the approved design, never in 3D.
 */
function marksOf(frame: OrbitFrame): Array<{ id: string; group: string; x: number; y: number }> {
  const programOf = new Map(frame.programs.flatMap((p) => p.nodes.map((n) => [n.id, p.id])));
  const marks = frame.crew
    .filter((c) => c.phase !== "leaving" && (c.plane === 0 || programOf.has(c.id)))
    .map((c) => ({ id: c.id, group: programOf.get(c.id) ?? c.id, x: c.x, y: c.y }));
  for (const program of frame.programs)
    marks.push({ id: program.id, group: program.id, x: program.x, y: program.y });
  return marks;
}

/**
 * The closest two marks of different tasks on the inner orbit, px apart. A
 * part circling its own program's root belongs with it (INF-5365, "The parts
 * circle the program as the crew circle the first mate").
 */
function closest(frame: OrbitFrame): number {
  const marks = marksOf(frame);
  let near = Number.POSITIVE_INFINITY;
  for (let i = 0; i < marks.length; i++)
    for (let j = i + 1; j < marks.length; j++) {
      const a = marks[i];
      const b = marks[j];
      if (!a || !b || a.group === b.group) continue;
      near = Math.min(near, Math.hypot(a.x - b.x, a.y - b.y));
    }
  return near;
}

/** The crowded formation's glyph, scene px (docs/crew-orbits.md). */
const GLYPH_PX = 25;

describe("a seat per constellation", () => {
  it("seats every root apart at boot and keeps every mark a glyph clear for a minute", () => {
    const { tasks } = captainsBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0);
    const settled = model.update(0, true);
    expect(settled.programs.map((p) => p.id)).toEqual(["505", "527", "867", "923"]);
    expect(closest(settled)).toBeGreaterThan(GLYPH_PX);
    let frame = settled;
    let near = Number.POSITIVE_INFINITY;
    for (let t = 16; t <= 60_000; t += 16) {
      frame = model.update(t);
      near = Math.min(near, closest(frame));
    }
    expect(near).toBeGreaterThan(GLYPH_PX);
  });

  it("enters a newcomer at the widest gap among crew and roots, and re-spaces them all", () => {
    const { tasks } = captainsBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0);
    run(model, 0, 2000);
    // A crewmate arrives and a fifth program draws, as the board moves on.
    model.spawn("1001", "working", 2000);
    applyCrewDependencies(
      model,
      [
        ...tasks,
        view({ id: "1001", parentId: null, createdAt: 1001 }),
        view({ id: "990", parentId: null, status: "open", activity: null, program: true }),
        view({ id: "991", parentId: "990", activity: "idle", createdAt: 991 }),
      ],
      2000,
    );
    model.spawn("991", "idle", 2000);
    let near = Number.POSITIVE_INFINITY;
    let frame = model.update(2000);
    // Once the spark has landed and the springs have glided everyone to their seats.
    for (let t = 2016; t <= 20_000; t += 16) {
      frame = model.update(t);
      if (t > 8000) near = Math.min(near, closest(frame));
    }
    expect(frame.programs.map((p) => p.id)).toEqual(["505", "527", "867", "923", "990"]);
    expect(near).toBeGreaterThan(GLYPH_PX);
  });
});

// INF-999: a root ring and a seated part were drawn
// with nothing to point at or nothing to say, so the captain could not tell
// which task a mark stood for.
describe("every mark names its task", () => {
  it("summarises and points at everything the stage paints", () => {
    const { tasks } = captainsBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0);
    const frame = model.update(0, true);
    const painted = [
      ...frame.crew.map((c) => c.id),
      ...frame.programs.flatMap((p) => [p.id, ...p.nodes.map((n) => n.id)]),
    ];
    const marks = new Set(stageMarks(frame).map((mark) => mark.id));
    const facts = crewFacts(tasks, (model) => model);
    for (const id of painted) {
      expect(marks.has(id), id).toBe(true);
      expect(facts[id]?.task.id, id).toBe(id);
    }
    for (const program of frame.programs) {
      expect(crewHit(stageMarks(frame), program.x, program.y)).toBe(program.id);
      for (const node of program.nodes)
        expect(crewHit(stageMarks(frame), node.x, node.y)).toBe(node.id);
    }
  });
});

// INF-1037: "Add a row such as '20 finished, 5 running, 0 waiting' when
// pointing at the ring", and "make the hover preview for a ring a bit richer
// than just the counts": the summary names each running part too.
describe("a program's progress on its ring", () => {
  it("counts the parts the stage no longer draws, and lists the running ones in filed order", () => {
    const { tasks } = reviewBoard();
    const board = [
      ...tasks,
      view({ id: "dropped", status: "dropped", closedReason: "cancelled", createdAt: 7 }),
      view({ id: "reviewer", reviewOf: "verify-a", createdAt: 8 }),
    ];
    const progress = programProgress(board, "review");
    expect(progress.finished).toBe(2);
    expect(progress.waiting).toBe(1);
    expect(progress.running.map((task) => task.id)).toEqual(["verify-a", "verify-b"]);
  });
});
