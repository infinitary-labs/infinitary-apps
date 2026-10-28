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
      // Activity rows have a two-line display. Keep every task's reading in
      // its own row instead of hiding later tasks in one truncated sentence.
      const text = `${label} · Memory pressure ${pressure}${processes?.status === "sampled" ? "" : " · Task use unavailable"}`;
      this.options.activity({ computerId, label, pressure, text });
      for (const task of tasks) {
        this.options.activity({
          computerId,
          label,
          pressure,
          text: `${task.key} · ${taskResourceWords(task)}`,
        });
      }
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

export type PressureTaskShare = Extract<
  ProcessResources,
  { status: "sampled" }
>["tasks"][number] & { key: string };
