import type { ComputerResourcesView, MacMemoryPressure, ProcessResources } from "@shared/resources";
import { taskResourceWords } from "@shared/resources";
import type { TypedWake } from "../orchestrator/wakes";

/** One notice per observed pressure transition. Missing readings never mean recovery. */
export class ResourcePressure {
  private readonly levels = new Map<string | null, MacMemoryPressure>();

  constructor(
    private readonly options: {
      taskKey: (id: string) => string;
      notify: (wake: TypedWake) => void;
      activity: (fact: {
        computerId: string | null;
        label: string;
        pressure: "warning" | "critical";
        text: string;
      }) => void;
    },
  ) {}

  observe(view: ComputerResourcesView): void {
    const known = new Set(view.computers.map((computer) => computer.computerId));
    for (const id of this.levels.keys()) if (!known.has(id)) this.levels.delete(id);
    for (const { computerId, label, reading } of view.computers) {
      if (reading.status !== "fresh") continue;
      const pressure = reading.observation.memory.memoryPressure;
      if (!pressure || pressure === this.levels.get(computerId)) continue;
      this.levels.set(computerId, pressure);
      if (pressure === "normal") continue;
      const processes = reading.observation.processes;
      const tasks =
        processes?.status === "sampled"
          ? processes.tasks.map((task) => ({ ...task, key: this.options.taskKey(task.taskId) }))
          : [];
      this.options.activity({
        computerId,
        label,
        pressure,
        text: pressureLine(
          label,
          pressure,
          tasks,
          processes?.status === "sampled" ? processes.other : undefined,
        ),
      });
      this.options.notify({
        facts: {
          kind: "resource-pressure",
          computerId,
          label,
          pressure,
          tasks,
          ...(processes?.status === "sampled"
            ? { other: processes.other, processCount: processes.processCount }
            : {}),
          ...(reading.observation.memory.swapUsedBytes === undefined
            ? {}
            : { swapUsedBytes: reading.observation.memory.swapUsedBytes }),
        },
        once: `resource-pressure:${computerId ?? "home"}:${reading.observation.epoch}:${reading.observation.sequence}`,
      });
    }
  }
}

/**
 * One feed line per pressure notice (INF-2299 finding 5): the computer, the
 * level and what holds the most memory - the task holding the most, or the
 * programs outside every task when they hold more (INF-3060 finding 6: a
 * warning blamed an idle task while the pressure came from elsewhere).
 * Every task's share still goes to the first mate in the wake.
 */
export function pressureLine(
  label: string,
  pressure: "warning" | "critical",
  tasks: PressureTaskShare[],
  /** Everything outside the tasks' process trees; absent when nothing was sampled. */
  other: ProcessShare | undefined,
): string {
  const heading = `${label} · Memory pressure ${pressure}`;
  if (!other) return `${heading} · Task use unavailable`;
  const top = tasks.reduce<PressureTaskShare | undefined>(
    (most, task) => (most && most.residentBytes >= task.residentBytes ? most : task),
    undefined,
  );
  if (other.residentBytes > (top?.residentBytes ?? 0))
    return `${heading} · Programs outside your tasks use the most: ${taskResourceWords(other)}`;
  if (!top) return heading;
  const who = tasks.length === 1 ? top.key : `${top.key} uses the most of ${tasks.length} tasks`;
  return `${heading} · ${who}: ${taskResourceWords(top)}`;
}

type ProcessShare = Extract<ProcessResources, { status: "sampled" }>["other"];

export type PressureTaskShare = Extract<
  ProcessResources,
  { status: "sampled" }
>["tasks"][number] & { key: string };
