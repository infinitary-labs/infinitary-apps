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

/** The once-names a memory warning's wakes go out under, read back after a restart. */
export const MEMORY_WARNING_PREFIX = "memory-warning:";
export const MEMORY_CLEAR_PREFIX = "memory-clear:";
const CRITICAL_SUFFIX = ":critical";

/**
 * How long a computer reads clear before its memory warning ends: the
 * captain's number (INF-4182's plan, "30 minutes"), never a setting.
 */
export const MEMORY_WARNING_CLEAR_MS = 30 * 60_000;

/** One stretch of one computer short on memory, told once (docs/heavy-runs.md, "Capacity and pressure"). */
type Warning = {
  id: string;
  since: number;
  critical: boolean;
  /** When it last read warning or critical on the home's clock. */
  lastPressureAt: number;
};

/** A warning's ID: memory, the computer, and when it began on the home's clock. */
export function memoryWarningId(computerId: string | null, since: number): string {
  return `${MEMORY_WARNING_PREFIX}${computerId ?? "home"}:${since}`;
}

/**
 * INF-4182: each memory warning has one ID and is told once, when it
 * begins. While it is open, only a first turn to critical is told again;
 * it ends, told once, when the computer reads normal after the clear time
 * without warning or critical. Open warnings are read back from the
 * names their wakes went out under, so a restart tells nothing again.
 */
export class ResourcePressure {
  private readonly warnings = new Map<string | null, Warning>();
  private readonly now: () => number;

  constructor(
    private readonly options: {
      taskKey: (id: string) => string;
      leftovers?: (computerId: string | null) => PressureLeftover[];
      /** What finished tasks left on the computer now, which the notice carries when it names anything. */
      leftBehind?: (computerId: string | null) => Promise<LeftBehindFacts | undefined>;
      /** Queues a first mate wake; answers null when nothing new was queued. */
      notify: (wake: TypedWake) => unknown;
      activity: (fact: {
        computerId: string | null;
        label: string;
        pressure: "warning" | "critical" | "normal";
        text: string;
      }) => void;
      /** The home's clock. */
      now?: () => number;
      /** The once-names already queued that start with `prefix`. */
      heard?: (prefix: string) => string[];
    },
  ) {
    this.now = options.now ?? Date.now;
    this.readBack();
  }

  /**
   * Open warnings from the names their wakes went out under. Not knowing
   * what happened while the app was closed is not recovery, so an open
   * warning's last pressure is now.
   */
  private readBack(): void {
    const heard = this.options.heard;
    if (!heard) return;
    const ended = new Set(heard(MEMORY_CLEAR_PREFIX));
    const now = this.now();
    for (const name of heard(MEMORY_WARNING_PREFIX)) {
      const critical = name.endsWith(CRITICAL_SUFFIX);
      const id = critical ? name.slice(0, -CRITICAL_SUFFIX.length) : name;
      const split = id.lastIndexOf(":");
      const computer = id.slice(MEMORY_WARNING_PREFIX.length, split);
      const since = Number(id.slice(split + 1));
      if (!computer || !Number.isFinite(since)) continue;
      if (ended.has(clearOnce(id))) continue;
      const computerId = computer === "home" ? null : computer;
      const open = this.warnings.get(computerId);
      if (open && open.since > since) continue;
      if (open && open.since === since) {
        open.critical ||= critical;
        continue;
      }
      this.warnings.set(computerId, { id, since, critical, lastPressureAt: now });
    }
  }

  observe(view: ComputerResourcesView): void {
    const now = this.now();
    for (const { computerId, label, reading } of view.computers) {
      // A missing or stale reading is never a normal one.
      if (reading.status !== "fresh") continue;
      const pressure = reading.observation.memory.memoryPressure;
      if (!pressure) continue;
      const open = this.warnings.get(computerId);
      if (pressure === "normal") {
        if (open && now - open.lastPressureAt >= MEMORY_WARNING_CLEAR_MS) {
          this.warnings.delete(computerId);
          this.end(computerId, label, open, now);
        }
        continue;
      }
      if (open) {
        open.lastPressureAt = now;
        if (pressure !== "critical" || open.critical) continue;
        open.critical = true;
        this.tell(computerId, label, reading.observation, open, `${open.id}${CRITICAL_SUFFIX}`);
        continue;
      }
      const warning: Warning = {
        id: memoryWarningId(computerId, now),
        since: now,
        critical: pressure === "critical",
        lastPressureAt: now,
      };
      this.warnings.set(computerId, warning);
      this.tell(computerId, label, reading.observation, warning, warning.id);
    }
  }

  /** The warning's end: one wake that asks for no card, and one Activity line. */
  private end(computerId: string | null, label: string, warning: Warning, now: number): void {
    const queued = this.options.notify({
      facts: {
        kind: "memory-warning-ended",
        computerId,
        label,
        warning: { id: warning.id, since: new Date(warning.since).toISOString() },
        clearMinutes: MEMORY_WARNING_CLEAR_MS / 60_000,
        endedAt: new Date(now).toISOString(),
      },
      once: clearOnce(warning.id),
    });
    if (queued === null) return;
    this.options.activity({
      computerId,
      label,
      pressure: "normal",
      text: `${label} · Memory warning ended · Normal for ${MEMORY_WARNING_CLEAR_MS / 60_000} minutes`,
    });
  }

  private tell(
    computerId: string | null,
    label: string,
    observation: Extract<
      ComputerResourcesView["computers"][number]["reading"],
      { status: "fresh" }
    >["observation"],
    warning: Warning,
    once: string,
  ): void {
    const pressure = observation.memory.memoryPressure as "warning" | "critical";
    const processes = observation.processes;
    const tasks =
      processes?.status === "sampled"
        ? processes.tasks.map((task) => ({ ...task, key: this.options.taskKey(task.taskId) }))
        : [];
    const recordedLeftovers = this.options.leftovers?.(computerId) ?? [];
    const other = processes?.status === "sampled" ? processes.other : undefined;
    // Reading the computer's list first lets a close report it shows cleared
    // be marked resolved, so this notice no longer names it.
    const emit = (recorded: PressureLeftover[], leftBehind?: LeftBehindFacts) => {
      const queued = this.options.notify({
        facts: {
          kind: "resource-pressure" as const,
          computerId,
          label,
          pressure,
          warning: { id: warning.id, since: new Date(warning.since).toISOString() },
          tasks,
          ...(recorded.length
            ? { recordedLeftovers: recorded, leftoverUse: "unknown" as const }
            : {}),
          ...(processes?.status === "sampled"
            ? { other: processes.other, processCount: processes.processCount }
            : {}),
          ...(observation.memory.swapUsedBytes === undefined
            ? {}
            : { swapUsedBytes: observation.memory.swapUsedBytes }),
          ...(leftBehind &&
          leftBehind.stops.length + leftBehind.programs.length + leftBehind.runs.length
            ? { leftBehind }
            : {}),
        },
        once,
      });
      // Only a queued wake writes its line, so a restart cannot repeat one.
      if (queued === null) return;
      this.options.activity({
        computerId,
        label,
        pressure,
        text: pressureLine(label, pressure, tasks, other, recorded),
      });
    };
    const listing = this.options.leftBehind?.(computerId);
    if (!listing) {
      emit(recordedLeftovers);
      return;
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

/** The name a warning's end goes out once under. */
function clearOnce(id: string): string {
  return `${MEMORY_CLEAR_PREFIX}${id.slice(MEMORY_WARNING_PREFIX.length)}`;
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
