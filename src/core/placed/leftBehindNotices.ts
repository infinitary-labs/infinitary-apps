import { LEFT_BEHIND_ORDER, type LeftBehind, leftBehindSchema } from "@shared/leftoverPrograms";
import type { LoadDemand } from "@shared/load";
import { type ComputerResourcesView, RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
import type { TypedWake } from "../orchestrator/wakes";
import type { TaskRecord } from "../storage/taskRecords";
import type { LeftBehindHere } from "../tasks/leftBehind";
import type { WorkDevices } from "./workDevices";

/** One computer's list, each item named by its task's key as well as its id. */
export type LeftBehindFacts = {
  stops: (LeftBehind["stops"][number] & { key: string })[];
  programs: (LeftBehind["programs"][number] & { key: string })[];
  runs: (LeftBehind["runs"][number] & { key: string })[];
};

/** A finished task's run still counted as running in a line where another waits. */
export type LineBlockedRun = { taskId: string; key: string; id: string; demand: LoadDemand };

type Finished = (taskId: string) => { key: string } | undefined;

/** A task this home records as finished, with its key. */
export function finishedTask(
  get: (id: string) => Pick<TaskRecord, "status" | "key" | "id"> | undefined,
): Finished {
  return (taskId) => {
    const record = get(taskId);
    return record && (record.status === "done" || record.status === "dropped")
      ? { key: record.key || record.id }
      : undefined;
  };
}

/**
 * Reads one computer's list (docs/leftover-programs.md, "What a close
 * leaves"): this home's own, or a computer's that takes work on this home's
 * contract major, asked through its order. Only tasks this home records as finished stay; a list
 * that could not be read is undefined, never empty.
 */
export function leftBehindReader(options: {
  here: Pick<LeftBehindHere, "list">;
  work: Pick<WorkDevices, "ask" | "inReach" | "takesCurrentWork">;
  finished: Finished;
  /** Hears which tasks still keep something there, after each list that came back. */
  resolve?: (computerId: string | null, kept: readonly string[]) => void;
  timeoutMs?: number;
}): (computerId: string | null) => Promise<LeftBehindFacts | undefined> {
  return async (computerId) => {
    let list: LeftBehind;
    try {
      if (computerId === null) list = await options.here.list();
      else {
        if (
          !options.work.inReach(computerId) ||
          // A computer on another major answers no order this major asks.
          !options.work.takesCurrentWork(computerId)
        )
          return undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const raw = await Promise.race([
          options.work.ask(computerId, LEFT_BEHIND_ORDER, []),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("No list came back in time.")),
              options.timeoutMs ?? RESOURCE_READ_TIMEOUT_MS * 4,
            );
            timer.unref?.();
          }),
        ]).finally(() => clearTimeout(timer));
        list = leftBehindSchema.parse(raw);
      }
    } catch {
      return undefined;
    }
    options.resolve?.(computerId, list.kept);
    const keyed = <T extends { task: string }>(items: readonly T[]) =>
      items.flatMap((item) => {
        const task = options.finished(item.task);
        return task ? [{ ...item, key: task.key }] : [];
      });
    return {
      stops: keyed(list.stops),
      programs: keyed(list.programs),
      runs: keyed(list.runs),
    };
  };
}

/**
 * The once-per-run notice that a finished task's run still counts as
 * running in a computer's heavy-run line while another run waits there
 * (docs/heavy-runs.md, "Capacity and pressure"). It reads the line facts the
 * resource feed already carries, and tells only once that computer's own
 * list names the run, which it does only after the task's close finished its
 * own cleanup there; a computer whose list cannot be read is asked again on
 * the next reading. It stops nothing.
 */
export class LineBlocked {
  private readonly told = new Set<string>();
  private readonly asking = new Set<string>();

  constructor(
    private readonly options: {
      finished: Finished;
      leftBehind: (computerId: string | null) => Promise<LeftBehindFacts | undefined>;
      notify: (wake: TypedWake) => void;
    },
  ) {}

  observe(view: ComputerResourcesView): void {
    for (const { computerId, label, load } of view.computers) {
      if (load?.status !== "fresh") continue;
      const waiting = load.runs.filter((run) => run.state === "waiting").length;
      if (waiting === 0) continue;
      for (const run of load.runs) {
        if (run.state !== "running") continue;
        const task = this.options.finished(run.taskId);
        if (!task) continue;
        const once = `line-blocked:${computerId ?? "home"}:${run.id}`;
        if (this.told.has(once) || this.asking.has(once)) continue;
        this.asking.add(once);
        const blocked: LineBlockedRun = {
          taskId: run.taskId,
          key: task.key,
          id: run.id,
          demand: run.demand,
        };
        void this.options
          .leftBehind(computerId)
          .catch(() => undefined)
          .then((leftBehind) => {
            this.asking.delete(once);
            // The computer names the run only once the close's own cleanup is done.
            if (!leftBehind?.runs.some((listed) => listed.id === run.id)) return;
            this.told.add(once);
            this.options.notify({
              facts: { kind: "line-blocked", computerId, label, run: blocked, waiting, leftBehind },
              once,
            });
          });
      }
    }
  }
}
