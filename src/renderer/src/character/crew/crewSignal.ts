import { type CenterNode, centerCues, crewedWaits } from "@shared/dependencyVisual";
import type { FmEvent } from "@shared/events";
import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import type { TaskLinkView, TaskView } from "@shared/tasks";
import { requestFirstmateFlicker, tokenIntensity, usageTotal } from "../flicker";
import { prefersReducedMotion } from "../reducedMotion";
import { stageNow } from "../stageClock";
import { ComputerOrbits } from "./computers";
import { programsOf } from "./constellation";
import type { CrewOrbit, CrewStatus, LeaveMode } from "./orbit";

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

/** Its working is the host's checks watch: the banked look with the checks ring (INF-676). */
export function crewWaitsOnChecks(posture: TaskView["workPosture"]): boolean {
  return posture?.state === "active" && posture.reason === "checks";
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
 * The sequenced board's waits, for whichever orbit holds each crewmate, and
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
  if (model instanceof ComputerOrbits) model.setWaits(crewedWaits(nodes));
  model.setPrograms(programsOf(tasks, links), now);
}

function leaveModeOf(status: TaskView["status"]): LeaveMode {
  return status === "done" ? "home" : "away";
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
        const status = event.workPosture
          ? event.workPosture.state === "active"
            ? "working"
            : "idle"
          : crewStatusOf(event.activity);
        // The served slot rides the change (absent says nothing new, null
        // says it never routed): the crewmate's solid follows it.
        const tier = event.tier ?? undefined;
        const checks = crewWaitsOnChecks(event.workPosture);
        if (model.has(event.taskId)) {
          model.setStatus(event.taskId, status);
          model.setChecks(event.taskId, checks);
          if (event.tier !== undefined) model.setTier(event.taskId, tier);
        } else model.spawn(event.taskId, status, now, false, tier, checks);
      } else {
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
  for (const task of tasks) {
    if (task.kind !== "work" || task.status !== "active") continue;
    if (model instanceof ComputerOrbits && task.executionDeviceId !== undefined)
      model.setPlacement(task.id, task.executionDeviceId);
    model.spawn(
      task.id,
      task.workPosture
        ? task.workPosture.state === "active"
          ? "working"
          : "idle"
        : crewStatusOf(task.activity),
      now,
      true,
      task.tier ?? undefined,
      crewWaitsOnChecks(task.workPosture),
    );
  }
  for (const task of tasks) {
    if (task.kind === "work" && task.status === "active" && task.reviewOf)
      model.setReview(task.id, task.reviewOf);
  }
  applyCrewDependencies(model, tasks, links, now);
  model.settleBootRoster(now);
}
