import { type CenterNode, centerCues, crewedWaits } from "@shared/dependencyVisual";
import type { FmEvent } from "@shared/events";
import type { Slot } from "@shared/modelSlots";
import { nowGroupOf } from "@shared/nowPanel";
import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import type { TaskBoard, TaskLinkView, TaskView } from "@shared/tasks";
import { requestFirstmateFlicker, tokenIntensity, usageTotal } from "../flicker";
import { prefersReducedMotion } from "../reducedMotion";
import { stageNow } from "../stageClock";
import { ComputerOrbits } from "./computers";
import { programsOf } from "./constellation";
import type { CrewOrbit, CrewStatus, CrewWait, LeaveMode } from "./orbit";

// Side channel from the store's event stream to the crew orbit, as a module
// ref rather than Zustand state (the emoteSignal pattern): positions are not
// shell state. The shell feeds the one shared model the roster as commands
// and the orbit component paints whatever it holds.
//
// Everything the ring needs reaches the renderer on the task stream: a
// crewmate is a `work` task while it is `active`, working while its host-derived posture
// is active and idle otherwise (the split `crewCounts()` makes in
// the core); its close says whether it folds home (done) or drifts away
// (dropped). Reports and what reaches it are packets on its line, a failed turn a
// stutter, a completed request a flicker, and the slot it is served on
// (`TaskView.tier`, and `task_changed`'s `tier`) its solid.

let shared: ComputerOrbits | null = null;

/** The one orbit the home view paints. */
export function crewOrbit(): ComputerOrbits {
  if (!shared) shared = new ComputerOrbits(stageNow());
  return shared;
}

export function crewStatusOf(activity: TaskView["activity"]): CrewStatus {
  return activity === "starting" || activity === "running" ? "working" : "idle";
}

/**
 * Its working is a background wait: the host's checks watch (INF-676), or
 * local work it left running - a host job, a heavy run, the Claude client's
 * background list. Either rests banked inside the wait ring; checks paint
 * blue, local work ember (INF-1777).
 */
export function crewWaitOf(posture: TaskView["workPosture"]): CrewWait {
  if (posture?.state !== "active") return null;
  if (posture.reason === "checks" && posture.batch)
    return posture.batch === "in-batch" ? "batch-running" : "batch";
  return posture.reason === "checks" || posture.reason === "job" ? posture.reason : null;
}

function centerNode(task: TaskView): CenterNode {
  return {
    id: task.id,
    key: task.key,
    blockedBy: task.blockedBy,
    deviceId: task.executionDeviceId ?? null,
    idleDependency: task.workPosture?.state === "idle" && task.workPosture.reason === "dependency",
    crewed: task.kind === "work" && task.status === "active",
  };
}

/**
 * The crew the Tasks panel lists under Waiting on you, a put-aside card
 * included: the one fact that lights the beacon (INF-1543).
 */
function applyCaptainWaits(model: CrewOrbit, tasks: readonly TaskView[]): void {
  model.setCaptainWaits(
    tasks
      .filter((task) => task.kind === "work" && task.status === "active")
      .filter((task) => nowGroupOf(task) === "waiting")
      .map((task) => task.id),
  );
}

/**
 * The crew the Tasks panel lists under Pinned (INF-3634, the captain's
 * answer: "Every crewmate the Tasks panel lists under Pinned"), in its
 * order: each pinned task oldest pin first, with its parts, and theirs,
 * under it by priority then age, as `pinnedRowsOf` lists them. A part
 * running on its program's branches stays there. These become fixed stars.
 */
export function pinnedCrewOf(
  tasks: readonly TaskView[],
  programParts: ReadonlySet<string> = new Set(),
): string[] {
  const pins = tasks
    .filter((task) => task.pinnedAt !== undefined)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
  if (pins.length === 0) return [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const partsOf = new Map<string, TaskView[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const parts = partsOf.get(task.parentId) ?? [];
    parts.push(task);
    partsOf.set(task.parentId, parts);
  }
  for (const parts of partsOf.values())
    parts.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const pinnedAbove = (task: TaskView) => {
    const seen = new Set([task.id]);
    for (let up = task.parentId; up !== null && !seen.has(up); ) {
      seen.add(up);
      const parent = byId.get(up);
      if (!parent) return false;
      if (parent.pinnedAt !== undefined) return true;
      up = parent.parentId;
    }
    return false;
  };
  const out: string[] = [];
  const held = new Set<string>();
  const place = (task: TaskView) => {
    if (held.has(task.id)) return;
    held.add(task.id);
    if (inOrbit(task) && !programParts.has(task.id)) out.push(task.id);
    for (const part of partsOf.get(task.id) ?? []) place(part);
  };
  for (const task of pins) if (!pinnedAbove(task)) place(task);
  for (const task of pins) place(task);
  return out;
}

/**
 * The sequenced board's waits, for whichever orbit holds each crewmate, the
 * crew waiting on the captain, and
 * its tasks with parts, drawn from the board's own links as constellations.
 */
export function applyCrewDependencies(
  model: CrewOrbit,
  tasks: readonly TaskView[],
  links: readonly TaskLinkView[] = [],
  now: number = stageNow(),
): void {
  const nodes = tasks.map(centerNode);
  model.setDependencies(centerCues(nodes));
  applyCaptainWaits(model, tasks);
  if (model instanceof ComputerOrbits) model.setWaits(crewedWaits(nodes));
  const programs = programsOf(tasks, links);
  model.setPrograms(programs, now);
  model.setPinned(
    pinnedCrewOf(tasks, new Set(programs.flatMap((program) => program.parts.map((p) => p.id)))),
  );
}

/**
 * The board sequence each crewmate on the ring was last seen active at, by
 * orbit: its `task_changed`, or the board that seeded it. A board at or past
 * that sequence that no longer lists it as active work is the record's own
 * word that it is gone (`reconcileCrew`); an older board is not.
 */
const activeSince = new WeakMap<CrewOrbit, Map<string, number>>();

function seenActive(model: CrewOrbit): Map<string, number> {
  let seen = activeSince.get(model);
  if (!seen) {
    seen = new Map();
    activeSince.set(model, seen);
  }
  return seen;
}

/**
 * The ring holds only crew the sequenced board still lists (INF-2371). A
 * record can go with no close of its own - a start that failed before its
 * crewmate ran erases the task it was born with - and the stream says
 * nothing then, so the board the Tasks panel and the phone read is the
 * roster's last word: a crewmate it no longer lists as active work drifts
 * away, once the board has caught up with the change that sent it out.
 */
export function reconcileCrew(
  model: CrewOrbit,
  board: Pick<TaskBoard, "seq" | "tasks">,
  now: number,
): void {
  const seen = seenActive(model);
  const listed = new Set(board.tasks.filter(inOrbit).map((task) => task.id));
  for (const id of listed) seen.set(id, Math.max(seen.get(id) ?? board.seq, board.seq));
  for (const id of model.present()) {
    if (listed.has(id)) continue;
    const since = seen.get(id);
    if (since !== undefined && since > board.seq) continue;
    seen.delete(id);
    model.leave(id, "away", now);
  }
}

function inOrbit(task: Pick<TaskView, "kind" | "status">): boolean {
  return task.kind === "work" && task.status === "active";
}

function leaveModeOf(status: TaskView["status"]): LeaveMode {
  return status === "done" ? "home" : "away";
}

/**
 * A crewmate whose task is active work takes the look its record says,
 * whether it is new, already on the ring (a board read again after a
 * reconnect), or on its way out (it arrives anew). `tier` undefined says
 * nothing new about its slot; null says it never routed.
 */
function place(
  model: CrewOrbit,
  id: string,
  status: CrewStatus,
  wait: CrewWait,
  tier: Slot | null | undefined,
  now: number,
  settled: boolean,
): void {
  model.spawn(id, status, now, settled, tier ?? undefined, wait);
  model.setStatus(id, status);
  model.setWait(id, wait);
  if (tier !== undefined) model.setTier(id, tier ?? undefined);
}

/** Apply one fleet event to the orbit. Every command is idempotent. */
export function applyCrewEvent(model: CrewOrbit, event: FmEvent, now: number): void {
  switch (event.type) {
    case "task_started":
      model.spawn(event.taskId, "working", now);
      return;
    case "task_changed":
      if (event.kind !== "work") return;
      if (model instanceof ComputerOrbits && event.executionDeviceId !== undefined)
        model.setPlacement(event.taskId, event.executionDeviceId);
      // A review is a host-shaped child of the builder. Its task's lifetime
      // owns the cue, regardless of whether its crewmate is running or idle.
      model.setReview(event.taskId, event.status === "active" ? (event.reviewOf ?? null) : null);
      if (event.status === "active") {
        seenActive(model).set(event.taskId, event.seq);
        const status = event.workPosture
          ? event.workPosture.state === "active"
            ? "working"
            : "idle"
          : crewStatusOf(event.activity);
        // The served slot rides the change (absent says nothing new, null
        // says it never routed): the crewmate's solid follows it.
        place(model, event.taskId, status, crewWaitOf(event.workPosture), event.tier, now, false);
      } else {
        seenActive(model).delete(event.taskId);
        model.leave(event.taskId, leaveModeOf(event.status), now);
      }
      return;
    case "task_report":
      model.signal(event.taskId, "report", now);
      return;
    case "task_event":
      // Something sent reached the crewmate - words entering its turn, a
      // stop, a close, an edit - as the core announces it (INF-759), never
      // when a message is only recorded: a held one sparks when it lands.
      if (event.reached) model.signal(event.taskId, "steer", now);
      return;
    case "turn_end": {
      // A completed request's usage lands as one flicker on the character
      // that spent it (../flicker): the Firstmate's own requests arrive on
      // this same stream under its session id, a crewmate's under its task
      // id. Pi reports every request; Claude reports a turn's usage
      // once, at its end. Under reduced motion there is no flicker -
      // it is motion and nothing else.
      if (!event.usage || prefersReducedMotion()) return;
      const total = usageTotal(event.usage);
      if (!(total > 0)) return;
      const strength = tokenIntensity(total);
      if (event.taskId === FIRSTMATE_SESSION_ID) requestFirstmateFlicker(strength);
      else model.flicker(event.taskId, strength, now);
      return;
    }
    case "turn_failed":
      if (event.crewmate) model.nudge(event.taskId, now);
      return;
    default:
      return;
  }
}

/**
 * The roster at boot: every crewmate already out is placed on its slot,
 * settled. Restart is not a spawn - no re-emission theatre for work that
 * was already there.
 */
export function seedCrew(
  model: CrewOrbit,
  tasks: readonly TaskView[],
  now: number,
  links: readonly TaskLinkView[] = [],
): void {
  // Known before the spawns, so a crewmate already waiting boots lit.
  applyCaptainWaits(model, tasks);
  for (const task of tasks) {
    if (task.kind !== "work" || task.status !== "active") continue;
    if (model instanceof ComputerOrbits && task.executionDeviceId !== undefined)
      model.setPlacement(task.id, task.executionDeviceId);
    place(
      model,
      task.id,
      task.workPosture
        ? task.workPosture.state === "active"
          ? "working"
          : "idle"
        : crewStatusOf(task.activity),
      crewWaitOf(task.workPosture),
      task.tier,
      now,
      true,
    );
  }
  for (const task of tasks) {
    if (task.kind === "work" && task.status === "active" && task.reviewOf)
      model.setReview(task.id, task.reviewOf);
  }
  applyCrewDependencies(model, tasks, links, now);
  model.settleBootRoster(now);
}
