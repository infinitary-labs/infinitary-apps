import type { FmEvent } from "@shared/events";
import type { ComputerResourcesView } from "@shared/resources";
import type { TypedWake } from "../orchestrator/wakes";
import type { LeftBehindHere } from "../tasks/leftBehind";
import type { TaskService } from "../tasks/taskService";
import { finishedTask, LineBlocked, leftBehindReader } from "./leftBehindNotices";
import { recordedPressureLeftovers, resolveClearedLeftovers } from "./pressureLeftovers";
import { ResourcePressure } from "./resourcePressure";
import type { WorkDevices } from "./workDevices";

/**
 * The home's two notices about a computer's resources, the memory-pressure
 * notice and the line-blocked notice, observing each view the feed sends and
 * the one it holds now. Both carry what finished tasks left on that computer
 * (docs/leftover-programs.md, "What a close leaves").
 */
export function attachComputerNotices(
  feed: { attachPressure: (observe: (view: ComputerResourcesView) => void) => void },
  now: ComputerResourcesView,
  options: {
    tasks: Pick<TaskService, "get" | "resolve" | "leftoverNotes" | "resolveLeftoverNote">;
    here: Pick<LeftBehindHere, "list">;
    work: Pick<WorkDevices, "ask" | "inReach" | "takesCurrentWork">;
    notify: (wake: TypedWake) => void;
    broadcast: (event: FmEvent) => void;
  },
): void {
  const { tasks } = options;
  const finished = finishedTask((id) => tasks.get(id));
  const leftBehind = leftBehindReader({
    here: options.here,
    work: options.work,
    finished,
    resolve: (computerId, kept) => resolveClearedLeftovers(tasks, computerId, kept),
  });
  const resourcePressure = new ResourcePressure({
    taskKey: (id) => tasks.resolve(id)?.key ?? id,
    leftovers: (computerId) => recordedPressureLeftovers(tasks, computerId),
    leftBehind,
    notify: options.notify,
    activity: (fact) =>
      options.broadcast({ type: "firstmate_note", text: fact.text, tone: "warn" }),
  });
  const lineBlocked = new LineBlocked({ finished, leftBehind, notify: options.notify });
  const observe = (view: ComputerResourcesView): void => {
    resourcePressure.observe(view);
    lineBlocked.observe(view);
  };
  feed.attachPressure(observe);
  observe(now);
}
