import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskGraphRefusal } from "./taskGraph";
import { keyOrId, type TaskWriter } from "./taskWriter";

/**
 * Whether a container, read as open, would wait on its own part: given its id,
 * the words naming the live part that waits on it, directly or through other
 * tasks, or undefined when none does. Opened, it and that part could never
 * move, so no site opens it while this answers (INF-3846).
 */
export type ContainerLoop = (parent: string) => string | undefined;

/** Close reasons the host's container close writes (`TaskIntake.completeContainers`). */
const CONTAINER_CLOSE_REASONS = new Set(["finished", "cancelled"]);

/**
 * A parent tells the truth about its parts (INF-3846 piece 1,
 * docs/task-graph.md "The close rules"): a container the host closed because
 * every part had closed is open again as soon as a part under it is live. A
 * parent that closed for its own reasons - its merge, its answer, the
 * captain's drop - keeps that close: its own work is over, and a part filed
 * under it carries that work on.
 */

export function closedAsContainer(writer: TaskWriter, record: TaskRecord): boolean {
  if (record.status !== "done" && record.status !== "dropped") return false;
  if (!record.closedReason || !CONTAINER_CLOSE_REASONS.has(record.closedReason)) return false;
  return writer.events.latestOfKind(record.id, "status")?.data?.container === true;
}

/**
 * Inside a write that files or moves a live part under `parent`: a container
 * the host closed opens again, with a line on its timeline naming the part;
 * any other parent stays as it is. A container one of its live parts already
 * waits on refuses the part instead (`loop`), and the refusal rolls back the
 * write.
 */
export function admitUnderParent(
  writer: TaskWriter,
  parent: TaskRecord,
  part: string,
  actor: TaskEventActor,
  at: number,
  loop: ContainerLoop,
): void {
  if (!closedAsContainer(writer, parent)) return;
  const words = loop(parent.id);
  if (words)
    throw new TaskGraphRefusal(
      `Refused: ${keyOrId(parent)} is closed, and opening it to take ${part} would make it wait on a part that already waits on it. ${words}`,
    );
  reopenContainer(writer, parent, `a part was filed under it (${part})`, actor, at);
}

/** The container opens again as it stood before its close: open, on request, never started. */
function reopenContainer(
  writer: TaskWriter,
  parent: TaskRecord,
  why: string,
  actor: TaskEventActor,
  at: number,
): void {
  // Its closed policy snapshot stays as history: it is read only while the
  // task is closed, and its next close takes a new one.
  writer.patch(parent.id, { status: "open", closedReason: null, closedAt: null, updatedAt: at });
  writer.addEvent({
    taskId: parent.id,
    at,
    actor,
    kind: "status",
    text: `open again: ${why}`,
    data: { status: "open", reopened: true },
    feed: false,
  });
}

/**
 * The repair the host's container sweep runs first: every container closed
 * while a part under it is live opens again. It corrects parents an earlier
 * release closed before their parts were filed, and any filing that reached a
 * closed container some other way. A parent closed for another reason is left
 * as it is - the captain's own drop keeps its open parts planned on purpose -
 * and so is a container a live part waits on (`loop`): opened, it would wait
 * on its own part and neither could ever move. Returns the ids it opened.
 */
export function reopenHeldContainers(writer: TaskWriter, loop: ContainerLoop): string[] {
  const run = writer.write((): string[] => {
    const at = writer.now();
    const opened: string[] = [];
    for (const id of writer.store.closedParentsWithLiveChildren()) {
      const parent = writer.store.get(id);
      if (!parent || !closedAsContainer(writer, parent)) continue;
      if (loop(id)) continue;
      reopenContainer(writer, parent, "a part under it is still open", "host", at);
      opened.push(id);
    }
    return opened;
  });
  return run();
}
