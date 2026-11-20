import { randomUUID } from "node:crypto";
import { type CpuInfo, cpus } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import {
  RESOURCE_MAX_SAMPLE_MS,
  RESOURCE_SAMPLE_MS,
  type ResourceMemory,
  type ResourceObservation,
  validResourceMemory,
} from "@shared/resources";

import { ProcessAttribution, type ProcessReading, processResources } from "./processResources";
import { processRoots } from "./processRoots";
import { folderOwners, readWorkingFolders, type TaskFolders } from "./workingFolders";

export type CpuWindow = { epoch: string; start: number; end: number };

/** `firstAt` is the wall-clock time just before the first reading, which process births compare against. */
export type ProcessWindow = { first: ProcessReading[]; firstAt: number; elapsedMs: number };

export type ResourceSamplerOptions = {
  /** The host supplies memory facts; core never reaches into Electron. A Mac read is async. */
  memory?: () => ResourceMemory | null | Promise<ResourceMemory | null>;
  cpus?: () => CpuInfo[];
  processes?: () => Promise<ProcessReading[] | null>;
  /** Monotonic, so a clock correction cannot make an old reading new. */
  now?: () => number;
  /** Wall clock, read beside each process reading so births inside the window count. */
  wallNow?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  /** The open tasks here and their folders: a program working in one counts as that task's. */
  taskFolders?: () => readonly TaskFolders[];
  /** Local owners reuse this completed window; process metadata never crosses the connection. */
  observed?: (
    observation: ResourceObservation,
    processes: ProcessReading[] | null,
    started: number,
    window?: ProcessWindow,
    cpuWindow?: CpuWindow,
  ) => void;
};

/** Demand-only sampling, shared by the home and work mode. No idle polling or saved history. */
export class ResourceSampler {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private readonly attribution = new ProcessAttribution();
  private pending: Promise<ResourceObservation> | undefined;
  private lastProcesses: ProcessReading[] | null = null;
  private processWindow: ProcessWindow | undefined;
  private cpuWindow: CpuWindow | undefined;
  private baseline:
    | {
        cpus: CpuInfo[];
        at: number;
        processes: ProcessReading[] | null;
        processAt: number;
        processWallAt: number;
      }
    | undefined;

  constructor(private readonly options: ResourceSamplerOptions = {}) {}

  /** Simultaneous readers share one bounded window, not independent CPU baselines. */
  read(): Promise<ResourceObservation> {
    if (this.pending) return this.pending;
    const started = (this.options.now ?? (() => performance.now()))();
    const pending = this.sample()
      .then((observation) => {
        this.options.observed?.(
          observation,
          this.lastProcesses,
          started,
          this.processWindow,
          this.cpuWindow,
        );
        return observation;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }

  /** No open task here, or an unreadable listing, attributes nothing by folder. */
  private async folderOwners(rows: ProcessReading[]): Promise<Map<number, string>> {
    const tasks = this.options.taskFolders?.() ?? [];
    if (tasks.length === 0) return new Map();
    const folders = await readWorkingFolders(rows.map((row) => row.pid)).catch(() => null);
    return folders ? folderOwners(folders, tasks) : new Map();
  }

  private async sample(): Promise<ResourceObservation> {
    this.lastProcesses = null;
    this.processWindow = undefined;
    this.cpuWindow = undefined;
    const stamp = { epoch: this.epoch, sequence: ++this.sequence };
    const unknown = (reason: "unavailable" | "interrupted"): ResourceObservation => ({
      ...stamp,
      status: "unknown",
      reason,
    });
    if (!this.options.memory) return unknown("unavailable");
    try {
      const readCpus = this.options.cpus ?? cpus;
      const now = this.options.now ?? (() => performance.now());
      const readProcess = this.options.processes;
      const wallNow = this.options.wallNow ?? Date.now;
      const previous = this.baseline;
      this.baseline = undefined;
      const elapsed = previous ? now() - previous.at : -1;
      const reuse = previous && elapsed >= 0 && elapsed <= RESOURCE_MAX_SAMPLE_MS;
      const firstAt = reuse ? previous.processWallAt : wallNow();
      const firstProcesses = reuse ? previous.processes : readProcess ? await readProcess() : null;
      const processStart = reuse ? previous.processAt : now();
      if (firstProcesses)
        this.attribution.owners(firstProcesses, processRoots.read(), processRoots.readGroups());
      const first = reuse ? previous.cpus : readCpus();
      const start = reuse ? previous.at : now();
      const pause = this.options.wait ?? wait;
      // Timers can wake just before their requested millisecond, more than once.
      // Wait until the window is finished rather than presenting an early wake
      // as missing CPU information. A reused window may be finished already.
      const remaining = () => RESOURCE_SAMPLE_MS - (now() - start);
      while (remaining() > 0) await pause(Math.ceil(remaining()));
      const last = readCpus();
      const at = now();
      const sampleMs = at - start;
      if (sampleMs < RESOURCE_SAMPLE_MS || sampleMs > RESOURCE_MAX_SAMPLE_MS)
        return unknown("interrupted");
      if (first.length === 0 || first.length !== last.length || last.length > 65_536)
        return unknown("interrupted");
      const processWallAt = wallNow();
      const lastProcesses = readProcess ? await readProcess() : null;
      this.lastProcesses = lastProcesses;
      const processAt = now();
      const processMs = processAt - processStart;
      this.baseline = { cpus: last, at, processes: lastProcesses, processAt, processWallAt };
      if (firstProcesses)
        this.processWindow = { first: firstProcesses, firstAt, elapsedMs: processMs };
      const processes =
        firstProcesses && lastProcesses
          ? processResources(
              firstProcesses,
              lastProcesses,
              this.attribution.owners(
                lastProcesses,
                processRoots.read(),
                processRoots.readGroups(),
                await this.folderOwners(lastProcesses),
              ),
              processMs,
              firstAt,
            )
          : { status: "unknown" as const };
      const memory = await this.options.memory();
      if (!memory || !validResourceMemory(memory)) return unknown("unavailable");
      let total = 0;
      let idle = 0;
      for (let index = 0; index < last.length; index++) {
        const before = first[index]?.times;
        const after = last[index]?.times;
        if (!before || !after) return unknown("interrupted");
        let cpuTotal = 0;
        for (const field of ["user", "nice", "sys", "idle", "irq"] as const) {
          const delta = after[field] - before[field];
          if (!Number.isFinite(delta) || delta < 0) return unknown("interrupted");
          cpuTotal += delta;
        }
        if (cpuTotal <= 0) return unknown("interrupted");
        total += cpuTotal;
        idle += after.idle - before.idle;
      }
      this.cpuWindow = { epoch: this.epoch, start, end: at };
      return {
        ...stamp,
        status: "sampled",
        sampleMs,
        cpu: { logicalCpus: last.length, idleFraction: idle / total },
        memory,
        ...(readProcess ? { processes } : {}),
      };
    } catch {
      return unknown("unavailable");
    }
  }
}
