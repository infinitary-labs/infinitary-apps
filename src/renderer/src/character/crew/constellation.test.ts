import type { TaskLinkView, TaskView } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { CONSTELLATION, layoutProgram, programsOf } from "./constellation";
import { applyCrewDependencies, seedCrew } from "./crewSignal";
import { crewHit } from "./hover";
import { stageMarks } from "./marks";
import { CrewOrbit, DEFAULT_ORBIT, type OrbitFrame } from "./orbit";
import { SCENE_REACH_PX } from "./satellites";
import { crewFacts } from "./useCrewBoard";

/**
 * The captain's INF-799 choice, "Branching constellation": a program the
 * host runs draws on the stage from the graph's own links, "a part hangs from the
 * parts whose results it builds on", a finished part's result climbs to the
 * root, the tree folds into the root, and one result falls home. The board
 * below is a review program as the task graph records one.
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

const blocks = (fromId: string, toId: string): TaskLinkView => ({ fromId, toId, type: "blocks" });

/** Two finders done, a verifier on each underway, a synthesis waiting on both. */
function reviewBoard(): { tasks: TaskView[]; links: TaskLinkView[] } {
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
    links: [
      blocks("find-a", "verify-a"),
      blocks("find-b", "verify-b"),
      blocks("verify-a", "synthesize"),
      blocks("verify-b", "synthesize"),
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
  it("hangs each part from the siblings it waits on, and the first ones from the root", () => {
    const { tasks, links } = reviewBoard();
    expect(programsOf(tasks, links)).toEqual([
      {
        id: "review",
        state: "live",
        parts: [
          { id: "find-a", parents: [], state: "done" },
          { id: "find-b", parents: [], state: "done" },
          { id: "verify-a", parents: ["find-a"], state: "live" },
          { id: "verify-b", parents: ["find-b"], state: "live" },
          { id: "synthesize", parents: ["verify-a", "verify-b"], state: "open" },
        ],
      },
    ]);
  });

  // INF-999: INF-923, an umbrella task holding a plan and its build, drew as
  // a program though none ran; the captain chose "programs only".
  it("leaves a task that runs no program, and its children, as they orbit today", () => {
    const { tasks, links } = reviewBoard();
    const umbrella = tasks.map((task) => {
      if (task.id !== "review") return task;
      const { program: _program, ...rest } = task;
      return rest;
    });
    expect(programsOf(umbrella, links)).toEqual([]);
    const crewed = umbrella.map((task) =>
      task.id === "review"
        ? { ...task, status: "active" as const, activity: "running" as const }
        : task,
    );
    expect(programsOf(crewed, links)).toEqual([]);
  });

  it("draws no part for a review, a dropped part or a link from outside the program", () => {
    const { tasks, links } = reviewBoard();
    const board = [
      ...tasks.filter((task) => task.id !== "synthesize"),
      view({ id: "synthesize", status: "dropped", closedReason: "cancelled", createdAt: 5 }),
      view({ id: "reviewer", reviewOf: "verify-a", createdAt: 6 }),
      view({ id: "elsewhere", parentId: null }),
    ];
    const [program] = programsOf(board, [...links, blocks("elsewhere", "verify-b")]);
    expect(program?.parts.map((part) => [part.id, part.parents])).toEqual([
      ["find-a", []],
      ["find-b", []],
      ["verify-a", ["find-a"]],
      ["verify-b", ["find-b"]],
    ]);
  });
});

describe("layoutProgram", () => {
  const root = { x: 0, y: 164 };

  it("keeps a chain straight, joins a barrier on the root's own line, and lays layers outward", () => {
    const { tasks, links } = reviewBoard();
    const [program] = programsOf(tasks, links);
    const places = layoutProgram(program?.parts ?? [], root, 1000);
    expect(places.get("verify-a")?.angle).toBeCloseTo(places.get("find-a")?.angle ?? Number.NaN);
    expect(places.get("verify-b")?.angle).toBeCloseTo(places.get("find-b")?.angle ?? Number.NaN);
    expect(places.get("synthesize")?.angle).toBeCloseTo(Math.atan2(root.y, root.x));
    const spread = (CONSTELLATION.spreadDeg * Math.PI) / 180;
    expect((places.get("find-b")?.angle ?? 0) - (places.get("find-a")?.angle ?? 0)).toBeCloseTo(
      spread,
    );
    expect(places.get("find-a")?.layer).toBe(1);
    expect(places.get("synthesize")?.layer).toBe(3);
    const reach = (id: string) =>
      Math.hypot((places.get(id)?.x ?? 0) - root.x, (places.get(id)?.y ?? 0) - root.y);
    expect(reach("find-a")).toBeCloseTo(CONSTELLATION.branchPx);
    expect(reach("synthesize")).toBeGreaterThan(reach("verify-a"));
  });

  it("scales the whole graph about its root when a node would leave the stage", () => {
    const { tasks, links } = reviewBoard();
    const [program] = programsOf(tasks, links);
    const places = layoutProgram(program?.parts ?? [], root, SCENE_REACH_PX);
    for (const place of places.values())
      expect(Math.abs(place.y)).toBeLessThanOrEqual(SCENE_REACH_PX + 1e-9);
    const free = layoutProgram(program?.parts ?? [], root, 1000);
    const k = (places.get("synthesize")?.y ?? 0) - root.y;
    const k0 = (free.get("synthesize")?.y ?? 0) - root.y;
    expect(k).toBeLessThan(k0);
    // About its root: every node keeps its angle.
    expect(
      Math.atan2((places.get("find-a")?.y ?? 0) - root.y, (places.get("find-a")?.x ?? 0) - root.x),
    ).toBeCloseTo(free.get("find-a")?.angle ?? Number.NaN);
  });
});

describe("the constellation on the orbit", () => {
  it("draws one branch per recorded link and seats each live part's crewmate at its node", () => {
    const { tasks, links } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0, links);
    const frame = model.update(0, true);
    const [program] = frame.programs;
    expect(program?.branches.map((b) => `${b.fromId}>${b.toId}`)).toEqual([
      "review>find-a",
      "review>find-b",
      "find-a>verify-a",
      "find-b>verify-b",
      "verify-a>synthesize",
      "verify-b>synthesize",
    ]);
    expect(program?.nodes.filter((n) => n.crewed).map((n) => n.id)).toEqual([
      "verify-a",
      "verify-b",
    ]);
    for (const id of ["verify-a", "verify-b"]) {
      const node = program?.nodes.find((n) => n.id === id);
      const mate = frame.crew.find((c) => c.id === id);
      expect(mate?.x).toBeCloseTo(node?.x ?? Number.NaN);
      expect(mate?.y).toBeCloseTo(node?.y ?? Number.NaN);
    }
    // Without their parent the same two crewmates keep their slots.
    const plain = adaptive();
    seedCrew(
      plain,
      tasks.map((task) => ({ ...task, parentId: null })),
      0,
      links,
    );
    const alone = plain.update(0, true);
    expect(alone.programs).toEqual([]);
    expect(alone.crew.find((c) => c.id === "verify-a")?.x).not.toBeCloseTo(
      frame.crew.find((c) => c.id === "verify-a")?.x ?? Number.NaN,
    );
  });

  it("replaces a wait arrow between two parts with their branch", () => {
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
    const links = [blocks("stage-1", "stage-2")];
    const model = adaptive();
    seedCrew(model, tasks, 0, links);
    const frame = model.update(0, true);
    expect(frame.links).toEqual([]);
    expect(frame.programs[0]?.branches.map((b) => `${b.fromId}>${b.toId}`)).toEqual([
      "review>stage-1",
      "stage-1>stage-2",
    ]);
  });

  // INF-979, from INF-977's board: INF-869, a live part of INF-867 (open, no
  // crewmate, here a program), waits on INF-886 outside its parent and on a sibling part.
  it("keeps a part's wait arrow to a blocker outside its parent, and only a sibling's gives way", () => {
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
    const links = [blocks("868", "869"), blocks("886", "869"), blocks("886", "911")];
    const model = adaptive();
    seedCrew(model, tasks, 0, links);
    const frame = model.update(0, true);
    const [program] = frame.programs;
    expect(program?.branches.map((b) => `${b.fromId}>${b.toId}`)).toEqual(["867>868", "868>869"]);
    expect(frame.links.map((l) => `${l.kind}:${l.fromId}>${l.toId}`).sort()).toEqual([
      "wait:869>886",
      "wait:911>886",
    ]);
    // The part stays seated at its node rather than circling its blocker.
    const node = program?.nodes.find((n) => n.id === "869");
    const mate = frame.crew.find((c) => c.id === "869");
    expect(mate?.x).toBeCloseTo(node?.x ?? Number.NaN);
    expect(mate?.y).toBeCloseTo(node?.y ?? Number.NaN);
  });

  it("sends a part's report up its branches to the mark, never into the core", () => {
    const { tasks, links } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0, links);
    run(model, 0, 1500);
    model.takeCues();
    model.signal("verify-a", "report", 1500);
    const riding = run(model, 1500, 1700);
    expect(riding.packets).toHaveLength(1);
    const lit = riding.programs[0]?.branches
      .filter((b) => b.lit)
      .map((b) => `${b.fromId}>${b.toId}`);
    expect(lit?.length).toBe(1);
    expect(["find-a>verify-a", "review>find-a"]).toContain(lit?.[0]);
    const landed = run(model, 1716, 3000);
    expect(landed.packets).toEqual([]);
    expect(model.takeCues().filter((cue) => cue.kind === "receive")).toEqual([]);
    // The mark lit as the result landed on it, and has settled again since.
    expect(landed.programs[0]?.lit).toBe(0);
  });

  it("feeds a part filed from finished results with a packet down each branch it hangs from", () => {
    const { tasks, links } = reviewBoard();
    const model = adaptive();
    seedCrew(
      model,
      tasks.filter((task) => task.id !== "synthesize"),
      0,
      links,
    );
    run(model, 0, 1000);
    const next = tasks
      .filter((task) => task.id !== "synthesize")
      .map((task) =>
        task.id.startsWith("verify")
          ? { ...task, status: "done" as const, closedReason: "answered" as const }
          : task,
      );
    applyCrewDependencies(
      model,
      [...next, view({ id: "write-up", createdAt: 6 })],
      [...links, blocks("verify-a", "write-up"), blocks("verify-b", "write-up")],
      1000,
    );
    const frame = run(model, 1000, 1200);
    expect(frame.packets).toHaveLength(2);
    expect(frame.programs[0]?.branches.filter((b) => b.lit).map((b) => b.toId)).toEqual([
      "write-up",
      "write-up",
    ]);
  });

  it("folds into its mark on a done close, which then falls home as the one result", () => {
    const { tasks, links } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0, links);
    run(model, 0, 1000);
    model.takeCues();
    const closed = tasks.map((task) =>
      task.status === "open" || task.status === "active"
        ? { ...task, status: "done" as const, closedReason: "answered" as const }
        : task,
    );
    applyCrewDependencies(model, closed, links, 1000);
    const folding = run(model, 1000, 1000 + DEFAULT_ORBIT.homeMs * 0.5);
    const [program] = folding.programs;
    const toMark = (id: string) => {
      const node = program?.nodes.find((n) => n.id === id);
      return Math.hypot((node?.x ?? 0) - (program?.x ?? 0), (node?.y ?? 0) - (program?.y ?? 0));
    };
    expect(toMark("synthesize")).toBeGreaterThan(1);
    const end = 1000 + DEFAULT_ORBIT.homeMs + DEFAULT_ORBIT.packetMs + 100;
    const after = run(model, 1000 + DEFAULT_ORBIT.homeMs * 0.5 + 16, end);
    expect(after.programs).toEqual([]);
    expect(model.takeCues().filter((cue) => cue.kind === "receive").length).toBeGreaterThan(0);
  });

  it("paints one settled frame under reduced motion: a closed program is simply gone", () => {
    const { tasks, links } = reviewBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0, links);
    model.signal("verify-a", "report", 0);
    const still = model.update(0, true);
    expect(still.packets).toEqual([]);
    expect(still.programs[0]?.lit).toBe(0);
    const dropped = tasks.map((task) =>
      task.id === "review" ? { ...task, status: "dropped" as const } : task,
    );
    applyCrewDependencies(model, dropped, links, 0);
    expect(model.update(0, true).programs).toEqual([]);
  });
});

/**
 * INF-999, from the captain's board of 2026-10-23: four tasks with a live
 * part each (INF-505, INF-527, INF-867, INF-923) drew their roots on one
 * spot, beside a crewmate and under a seated part; the captain chose "a
 * seat per constellation". Here each is a program, so all four draw: eight
 * crewmates on this Mac's inner orbit, four of them parts, and each program
 * with a finished part beside its live one.
 */
function captainsBoard(): { tasks: TaskView[]; links: TaskLinkView[] } {
  const tasks: TaskView[] = [];
  const links: TaskLinkView[] = [];
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
    links.push(blocks(done, live));
  }
  return { tasks, links };
}

/**
 * Every mark the inner orbit carries, by the task it stands for: its
 * crewmates, each root, and every part's node or seated crewmate. Crew on
 * the other planes cross it on screen by the approved design, never in 3D.
 */
function marksOf(frame: OrbitFrame): Array<{ id: string; x: number; y: number }> {
  const seated = new Set(frame.programs.flatMap((p) => p.nodes.map((n) => n.id)));
  const marks = frame.crew
    .filter((c) => c.phase !== "leaving" && (c.plane === 0 || seated.has(c.id)))
    .map((c) => ({ id: c.id, x: c.x, y: c.y }));
  for (const program of frame.programs) {
    marks.push({ id: program.id, x: program.x, y: program.y });
    for (const node of program.nodes)
      if (!node.crewed) marks.push({ id: node.id, x: node.x, y: node.y });
  }
  return marks;
}

/** The closest two marks of different tasks on the inner orbit, px apart. */
function closest(frame: OrbitFrame): number {
  const marks = marksOf(frame);
  let near = Number.POSITIVE_INFINITY;
  for (let i = 0; i < marks.length; i++)
    for (let j = i + 1; j < marks.length; j++) {
      const a = marks[i];
      const b = marks[j];
      if (!a || !b || a.id === b.id) continue;
      near = Math.min(near, Math.hypot(a.x - b.x, a.y - b.y));
    }
  return near;
}

/** The crowded formation's glyph, scene px (docs/crew-orbits.md). */
const GLYPH_PX = 25;

describe("a seat per constellation", () => {
  it("seats every root apart at boot and keeps every mark a glyph clear for a minute", () => {
    const { tasks, links } = captainsBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0, links);
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
    const { tasks, links } = captainsBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0, links);
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
      links,
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

// INF-999: a root ring, a finished part's node and a seated part were drawn
// with nothing to point at or nothing to say, so the captain could not tell
// which task a mark stood for.
describe("every mark names its task", () => {
  it("summarises and points at everything the stage paints", () => {
    const { tasks, links } = captainsBoard();
    const model = adaptive();
    seedCrew(model, tasks, 0, links);
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
    // Pointing at a root ring or a finished part's node reads that task.
    for (const program of frame.programs) {
      expect(crewHit(stageMarks(frame), program.x, program.y)).toBe(program.id);
      for (const node of program.nodes)
        expect(crewHit(stageMarks(frame), node.x, node.y)).toBe(node.id);
    }
  });
});
