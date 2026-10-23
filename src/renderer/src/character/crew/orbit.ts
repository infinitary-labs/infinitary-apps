// The crew orbit: where every live crewmate sits around the Firstmate, how
// it got there, and how it leaves. One DOM-free, time-injected model in the
// style of the character's machine (../machine.ts): the shell feeds it the
// roster as commands (spawn / setStatus / signal / leave), it owns the
// choreography, and each frame it hands the painter (./crewmate.ts) a plain
// snapshot. Nothing here reads a clock, a token, or a canvas.
//
// The small formation is one ring, seen from slightly above (an inclined ellipse
// whose near leg runs across the bottom of the screen), evenly spaced and
// revolving very slowly - the design's "alive but not distracting". Slots
// are a preference, not a position: every crewmate's polar coordinates ride
// springs toward its slot, so a spawn or a departure re-spaces the others
// with one calm glide, never a jump. The adaptive home formation places crew
// on the approved inner-first planes (orbitalPlanes.ts); geometry
// blends while the existing lifecycle, springs and cues remain the owners.
//
// The spawn is the Firstmate sending someone out: a spark condenses in the
// inner cell, leaves tangentially (the same swirl the pretend black hole's
// wind-up uses), and unfolds from a point into its solid as it reaches
// the ring. Leaving has two honest stories: a finished crewmate folds back
// into the Firstmate (home), a dropped or failed one dims and drifts off
// (away). Reports and steers are packets on the same line, direction telling
// which. Every one of these is a target change, so an interruption mid-way
// is just the next target - nothing ever waits for a clip to finish.
//
// While the Firstmate plays its pretend black hole the crew race their
// orbits (./rush.ts): only their travel and a share of their spin speed up,
// with a streak behind each one; every clip keeps its pace.
//
// A remote cluster's orbit (./computers.ts) hands this model a projection
// that puts its circles beside the home formation. Its spark, its fall home
// and its packets then fly one curved path in screen space between the
// Firstmate and the slot, eased once, and a longer trip takes longer
// (REMOTE_TRIP); its cues carry a unit direction so the Firstmate glances
// toward the cluster.

import { type CenterCue, DEPENDENCY_VISUAL } from "@shared/dependencyVisual";
import type { Slot } from "@shared/modelSlots";
import { clamp01, easeInOut, easeOut, Spring, TAU } from "../face";
import { flickerEnvelope, flickerMerge } from "../flicker";
import {
  CONSTELLATION,
  layerGlyphShare,
  layoutProgram,
  type NodePlace,
  type PartState,
  type Program,
  type ProgramPart,
} from "./constellation";
import { CROWDED_PLANES, planePhase, projectPlane } from "./orbitalPlanes";
import { CREW_RUSH, streakArc } from "./rush";
import { SCENE_REACH_PX, satelliteFits, satelliteOffset, satellitePhase } from "./satellites";

export type OrbitProjection = (
  point: { x: number; y: number; depth: number },
  radius: number,
) => { x: number; y: number; depth: number };

export type CrewStatus = "working" | "idle";
export type CrewPhase = "spawning" | "orbiting" | "leaving";
export type LeaveMode = "home" | "away";
export type PacketDirection = "report" | "steer";

export type OrbitTuning = {
  /** Ring radius (major axis) in px with five or fewer crewmates. */
  radius: number;
  /** Minor/major ratio of the ring: 1 is a flat circle seen face-on. */
  tilt: number;
  /** Glyph size in px with five or fewer crewmates. */
  glyph: number;
  /** One full revolution of the formation, in ms. */
  ringPeriodMs: number;
  /** The spark's travel from the inner cell to the ring, in ms. */
  spawnMs: number;
  /** How far the spark swings around the core on its way out, in radians (0 = radial). */
  swirl: number;
  /** Ms between emissions when several spawn at once. */
  staggerMs: number;
  /** Idle crewmates sit this fraction farther out than working ones. */
  idleOffset: number;
  /** A finished crewmate's fall home, in ms. */
  homeMs: number;
  /** A dropped crewmate's fade away, in ms. */
  awayMs: number;
  /** A packet's travel between the ring and the core, in ms. */
  packetMs: number;
};

export const DEFAULT_ORBIT: OrbitTuning = {
  radius: 190,
  tilt: 0.58,
  glyph: 30,
  ringPeriodMs: 64000,
  spawnMs: 720,
  swirl: 1.1,
  staggerMs: 150,
  idleOffset: 0.06,
  homeMs: 620,
  awayMs: 720,
  packetMs: 520,
};

/** How long before emission the Firstmate's send-off cue starts. */
export const SENDOFF_LEAD_MS = 240;
/**
 * A remote clip's trip grows with the distance it covers (the captain's
 * FI3-1519 settings): a spark takes the home spawn's time over the distance a
 * home spark covers, and about a second across the stage; the fall home and
 * a packet add the same extra over their own base.
 */
export const REMOTE_TRIP = {
  /** The distance a home spark covers on average, px: no extra up to here. */
  homeDistancePx: 147,
  /** The spark's trip at this distance... */
  acrossPx: 320,
  /** ...takes this long, ms. */
  acrossMs: 1000,
} as const;

/** How long a remote clip with this base takes over `distancePx`, ms. */
export function remoteTripMs(baseMs: number, distancePx: number): number {
  const extra =
    ((REMOTE_TRIP.acrossMs - DEFAULT_ORBIT.spawnMs) * (distancePx - REMOTE_TRIP.homeDistancePx)) /
    (REMOTE_TRIP.acrossPx - REMOTE_TRIP.homeDistancePx);
  return baseMs + Math.max(0, extra);
}

type Point = { x: number; y: number };
/** A cubic curve in screen space, px from the Firstmate's center. */
type Arc = { from: Point; c1: Point; c2: Point; to: Point };

/**
 * A curved path from `from` to `to` that leaves tangentially, the way the
 * home spark swirls out of the core; `side` (1 or -1) picks which way it
 * bends. Both ends may move: the spark re-aims at its live slot.
 */
export function arcBetween(from: Point, to: Point, side: 1 | -1): Arc {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const nx = -uy;
  const ny = ux;
  const swing = side * 0.8;
  return {
    from,
    c1: {
      x: from.x + (ux * Math.cos(swing) + nx * Math.sin(swing)) * d * 0.38,
      y: from.y + (uy * Math.cos(swing) + ny * Math.sin(swing)) * d * 0.38,
    },
    c2: {
      x: to.x - ux * d * 0.22 + nx * side * d * 0.1,
      y: to.y - uy * d * 0.22 + ny * side * d * 0.1,
    },
    to,
  };
}

/** The point `s` (0..1) of the way along an arc. */
export function alongArc(arc: Arc, s: number): Point {
  const u = 1 - s;
  const w0 = u * u * u;
  const w1 = 3 * u * u * s;
  const w2 = 3 * u * s * s;
  const w3 = s * s * s;
  return {
    x: w0 * arc.from.x + w1 * arc.c1.x + w2 * arc.c2.x + w3 * arc.to.x,
    y: w0 * arc.from.y + w1 * arc.c1.y + w2 * arc.c2.y + w3 * arc.to.y,
  };
}

/** A direction of length one, for a cue; the origin looks right. */
function unit(point: Point): Point {
  const len = Math.hypot(point.x, point.y);
  return len > 0 ? { x: point.x / len, y: point.y / len } : { x: 1, y: 0 };
}

/**
 * The ellipse `centre + u cos t + v sin t` by its axes. A blend of the ring
 * and a plane leaves `u` and `v` oblique, so the axes come from the
 * ellipse's own shape: the eigenvalues of u uᵀ + v vᵀ are the squared
 * semi-axes, and its leading eigenvector is the major axis.
 */
function ellipseOf(centre: Point, u: Point, v: Point): OrbitPath {
  const xx = u.x * u.x + v.x * v.x;
  const yy = u.y * u.y + v.y * v.y;
  const xy = u.x * u.y + v.x * v.y;
  const mid = (xx + yy) / 2;
  const spread = Math.hypot((xx - yy) / 2, xy);
  return {
    x: centre.x,
    y: centre.y,
    major: Math.sqrt(mid + spread),
    minor: Math.sqrt(Math.max(0, mid - spread)),
    angle: Math.atan2(2 * xy, xx - yy) / 2,
  };
}
/** Where the spark starts and the fall home ends, as a fraction of the ring radius. */
const CORE_FRACTION = 0.09;
/** Ring crowding: past this many the ring widens and the glyphs shrink. */
const COMFORTABLE = 5;
/** A nudge (a failed turn) lasts this long. */
export const NUDGE_MS = 600;
/** A steer landing brightens its crewmate for this long. */
const FLASH_MS = 360;
/** Segments in a rushing crewmate's speed streak. */
const STREAK_POINTS = 12;

export type Cue =
  | { kind: "sendoff"; dx: number; dy: number; strength: number }
  | { kind: "receive" };

export type CrewmateFrame = {
  id: string;
  /** Present for the adaptive formation; stable through arrivals/departures. */
  plane?: number;
  status: CrewStatus;
  phase: CrewPhase;
  leaveMode: LeaveMode | null;
  /** Px from the Firstmate's center, screen axes (y down). */
  x: number;
  y: number;
  /** 0 = far leg (behind the Firstmate), 1 = near leg (in front). */
  depth: number;
  /** Glyph size in px, depth and crowding applied. */
  size: number;
  alpha: number;
  /** 0 = a point, 1 = the whole solid. */
  unfold: number;
  /** 0..1 brightness of the travelling spark while spawning. */
  spark: number;
  /** Ghost positions trailing the spark, nearest first. */
  trail: Array<{ x: number; y: number }>;
  /**
   * The arc it just swept along its own orbit during the black hole's rush
   * (./rush.ts), from the crewmate backwards; absent at its normal pace.
   */
  streak?: Array<{ x: number; y: number }>;
  /** 0..1 eased working blend. */
  work: number;
  /**
   * 0..1 eased blend of waiting on its checks (INF-676): working that rests
   * banked - ember at idle strength and pace - inside a cyan checks ring.
   * Absent when it is not waiting.
   */
  checks?: number;
  /**
   * Where the checks ring's travelling arc starts, radians; absent on a
   * settled (reduced-motion) frame, which draws the ring whole and still.
   */
  checksArc?: number;
  /** Own rotation, radians. */
  spin: number;
  /** 0..1 jitter strength of a nudge. */
  nudge: number;
  /** 0..1 brightening after a steer lands. */
  flash: number;
  /** Token-flicker strength (0 = none): a completed request's usage, wavering out (../flicker). */
  flicker: number;
  /** The slot the crewmate is served on, which picks its solid (./crewmate.ts); absent when unknown. */
  tier?: Slot;
  seed: number;
  /** Present only in a multi-computer scene. */
  computerId?: string;
  /** Last-known remote appearance is not evidence of current activity. */
  activityUnknown?: boolean;
};

export type PacketFrame = {
  direction: PacketDirection;
  x: number;
  y: number;
  /** 0..1 progress along the line. */
  t: number;
  alpha: number;
};

/** An arrow from a waiting crewmate or a reviewer to the crewmate it waits on or reviews. */
export type DependencyLink = { fromId: string; toId: string; kind: "wait" | "review" };

/**
 * A task with parts as a branching constellation (./constellation.ts): the
 * program's mark on the inner orbit, a node for every part and a branch for
 * every link it hangs from. A live part's crewmate is drawn at its node; a
 * finished or unstarted part is a small node of its own. Px from the
 * Firstmate's center, like a crewmate.
 */
export type ProgramFrame = {
  id: string;
  x: number;
  y: number;
  depth: number;
  alpha: number;
  /** 0..1: a result has just landed on the mark. */
  lit: number;
  nodes: Array<{ id: string; x: number; y: number; state: PartState; crewed: boolean }>;
  /** `fromId` is the program's own id at the root. */
  branches: Array<{ fromId: string; toId: string; lit: boolean }>;
};

/**
 * An orbit as the crew travel it on screen: an ellipse around `x, y` with
 * semi-axes `major` and `minor`, its major axis at `angle` radians, px from
 * the Firstmate's center.
 */
export type OrbitPath = { x: number; y: number; major: number; minor: number; angle: number };

export type OrbitFrame = {
  /** Multi-computer fitted scene; absent on the unchanged single-computer path. */
  clustered?: boolean;
  /**
   * How far that scene reaches from the Firstmate's center, px, clear air
   * included; the view fits the whole scene to the window from it.
   */
  scene?: { halfWidth: number; halfHeight: number };
  crew: CrewmateFrame[];
  /**
   * The occupied orbits: one for each plane a crewmate that is not leaving
   * travels or is headed for, at the radius it settles at. Empty with nobody out.
   */
  orbits: OrbitPath[];
  packets: PacketFrame[];
  formation: "ring" | "planes";
  planeBlend: number;
  ringRadius: number;
  ringTilt: number;
  /** The crew's travel speed this frame, times normal: above 1 only during the black hole's rush. */
  travel: number;
  /** Crewmates on the ring or on their way to it. */
  count: number;
  working: number;
  idle: number;
  /** An arrow for every wait and review on this orbit, circling or on a slot. Empty when there are none. */
  links: DependencyLink[];
  /** Every task with parts on this orbit, as a constellation. Empty when there are none. */
  programs: ProgramFrame[];
};

type Packet = { direction: PacketDirection; at: number };

/** A live part's node, and every part of its parent, whose waits are branches. */
type Seat = { x: number; y: number; z: number; siblings: ReadonlySet<string> };

/** A result riding a constellation's branches: node ids from where it starts, the program's id at the root. */
type RoutePacket = { route: string[]; at: number; home: boolean };

type ProgramState = {
  id: string;
  parts: ProgramPart[];
  /** Where the mark sits on the inner orbit, travelling with it. */
  rootSlot: number;
  leaving: LeaveMode | null;
  leaveAt: number;
  litAt: number;
  packets: RoutePacket[];
};

type Crewmate = {
  id: string;
  status: CrewStatus;
  phase: CrewPhase;
  leaveMode: LeaveMode | null;
  /** Its task closed while a spark was on its way to it: it leaves once the spark lands. */
  leaveAfter?: LeaveMode;
  spawnAt: number;
  sendoffCued: boolean;
  leaveAt: number;
  /** Where the leave started from, so the fall reads from the ring. */
  leaveFromR: number;
  angle: Spring;
  radius: Spring;
  work: number;
  /** Its working is the host's checks watch (posture active, reason checks). */
  checks: boolean;
  checksBlend: number;
  seed: number;
  spin: number;
  spinVel: number;
  nudgeAt: number;
  flashAt: number;
  /** When the last token flicker began, and its strength (token count mapped). */
  flickerAt: number;
  flickerBoost: number;
  packets: Packet[];
  order: number;
  plane: number;
  /** The plane currently painted; springs toward plane on an inward move. */
  planePosition: Spring;
  planeSlot: number;
  tier?: Slot;
  /** A remote spark's or fall's screen-space path, and how long its trip takes. */
  path?: Arc;
  tripMs?: number;
  /** Offset from the reserved slot toward a blocker, scene px. Zero keeps the slot. */
  companionX: Spring;
  companionY: Spring;
  companionZ: Spring;
  /** Where it was last drawn, companion offset included; a send-off aims here. */
  drawn?: Point;
};

/** The checks ring's travelling arc, radians a second: the fact strip's running mark, carried round. */
const CHECKS_ARC_RATE = 1.6;

const easeIn = (t: number): number => t * t;
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/** The ring widens gently as it crowds. */
export function ringRadiusFor(count: number, tuning: OrbitTuning): number {
  const over = Math.max(0, count - COMFORTABLE);
  return tuning.radius * Math.min(1.25, 1 + over * 0.035);
}

/** Glyphs shrink as the ring crowds, never below 60%. */
export function glyphScaleFor(count: number): number {
  const over = Math.max(0, count - COMFORTABLE);
  return Math.max(0.6, 1 - over * 0.05);
}

export class CrewOrbit {
  private crew = new Map<string, Crewmate>();
  /** Reviewer task -> builder task; the reviewer circles its builder while the review is live. */
  private reviews = new Map<string, string>();
  /** Recorded waits. The slot stays reserved; only the painted offset moves. */
  private dependencies = new Map<string, CenterCue>();
  /** Tasks with parts, by the parent's id; a part's slot stays reserved like a wait's. */
  private programs = new Map<string, ProgramState>();
  private nextOrder = 0;
  private lastSpawnAt = Number.NEGATIVE_INFINITY;
  private cues: Cue[] = [];
  private last: number;
  private crowded = false;
  private planeBlend = new Spring(0, 0.8, 1);
  /** Extra travel the black hole's rush has added to the orbit's clock, ms. */
  private lead = 0;
  private listeners = new Set<() => void>();
  /** Bumps on every command; a static (reduced-motion) frame repaints on it. */
  version = 0;

  constructor(
    now: number,
    public tuning: OrbitTuning = { ...DEFAULT_ORBIT },
    private random: () => number = Math.random,
    private formation: "ring" | "adaptive" = "ring",
    private projection?: OrbitProjection,
  ) {
    this.last = now;
  }

  /** Called after every version bump. Returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  protected bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** Ids on the ring or on their way to it, in ring order. */
  present(): string[] {
    return this.roster().map((c) => c.id);
  }

  has(id: string): boolean {
    return this.crew.has(id);
  }

  statusOf(id: string): CrewStatus | undefined {
    return this.crew.get(id)?.status;
  }

  phaseOf(id: string): CrewPhase | undefined {
    return this.crew.get(id)?.phase;
  }

  /**
   * Removes a crewmate at once, with no departure and no cue: it was placed
   * here by mistake and belongs on another computer (./computers.ts). The
   * others re-space as after any departure, on their springs; nothing snaps.
   */
  discard(id: string): void {
    const c = this.crew.get(id);
    if (!c) return;
    this.crew.delete(id);
    if (c.phase !== "leaving") {
      this.fillPlaneVacancies();
      this.respacePlanes();
    }
    this.bump();
  }

  /**
   * The sequenced board's waits for crew on this orbit. An empty list
   * clears every cue. The original slot is never given away.
   */
  setDependencies(cues: readonly CenterCue[]): void {
    const next = new Map(cues.map((cue) => [cue.waiterId, cue]));
    if (next.size === this.dependencies.size) {
      let same = true;
      for (const [id, cue] of next) {
        const had = this.dependencies.get(id);
        if (
          !had ||
          had.mode !== cue.mode ||
          had.blockerId !== cue.blockerId ||
          had.index !== cue.index ||
          had.count !== cue.count ||
          had.arrows.join() !== cue.arrows.join()
        ) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.dependencies = next;
    this.bump();
  }

  /** The task record, not a title or activity heuristic, identifies a live review. */
  setReview(reviewerId: string, builderId: string | null): void {
    if (this.reviews.get(reviewerId) === builderId || (!builderId && !this.reviews.has(reviewerId)))
      return;
    if (builderId) this.reviews.set(reviewerId, builderId);
    else this.reviews.delete(reviewerId);
    this.bump();
  }

  /**
   * The board's tasks with parts (./constellation.ts). A program first
   * draws once one of its parts is underway; a part filed from finished
   * parts' results takes a packet down each branch it hangs from; the
   * parent's close folds the tree into its mark (done), which then falls
   * home, or fades it (dropped). A closed program the stage never drew
   * draws nothing.
   */
  setPrograms(list: readonly Program[], now: number): void {
    let changed = false;
    const seen = new Set<string>();
    for (const program of list) {
      seen.add(program.id);
      const had = this.programs.get(program.id);
      if (!had) {
        if (program.state !== "live" || !program.parts.some((part) => part.state === "live"))
          continue;
        this.programs.set(program.id, {
          id: program.id,
          parts: program.parts,
          rootSlot: this.openPlaneSlot(0),
          leaving: null,
          leaveAt: 0,
          litAt: Number.NEGATIVE_INFINITY,
          packets: [],
        });
        changed = true;
        continue;
      }
      if (had.leaving) continue;
      const before = new Set(had.parts.map((part) => part.id));
      for (const part of program.parts) {
        if (before.has(part.id)) continue;
        for (const parent of part.parents)
          had.packets.push({ route: [parent, part.id], at: now, home: false });
      }
      const key = (parts: readonly ProgramPart[]) =>
        parts.map((part) => `${part.id}:${part.state}:${part.parents.join("+")}`).join();
      if (key(had.parts) !== key(program.parts)) {
        had.parts = program.parts;
        changed = true;
      }
      if (program.state !== "live") {
        this.endProgram(had, program.state === "done" ? "home" : "away", now);
        changed = true;
      }
    }
    for (const had of this.programs.values()) {
      if (seen.has(had.id) || had.leaving) continue;
      this.endProgram(had, "away", now);
      changed = true;
    }
    if (changed) this.bump();
  }

  private endProgram(program: ProgramState, mode: LeaveMode, now: number): void {
    program.leaving = mode;
    program.leaveAt = now;
    program.packets = [];
  }

  /** The program a crewmate is a part of, on this orbit. */
  private programOfPart(id: string): ProgramState | undefined {
    for (const program of this.programs.values())
      if (!program.leaving && program.parts.some((part) => part.id === id)) return program;
    return undefined;
  }

  /** A part's way up to the mark, by its first parent at each step. */
  private routeHome(program: ProgramState, id: string): string[] {
    const byId = new Map(program.parts.map((part) => [part.id, part]));
    const route = [id];
    let at = byId.get(id);
    while (at?.parents[0] && !route.includes(at.parents[0])) {
      route.push(at.parents[0]);
      at = byId.get(at.parents[0]);
    }
    route.push(program.id);
    return route;
  }

  /**
   * A crewmate starts: the Firstmate sends it out. Several spawns at once
   * are staggered so they read as one, two, three - never a clump - and
   * the ring opens every new slot immediately, so the others re-space once.
   * `settled` places a crewmate that was already out (the roster at boot):
   * restart is not a spawn, so no spark, no stagger, no send-off.
   * `checks` says its working is the wait on its checks, so it starts banked.
   */
  spawn(
    id: string,
    status: CrewStatus,
    now: number,
    settled = false,
    tier?: Slot,
    checks = false,
  ): void {
    if (this.crew.has(id)) return;
    const spawnAt = settled ? now : Math.max(now, this.lastSpawnAt + this.tuning.staggerMs);
    if (!settled) this.lastSpawnAt = spawnAt;
    const count = this.roster().length + 1;
    const ringR = ringRadiusFor(count, this.tuning);
    const counts = CROWDED_PLANES.map((_, i) => this.roster().filter((m) => m.plane === i).length);
    // Fill each plane to its selected capacity before opening the next.
    // Beyond all three capacities, keep the old least-populated overflow rule.
    const plane = counts.findIndex((n, i) => n < (CROWDED_PLANES[i]?.capacity ?? 0));
    const chosenPlane = plane < 0 ? counts.indexOf(Math.min(...counts)) : plane;
    const waits = status === "working" && checks;
    const hot = status === "working" && !waits;
    const c: Crewmate = {
      id,
      status,
      phase: settled ? "orbiting" : "spawning",
      leaveMode: null,
      spawnAt,
      sendoffCued: settled,
      leaveAt: 0,
      leaveFromR: ringR,
      angle: new Spring(0, 0.7, 1),
      // An idle crewmate's posture sits farther out from the first frame.
      radius: new Spring(ringR * (hot ? 1 : 1 + this.tuning.idleOffset), 0.8, 1),
      work: hot ? 1 : 0,
      checks: waits,
      checksBlend: waits ? 1 : 0,
      seed: this.random() * 1000,
      spin: this.random() * TAU,
      spinVel: hot ? 1.5 : 0.35,
      nudgeAt: Number.NEGATIVE_INFINITY,
      flashAt: Number.NEGATIVE_INFINITY,
      flickerAt: Number.NEGATIVE_INFINITY,
      flickerBoost: 0,
      packets: [],
      order: this.nextOrder++,
      plane: chosenPlane,
      planePosition: new Spring(chosenPlane, 0.8, 1),
      planeSlot: this.openPlaneSlot(chosenPlane),
      companionX: new Spring(0, 0.8, 1),
      companionY: new Spring(0, 0.8, 1),
      companionZ: new Spring(0, 0.8, 1),
      ...(tier ? { tier } : {}),
    };
    this.crew.set(id, c);
    this.respacePlanes();
    // Pin the newcomer's angle spring at its slot so the spark aims true.
    this.layout();
    c.angle.x = this.slotAngle(c, now + this.lead);
    c.angle.v = 0;
    this.bump();
  }

  setStatus(id: string, status: CrewStatus): void {
    const c = this.crew.get(id);
    if (!c || c.status === status) return;
    c.status = status;
    this.bump();
  }

  /**
   * Its working is, or stops being, the wait on its checks (INF-676). It
   * stays among the working; only its look banks, and it heats back to full
   * ember the moment a turn runs again.
   */
  setChecks(id: string, checks: boolean): void {
    const c = this.crew.get(id);
    if (!c || c.checks === checks) return;
    c.checks = checks;
    this.bump();
  }

  /**
   * The slot the crewmate is served on is known, or moved (a re-route at a
   * resume): its solid follows. Undefined forgets it - the unknown solid.
   */
  setTier(id: string, tier: Slot | undefined): void {
    const c = this.crew.get(id);
    if (!c || c.tier === tier) return;
    if (tier) c.tier = tier;
    else delete c.tier;
    this.bump();
  }

  /** A report goes in, a steer goes out - the same line, direction tells which. */
  signal(id: string, direction: PacketDirection, now: number): void {
    const c = this.crew.get(id);
    if (direction === "report") {
      // A part's report is its result: it climbs its branches to the mark.
      // The program's own report, with no crewmate of its own here, is the
      // one result home.
      const owner = c && c.phase !== "leaving" ? this.programOfPart(id) : undefined;
      const program = this.programs.get(id);
      if (owner) owner.packets.push({ route: this.routeHome(owner, id), at: now, home: false });
      else if (!c && program && !program.leaving)
        program.packets.push({ route: [id], at: now, home: true });
      if (owner || (!c && program)) {
        this.bump();
        return;
      }
    }
    if (!c || c.phase === "leaving") return;
    c.packets.push({ direction, at: now });
    if (direction === "steer") {
      const a = c.angle.x;
      const circling = Math.hypot(c.companionX.x, c.companionY.x, c.companionZ.x) > 0.5;
      const point =
        this.planeBlend.x === 0 && !this.projection
          ? { x: Math.cos(a), y: Math.sin(a) }
          : this.position(c, a, this.projection ? c.radius.x : 1);
      const dir = circling && c.drawn ? unit(c.drawn) : this.projection ? unit(point) : point;
      this.cues.push({ kind: "sendoff", dx: dir.x, dy: dir.y, strength: 0.5 });
    }
    this.bump();
  }

  /** A failed turn: a brief stutter, nothing more. */
  nudge(id: string, now: number): void {
    const c = this.crew.get(id);
    if (!c) return;
    c.nudgeAt = now;
    this.bump();
  }

  /**
   * One of the crewmate's requests completed: it flickers with the request's
   * token count (strength mapped by ../flicker). A completion landing inside
   * a still-fading flicker keeps whichever is brighter. No version bump: a
   * flicker is motion only, so a static (reduced-motion) frame has nothing
   * to repaint.
   */
  flicker(id: string, strength: number, now: number): void {
    const c = this.crew.get(id);
    if (!c || c.phase === "leaving") return;
    c.flickerBoost = flickerMerge(c.flickerAt, c.flickerBoost, strength, now);
    c.flickerAt = now;
  }

  /**
   * The crewmate's task closes. Home is the finished crewmate folding back
   * into the Firstmate; away is a dropped one dimming off the ring. Either
   * vacates the slot at once, so the ring re-spaces while it goes. Leaving
   * mid-spawn is fine: the spark simply turns. A spark still on its way out
   * to it - the close reaching it (INF-759) - lands first, and the crewmate
   * leaves on the frame after.
   */
  leave(id: string, mode: LeaveMode, now: number): void {
    const c = this.crew.get(id);
    if (!c || c.phase === "leaving") return;
    if (c.packets.some((p) => p.direction === "steer")) {
      c.leaveAfter = mode;
      this.bump();
      return;
    }
    this.depart(c, mode, now);
  }

  private depart(c: Crewmate, mode: LeaveMode, now: number): void {
    delete c.leaveAfter;
    c.phase = "leaving";
    c.leaveMode = mode;
    c.leaveAt = now;
    c.leaveFromR = c.radius.x;
    c.packets = [];
    delete c.drawn;
    delete c.path;
    delete c.tripMs;
    if (this.projection && mode === "home") {
      // A remote crewmate falls home along one screen-space path, taking
      // longer the farther it is (REMOTE_TRIP).
      const from = this.position(c, c.angle.x, c.radius.x);
      c.path = arcBetween({ x: from.x, y: from.y }, { x: 0, y: 0 }, -1);
      c.tripMs = remoteTripMs(this.tuning.homeMs, Math.hypot(from.x, from.y));
    }
    this.fillPlaneVacancies();
    this.respacePlanes();
    this.bump();
  }

  /** Drain the Firstmate-side cues raised since the last take. */
  takeCues(): Cue[] {
    const out = this.cues;
    this.cues = [];
    return out;
  }

  private roster(): Crewmate[] {
    return [...this.crew.values()]
      .filter((c) => c.phase !== "leaving")
      .sort((a, b) => a.order - b.order);
  }

  private ringPhase(now: number): number {
    // Angle decreasing: counter-clockwise on screen, near leg right to left.
    return -(now / this.tuning.ringPeriodMs) * TAU;
  }

  /** How fast a crewmate's slot travels, rad per ms of the orbit's clock. */
  private slotRate(c: Crewmate): number {
    if (this.crowded)
      return (-(Math.PI / 180) * (CROWDED_PLANES[c.plane]?.speedDegPerSec ?? 0)) / 1000;
    return -TAU / this.tuning.ringPeriodMs;
  }

  private slotAngle(c: Crewmate, now: number): number {
    if (this.crowded) {
      const raw = c.planeSlot + planePhase(c.plane, now);
      return raw + Math.round((c.angle.x - raw) / TAU) * TAU;
    }
    const roster = this.roster();
    const n = Math.max(1, roster.length);
    const i = Math.max(0, roster.indexOf(c));
    const raw = this.ringPhase(now) + (i / n) * TAU;
    // The nearest equivalent angle, so the spring never runs the long way.
    return raw + Math.round((c.angle.x - raw) / TAU) * TAU;
  }

  /** Fill an earlier plane with its oldest later member; respacePlanes evens the slots after. */
  private fillPlaneVacancies(): void {
    const roster = this.roster();
    for (let plane = 0; plane < CROWDED_PLANES.length - 1; plane++) {
      let count = roster.filter((c) => c.plane === plane).length;
      while (count < (CROWDED_PLANES[plane]?.capacity ?? 0)) {
        let next: Crewmate | undefined;
        for (let source = plane + 1; source < CROWDED_PLANES.length && !next; source++)
          next = roster.find((c) => c.plane === source);
        if (!next) break;
        next.planeSlot = this.openPlaneSlot(plane);
        next.plane = plane;
        count++;
      }
    }
  }

  /**
   * Every orbit keeps its crew evenly spaced through joins and leaves. Each
   * plane keeps its members' order around the circle and takes the rotation
   * that moves them least, so the angle springs glide them to the new slots.
   */
  private respacePlanes(): void {
    const roster = this.roster();
    for (let plane = 0; plane < CROWDED_PLANES.length; plane++) {
      const members = roster
        .filter((c) => c.plane === plane)
        .sort((a, b) => (((a.planeSlot % TAU) + TAU) % TAU) - (((b.planeSlot % TAU) + TAU) % TAU));
      const m = members.length;
      if (m === 0) continue;
      let sin = 0;
      let cos = 0;
      members.forEach((c, i) => {
        const d = c.planeSlot - (i / m) * TAU;
        sin += Math.sin(d);
        cos += Math.cos(d);
      });
      const base = Math.atan2(sin, cos);
      members.forEach((c, i) => {
        const target = base + (i / m) * TAU;
        c.planeSlot = target + Math.round((c.planeSlot - target) / TAU) * TAU;
      });
    }
  }

  /** Where a newcomer would enter: the middle of the widest gap. */
  private openPlaneSlot(plane: number): number {
    const slots = this.roster()
      .filter((c) => c.plane === plane)
      .map((c) => ((c.planeSlot % TAU) + TAU) % TAU)
      .sort((a, b) => a - b);
    let best = CROWDED_PLANES[plane]?.phase ?? 0;
    let widest = 0;
    for (let i = 0; i < slots.length; i++) {
      const a = slots[i] ?? 0;
      const b = (slots[(i + 1) % slots.length] ?? 0) + (i === slots.length - 1 ? TAU : 0);
      if (b - a > widest) {
        widest = b - a;
        best = (a + b) / 2;
      }
    }
    return best;
  }

  /**
   * The slot in scene space, before a remote cluster's scale and a dependency
   * offset, on plane `onPlane` (a crewmate's painted plane, between two while it glides).
   */
  private scenePoint(onPlane: number, angle: number, radius: number) {
    const mix = this.planeBlend.x;
    const ring = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * this.tuning.tilt,
      z: 0,
      depth: 0.5 + 0.5 * Math.sin(angle),
    };
    if (mix === 0) return ring;
    const lower = Math.max(0, Math.min(CROWDED_PLANES.length - 1, Math.floor(onPlane)));
    const upper = Math.min(CROWDED_PLANES.length - 1, lower + 1);
    const between = clamp01(onPlane - lower);
    const from = projectPlane(lower, angle, radius);
    const to = between === 0 ? from : projectPlane(upper, angle, radius);
    const plane = {
      x: from.x + (to.x - from.x) * between,
      y: from.y + (to.y - from.y) * between,
      z: from.z + (to.z - from.z) * between,
    };
    return {
      x: ring.x + (plane.x - ring.x) * mix,
      y: ring.y + (plane.y - ring.y) * mix,
      z: plane.z * mix,
      depth: ring.depth + (0.5 + plane.z / 512 - ring.depth) * mix,
    };
  }

  private projectScene(
    scene: { x: number; y: number; depth: number },
    radius: number,
  ): { x: number; y: number; depth: number } {
    return this.projection ? this.projection(scene, radius) : scene;
  }

  private position(c: Crewmate, angle: number, radius: number) {
    return this.projectScene(this.scenePoint(c.planePosition.x, angle, radius), radius);
  }

  /**
   * The orbits on `planes` as painted this frame, through the same blend and
   * projection as every crewmate: each at the radius its crew settle at, the
   * ring's idle one blending to the plane's own. The ring is one orbit
   * whatever the planes.
   */
  private orbitPaths(planes: ReadonlySet<number>, ringR: number, mix: number): OrbitPath[] {
    const ringOut = ringR * (1 + this.tuning.idleOffset);
    const traced = mix === 0 ? [...planes].slice(0, 1) : [...planes];
    return traced.map((plane) => {
      const radius = ringOut + ((CROWDED_PLANES[plane]?.radius ?? ringOut) - ringOut) * mix;
      const centre = this.projectScene({ x: 0, y: 0, depth: 0.5 }, radius);
      const along = (angle: number) => {
        const point = this.projectScene(this.scenePoint(plane, angle, radius), radius);
        return { x: point.x - centre.x, y: point.y - centre.y };
      };
      return ellipseOf(centre, along(0), along(Math.PI / 2));
    });
  }

  private layout(): { ringR: number; glyphK: number; n: number } {
    const roster = this.roster();
    const n = roster.length;
    // A task with parts keeps the planes while its next parts are filed.
    const crowded = this.formation === "adaptive" && (n > 0 || this.programs.size > 0);
    if (crowded && !this.crowded) this.spacePlaneSlots(roster);
    this.crowded = crowded;
    return { ringR: ringRadiusFor(n, this.tuning), glyphK: glyphScaleFor(n), n };
  }

  private spacePlaneSlots(roster: Crewmate[]): void {
    for (let plane = 0; plane < CROWDED_PLANES.length; plane++) {
      const members = roster.filter((c) => c.plane === plane);
      members.forEach((c, i) => {
        c.planeSlot = (i / members.length) * TAU + (CROWDED_PLANES[plane]?.phase ?? 0);
      });
    }
  }

  /** Called after the asynchronous boot board is seeded, even if an empty frame painted first. */
  settleBootRoster(now: number): void {
    this.layout();
    if (!this.crowded) return;
    this.spacePlaneSlots(this.roster());
    this.update(now, true);
    this.bump();
  }

  /**
   * Advance and snapshot. `settled` (reduced motion) snaps every spring to
   * its slot and completes every clip, so one static frame shows the
   * formation as it will be - no spark, no fall, no packet. `rush` is the
   * black hole's rush level (./rush.ts), 0 at the normal pace; a settled
   * frame has none.
   */
  update(now: number, settled = false, rush = 0): OrbitFrame {
    const dt = Math.min(Math.max(0, now - this.last) / 1000, 0.05);
    this.last = now;
    // A crewmate whose close waited on its spark leaves once the spark has
    // landed; a settled frame lands every spark at once.
    for (const c of this.crew.values()) {
      if (c.leaveAfter && (settled || !c.packets.some((p) => p.direction === "steer")))
        this.depart(c, c.leaveAfter, now);
    }
    const tuning = this.tuning;
    const { ringR, glyphK } = this.layout();
    // The rush runs the crew's travel `travel` times faster: the extra is a
    // lead on the orbit's clock, and every angle spring moves with its
    // target, so the crew race on their slots instead of trailing them.
    // Spawns, departures, packets and every other clip keep their pace.
    const level = settled ? 0 : clamp01(rush);
    const travel = 1 + (CREW_RUSH.peak - 1) * level;
    const lead = (travel - 1) * dt * 1000;
    this.lead += lead;
    const targetBlend = this.crowded ? 1 : 0;
    if (settled) {
      this.planeBlend.x = targetBlend;
      this.planeBlend.v = 0;
    } else {
      this.planeBlend.step(targetBlend, dt);
      if (Math.abs(this.planeBlend.x - targetBlend) < 0.00001) {
        this.planeBlend.x = targetBlend;
        this.planeBlend.v = 0;
      }
    }
    const mix = this.planeBlend.x;
    const slotTime = settled && this.crowded ? 0 : now + this.lead;
    const coreR = ringR * CORE_FRACTION;
    const crewFrames: CrewmateFrame[] = [];
    const scenes = new Map<
      string,
      { x: number; y: number; z: number; depth: number; radius: number }
    >();
    const packets: PacketFrame[] = [];
    const anchors = new Map<string, { c: Crewmate; wobble: number }>();
    const gone: string[] = [];
    /** The planes of the painted crewmates that are not leaving. */
    const occupied = new Set<number>();
    let working = 0;
    let idle = 0;

    for (const c of this.crew.values()) {
      if (settled) {
        c.planePosition.x = c.plane;
        c.planePosition.v = 0;
      } else c.planePosition.step(c.plane, dt);
      if (c.phase !== "leaving") {
        if (c.status === "working") working += 1;
        else idle += 1;
      }
      if (lead > 0) c.angle.x += this.slotRate(c) * lead;
      // Working blend and own spin: the rig's dt*4 ease, spin easing over ~0.3s.
      // The rush lends the spin a share of its boost. Waiting on its checks
      // keeps it working at an idle pace, banked, on the same ease; a
      // settled frame shows both blends as they will be.
      const waits = c.status === "working" && c.checks;
      const workTarget = c.status === "working" && !waits ? 1 : 0;
      const checksTarget = waits ? 1 : 0;
      const ease = settled ? 1 : Math.min(dt * 4, 1);
      c.work += (workTarget - c.work) * ease;
      c.checksBlend += (checksTarget - c.checksBlend) * ease;
      const spinTarget = 0.35 + 1.15 * c.work;
      c.spinVel += (spinTarget - c.spinVel) * Math.min(dt * 3, 1);
      c.spin += c.spinVel * dt * (1 + (travel - 1) * CREW_RUSH.spinShare);

      // Slot targets: the ring's slow revolution plus the crewmate's posture.
      const idleOut = 1 + tuning.idleOffset * (1 - c.work);
      const ringTarget = ringR * idleOut;
      const targetR =
        ringTarget + ((CROWDED_PLANES[c.plane]?.radius ?? ringTarget) - ringTarget) * mix;
      let a: number;
      let r: number;
      let alpha = 1;
      let unfold = 1;
      let spark = 0;
      const trail: Array<{ x: number; y: number }> = [];
      /** Where a remote clip is along its screen-space path, when it is on one. */
      let screen: Point | null = null;

      if (c.phase === "spawning") {
        const targetA = this.slotAngle(c, slotTime);
        if (!c.sendoffCued && now >= c.spawnAt - SENDOFF_LEAD_MS) {
          c.sendoffCued = true;
          const point = this.position(c, targetA, this.projection ? targetR : 1);
          const dir = this.projection ? unit(point) : point;
          this.cues.push({
            kind: "sendoff",
            dx: dir.x,
            dy: dir.y,
            strength: 1,
          });
        }
        if (this.projection) {
          // A remote spark flies one curved screen-space path from the
          // Firstmate to its slot, re-aimed at the live slot each frame, and
          // takes longer the farther it flies (REMOTE_TRIP).
          const live = this.position(c, targetA, targetR);
          const to = { x: live.x, y: live.y };
          if (!c.path) {
            c.path = arcBetween({ x: 0, y: 0 }, to, 1);
            c.tripMs = remoteTripMs(tuning.spawnMs, Math.hypot(to.x, to.y));
          } else c.path = arcBetween(c.path.from, to, 1);
        }
        const dur = c.tripMs ?? tuning.spawnMs;
        const t = settled ? 1 : clamp01((now - c.spawnAt) / dur);
        if (now < c.spawnAt && !settled) {
          // Not yet emitted: hold the slot, show nothing.
          c.angle.x = targetA;
          c.radius.x = targetR;
          continue;
        }
        if (t >= 1) {
          c.phase = "orbiting";
          c.angle.x = targetA;
          c.angle.v = 0;
          c.radius.x = targetR;
          c.radius.v = 0;
          delete c.path;
          delete c.tripMs;
        }
        // The spark aims at the live slot (the ring keeps turning underneath).
        c.angle.x = targetA;
        c.radius.x = targetR;
        const travel = easeOutCubic(t);
        alpha = clamp01(t / 0.15);
        unfold = easeInOut(clamp01((t - 0.35) / 0.65));
        spark = 1 - unfold;
        if (c.path) {
          a = targetA;
          r = targetR;
          screen = alongArc(c.path, travel);
          if (spark > 0.01) {
            for (let g = 1; g <= 3; g++)
              trail.push(alongArc(c.path, easeOutCubic(clamp01(t - g * 0.035))));
          }
        } else {
          r = coreR + (targetR - coreR) * travel;
          a = targetA + tuning.swirl * (1 - travel);
          if (spark > 0.01) {
            // Three ghosts a few frames behind along the same path.
            for (let g = 1; g <= 3; g++) {
              const tg = clamp01(t - g * 0.035);
              const trg = easeOutCubic(tg);
              const rg = coreR + (targetR - coreR) * trg;
              const ag = targetA + tuning.swirl * (1 - trg);
              const point = this.position(c, ag, rg);
              trail.push({ x: point.x, y: point.y });
            }
          }
        }
      } else if (c.phase === "leaving") {
        const mode = c.leaveMode ?? "away";
        const dur = c.tripMs ?? (mode === "home" ? tuning.homeMs : tuning.awayMs);
        const t = settled ? 1 : clamp01((now - c.leaveAt) / dur);
        // The angle keeps riding its spring so the departure follows the ring.
        c.angle.step(c.angle.x, dt);
        a = c.angle.x;
        if (mode === "home") {
          // Falls in, accelerating; folds over the first two thirds.
          r = c.leaveFromR + (coreR - c.leaveFromR) * easeIn(t);
          if (c.path) {
            r = c.leaveFromR;
            screen = alongArc(c.path, easeIn(t));
          }
          unfold = 1 - easeInOut(clamp01(t / 0.66));
          alpha = 1 - easeIn(clamp01((t - 0.75) / 0.25));
          spark = clamp01((t - 0.4) / 0.4) * (1 - easeIn(clamp01((t - 0.85) / 0.15)));
        } else {
          // Dims and drifts outward, folding as the light goes.
          r = c.leaveFromR + 40 * easeOut(t);
          unfold = 1 - easeInOut(t);
          alpha = 1 - easeIn(t);
        }
        if (t >= 1) {
          gone.push(c.id);
          if (mode === "home") this.cues.push({ kind: "receive" });
          continue;
        }
      } else {
        const targetA = this.slotAngle(c, slotTime);
        if (settled) {
          c.angle.x = targetA;
          c.angle.v = 0;
          c.radius.x = targetR;
          c.radius.v = 0;
        } else {
          c.angle.step(targetA, dt);
          c.radius.step(targetR, dt);
        }
        a = c.angle.x;
        r = c.radius.x;
      }

      const scene = this.scenePoint(c.planePosition.x, a, r);
      scenes.set(c.id, { x: scene.x, y: scene.y, z: scene.z, depth: scene.depth, radius: r });
      const slot = this.projectScene(scene, r);
      const position = screen ? { x: screen.x, y: screen.y, depth: slot.depth } : slot;
      const depth = position.depth;
      // Idle crewmates bob slowly across the ring plane; working ones hold steady.
      const wobble = (1 - c.work) * Math.sin((now / 1000) * 1.1 + c.seed) * 3 * unfold * (1 - mix);
      // During the rush an orbiting crewmate trails the arc it just swept.
      let streak: Array<{ x: number; y: number }> | undefined;
      const rate = this.slotRate(c);
      const arc = c.phase === "orbiting" ? streakArc(rate * 1000 * travel, level) : 0;
      if (arc > 0) {
        streak = [];
        for (let i = 0; i <= STREAK_POINTS; i++) {
          const point = this.position(c, a - Math.sign(rate) * arc * (i / STREAK_POINTS), r);
          streak.push({ x: point.x, y: point.y + wobble });
        }
      }
      const nudge = settled ? 0 : clamp01(1 - (now - c.nudgeAt) / NUDGE_MS);
      const flash = settled ? 0 : clamp01(1 - (now - c.flashAt) / FLASH_MS);
      const flicker = settled ? 0 : flickerEnvelope(now - c.flickerAt) * c.flickerBoost;
      if (c.phase !== "leaving") occupied.add(c.plane);
      crewFrames.push({
        id: c.id,
        status: c.status,
        phase: c.phase,
        leaveMode: c.leaveMode,
        ...(this.formation === "adaptive" ? { plane: c.plane } : {}),
        x: position.x,
        y: position.y + wobble,
        depth,
        size: (tuning.glyph * glyphK + (25 - tuning.glyph * glyphK) * mix) * (0.84 + 0.32 * depth),
        alpha: alpha * (0.78 + 0.22 * depth + (-0.1 + 0.1 * depth) * mix),
        unfold,
        spark,
        trail,
        ...(streak ? { streak } : {}),
        work: c.work,
        ...(c.checksBlend > 0.001
          ? {
              checks: c.checksBlend,
              ...(settled ? {} : { checksArc: (now / 1000) * CHECKS_ARC_RATE + c.seed }),
            }
          : {}),
        spin: c.spin,
        nudge: nudge * Math.sin(nudge * Math.PI),
        flash,
        flicker,
        ...(c.tier ? { tier: c.tier } : {}),
        seed: c.seed,
      });

      anchors.set(c.id, { c, wobble });
    }
    for (const id of gone) this.crew.delete(id);
    if (gone.length > 0) this.bump();
    const layouts = this.layoutPrograms(slotTime, ringR, mix);
    const seats = new Map<string, Seat>();
    for (const layout of layouts) {
      if (layout.program.leaving) continue;
      const siblings = new Set(layout.program.parts.map((part) => part.id));
      for (const part of layout.program.parts) {
        const place = layout.places.get(part.id);
        if (part.state === "live" && place)
          seats.set(part.id, { x: place.x, y: place.y, z: layout.root.z, siblings });
      }
    }
    const links = this.applyCompanions(crewFrames, scenes, now, settled, dt, seats);
    const programs = this.programFrames(layouts, crewFrames, now, settled, packets);
    // Packets ride the line to where the crewmate is drawn, circle included.
    for (const frame of crewFrames) {
      const anchor = anchors.get(frame.id);
      if (!anchor) continue;
      anchor.c.drawn = { x: frame.x, y: frame.y - anchor.wobble };
      this.ridePackets(anchor.c, anchor.c.drawn, now, settled, packets);
    }

    return {
      crew: mix > 0 ? crewFrames.sort((a, b) => a.depth - b.depth) : crewFrames,
      orbits: this.orbitPaths(occupied, ringR, mix),
      packets,
      links,
      programs,
      formation: this.crowded ? "planes" : "ring",
      planeBlend: mix,
      travel,
      ringRadius: ringR,
      ringTilt: tuning.tilt,
      count: working + idle,
      working,
      idle,
    };
  }

  /**
   * Each program's mark and the layout of its parts, in scene space before a
   * remote cluster's projection. The mark rides the inner orbit at its own
   * angle; the planes must be settled in, as for a waiting crewmate's circle.
   */
  private layoutPrograms(
    slotTime: number,
    ringR: number,
    mix: number,
  ): Array<{
    program: ProgramState;
    root: { x: number; y: number; z: number; depth: number; radius: number };
    places: Map<string, NodePlace>;
  }> {
    if (this.formation !== "adaptive" || mix < 0.999) return [];
    const radius = ringR + ((CROWDED_PLANES[0]?.radius ?? ringR) - ringR) * mix;
    return [...this.programs.values()].map((program) => {
      const angle = program.rootSlot + planePhase(0, slotTime);
      const scene = this.scenePoint(0, angle, radius);
      const root = { ...scene, radius };
      const places = layoutProgram(program.parts, root, SCENE_REACH_PX);
      return { program, root, places };
    });
  }

  /**
   * Paint-ready constellations, and their results in flight among the
   * packets: a branch lights while a result rides it, the mark lights when
   * one lands, and a result that reaches the core is received there. A
   * closing program folds into its mark, which then falls home, or fades.
   */
  private programFrames(
    layouts: ReturnType<CrewOrbit["layoutPrograms"]>,
    crew: CrewmateFrame[],
    now: number,
    settled: boolean,
    packets: PacketFrame[],
  ): ProgramFrame[] {
    const frames: ProgramFrame[] = [];
    const drawn = new Map(crew.filter((c) => c.phase !== "leaving").map((c) => [c.id, c]));
    const ended: string[] = [];
    for (const { program, root, places } of layouts) {
      const tuning = this.tuning;
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
      const rootPoint = this.projectScene(root, root.radius);
      const at = new Map<string, Point>();
      const nodes: ProgramFrame["nodes"] = [];
      const share = layerGlyphShare(program.parts, places);
      for (const part of program.parts) {
        const place = places.get(part.id);
        if (!place) continue;
        const scene = {
          x: place.x + (root.x - place.x) * fold,
          y: place.y + (root.y - place.y) * fold,
          depth: root.depth,
        };
        const point = this.projectScene(scene, root.radius);
        const mate = part.state === "live" ? drawn.get(part.id) : undefined;
        if (mate) mate.size *= share;
        const where = mate ? { x: mate.x, y: mate.y } : { x: point.x, y: point.y };
        at.set(part.id, where);
        nodes.push({ id: part.id, ...where, state: part.state, crewed: Boolean(mate) });
      }
      // The mark falls home over the last stretch of a done close.
      const fall = home ? easeIn(clamp01((t - foldMs) / (1 - foldMs))) : 0;
      const mark = { x: rootPoint.x * (1 - fall), y: rootPoint.y * (1 - fall) };
      at.set(program.id, mark);
      const lit = new Set<string>();
      const keep: RoutePacket[] = [];
      for (const packet of program.packets) {
        const points = packet.route.map((id) => at.get(id)).filter((p): p is Point => !!p);
        if (packet.home) points.push({ x: 0, y: 0 });
        const legs = Math.max(1, points.length - 1);
        const dur = tuning.packetMs * (0.6 + 0.4 * legs);
        const u = settled ? 1 : clamp01((now - packet.at) / dur);
        if (u >= 1 || points.length < 2) {
          if (packet.home) this.cues.push({ kind: "receive" });
          else program.litAt = now;
          continue;
        }
        keep.push(packet);
        const along = easeInOut(u) * legs;
        const leg = Math.min(legs - 1, Math.floor(along));
        const a = points[leg] as Point;
        const b = points[leg + 1] as Point;
        const s = along - leg;
        const from = packet.route[leg];
        const to = packet.route[leg + 1];
        if (from && to) lit.add(`${from}>${to}`).add(`${to}>${from}`);
        packets.push({
          direction: "report",
          x: a.x + (b.x - a.x) * s,
          y: a.y + (b.y - a.y) * s,
          t: u,
          alpha: Math.sin(u * Math.PI) ** 0.5,
        });
      }
      program.packets = keep;
      const branches: ProgramFrame["branches"] = [];
      for (const part of program.parts) {
        if (!at.has(part.id)) continue;
        const parents = part.parents.filter((id) => at.has(id));
        for (const fromId of parents.length ? parents : [program.id])
          branches.push({ fromId, toId: part.id, lit: lit.has(`${fromId}>${part.id}`) });
      }
      if (home && t > 0) {
        // The fall is the one result home: it lands in the core.
        if (fall > 0)
          packets.push({ direction: "report", x: mark.x, y: mark.y, t: fall, alpha: 1 - fall });
      }
      frames.push({
        id: program.id,
        x: mark.x,
        y: mark.y,
        depth: rootPoint.depth,
        alpha: fade * (1 - fall),
        lit: settled ? 0 : clamp01(1 - (now - program.litAt) / FLASH_MS),
        nodes: fold >= 1 ? [] : nodes,
        branches: fold >= 1 ? [] : branches,
      });
    }
    for (const id of ended) {
      const program = this.programs.get(id);
      this.programs.delete(id);
      if (program?.leaving === "home" && !settled) this.cues.push({ kind: "receive" });
    }
    if (ended.length > 0) this.bump();
    return frames;
  }

  /** Advance one crewmate's packets along the live line between it and the core. */
  private ridePackets(
    c: Crewmate,
    position: Point,
    now: number,
    settled: boolean,
    packets: PacketFrame[],
  ): void {
    const keep: Packet[] = [];
    // A remote crewmate's packet takes longer the farther it flies (REMOTE_TRIP).
    const packetMs = this.projection
      ? remoteTripMs(this.tuning.packetMs, Math.hypot(position.x, position.y))
      : this.tuning.packetMs;
    for (const p of c.packets) {
      const t = settled ? 1 : clamp01((now - p.at) / packetMs);
      if (t >= 1) {
        if (p.direction === "report") this.cues.push({ kind: "receive" });
        else c.flashAt = now;
        continue;
      }
      keep.push(p);
      const cx = position.x;
      const cy = position.y;
      const from = p.direction === "report" ? { x: cx, y: cy } : { x: 0, y: 0 };
      const to = p.direction === "report" ? { x: 0, y: 0 } : { x: cx, y: cy };
      // A gentle arc: the control point bulges 12% of the distance to one side.
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const mx = (from.x + to.x) / 2 - dy * 0.12;
      const my = (from.y + to.y) / 2 + dx * 0.12;
      const u = easeInOut(t);
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * (1 - u) * u;
      const w2 = u * u;
      packets.push({
        direction: p.direction,
        x: w0 * from.x + w1 * mx + w2 * to.x,
        y: w0 * from.y + w1 * my + w2 * to.y,
        t,
        alpha: Math.sin(t * Math.PI) ** 0.5,
      });
    }
    c.packets = keep;
  }

  /**
   * The recorded waits plus each live review: a reviewer circles its builder
   * like a satellite does. A real dependency keeps its place; the reviewers
   * and satellites of one builder share up to three seats, and more than that
   * (or a builder that is itself a satellite) leaves reviewers on their slots.
   * Every reviewer keeps its arrow to the builder, wherever it is drawn. A
   * builder or reviewer off this orbit draws nothing.
   */
  private withReviewCues(): Map<string, CenterCue> {
    const cues = new Map(this.dependencies);
    const live = (id: string) => this.crew.get(id)?.phase === "orbiting";
    // The review's own merge hold on the builder is the reviewer's circle seen
    // from the other side: the builder never orbits or tethers to its reviewer.
    for (const [reviewer, builder] of this.reviews) {
      const hold = cues.get(builder);
      if (hold?.blockerId !== reviewer && !hold?.arrows.includes(reviewer)) continue;
      const arrows = hold.arrows.filter((id) => id !== reviewer);
      if (hold.mode === "tether" && arrows.length > 0) cues.set(builder, { ...hold, arrows });
      else cues.delete(builder);
    }
    const byBuilder = new Map<string, string[]>();
    for (const [reviewer, builder] of this.reviews) {
      if (cues.has(reviewer) || reviewer === builder || !live(reviewer) || !live(builder)) continue;
      const list = byBuilder.get(builder) ?? [];
      list.push(reviewer);
      byBuilder.set(builder, list);
    }
    for (const [builder, reviewers] of byBuilder) {
      reviewers.sort();
      const seated = [...cues.values()]
        .filter((cue) => cue.mode === "satellite" && cue.blockerId === builder)
        .sort((a, b) => a.index - b.index);
      const count = seated.length + reviewers.length;
      const nested = cues.get(builder)?.mode === "satellite";
      const satellite = !nested && count <= DEPENDENCY_VISUAL.maxCompanions;
      if (satellite) {
        for (const [index, cue] of seated.entries())
          cues.set(cue.waiterId, { ...cue, index, count });
      }
      reviewers.forEach((reviewer, i) => {
        cues.set(reviewer, {
          waiterId: reviewer,
          mode: satellite ? "satellite" : "tether",
          blockerId: builder,
          index: seated.length + i,
          count: satellite ? count : 1,
          arrows: [builder],
        });
      });
    }
    return cues;
  }

  /**
   * Move eligible idle waits onto their blocker's perpendicular circle, and
   * name the arrow of every wait and review, circling or on a slot. The angle
   * and radius springs are untouched, so clearing a wait glides the offset home.
   */
  private applyCompanions(
    frames: CrewmateFrame[],
    scenes: ReadonlyMap<string, { x: number; y: number; z: number; depth: number; radius: number }>,
    now: number,
    settled: boolean,
    dt: number,
    seats: ReadonlyMap<string, Seat> = new Map(),
  ): DependencyLink[] {
    const links: DependencyLink[] = [];
    const cues = this.withReviewCues();
    // A part is seated at its node and never circles. Its branches replace a
    // wait arrow to a sibling part; a wait outside its parent keeps its arrow.
    for (const [id, cue] of cues) {
      const seat = seats.get(id);
      if (seat) {
        const arrows = cue.arrows.filter((to) => !seat.siblings.has(to));
        if (arrows.length > 0) cues.set(id, { ...cue, mode: "tether", index: 0, count: 1, arrows });
        else cues.delete(id);
      } else if (cue.mode === "satellite" && seats.has(cue.blockerId))
        cues.set(id, { ...cue, mode: "tether", index: 0, count: 1 });
    }
    if (
      cues.size === 0 &&
      seats.size === 0 &&
      ![...this.crew.values()].some((c) => c.companionX.x || c.companionY.x || c.companionZ.x)
    )
      return links;
    const byId = new Map(frames.map((frame) => [frame.id, frame]));
    const wanted = new Map<string, { x: number; y: number; z: number; arrows: string[] }>();
    const groups = new Map<string, string[]>();
    for (const [id, cue] of cues) {
      if (cue.mode !== "satellite" || this.planeBlend.x < 0.999) {
        wanted.set(id, { x: 0, y: 0, z: 0, arrows: cue.arrows });
        continue;
      }
      const list = groups.get(cue.blockerId) ?? [];
      list.push(id);
      groups.set(cue.blockerId, list);
    }
    for (const [blockerId, ids] of groups) {
      const blocker = this.crew.get(blockerId);
      const origin = blocker ? scenes.get(blockerId) : undefined;
      if (blocker?.phase !== "orbiting" || !origin) {
        for (const id of ids) wanted.set(id, { x: 0, y: 0, z: 0, arrows: [blockerId] });
        continue;
      }
      const placed = ids.flatMap((id) => {
        const cue = cues.get(id);
        const mate = this.crew.get(id);
        if (!cue || !mate || mate.phase !== "orbiting") return [];
        const offset = satelliteOffset(
          blocker.plane,
          blocker.angle.x,
          satellitePhase(cue.index, cue.count, now, settled),
        );
        return [{ id, x: origin.x + offset[0], y: origin.y + offset[1], z: offset[2] }];
      });
      const fits = placed.length === ids.length && placed.every((point) => satelliteFits(point));
      for (const id of ids) {
        const point = placed.find((item) => item.id === id);
        const slot = scenes.get(id);
        // Circling or on its slot, the companion keeps its arrow to the blocker.
        wanted.set(
          id,
          fits && point && slot
            ? {
                x: point.x - slot.x,
                y: point.y - slot.y,
                z: point.z - (slot.z ?? 0),
                arrows: [blockerId],
              }
            : { x: 0, y: 0, z: 0, arrows: [blockerId] },
        );
      }
    }
    for (const [id, seat] of seats) {
      const slot = scenes.get(id);
      if (!slot) continue;
      wanted.set(id, {
        x: seat.x - slot.x,
        y: seat.y - slot.y,
        z: seat.z - slot.z,
        arrows: cues.get(id)?.arrows ?? [],
      });
    }
    for (const frame of frames) {
      const mate = this.crew.get(frame.id);
      const scene = scenes.get(frame.id);
      if (!mate || !scene) continue;
      // A departing crewmate has no circle: its offset eases out on the springs
      // as it falls, so it leaves from the seat it was drawn at.
      const target =
        mate.phase === "leaving"
          ? { x: 0, y: 0, z: 0, arrows: [] }
          : (wanted.get(frame.id) ?? { x: 0, y: 0, z: 0, arrows: [] });
      if (mate.phase === "spawning") {
        // A spark still aims at its slot.
      } else if (settled) {
        mate.companionX.x = target.x;
        mate.companionY.x = target.y;
        mate.companionZ.x = target.z;
        mate.companionX.v = 0;
        mate.companionY.v = 0;
        mate.companionZ.v = 0;
      } else {
        mate.companionX.step(target.x, dt);
        mate.companionY.step(target.y, dt);
        mate.companionZ.step(target.z, dt);
        // Close to home with nothing to circle: land exactly on the slot.
        if (
          !target.x &&
          !target.y &&
          !target.z &&
          Math.hypot(mate.companionX.x, mate.companionY.x, mate.companionZ.x) < 0.05
        ) {
          for (const spring of [mate.companionX, mate.companionY, mate.companionZ]) {
            spring.x = 0;
            spring.v = 0;
          }
        }
      }
      const moved = Math.hypot(mate.companionX.x, mate.companionY.x, mate.companionZ.x) > 0.5;
      if (moved && frame.phase !== "spawning") {
        const slot = this.projectScene(scene, scene.radius);
        const next = this.projectScene(
          {
            x: scene.x + mate.companionX.x,
            y: scene.y + mate.companionY.x,
            depth: scene.depth + mate.companionZ.x / 512,
          },
          scene.radius,
        );
        // The frame's y already includes the idle wobble. Keep it.
        // Add the offset as a delta to wherever the frame already is, so a
        // departing crewmate's screen-space arc is kept. The delta fades out
        // over the fall, so it lands on the Firstmate's center.
        const fade =
          mate.phase === "leaving" && !settled
            ? 1 -
              clamp01(
                (now - mate.leaveAt) /
                  (mate.tripMs ??
                    (mate.leaveMode === "home" ? this.tuning.homeMs : this.tuning.awayMs)),
              )
            : 1;
        frame.x += (next.x - slot.x) * fade;
        frame.y += (next.y - slot.y) * fade;
        frame.size *= (0.84 + 0.32 * next.depth) / (0.84 + 0.32 * frame.depth);
        frame.depth = next.depth;
        delete frame.streak;
      }
      if (mate.phase === "orbiting") {
        for (const toId of target.arrows) {
          if (!byId.has(toId)) continue;
          const kind = this.reviews.get(frame.id) === toId ? "review" : "wait";
          links.push({ fromId: frame.id, toId, kind });
        }
      }
    }
    return links;
  }
}
