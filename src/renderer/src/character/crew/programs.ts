// A task with parts on the crew orbit: its mark, seated on the first orbit
// among the crew, its running parts circling it on a small tilted ring
// (./constellation.ts lays them out), the gem its finished parts build round
// the mark, and the results that fly to the mark and home. The orbit model (./orbit.ts) keeps the programs,
// spaces their marks with its crew and feeds them every frame; here a
// program's state changes, its parts are placed, and it is painted.

import { clamp01, easeInOut, type Spring } from "../face";
import {
  CONSTELLATION,
  layoutProgram,
  type MoonRing,
  type NodePlace,
  type ProgramPart,
  ringPoint,
} from "./constellation";
import type {
  CrewmateFrame,
  LeaveMode,
  OrbitProjection,
  OrbitTuning,
  PacketFrame,
  ProgramFrame,
} from "./orbit";
import { planePhase, planeRadius } from "./orbitalPlanes";
import { easeIn, type Point, type SceneSlot } from "./orbitPaths";
import { SCENE_REACH_PX } from "./satellites";

/** A landing brightens what it lands on for this long: a steer its crewmate, a result its mark. */
export const FLASH_MS = 360;

/** A result flying to the mark: the part it starts from and the program's id, or the program's id alone going home. */
type RoutePacket = { route: string[]; at: number; home: boolean };

export type ProgramState = {
  id: string;
  parts: ProgramPart[];
  /** How much of the program has finished, 0..1, for its gem (`programShare`). */
  share: number;
  /**
   * The mark's seat on the first orbit, travelling with it: an occupant
   * like a crewmate, so the plane spaces crew and marks evenly together
   * (INF-999) and a newcomer enters the widest gap between them all.
   */
  rootSlot: number;
  /** Where the mark is drawn, gliding to its seat on the springs a crewmate's slot uses. */
  rootAngle: Spring;
  leaving: LeaveMode | null;
  leaveAt: number;
  litAt: number;
  packets: RoutePacket[];
};

/** Where a running part circles this frame. */
export type Seat = { x: number; y: number; z: number };

/** A program's mark, where its parts circle and their rings, in scene space before a remote cluster's projection. */
export type ProgramLayout = {
  program: ProgramState;
  root: SceneSlot;
  places: Map<string, NodePlace>;
  rings: MoonRing[];
  /** The stage's clock, seconds, which turns the gem. */
  seconds: number;
};

/** A program's running parts and its share finished as they are now. True when what it draws changed. */
export function takeParts(program: ProgramState, parts: ProgramPart[], share: number): boolean {
  const key = (parts: readonly ProgramPart[]) => parts.map((part) => part.id).join();
  if (key(program.parts) === key(parts) && program.share === share) return false;
  program.parts = parts;
  program.share = share;
  return true;
}

/** The program closes: done folds it home, dropped fades it; results in flight go with it. */
export function endProgram(program: ProgramState, mode: LeaveMode, now: number): void {
  program.leaving = mode;
  program.leaveAt = now;
  program.packets = [];
}

/** The program a crewmate is a part of, among `programs`. */
export function programOfPart(
  programs: Iterable<ProgramState>,
  id: string,
): ProgramState | undefined {
  for (const program of programs)
    if (!program.leaving && program.parts.some((part) => part.id === id)) return program;
  return undefined;
}

/**
 * Each program's mark and the layout of its parts, in scene space before a
 * remote cluster's projection. The mark rides the first orbit at its own
 * angle; the planes must be settled in, as for a waiting crewmate's circle.
 * `scene` places a point on a plane as the orbit does, and `project` takes
 * scene space to the screen.
 */
export function layoutPrograms(
  programs: Iterable<ProgramState>,
  slotTime: number,
  ringR: number,
  mix: number,
  counts: readonly number[],
  scene: (
    onPlane: number,
    angle: number,
    radius: number,
  ) => { x: number; y: number; z: number; depth: number },
  project: OrbitProjection,
): ProgramLayout[] {
  const radius = ringR + (planeRadius(0, counts) - ringR) * mix;
  // A remote computer's group draws at a share of the scene's size, its
  // glyphs at nearly full size: the gap between crewmates is kept on screen.
  const a = project({ x: 0, y: 0, depth: 0.5 }, radius);
  const b = project({ x: 1, y: 0, depth: 0.5 }, radius);
  const share = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return [...programs].map((program) => {
    const angle = program.rootAngle.x + planePhase(0, slotTime);
    const root = { ...scene(0, angle, radius), radius };
    const seconds = slotTime / 1000;
    const { places, rings } = layoutProgram(
      program.parts,
      root,
      SCENE_REACH_PX,
      CONSTELLATION.crewGapPx / share,
      seconds,
    );
    return { program, root, places, rings, seconds };
  });
}

/** Where each live part circles, for its crewmate to be drawn there (./companions.ts). */
export function partSeats(layouts: readonly ProgramLayout[]): Map<string, Seat> {
  const seats = new Map<string, Seat>();
  for (const layout of layouts) {
    if (layout.program.leaving) continue;
    for (const part of layout.program.parts) {
      const place = layout.places.get(part.id);
      if (part.state === "live" && place)
        seats.set(part.id, { x: place.x, y: place.y, z: layout.root.z + place.z });
    }
  }
  return seats;
}

/** The faint ring line's points round a ring: enough that its ellipse reads smooth at the stage's size. */
const RING_LINE_POINTS = 48;

/**
 * Paint-ready programs, and their results in flight among the packets: a
 * part's result flies to the mark, which lights when it lands, and a result
 * that reaches the core is `receive`d there. A closing program folds its
 * rings into its mark, which then falls home, or fades; `ended` names each
 * one that has finished going, for the orbit to forget.
 */
export function programFrames(
  layouts: readonly ProgramLayout[],
  crew: readonly CrewmateFrame[],
  now: number,
  settled: boolean,
  tuning: OrbitTuning,
  project: OrbitProjection,
  packets: PacketFrame[],
  receive: () => void,
): { frames: ProgramFrame[]; ended: string[] } {
  const frames: ProgramFrame[] = [];
  const drawn = new Map(crew.filter((c) => c.phase !== "leaving").map((c) => [c.id, c]));
  // A result from a part just finished starts at its crewmate, going or not.
  const anywhere = new Map(crew.map((c) => [c.id, c]));
  const ended: string[] = [];
  for (const { program, root, places, rings, seconds } of layouts) {
    const t = program.leaving
      ? settled
        ? 1
        : (now - program.leaveAt) /
          (program.leaving === "home" ? tuning.homeMs + tuning.packetMs : tuning.awayMs)
      : 0;
    if (t >= 1) {
      ended.push(program.id);
      continue;
    }
    const home = program.leaving === "home";
    const foldMs = tuning.homeMs / (tuning.homeMs + tuning.packetMs);
    const fold = home && CONSTELLATION.collapse === "fold" ? easeInOut(clamp01(t / foldMs)) : 0;
    const fade = program.leaving
      ? home
        ? CONSTELLATION.collapse === "fold"
          ? 1
          : 1 - clamp01(t / foldMs)
        : 1 - easeIn(clamp01(t))
      : 1;
    const rootPoint = project(root, root.radius);
    const nodes: ProgramFrame["nodes"] = [];
    // Only a part whose crewmate is drawn here is a node, and a closed program has none.
    for (const part of program.leaving ? [] : program.parts) {
      const mate = places.has(part.id) ? drawn.get(part.id) : undefined;
      if (mate) nodes.push({ id: part.id, x: mate.x, y: mate.y });
    }
    // The mark falls home over the last stretch of a done close.
    const fall = home ? easeIn(clamp01((t - foldMs) / (1 - foldMs))) : 0;
    const mark = { x: rootPoint.x * (1 - fall), y: rootPoint.y * (1 - fall) };
    const keep: RoutePacket[] = [];
    for (const packet of program.packets) {
      const points: Point[] = [];
      for (const id of packet.route) {
        const at = id === program.id ? mark : anywhere.get(id);
        if (at) points.push({ x: at.x, y: at.y });
      }
      if (packet.home) points.push({ x: 0, y: 0 });
      const legs = Math.max(1, points.length - 1);
      const dur = tuning.packetMs * (0.6 + 0.4 * legs);
      const u = settled ? 1 : clamp01((now - packet.at) / dur);
      if (u >= 1 || points.length < 2) {
        if (packet.home) receive();
        else program.litAt = now;
        continue;
      }
      keep.push(packet);
      const along = easeInOut(u) * legs;
      const leg = Math.min(legs - 1, Math.floor(along));
      const a = points[leg] as Point;
      const b = points[leg + 1] as Point;
      const s = along - leg;
      packets.push({
        direction: "report",
        x: a.x + (b.x - a.x) * s,
        y: a.y + (b.y - a.y) * s,
        t: u,
        alpha: Math.sin(u * Math.PI) ** 0.5,
      });
    }
    program.packets = keep;
    // The faint ring line the parts circle on, drawn through the same
    // projection as the crew; it folds into the mark on a done close.
    const lines: ProgramFrame["rings"] = [];
    if (fold < 1)
      for (const ring of rings) {
        const folded = { ...ring, radius: ring.radius * (1 - fold) };
        const line: ProgramFrame["rings"][number] = [];
        for (let i = 0; i <= RING_LINE_POINTS; i++) {
          const at = ringPoint(folded, (i / RING_LINE_POINTS) * Math.PI * 2);
          const p = project({ x: root.x + at.x, y: root.y + at.y, depth: root.depth }, root.radius);
          line.push({ x: p.x * (1 - fall), y: p.y * (1 - fall), near: at.z > 0 });
        }
        lines.push(line);
      }
    // The fall is the one result home: it lands in the core.
    if (home && t > 0 && fall > 0)
      packets.push({ direction: "report", x: mark.x, y: mark.y, t: fall, alpha: 1 - fall });
    frames.push({
      id: program.id,
      x: mark.x,
      y: mark.y,
      depth: rootPoint.depth,
      alpha: fade * (1 - fall),
      lit: settled ? 0 : clamp01(1 - (now - program.litAt) / FLASH_MS),
      gem: home ? 1 : program.share,
      spin: seconds * CONSTELLATION.gemSpinRadS,
      nodes: fold >= 1 ? [] : nodes,
      rings: lines,
    });
  }
  return { frames, ended };
}
