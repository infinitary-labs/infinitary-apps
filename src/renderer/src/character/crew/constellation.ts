import type { TaskView } from "@shared/tasks";

/**
 * A program the host runs, drawn on the stage as its running parts circling
 * the program's ring (the captain's INF-5365 choice, "Moons": "The parts
 * circle the program as the crew circle the first mate"). Everything here is
 * read from the graph's own facts: a task the board marks as running a
 * program (`TaskView.program`, its `shape.program`) and its children. A task
 * that only holds children is no program (INF-999): its parts orbit as every
 * crewmate does. A wait between two parts draws as the ordinary wait arrow
 * (the captain's INF-5365 answer), so the look never depends on the waits.
 */

/**
 * The captain's staged settings (INF-5365, `program_look.moons`): a ring of
 * 40 px tilted 40 degrees, turning 26 degrees a second, a second ring past
 * ten parts, and a faint ring line. The rest are the preview's own numbers.
 */
export const CONSTELLATION = {
  /** The least radius of the ring the parts circle on, scene px. */
  ringPx: 40,
  /** The ring's tilt out of the screen, degrees. */
  tiltDeg: 40,
  /** How fast the parts circle, degrees a second; the second ring turns the other way. */
  speedDegS: 26,
  /** Past this many running parts a second ring opens outside the first. */
  secondRingPastParts: 10,
  /** The faint ring line's light on its near half and its far half (`ring_line: "faint"`). */
  ringLineNear: 0.3,
  ringLineFar: 0.13,
  /** Each part's share of its ring's length, so neighbours keep a glyph and some air apart, px. */
  partArcPx: 30,
  /** The second ring lies at least this far outside the first, px. */
  ringStepPx: 26,
  /** The second ring tilts this much less than the first, degrees. */
  secondTiltDropDeg: 18,
  /** Each ring's turn about the screen's normal, radians, so the two rings cross rather than nest. */
  firstNodeRad: -0.3,
  secondNodeRad: 1.1,
  collapse: "fold" as "fold" | "fade",
  /** The program's mark, a hollow ring, px. */
  rootMarkPx: 5,
  /**
   * A glyph's width on screen, px: running crewmates keep their full size,
   * and a remote computer's group asks for the same room on screen.
   */
  crewGapPx: 25,
  /**
   * The gem round the mark (the captain's INF-5365 answer, "Build a gem
   * round it"): an icosahedron of this radius, px, that gains a wire as each
   * part finishes and is whole when the program is done.
   */
  gemPx: 10,
  /** How fast the gem turns, radians a second. */
  gemSpinRadS: 0.5,
} as const;

export type PartState = "live" | "done" | "open";

export type ProgramPart = {
  id: string;
  state: PartState;
};

export type Program = {
  /** The parent task's id; the root is its node. */
  id: string;
  /** Live while the parent is open or underway; its close says how it goes. */
  state: "live" | "done" | "dropped";
  /** In the order they were filed. */
  parts: ProgramPart[];
  /**
   * How much of the whole program has finished, set on a copy that holds
   * only the parts running on one computer (`programShare` otherwise reads it).
   */
  share?: number;
};

function partState(task: TaskView): PartState | null {
  if (task.status === "active") return "live";
  if (task.status === "open") return "open";
  if (task.status === "done") return "done";
  // A dropped part dims and drifts off as today; it leaves no node.
  return null;
}

/**
 * The parts the stage draws (INF-1037): only the running ones, each a
 * crewmate. A finished or unstarted part draws nothing.
 */
export function runningParts(parts: readonly ProgramPart[]): ProgramPart[] {
  return parts.filter((part) => part.state === "live");
}

/**
 * How much of a program has finished, for its gem: finished parts over every
 * part that is not dropped, and whole once the program itself is done.
 */
export function programShare(program: Program): number {
  if (program.state === "done") return 1;
  if (program.share !== undefined) return program.share;
  const finished = program.parts.filter((part) => part.state === "done").length;
  return program.parts.length ? finished / program.parts.length : 0;
}

/** How far a program has got, for the summary its ring opens (INF-1037). */
export type ProgramProgress = {
  finished: number;
  /** Its running parts, each named in the summary, in the order they were filed. */
  running: TaskView[];
  waiting: number;
};

/**
 * A program's parts by state, read from the board as `programsOf` reads
 * them: the stage draws only the running ones, so the ring's summary counts
 * the rest. A dropped part counts in none.
 */
export function programProgress(tasks: readonly TaskView[], programId: string): ProgramProgress {
  const progress: ProgramProgress = { finished: 0, running: [], waiting: 0 };
  const parts = tasks
    .filter((task) => task.parentId === programId && task.kind === "work" && !task.reviewOf)
    .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  for (const part of parts) {
    const state = partState(part);
    if (state === "done") progress.finished++;
    else if (state === "live") progress.running.push(part);
    else if (state === "open") progress.waiting++;
  }
  return progress;
}

/**
 * Every program on the board with work parts. A host-commissioned review is
 * the builder's own cue, never a part.
 */
export function programsOf(tasks: readonly TaskView[]): Program[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, TaskView[]>();
  for (const task of tasks) {
    if (!task.parentId || task.kind !== "work" || task.reviewOf) continue;
    if (!byId.has(task.parentId)) continue;
    const list = children.get(task.parentId) ?? [];
    list.push(task);
    children.set(task.parentId, list);
  }
  const programs: Program[] = [];
  for (const [parentId, kids] of children) {
    const parent = byId.get(parentId);
    // Only a program the host runs draws its parts round its ring; any other
    // parent's children orbit as they always have (INF-999).
    if (!parent?.program) continue;
    const ordered = [...kids].sort(
      (a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key),
    );
    const parts: ProgramPart[] = [];
    for (const kid of ordered) {
      const state = partState(kid);
      if (state) parts.push({ id: kid.id, state });
    }
    if (parts.length === 0) continue;
    const state =
      parent.status === "done" ? "done" : parent.status === "dropped" ? "dropped" : "live";
    programs.push({ id: parentId, state, parts });
  }
  return programs.sort((a, b) => a.id.localeCompare(b.id));
}

/** One ring the parts circle on, round the program's mark. */
export type MoonRing = {
  /** Scene px. */
  radius: number;
  /** Out of the screen, radians. */
  tilt: number;
  /** About the screen's normal, radians. */
  node: number;
  /** How many parts circle on it. */
  count: number;
};

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/**
 * The rings `count` running parts circle on: one, or two past
 * `secondRingPastParts`, the first holding the larger half. Each ring is wide
 * enough for its parts to keep a glyph and some air apart; `gap` is a glyph's
 * width in scene px (larger in a remote computer's smaller group), so the
 * room is kept on screen.
 */
export function moonRings(count: number, gap: number = CONSTELLATION.crewGapPx): MoonRing[] {
  if (count <= 0) return [];
  const scale = gap / CONSTELLATION.crewGapPx;
  const counts =
    count > CONSTELLATION.secondRingPastParts
      ? [Math.ceil(count / 2), Math.floor(count / 2)]
      : [count];
  const rings: MoonRing[] = [];
  let reach = 0;
  for (const [j, n] of counts.entries()) {
    const radius = Math.max(
      CONSTELLATION.ringPx,
      (n * CONSTELLATION.partArcPx) / TAU,
      j > 0 ? reach + CONSTELLATION.ringStepPx : 0,
    );
    reach = radius;
    rings.push({
      radius: radius * scale,
      tilt: Math.max(0, CONSTELLATION.tiltDeg - j * CONSTELLATION.secondTiltDropDeg) * DEG,
      node: j === 0 ? CONSTELLATION.firstNodeRad : CONSTELLATION.secondNodeRad,
      count: n,
    });
  }
  return rings;
}

/** A point on `ring` at angle `theta`, from the mark: x and y on the screen, z toward the viewer. */
export function ringPoint(ring: MoonRing, theta: number): { x: number; y: number; z: number } {
  const across = ring.radius * Math.cos(theta);
  const along = ring.radius * Math.sin(theta);
  const flat = along * Math.cos(ring.tilt);
  const c = Math.cos(ring.node);
  const s = Math.sin(ring.node);
  return { x: across * c - flat * s, y: across * s + flat * c, z: along * Math.sin(ring.tilt) };
}

export type NodePlace = { x: number; y: number; z: number; ring: number };

/** A program's parts where they circle, and the rings they circle on. */
export type ProgramPlaces = { places: Map<string, NodePlace>; rings: MoonRing[] };

/**
 * Where each running part circles at `seconds` (scene px, y down): in the
 * order filed, evenly round its ring, the first ring turning one way and the
 * second the other. The rings keep their full size wherever the mark sits:
 * a part may pass beyond the stage's edge or over another computer's crew.
 */
export function layoutProgram(
  parts: readonly ProgramPart[],
  root: { x: number; y: number },
  gap: number = CONSTELLATION.crewGapPx,
  seconds = 0,
): ProgramPlaces {
  const rings = moonRings(parts.length, gap);
  const placed = new Map<string, NodePlace>();
  const turn = seconds * CONSTELLATION.speedDegS * DEG;
  let index = 0;
  for (const [j, ring] of rings.entries()) {
    for (let i = 0; i < ring.count; i++) {
      const part = parts[index++];
      if (!part) continue;
      const theta = (TAU * i) / ring.count + (j === 0 ? turn : 0.5 - turn);
      const at = ringPoint(ring, theta);
      placed.set(part.id, { x: root.x + at.x, y: root.y + at.y, z: at.z, ring: j });
    }
  }
  return { places: placed, rings };
}
