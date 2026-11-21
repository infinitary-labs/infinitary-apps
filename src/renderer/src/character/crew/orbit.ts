import { BATCH_GATE } from "@shared/batchGate";
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
// on the captain's growing ring (orbitalPlanes.ts): one orbit widens as crew
// arrive, a second opens inside it past its seats; geometry blends while the
// existing lifecycle, springs and cues remain the owners.
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
// While it plays a warp (../warp.ts) the crew ride along (./warp.ts): their
// travel speeds up the same way, the tunnel opens their orbits face-on, and
// each orbiting crewmate is moved in screen space after it is seated.
//
// A remote cluster's orbit (./computers.ts) hands this model a projection
// that puts its circles beside the home formation. Its spark, its fall home
// and its packets then fly one curved path in screen space between the
// Firstmate and the slot, eased once, and a longer trip takes longer
// (REMOTE_TRIP); its cues carry a unit direction so the Firstmate glances
// toward the cluster.
//
// Beside it: the screen-space paths and ellipses (./orbitPaths.ts), the
// companions that circle a blocker or a program's mark (./companions.ts), and
// the tasks with parts drawn as their parts circling a mark (./programs.ts).

import type { CenterCue } from "@shared/dependencyVisual";
import type { Slot } from "@shared/modelSlots";
import { clamp01, easeInOut, easeOut, Spring, TAU } from "../face";
import { flickerEnvelope, flickerMerge } from "../flicker";
import { type WarpFrame, warpCrewTravel } from "../warp";
import { type CircleBase, companionTargets, seatParts, withReviewCues } from "./companions";
import { type Program, programShare, runningParts } from "./constellation";
import { FIXED_STARS, skyPlaces, twinkleOf } from "./fixedStars";
import { CROWDED_PLANES, planePhase, planeRadius, projectPlane } from "./orbitalPlanes";
import {
  type Arc,
  alongArc,
  arcBetween,
  easeIn,
  easeOutCubic,
  ellipseOf,
  type OrbitPath,
  type Point,
  type SceneSlot,
  unit,
} from "./orbitPaths";
import {
  endProgram,
  FLASH_MS,
  layoutPrograms,
  type ProgramState,
  partSeats,
  programFrames,
  programOfPart,
  type Seat,
  takeParts,
} from "./programs";
import { CREW_RUSH, streakArc } from "./rush";
import { warpCrewmate } from "./warp";

export type OrbitProjection = (
  point: { x: number; y: number; depth: number },
  radius: number,
) => { x: number; y: number; depth: number };

export type CrewStatus = "working" | "idle";
/**
 * The background wait its working is, when it is one: the host's checks
 * watch, or local work it left running (posture reason `job`). Either rests
 * banked inside the wait ring; only the wires' color tells them apart.
 * A batch replaces the dashes with paired arcs, turning only during a run.
 */
export type CrewWait = "checks" | "job" | "batch" | "batch-running" | null;
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

/** A home crewmate's glyph in the crowded planes, px, before the depth cue. */
export const PLANES_GLYPH_PX = 25;

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

/** Where the spark starts and the fall home ends, as a fraction of the ring radius. */
const CORE_FRACTION = 0.09;
/** Ring crowding: past this many the ring widens and the glyphs shrink. */
const COMFORTABLE = 5;
/** A nudge (a failed turn) lasts this long. */
export const NUDGE_MS = 600;
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
   * 0..1 eased blend of a background wait (INF-676, INF-1777): working that
   * rests banked - idle strength and pace - inside the dashed wait ring.
   * Absent when it is not waiting.
   */
  wait?: number;
  /**
   * 0..1 eased share of that wait that is local work (posture `job`): its
   * wires stay ember; a wait on checks turns them ice cyan. Absent at zero.
   */
  job?: number;
  /**
   * Where the wait ring's travelling arc starts, radians; absent on a
   * settled (reduced-motion) frame, which draws the ring whole and still.
   */
  waitArc?: number;
  /** The batch gate replaces the dashed ring; only an active batch turns. */
  batch?: true;
  batchTurn?: number;
  /**
   * 0..1 eased blend of waiting on the captain (INF-1543, the captain's
   * direction A): the Tasks row's Waiting on you ring, round the solid,
   * breathing. Absent when it is not waiting.
   */
  captain?: number;
  /**
   * Where the beacon's breath is, 0 faintest .. 1 brightest; absent on a
   * settled (reduced-motion) frame, which draws the ring whole and still.
   */
  captainBreath?: number;
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
  /**
   * 0..1 eased blend of a fixed star (./fixedStars.ts): its task is listed
   * under Pinned, so it holds a place in the sky and wears the glint.
   * Absent when it is not pinned.
   */
  star?: number;
  /** The glint's twinkle, -0.5..0.5; absent on a settled frame, which holds it steady. */
  twinkle?: number;
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
 * A task with parts (./constellation.ts): the program's mark on the first
 * orbit, a node for every running part whose crewmate is drawn there as it
 * circles the mark, the faint rings they circle on, and the gem round the
 * mark. A finished or unstarted part draws nothing (INF-1037). Px from the
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
  /** 0..1: the share of its parts finished, as the gem's wires; 0 draws the plain ring. */
  gem: number;
  /** The gem's turn, radians. */
  spin: number;
  /** Each running part, where its crewmate is drawn. */
  nodes: Array<{ id: string; x: number; y: number }>;
  /** Each ring the parts circle on, as a closed line; `near` is its half toward the viewer. */
  rings: Array<Array<{ x: number; y: number; near: boolean }>>;
};

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
  /** Every task with parts on this orbit, its parts circling its mark. Empty when there are none. */
  programs: ProgramFrame[];
  /** The hairline joining the fixed stars, neighbour to neighbour; absent when there are none. */
  starJoins?: StarJoin[];
};

/** One stretch of the hairline between two fixed stars (./fixedStars.ts). */
export type StarJoin = { fromId: string; toId: string };

type Packet = { direction: PacketDirection; at: number };

/** One occupant's angle on its plane: a crewmate's slot, or a program mark's seat. */
type PlaneSeat = { slot: number };

const crewSeat = (c: Crewmate): PlaneSeat => ({
  get slot() {
    return c.planeSlot;
  },
  set slot(value: number) {
    c.planeSlot = value;
  },
});

const markSeat = (program: ProgramState): PlaneSeat => ({
  get slot() {
    return program.rootSlot;
  },
  set slot(value: number) {
    program.rootSlot = value;
  },
});

/** `marks` spread evenly through `crew`, in order: the first a half step in. */
function interleave<T>(crew: readonly T[], marks: readonly T[]): T[] {
  const total = crew.length + marks.length;
  const out: T[] = [];
  let c = 0;
  let m = 0;
  for (let i = 0; i < total; i++) {
    const due = m < marks.length && i >= Math.floor(((m + 0.5) * total) / marks.length);
    if ((due || c >= crew.length) && m < marks.length) out.push(marks[m++] as T);
    else out.push(crew[c++] as T);
  }
  return out;
}

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
  /** The background wait its working is (posture active, reason checks or job). */
  wait: CrewWait;
  waitBlend: number;
  jobBlend: number;
  /** 0..1 eased blend of waiting on the captain, and when that wait began (its breath's phase). */
  captainBlend: number;
  captainSince: number;
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
  /** Offset from the reserved slot toward a blocker, scene px, a spring an axis. Zero keeps the slot. */
  companion: Record<Axis, Spring>;
  /** Carries the circle with its builder while visible main seats re-space. */
  companionBase?: CircleBase & { slot: { x: number; y: number; z: number } };
  /** Where it was last drawn, companion offset included; a send-off aims here. */
  drawn?: Point;
  /** 0..1 eased blend of a fixed star, and its place in scene px, easing there; NaN before it has one. */
  star: number;
  starX: number;
  starY: number;
};

/** The wait ring's travelling arc, radians a second: the fact strip's running mark, carried round. */
export const WAIT_ARC_RATE = 1.6;

/** One breath of the waiting-on-you beacon, ms (INF-1543, the captain's settings). */
export const CAPTAIN_BREATH_MS = 3200;

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

/** Puts a spring at rest on `target`. */
function snap(spring: Spring, target: number): void {
  spring.x = target;
  spring.v = 0;
}

/** A settled frame puts a spring at rest on its target; any other frame steps it there. */
function follow(spring: Spring, target: number, dt: number, settled: boolean): void {
  if (settled) snap(spring, target);
  else spring.step(target, dt);
}

type Axis = "x" | "y" | "z";
const AXES: readonly Axis[] = ["x", "y", "z"];

/** How far a crewmate's companion offset has carried it from its slot, scene px. */
const offsetLength = (c: Crewmate): number =>
  Math.hypot(c.companion.x.x, c.companion.y.x, c.companion.z.x);

export class CrewOrbit {
  private crew = new Map<string, Crewmate>();
  /** Reviewer task -> builder task; the reviewer circles its builder while the review is live. */
  private reviews = new Map<string, string>();
  /** Recorded waits; logical orbit membership survives a relationship circle. */
  private dependencies = new Map<string, CenterCue>();
  /** Tasks with parts, by the parent's id. Branch occupants keep logical membership only. */
  private programs = new Map<string, ProgramState>();
  /** Resolved drawing placement, separate from logical membership and radius/allocation counts. */
  private offMain = new Set<string>();
  /** The crew the Tasks panel lists under Waiting on you. */
  private captainWaits = new Set<string>();
  /** The crew listed under Pinned, oldest pin first, and the same ids as a set: fixed stars take no seat. */
  private pinned: string[] = [];
  private stars = new Set<string>();
  private seatsChanged = false;
  /** A group that could not circle cannot be retried by a re-spacing pass in this frame. */
  private frameFallback = new Set<string>();
  private nextOrder = 0;
  private lastSpawnAt = Number.NEGATIVE_INFINITY;
  private cues: Cue[] = [];
  private last: number;
  private crowded = false;
  private planeBlend = new Spring(0, 0.8, 1);
  /** Extra travel the black hole's rush and the warps have added to the orbit's clock, ms. */
  private lead = 0;
  /** This frame's warp on the orbits: how far they open face-on, and how much they draw in. */
  private warpFlat = 0;
  private warpShrink = 1;
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
   * clears every cue. A returning crewmate opens a new visible seat on its original orbit.
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
   * The board's tasks with parts (./constellation.ts), of which only the
   * running parts draw (INF-1037). A program first draws once one of its
   * parts is underway and keeps its mark while it is open, even with none
   * running, and its gem gains a wire as each part finishes; the parent's
   * close folds the rings into its mark (done), which then falls home, or
   * fades it (dropped). A closed program the stage never drew draws nothing.
   */
  setPrograms(list: readonly Program[], now: number): void {
    let changed = false;
    let seats = false;
    const seen = new Set<string>();
    for (const program of list) {
      seen.add(program.id);
      const had = this.programs.get(program.id);
      const parts = runningParts(program.parts);
      const share = programShare(program);
      if (!had) {
        if (program.state !== "live" || parts.length === 0) continue;
        const rootSlot = this.openPlaneSlot(0);
        this.programs.set(program.id, {
          id: program.id,
          parts,
          share,
          rootSlot,
          rootAngle: new Spring(rootSlot, 0.7, 1),
          leaving: null,
          leaveAt: 0,
          litAt: Number.NEGATIVE_INFINITY,
          packets: [],
        });
        changed = true;
        seats = true;
        continue;
      }
      if (had.leaving) continue;
      // A closing program keeps the rings it last drew, to fold them into its mark.
      if (program.state === "live" && takeParts(had, parts, share)) changed = true;
      if (program.state !== "live") {
        endProgram(had, program.state === "done" ? "home" : "away", now);
        changed = true;
        seats = true;
      }
    }
    for (const had of this.programs.values()) {
      if (seen.has(had.id) || had.leaving) continue;
      endProgram(had, "away", now);
      changed = true;
      seats = true;
    }
    // A mark that takes or gives up its seat re-spaces the first orbit.
    if (seats) this.respacePlanes();
    if (changed) this.bump();
  }

  /**
   * A crewmate starts: the Firstmate sends it out. Several spawns at once
   * are staggered so they read as one, two, three - never a clump - and
   * the ring opens every new slot immediately, so the others re-space once.
   * `settled` places a crewmate that was already out (the roster at boot):
   * restart is not a spawn, so no spark, no stagger, no send-off.
   * `wait` says its working is a background wait, so it starts banked.
   */
  spawn(
    id: string,
    status: CrewStatus,
    now: number,
    settled = false,
    tier?: Slot,
    wait: CrewWait = null,
  ): void {
    const had = this.crew.get(id);
    if (had && had.phase !== "leaving") {
      // Already on the ring: a close still waiting on its spark is called off.
      if (had.leaveAfter) {
        delete had.leaveAfter;
        this.bump();
      }
      return;
    }
    // Its task is active again while it leaves: the departing body goes and
    // it arrives anew, so an active task is never left off the ring.
    if (had) this.crew.delete(id);
    const spawnAt = settled ? now : Math.max(now, this.lastSpawnAt + this.tuning.staggerMs);
    if (!settled) this.lastSpawnAt = spawnAt;
    const count = this.roster().length + 1;
    const ringR = ringRadiusFor(count, this.tuning);
    const counts = CROWDED_PLANES.map((_, i) => this.roster().filter((m) => m.plane === i).length);
    // Fill each orbit's seats before opening the next. Past both, the orbit
    // with fewer crew takes the arrival, the first on a tie.
    const plane = counts.findIndex((n, i) => n < (CROWDED_PLANES[i]?.capacity ?? 0));
    const chosenPlane = plane < 0 ? counts.indexOf(Math.min(...counts)) : plane;
    const waits = status === "working" && wait !== null;
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
      wait,
      waitBlend: waits ? 1 : 0,
      jobBlend: waits && wait === "job" ? 1 : 0,
      captainBlend: this.captainWaits.has(id) ? 1 : 0,
      captainSince: now,
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
      companion: { x: new Spring(0, 0.8, 1), y: new Spring(0, 0.8, 1), z: new Spring(0, 0.8, 1) },
      star: 0,
      starX: Number.NaN,
      starY: Number.NaN,
      ...(tier ? { tier } : {}),
    };
    this.crew.set(id, c);
    this.respacePlanes();
    // Pin the newcomer's angle spring at its slot so the spark aims true.
    this.layout();
    snap(c.angle, this.slotAngle(c, now + this.lead));
    this.bump();
  }

  setStatus(id: string, status: CrewStatus): void {
    const c = this.crew.get(id);
    if (!c || c.status === status) return;
    c.status = status;
    this.bump();
  }

  /**
   * Its working is, or stops being, a background wait (INF-676, INF-1777).
   * It stays among the working; only its look banks, and it heats back to
   * full ember the moment a turn runs again.
   */
  setWait(id: string, wait: CrewWait): void {
    const c = this.crew.get(id);
    if (!c || c.wait === wait) return;
    c.wait = wait;
    this.bump();
  }

  /**
   * The crew that wait on the captain: the Tasks panel's Waiting on you
   * group (`nowGroupOf`), a put-aside card included. Only the look follows;
   * it stays working or idle as its posture says.
   */
  setCaptainWaits(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (next.size === this.captainWaits.size && [...next].every((id) => this.captainWaits.has(id)))
      return;
    this.captainWaits = next;
    this.bump();
  }

  /**
   * The crew whose tasks the Tasks panel lists under Pinned, oldest pin
   * first (INF-3634): each becomes a fixed star, giving up its seat on the
   * orbit while it keeps its membership, and an unpinned one returns to the
   * widest gap among the seated crew. Ids this orbit does not hold are kept
   * for when they arrive.
   */
  setPinned(ids: Iterable<string>): void {
    const next = [...new Set(ids)];
    if (next.length === this.pinned.length && next.every((id, i) => this.pinned[i] === id)) return;
    const keep = new Set(next);
    for (const c of this.roster()) {
      if (!this.stars.has(c.id) || keep.has(c.id)) continue;
      c.planeSlot = this.openPlaneSlot(c.plane);
      this.stars.delete(c.id);
    }
    this.pinned = next;
    this.stars = keep;
    this.respacePlanes();
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
      // A part's report is its result: it flies to its program's mark.
      // The program's own report, with no crewmate of its own here, is the
      // one result home.
      const owner =
        c && c.phase !== "leaving" ? programOfPart(this.programs.values(), id) : undefined;
      const program = this.programs.get(id);
      if (owner) owner.packets.push({ route: [id, owner.id], at: now, home: false });
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
      const circling = offsetLength(c) > 0.5;
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

  /** A departure's length: a remote fall's own trip, else the fall home or the fade away. */
  private leaveMs(c: Crewmate): number {
    return c.tripMs ?? (c.leaveMode === "home" ? this.tuning.homeMs : this.tuning.awayMs);
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

  /**
   * The marks seated on the first orbit: each program's root that is not
   * leaving. They count as occupants wherever the plane is spaced, so no
   * crewmate is ever seated on a mark and no two marks share a seat.
   */
  private seatedRoots(): ProgramState[] {
    if (this.formation !== "adaptive") return [];
    return [...this.programs.values()]
      .filter((program) => !program.leaving)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Every occupant of a plane as a seat: its crew, and on the first orbit the marks too. */
  private planeSeats(plane: number, roster: Crewmate[]): PlaneSeat[] {
    const crew = roster
      .filter((c) => c.plane === plane && !this.offMain.has(c.id) && !this.stars.has(c.id))
      .map(crewSeat);
    return plane === 0 ? [...crew, ...this.seatedRoots().map(markSeat)] : crew;
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
      const members = this.planeSeats(plane, roster).sort(
        (a, b) => (((a.slot % TAU) + TAU) % TAU) - (((b.slot % TAU) + TAU) % TAU),
      );
      const m = members.length;
      if (m === 0) continue;
      let sin = 0;
      let cos = 0;
      members.forEach((seat, i) => {
        const d = seat.slot - (i / m) * TAU;
        sin += Math.sin(d);
        cos += Math.cos(d);
      });
      const base = Math.atan2(sin, cos);
      members.forEach((seat, i) => {
        const target = base + (i / m) * TAU;
        seat.slot = target + Math.round((seat.slot - target) / TAU) * TAU;
      });
    }
  }

  private seatVisible(next: Set<string>): void {
    // Insert returns among visible occupants, never restore a reserved gap.
    for (const c of this.roster()) {
      if (this.offMain.has(c.id) && !next.has(c.id)) {
        c.planeSlot = this.openPlaneSlot(c.plane);
        this.offMain.delete(c.id);
      }
    }
    this.offMain = next;
  }

  /** Where a newcomer would enter: the middle of the widest gap, marks counted. */
  private openPlaneSlot(plane: number): number {
    const slots = this.planeSeats(plane, this.roster())
      .map((seat) => ((seat.slot % TAU) + TAU) % TAU)
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
  private scenePoint(onPlane: number, angle: number, orbitRadius: number) {
    const mix = this.planeBlend.x;
    const radius = orbitRadius * this.warpShrink;
    const flat = this.warpFlat;
    const ring = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * (this.tuning.tilt + (1 - this.tuning.tilt) * flat),
      z: 0,
      depth: 0.5 + 0.5 * Math.sin(angle),
    };
    if (mix === 0) return ring;
    const lower = Math.max(0, Math.min(CROWDED_PLANES.length - 1, Math.floor(onPlane)));
    const upper = Math.min(CROWDED_PLANES.length - 1, lower + 1);
    const between = clamp01(onPlane - lower);
    const from = projectPlane(lower, angle, radius, flat);
    const to = between === 0 ? from : projectPlane(upper, angle, radius, flat);
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
  private orbitPaths(
    planes: ReadonlySet<number>,
    ringR: number,
    mix: number,
    counts: readonly number[],
  ): OrbitPath[] {
    const ringOut = ringR * (1 + this.tuning.idleOffset);
    const traced = mix === 0 ? [...planes].slice(0, 1) : [...planes];
    return traced.map((plane) => {
      const radius = ringOut + (planeRadius(plane, counts) - ringOut) * mix;
      const centre = this.projectScene({ x: 0, y: 0, depth: 0.5 }, radius);
      const along = (angle: number) => {
        const point = this.projectScene(this.scenePoint(plane, angle, radius), radius);
        return { x: point.x - centre.x, y: point.y - centre.y };
      };
      return ellipseOf(centre, along(0), along(Math.PI / 2));
    });
  }

  /** Crew on each orbit, those leaving not counted: what sizes the growing ring. */
  private planeCounts(): number[] {
    const counts = CROWDED_PLANES.map(() => 0);
    for (const c of this.roster()) counts[c.plane] = (counts[c.plane] ?? 0) + 1;
    return counts;
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
      const crew = roster
        .filter((c) => c.plane === plane && !this.offMain.has(c.id) && !this.stars.has(c.id))
        .map(crewSeat);
      // The marks spread evenly among the crew, never bunched together.
      const marks = plane === 0 ? this.seatedRoots().map(markSeat) : [];
      const members = interleave(crew, marks);
      members.forEach((seat, i) => {
        seat.slot = (i / members.length) * TAU + (CROWDED_PLANES[plane]?.phase ?? 0);
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
   * black hole's rush level (./rush.ts), 0 at the normal pace; `warp` is the
   * warp the first mate is playing (./warp.ts), null when none. A settled
   * frame has neither, and a remote cluster's orbit never takes a warp.
   */
  update(now: number, settled = false, rush = 0, warp: WarpFrame | null = null): OrbitFrame {
    this.frameFallback.clear();
    const originalSeats = new Map(this.roster().map((c) => [c.id, c.planeSlot]));
    const originalMarks = new Map([...this.programs].map(([id, p]) => [id, p.rootSlot]));
    const originalOffMain = new Set(this.offMain);
    let frame: OrbitFrame;
    do {
      this.seatsChanged = false;
      frame = this.updateFrame(now, settled, rush, warp);
      if (this.seatsChanged) {
        const resolved = this.offMain;
        // Resolve each candidate from the same starting seats. A rejected circle
        // must not rotate or reorder the visible crew on every still-frame read.
        for (const c of this.roster()) c.planeSlot = originalSeats.get(c.id) ?? c.planeSlot;
        for (const [id, p] of this.programs) p.rootSlot = originalMarks.get(id) ?? p.rootSlot;
        this.offMain = new Set(originalOffMain);
        this.seatVisible(resolved);
        this.respacePlanes();
      }
      // Extra passes have dt=0: springs advance once, while Reduce Motion resolves
      // spacing and any circle fallback in this very frame. Each failed group
      // stays on the main orbit for the rest of this resolution.
    } while (this.seatsChanged);
    return frame;
  }

  private updateFrame(
    now: number,
    settled: boolean,
    rush: number,
    warp: WarpFrame | null,
  ): OrbitFrame {
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
    // A warp lends the crew its own lead the same way; the tunnel opens the
    // orbits face-on and draws them in, the sphere draws them in a little.
    const w = settled || this.projection ? null : warp;
    this.warpFlat = w?.variant === "tunnel" ? w.k : 0;
    this.warpShrink = w
      ? 1 - (w.variant === "tunnel" ? 0.12 : w.variant === "sphere" ? 0.05 : 0) * w.k
      : 1;
    const travel = 1 + (CREW_RUSH.peak - 1) * level + (w ? warpCrewTravel(w.variant, w.sp) - 1 : 0);
    const lead = (travel - 1) * dt * 1000;
    this.lead += lead;
    const targetBlend = this.crowded ? 1 : 0;
    follow(this.planeBlend, targetBlend, dt, settled);
    if (Math.abs(this.planeBlend.x - targetBlend) < 0.00001) snap(this.planeBlend, targetBlend);
    const mix = this.planeBlend.x;
    const counts = this.planeCounts();
    const slotTime = settled && this.crowded ? 0 : now + this.lead;
    const coreR = ringR * CORE_FRACTION;
    const crewFrames: CrewmateFrame[] = [];
    const scenes = new Map<string, SceneSlot>();
    const packets: PacketFrame[] = [];
    const anchors = new Map<string, { c: Crewmate; wobble: number }>();
    const gone: string[] = [];
    /** The planes of the painted crewmates that are not leaving. */
    const occupied = new Set<number>();
    let working = 0;
    let idle = 0;

    for (const c of this.crew.values()) {
      follow(c.planePosition, c.plane, dt, settled);
      if (c.phase !== "leaving") {
        if (c.status === "working") working += 1;
        else idle += 1;
      }
      if (lead > 0) c.angle.x += this.slotRate(c) * lead;
      // Working blend and own spin: the rig's dt*4 ease, spin easing over ~0.3s.
      // The rush lends the spin a share of its boost. A background wait
      // keeps it working at an idle pace, banked, on the same ease; a
      // settled frame shows the blends as they will be.
      const waits = c.status === "working" && c.wait !== null;
      const workTarget = c.status === "working" && !waits ? 1 : 0;
      const waitTarget = waits ? 1 : 0;
      const ease = settled ? 1 : Math.min(dt * 4, 1);
      c.work += (workTarget - c.work) * ease;
      c.waitBlend += (waitTarget - c.waitBlend) * ease;
      // The wires' color only moves while it waits, so a wait ending keeps its hue as the ring fades.
      if (waits) c.jobBlend += ((c.wait === "job" ? 1 : 0) - c.jobBlend) * ease;
      // Waiting on the captain eases in on the same heat ramp; its breath
      // starts from the faintest light when the wait begins.
      const captainTarget = this.captainWaits.has(c.id) ? 1 : 0;
      if (captainTarget && c.captainBlend < 0.001) c.captainSince = now;
      c.captainBlend += (captainTarget - c.captainBlend) * ease;
      const spinTarget = 0.35 + 1.15 * c.work;
      c.spinVel += (spinTarget - c.spinVel) * Math.min(dt * 3, 1);
      c.spin += c.spinVel * dt * (1 + (travel - 1) * CREW_RUSH.spinShare);

      // Slot targets: the ring's slow revolution plus the crewmate's posture.
      const idleOut = 1 + tuning.idleOffset * (1 - c.work);
      const ringTarget = ringR * idleOut;
      const targetR = ringTarget + (planeRadius(c.plane, counts) - ringTarget) * mix;
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
          snap(c.angle, targetA);
          snap(c.radius, targetR);
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
        const t = settled ? 1 : clamp01((now - c.leaveAt) / this.leaveMs(c));
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
        follow(c.angle, targetA, dt, settled);
        follow(c.radius, targetR, dt, settled);
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
        size:
          (tuning.glyph * glyphK + (PLANES_GLYPH_PX - tuning.glyph * glyphK) * mix) *
          (0.84 + 0.32 * depth),
        alpha: alpha * (0.78 + 0.22 * depth + (-0.1 + 0.1 * depth) * mix),
        unfold,
        spark,
        trail,
        ...(streak ? { streak } : {}),
        work: c.work,
        ...(c.waitBlend > 0.001
          ? {
              wait: c.waitBlend,
              ...(c.jobBlend > 0.001 ? { job: c.jobBlend } : {}),
              ...(c.wait === "batch" || c.wait === "batch-running"
                ? {
                    batch: true as const,
                    batchTurn:
                      !settled && c.wait === "batch-running"
                        ? (now / 1000) * BATCH_GATE.turnRadPerS + c.seed
                        : 0,
                  }
                : settled
                  ? {}
                  : { waitArc: (now / 1000) * WAIT_ARC_RATE + c.seed }),
            }
          : {}),
        ...(c.captainBlend > 0.001
          ? {
              captain: c.captainBlend,
              ...(settled
                ? {}
                : {
                    captainBreath:
                      0.5 - 0.5 * Math.cos((TAU * (now - c.captainSince)) / CAPTAIN_BREATH_MS),
                  }),
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
    // A mark glides to its seat when the first orbit re-spaces, as a crewmate does.
    for (const program of this.programs.values())
      follow(program.rootAngle, program.rootSlot, dt, settled);
    const project = (scene: { x: number; y: number; depth: number }, radius: number) =>
      this.projectScene(scene, radius);
    const layouts =
      this.formation !== "adaptive" || mix < 0.999
        ? []
        : layoutPrograms(
            this.programs.values(),
            slotTime,
            ringR,
            mix,
            counts,
            (onPlane, angle, radius) => this.scenePoint(onPlane, angle, radius),
            project,
          );
    const seats = partSeats(layouts);
    const links = this.applyCompanions(crewFrames, scenes, now, settled, dt, seats);
    const starJoins = this.applyStars(crewFrames, counts, now, settled, dt, seats);
    const { frames: programs, ended } = programFrames(
      layouts,
      crewFrames,
      now,
      settled,
      tuning,
      project,
      packets,
      () => this.cues.push({ kind: "receive" }),
    );
    for (const id of ended) {
      const program = this.programs.get(id);
      this.programs.delete(id);
      if (program?.leaving === "home" && !settled) this.cues.push({ kind: "receive" });
    }
    if (ended.length > 0) this.bump();
    // The warp's riders: every orbiting crewmate not circling a program's mark.
    if (w) {
      const riders = crewFrames.filter(
        (f) => f.phase === "orbiting" && !seats.has(f.id) && (f.star ?? 0) < 0.5,
      );
      for (const [i, f] of riders.entries()) warpCrewmate(f, i, riders.length, w);
    }
    // Packets ride the line to where the crewmate is drawn, circle included.
    for (const frame of crewFrames) {
      const anchor = anchors.get(frame.id);
      if (!anchor) continue;
      anchor.c.drawn = { x: frame.x, y: frame.y - anchor.wobble };
      this.ridePackets(anchor.c, anchor.c.drawn, now, settled, packets);
    }

    return {
      crew: mix > 0 ? crewFrames.sort((a, b) => a.depth - b.depth) : crewFrames,
      orbits: this.orbitPaths(occupied, ringR, mix, counts),
      packets,
      links,
      programs,
      ...(starJoins.length > 0 ? { starJoins } : {}),
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
   * Ease each pinned crewmate to its place in the sky and back (INF-3634):
   * the constellation over the occupied orbits, in pin order. A spark flies
   * to its slot first and rises once it arrives; a part seated on its
   * program's ring stays there; a departing star leaves from where it
   * hangs. Returns the hairline joining the stars.
   */
  private applyStars(
    frames: CrewmateFrame[],
    counts: readonly number[],
    now: number,
    settled: boolean,
    dt: number,
    seats: ReadonlyMap<string, Seat>,
  ): StarJoin[] {
    if (this.formation !== "adaptive") return [];
    const order = this.pinned.filter((id) => {
      const c = this.crew.get(id);
      return c !== undefined && c.phase !== "leaving" && !seats.has(id);
    });
    const orbits = counts.flatMap((n, plane) =>
      n > 0 ? [{ plane, radius: planeRadius(plane, counts) * (1 + this.tuning.idleOffset) }] : [],
    );
    const places = skyPlaces(order.length, orbits);
    const placeOf = new Map(order.map((id, i) => [id, places.points[i]]));
    const blend = settled ? 1 : Math.min(dt * FIXED_STARS.blendRate, 1);
    const glide = settled ? 1 : Math.min(dt * FIXED_STARS.placeRate, 1);
    const shown = new Set<string>();
    for (const frame of frames) {
      const c = this.crew.get(frame.id);
      if (!c) continue;
      const place = placeOf.get(c.id);
      if (c.phase !== "leaving") {
        const target = place && c.phase === "orbiting" ? 1 : 0;
        c.star += (target - c.star) * blend;
        if (target === 0 && c.star < 0.001) c.star = 0;
        if (place) {
          if (c.star < 0.02 || Number.isNaN(c.starX)) {
            c.starX = place.x;
            c.starY = place.y;
          } else {
            c.starX += (place.x - c.starX) * glide;
            c.starY += (place.y - c.starY) * glide;
          }
        }
      }
      if (c.star <= 0 || Number.isNaN(c.starX)) continue;
      const fade =
        c.phase === "leaving" && !settled ? 1 - clamp01((now - c.leaveAt) / this.leaveMs(c)) : 1;
      const k = c.star * c.star * (3 - 2 * c.star);
      const fix = k * fade;
      const at = this.projectScene({ x: c.starX, y: c.starY, depth: FIXED_STARS.depth }, 0);
      const depth = frame.depth + (at.depth - frame.depth) * fix;
      frame.x += (at.x - frame.x) * fix;
      frame.y += (at.y - frame.y) * fix;
      frame.size *= (0.84 + 0.32 * depth) / (0.84 + 0.32 * frame.depth);
      frame.depth = depth;
      if (fix > 0.5) delete frame.streak;
      frame.star = fix;
      if (!settled) frame.twinkle = twinkleOf(c.seed, now, settled);
      if (fix > 0.01) shown.add(c.id);
    }
    if (!FIXED_STARS.joined) return [];
    return places.joins.flatMap(([a, b]) => {
      const fromId = order[a];
      const toId = order[b];
      return fromId && toId && shown.has(fromId) && shown.has(toId) ? [{ fromId, toId }] : [];
    });
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
   * Move eligible idle waits onto their blocker's perpendicular circle, and
   * name the arrow of every wait and review, circling or on a slot. The angle
   * and radius springs are untouched, so clearing a wait glides the offset home.
   */
  private applyCompanions(
    frames: CrewmateFrame[],
    scenes: ReadonlyMap<string, SceneSlot>,
    now: number,
    settled: boolean,
    dt: number,
    seats: ReadonlyMap<string, Seat> = new Map(),
  ): DependencyLink[] {
    const links: DependencyLink[] = [];
    const cues = withReviewCues(
      this.dependencies,
      this.reviews,
      (id) => this.crew.get(id)?.phase === "orbiting",
    );
    seatParts(cues, seats);
    if (
      cues.size === 0 &&
      seats.size === 0 &&
      this.offMain.size === 0 &&
      ![...this.crew.values()].some((c) => AXES.some((axis) => c.companion[axis].x))
    )
      return links;
    const byId = new Map(frames.map((frame) => [frame.id, frame]));
    // A fixed star neither circles nor is circled: a wait on one, or by one,
    // keeps its slot and its arrow (INF-3634).
    const fallback = new Set(this.frameFallback);
    for (const [id, cue] of cues)
      if (this.stars.has(id) || (cue.mode === "satellite" && this.stars.has(cue.blockerId)))
        fallback.add(id);
    const { wanted, offMain, circleBases, failed } = companionTargets({
      cues,
      seats,
      scenes,
      crew: this.crew,
      blending: this.planeBlend.x < 0.999,
      fallback,
      now,
      settled,
    });
    for (const id of failed) this.frameFallback.add(id);
    if (offMain.size !== this.offMain.size || [...offMain].some((id) => !this.offMain.has(id))) {
      this.seatVisible(offMain);
      this.seatsChanged = true;
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
      const base = circleBases.get(frame.id);
      const previous = mate.companionBase;
      if (!settled && base && previous?.blocker === base.blocker && mate.phase === "orbiting") {
        // Follow the builder's displacement and cancel the hidden slot's displacement.
        // Only the little circle's own motion eases; re-spacing cannot drag it away.
        for (const axis of AXES)
          mate.companion[axis].x +=
            base.origin[axis] - previous.origin[axis] - (scene[axis] - previous.slot[axis]);
      }
      mate.companionBase = base
        ? { ...base, slot: { x: scene.x, y: scene.y, z: scene.z } }
        : undefined;
      // A spark still aims at its slot; everyone else eases toward the target.
      if (mate.phase !== "spawning") {
        for (const axis of AXES) follow(mate.companion[axis], target[axis], dt, settled);
        // Close to home with nothing to circle: land exactly on the slot.
        if (!settled && !target.x && !target.y && !target.z && offsetLength(mate) < 0.05)
          for (const axis of AXES) snap(mate.companion[axis], 0);
      }
      const moved = offsetLength(mate) > 0.5;
      if (moved && frame.phase !== "spawning") {
        const slot = this.projectScene(scene, scene.radius);
        const next = this.projectScene(
          {
            x: scene.x + mate.companion.x.x,
            y: scene.y + mate.companion.y.x,
            depth: scene.depth + mate.companion.z.x / 512,
          },
          scene.radius,
        );
        // The frame's y already includes the idle wobble. Keep it.
        // Add the offset as a delta to wherever the frame already is, so a
        // departing crewmate's screen-space arc is kept. The delta fades out
        // over the fall, so it lands on the Firstmate's center.
        const fade =
          mate.phase === "leaving" && !settled
            ? 1 - clamp01((now - mate.leaveAt) / this.leaveMs(mate))
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
