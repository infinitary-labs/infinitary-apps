import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { softHoldWords } from "@shared/holds";
import { type LoadDemand, type LoadRun, type LoadSnapshot, loadDemandSchema } from "@shared/load";
import {
  RESOURCE_MAX_AGE_MS,
  RESOURCE_REFRESH_MS,
  type ResourceObservation,
} from "@shared/resources";
import { z } from "zod";
import { memoryUsedBytes } from "./memoryUsed";
import { type ProcessReading, processResources, readProcesses } from "./processResources";
import { processRoots } from "./processRoots";
import { memoryMarginBytes, resourceCapacity } from "./resourceCapacity";
import type { ProcessWindow } from "./resourceSampler";

const heldSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().min(1),
  demand: loadDemandSchema,
  pid: z.number().int().positive(),
  started: z.string().min(1),
  state: z.enum(["waiting", "running"]),
});
type Held = z.infer<typeof heldSchema>;

export type LoadClaim = { pid: number; demand: LoadDemand; parent?: string };
export type TaskLoad = {
  claim: (input: LoadClaim) => Promise<LoadRun>;
  read: () => LoadSnapshot;
};

/** Signal zero observes existence only. It never kills, pauses or changes scheduling. */
export function loadGroupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * One line on a work computer. The native wrapper is its own process-group
 * leader before it asks; admission execs the caller's program in that group.
 * The whole group, not the requesting shell or an HTTP connection, owns its
 * declared hold. Saved metadata lets living groups retain it after a restart.
 * No command, environment, process argument or credential is kept here.
 */
export class LoadLine {
  private held: Held[];
  private readonly roots = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private latest: { observation: ResourceObservation; at: number } | undefined;
  private measured = new Map<string, number>();
  private measuredMemory = new Map<string, number>();
  private failure: unknown;
  private stopped = false;

  constructor(
    private readonly options: {
      stateFile: string;
      processes?: () => Promise<ProcessReading[] | null>;
      groupExists?: (group: number) => boolean;
      overridden?: (taskId: string) => boolean;
      changed?: () => void;
      now?: () => number;
    },
  ) {
    try {
      this.held = z.array(heldSchema).parse(JSON.parse(readFileSync(options.stateFile, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failure = error;
      this.held = [];
    }
    for (const held of this.held) this.track(held);
    this.watch();
  }

  get active(): boolean {
    return this.held.length > 0;
  }

  forTask(taskId: string): TaskLoad {
    return {
      claim: (input) => this.claim(taskId, input),
      read: () => ({ runs: this.snapshot().runs.filter((run) => run.taskId === taskId) }),
    };
  }

  /** Reuses the sampler's completed reading and metadata; never starts another CPU window. */
  observe(
    observation: ResourceObservation,
    processes: ProcessReading[] | null,
    started = this.now(),
    window?: ProcessWindow,
  ): void {
    if (this.stopped || this.failure) return;
    this.latest = { observation, at: started };
    try {
      if (processes) {
        const byPid = new Map(processes.map((row) => [row.pid, row]));
        const groups = new Set(processes.map((row) => row.group));
        this.commit(
          this.held.filter((held) => {
            if (!groups.has(held.pid)) return false;
            const leader = byPid.get(held.pid);
            // A reused group identifier is not the group this caller registered.
            return !leader || leader.group !== held.pid || leader.started === held.started;
          }),
        );
      }
      this.measured.clear();
      this.measuredMemory.clear();
      if (processes && observation.status === "sampled") {
        const owners = new Map(
          processes.flatMap((row) => {
            const held = this.held.find((held) => held.pid === row.group);
            return held ? [[row.pid, held.id] as const] : [];
          }),
        );
        // Resident memory is a reading of this table alone; processor use needs a window.
        for (const row of processes) {
          const id = owners.get(row.pid);
          if (id)
            this.measuredMemory.set(id, (this.measuredMemory.get(id) ?? 0) + row.residentBytes);
        }
        const use = window
          ? processResources(window.first, processes, owners, window.elapsedMs)
          : undefined;
        if (use?.status === "sampled") {
          for (const run of use.tasks)
            if (run.cpuCores !== undefined) this.measured.set(run.taskId, run.cpuCores);
        }
      }
      this.admit();
    } catch (error) {
      // A failed declaration store must not turn the independent Use reading unknown.
      this.failure = error;
    }
  }

  /** The home may refresh recorded overrides without collecting another resource sample. */
  reconsider(): void {
    if (this.stopped || this.failure) return;
    try {
      this.admit();
    } catch (error) {
      this.failure = error;
    }
  }

  snapshot(): LoadSnapshot {
    this.check();
    const running = this.held.filter((held) => held.state === "running").length;
    let waiting = 0;
    const unavailable = this.capacity();
    const pressure = this.observation()?.value.memory.memoryPressure;
    return {
      runs: this.held.map((held): LoadRun => {
        if (held.state === "running") {
          return {
            id: held.id,
            taskId: held.taskId,
            demand: held.demand,
            state: held.state,
            ahead: 0,
          };
        }
        const ahead = running + waiting++;
        const reason =
          pressure === "warning" || pressure === "critical"
            ? "pressure"
            : unavailable === null
              ? "unavailable"
              : waiting > 1
                ? "line"
                : "capacity";
        return {
          id: held.id,
          taskId: held.taskId,
          demand: held.demand,
          state: held.state,
          ahead,
          reason,
        };
      }),
    };
  }

  /** Stop observing only. Existing groups and their saved holds are untouched. */
  dispose(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const release of this.roots.values()) release();
    this.roots.clear();
  }

  private async claim(taskId: string, input: LoadClaim): Promise<LoadRun> {
    this.check();
    const demand = loadDemandSchema.parse(input.demand);
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0)
      throw new Error("The run has no process identity.");
    const rows = await (this.options.processes ?? readProcesses)();
    this.check();
    const row = rows?.find((row) => row.pid === input.pid);
    if (!row) {
      // An unavailable table does not prove that a previously verified caller
      // ended. Keep its place, but never hand out a saved admission without a
      // fresh identity check, even if observe() admitted it during this read.
      const held =
        rows === null && !input.parent
          ? this.held.find(
              (held) =>
                held.taskId === taskId &&
                held.pid === input.pid &&
                held.demand.cpu === demand.cpu &&
                held.demand.memoryBytes === demand.memoryBytes,
            )
          : undefined;
      if (held) return { ...this.runOf(held.id), state: "waiting", reason: "unavailable" };
      throw new Error("The run's process could not be read; nothing started.");
    }
    if (input.parent) {
      const parent = this.held.find((held) => held.id === input.parent && held.taskId === taskId);
      if (parent?.state !== "running" || row.group !== parent.pid)
        throw new Error("The inherited hold does not belong to this running process group.");
      if (demand.cpu > parent.demand.cpu || demand.memoryBytes > parent.demand.memoryBytes)
        throw new Error(
          "The outer run declared less than this run needs. Declare the whole run's needs on the outer command.",
        );
      return this.runOf(parent.id);
    }
    if (row.group !== row.pid)
      throw new Error(
        "The run must ask from its own process group through infinitary-load-axi run.",
      );
    const existing = this.held.find((held) => held.pid === row.pid && held.started === row.started);
    if (existing) {
      if (
        existing.taskId !== taskId ||
        existing.demand.cpu !== demand.cpu ||
        existing.demand.memoryBytes !== demand.memoryBytes
      )
        throw new Error("This process group already declared a different hold.");
    } else {
      const held: Held = {
        id: randomUUID(),
        taskId,
        demand,
        pid: row.pid,
        started: row.started,
        state: "waiting",
      };
      this.commit([...this.held.filter((held) => held.pid !== row.pid), held]);
    }
    this.admit();
    this.watch();
    const held = this.held.find((held) => held.taskId === taskId && held.pid === row.pid);
    if (!held) throw new Error("The requesting process group has ended.");
    return this.runOf(held.id);
  }

  private runOf(id: string): LoadRun {
    const run = this.snapshot().runs.find((run) => run.id === id);
    if (!run) throw new Error("The requesting process group has ended.");
    return run;
  }

  private observation():
    | { value: Extract<ResourceObservation, { status: "sampled" }>; ageMs: number }
    | undefined {
    if (!this.latest) return undefined;
    const age = this.now() - this.latest.at;
    const { observation } = this.latest;
    return age >= 0 && age <= RESOURCE_MAX_AGE_MS && observation.status === "sampled"
      ? { value: observation, ageMs: age }
      : undefined;
  }

  private capacity(): LoadDemand | null {
    const current = this.observation();
    if (!current) return null;
    const { value: observation, ageMs } = current;
    if (
      observation.memory.memoryPressure === "warning" ||
      observation.memory.memoryPressure === "critical"
    )
      return null;
    return resourceCapacity({
      status: "fresh",
      observation,
      ageMs,
      memoryUsedBytes: memoryUsedBytes(observation.memory),
    });
  }

  private admit(): void {
    this.check();
    const remaining = this.capacity();
    let running = 0;
    if (remaining) {
      for (const held of this.held) {
        if (held.state !== "running") continue;
        running++;
        const measured = this.measured.get(held.id) ?? 0;
        // Restore observed use before applying the same placement margin, then
        // reserve the larger of declared and measured use exactly once.
        remaining.cpu += measured * 0.8 - Math.max(held.demand.cpu, measured);
        // The memory reading already lacks a running group's resident memory: add
        // it back, then reserve the larger of declared and resident once (INF-2165).
        // An unmeasured group reserves its declaration with nothing added back.
        const resident = this.measuredMemory.get(held.id) ?? 0;
        remaining.memoryBytes += resident - Math.max(held.demand.memoryBytes, resident);
      }
    }
    // With nothing running, the front run's memory ask is judged against installed
    // memory less the same margin, not today's free reading (INF-2165 direction A).
    // Pressure and a fresh reading still gate it through capacity().
    const total = this.observation()?.value.memory.totalBytes ?? 0;
    const installed = Math.max(0, Math.floor(total - memoryMarginBytes(total)));
    let earlier = false;
    const next = this.held.map((held): Held => {
      if (held.state === "running") return held;
      const overridden = this.options.overridden?.(held.taskId) === true;
      const fits =
        !earlier &&
        remaining !== null &&
        (running === 0
          ? held.demand.memoryBytes <= installed
          : held.demand.cpu <= remaining.cpu && held.demand.memoryBytes <= remaining.memoryBytes);
      if (!overridden && !fits) {
        earlier = true;
        return held;
      }
      if (remaining) {
        remaining.cpu -= held.demand.cpu;
        remaining.memoryBytes -= held.demand.memoryBytes;
      }
      running++;
      return { ...held, state: "running" };
    });
    this.commit(next);
  }

  private commit(next: Held[]): void {
    if (JSON.stringify(next) === JSON.stringify(this.held)) return;
    // Persist before a caller can receive a grant. A failed write grants nothing.
    mkdirSync(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.stateFile}.new`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.options.stateFile);
    for (const held of this.held) {
      if (next.some((row) => row.id === held.id)) continue;
      this.roots.get(held.id)?.();
      this.roots.delete(held.id);
    }
    this.held = next;
    for (const held of next) if (!this.roots.has(held.id)) this.track(held);
    this.options.changed?.();
  }

  private track(held: Held): void {
    this.roots.set(held.id, processRoots.addGroup(held.pid, held.taskId, held.started));
  }

  private watch(): void {
    if (this.timer || this.stopped || !this.active) return;
    this.timer = setInterval(() => {
      try {
        const exists = this.options.groupExists ?? loadGroupExists;
        this.commit(this.held.filter((held) => exists(held.pid)));
        this.admit();
        if (!this.active && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      } catch (error) {
        this.failure = error;
      }
    }, RESOURCE_REFRESH_MS);
    this.timer.unref();
  }

  private check(): void {
    if (this.stopped) throw new Error("The computer's load line is closed; nothing started.");
    if (this.failure)
      throw new Error("The computer's load holds could not be kept; nothing started.");
  }

  private now(): number {
    return (this.options.now ?? (() => performance.now()))();
  }
}

export function loadWaitWords(): string {
  return softHoldWords("load-line", "crewmate");
}
