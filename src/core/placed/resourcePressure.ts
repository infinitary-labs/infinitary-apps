import type { LeftoversReport } from "@shared/leftoverPrograms";
import { leftoversKept } from "@shared/leftoverPrograms";
import type { ComputerResourcesView, ProcessResources } from "@shared/resources";
import { taskResourceWords } from "@shared/resources";
import type { TypedWake } from "../orchestrator/wakes";
import type { LeftBehindFacts } from "./leftBehindNotices";

/** A recorded close outcome, not a reading of what is running now. */
export type PressureLeftover = {
  id: string;
  taskId: string;
  key: string;
  report: LeftoversReport;
};

type Episode = { seen: Set<string>; lineShown: boolean };

/** INF-3497 finding 5: one Activity line per episode, wakes only with new facts. */
export class ResourcePressure {
  private readonly episodes = new Map<string | null, Episode>();

  constructor(
    private readonly options: {
      taskKey: (id: string) => string;
      leftovers?: (computerId: string | null) => PressureLeftover[];
      /** What finished tasks left on the computer now, which the notice carries when it names anything. */
      leftBehind?: (computerId: string | null) => Promise<LeftBehindFacts | undefined>;
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
    for (const { computerId, label, reading } of view.computers) {
      if (reading.status !== "fresh") continue;
      const pressure = reading.observation.memory.memoryPressure;
      if (!pressure) continue;
      if (pressure === "normal") {
        const episode = this.episodes.get(computerId);
        if (episode) episode.lineShown = false;
        continue;
      }
      const processes = reading.observation.processes;
      const tasks =
        processes?.status === "sampled"
          ? processes.tasks.map((task) => ({ ...task, key: this.options.taskKey(task.taskId) }))
          : [];
      const recordedLeftovers = this.options.leftovers?.(computerId) ?? [];
      let episode = this.episodes.get(computerId);
      if (!episode) {
        episode = { seen: new Set(), lineShown: false };
        this.episodes.set(computerId, episode);
      }
      // Compare typed identities and newly available facts, never drifting byte
      // counts or prose. A first critical reading is news; another flip is not.
      const facts = [
        "episode",
        ...(pressure === "critical" ? ["pressure:critical"] : []),
        ...(processes?.status === "sampled" ? ["processes:sampled"] : []),
        ...tasks.map((task) => `task:${task.taskId}`),
        ...recordedLeftovers.map((leftover) => `leftover:${leftover.id}`),
      ];
      const novel = facts.filter((fact) => !episode.seen.has(fact));
      if (novel.length === 0) continue;
      for (const fact of novel) episode.seen.add(fact);
      // Normal permits another line but does not erase what was already
      // reported: a normal/warning oscillation with the same facts is quiet.
      const showLine = !episode.lineShown;
      episode.lineShown = true;
      const other = processes?.status === "sampled" ? processes.other : undefined;
      const once = `resource-pressure:${computerId ?? "home"}:${reading.observation.epoch}:${reading.observation.sequence}:${JSON.stringify(novel)}`;
      // Reading the computer's list first lets a close report it shows cleared
      // be marked resolved, so this notice no longer names it.
      const emit = (recorded: PressureLeftover[], leftBehind?: LeftBehindFacts) => {
        if (showLine)
          this.options.activity({
            computerId,
            label,
            pressure,
            text: pressureLine(label, pressure, tasks, other, recorded),
          });
        this.options.notify({
          facts: {
            kind: "resource-pressure" as const,
            computerId,
            label,
            pressure,
            tasks,
            ...(recorded.length
              ? { recordedLeftovers: recorded, leftoverUse: "unknown" as const }
              : {}),
            ...(processes?.status === "sampled"
              ? { other: processes.other, processCount: processes.processCount }
              : {}),
            ...(reading.observation.memory.swapUsedBytes === undefined
              ? {}
              : { swapUsedBytes: reading.observation.memory.swapUsedBytes }),
            ...(leftBehind &&
            leftBehind.stops.length + leftBehind.programs.length + leftBehind.runs.length
              ? { leftBehind }
              : {}),
          },
          once,
        });
      };
      const listing = this.options.leftBehind?.(computerId);
      if (!listing) {
        emit(recordedLeftovers);
        continue;
      }
      void listing
        .catch(() => undefined)
        .then((leftBehind) =>
          emit(
            leftBehind ? (this.options.leftovers?.(computerId) ?? []) : recordedLeftovers,
            leftBehind,
          ),
        );
    }
  }
}

/** Current shares and recorded close outcomes are separate facts, never an invented attribution. */
export function pressureLine(
  label: string,
  pressure: "warning" | "critical",
  tasks: PressureTaskShare[],
  other: ProcessShare | undefined,
  recordedLeftovers: PressureLeftover[] = [],
): string {
  const heading = `${label} · Memory pressure ${pressure}`;
  if (recordedLeftovers.length) {
    const names = recordedLeftovers.map((leftover) => {
      const kept = leftoversKept(leftover.report);
      const names = [
        ...kept.stops.map(
          (stop) =>
            `stop "${stop.label}" ${stop.outcome === "failed" ? "failed" : "did not finish"}`,
        ),
        ...kept.programs.map((program) => `${program.name || "a program"} survived`),
      ];
      return `${leftover.key}: ${names.join(", ")}`;
    });
    return `${heading} · Leftovers recorded at close: ${names.join("; ")} · Current use unknown`;
  }
  if (!other) return `${heading} · Task use unavailable`;
  const top = tasks.reduce<PressureTaskShare | undefined>(
    (most, task) => (most && most.residentBytes >= task.residentBytes ? most : task),
    undefined,
  );
  if (other.residentBytes > (top?.residentBytes ?? 0))
    return `${heading} · Programs not linked to open tasks use the most: ${taskResourceWords(other)}`;
  if (!top) return heading;
  const who = tasks.length === 1 ? top.key : `${top.key} uses the most of ${tasks.length} tasks`;
  return `${heading} · ${who}: ${taskResourceWords(top)}`;
}

type ProcessShare = Extract<ProcessResources, { status: "sampled" }>["other"];

export type PressureTaskShare = Extract<
  ProcessResources,
  { status: "sampled" }
>["tasks"][number] & { key: string };
