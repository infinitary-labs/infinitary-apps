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

export type ProcessWindow = { first: ProcessReading[]; elapsedMs: number };

export type ResourceSamplerOptions = {
  /** The host supplies memory facts; core never reaches into Electron. A Mac read is async. */
  memory?: () => ResourceMemory | null | Promise<ResourceMemory | null>;
  cpus?: () => CpuInfo[];
  processes?: () => Promise<ProcessReading[] | null>;
  /** Monotonic, so a clock correction cannot make an old reading new. */
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  /** Local owners reuse this completed window; process metadata never crosses the connection. */
  observed?: (
    observation: ResourceObservation,
    processes: ProcessReading[] | null,
    started: number,
    window?: ProcessWindow,
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
  private baseline:
    | { cpus: CpuInfo[]; at: number; processes: ProcessReading[] | null; processAt: number }
    | undefined;

  constructor(private readonly options: ResourceSamplerOptions = {}) {}

  /** Simultaneous readers share one bounded window, not independent CPU baselines. */
  read(): Promise<ResourceObservation> {
    if (this.pending) return this.pending;
    const started = (this.options.now ?? (() => performance.now()))();
    const pending = this.sample()
      .then((observation) => {
        this.options.observed?.(observation, this.lastProcesses, started, this.processWindow);
        return observation;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }

  private async sample(): Promise<ResourceObservation> {
    this.lastProcesses = null;
    this.processWindow = undefined;
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
      const previous = this.baseline;
      this.baseline = undefined;
      const elapsed = previous ? now() - previous.at : -1;
      const reuse = previous && elapsed >= 0 && elapsed <= RESOURCE_MAX_SAMPLE_MS;
      const firstProcesses = reuse ? previous.processes : readProcess ? await readProcess() : null;
      const processStart = reuse ? previous.processAt : now();
      if (firstProcesses)
        this.attribution.owners(firstProcesses, processRoots.read(), processRoots.readGroups());
      const first = reuse ? previous.cpus : readCpus();
      const start = reuse ? previous.at : now();
      const pause = this.options.wait ?? wait;
      if (!reuse) await pause(RESOURCE_SAMPLE_MS);
      // Timers can wake just before their requested millisecond. Finish the
      // window rather than presenting that as missing CPU information.
      const remaining = RESOURCE_SAMPLE_MS - (now() - start);
      if (remaining > 0) await pause(Math.ceil(remaining));
      const last = readCpus();
      const at = now();
      const sampleMs = at - start;
      if (sampleMs < RESOURCE_SAMPLE_MS || sampleMs > RESOURCE_MAX_SAMPLE_MS)
        return unknown("interrupted");
      if (first.length === 0 || first.length !== last.length || last.length > 65_536)
        return unknown("interrupted");
      const lastProcesses = readProcess ? await readProcess() : null;
      this.lastProcesses = lastProcesses;
      const processAt = now();
      const processMs = processAt - processStart;
      this.baseline = { cpus: last, at, processes: lastProcesses, processAt };
      if (firstProcesses) this.processWindow = { first: firstProcesses, elapsedMs: processMs };
      const processes =
        firstProcesses && lastProcesses
          ? processResources(
              firstProcesses,
              lastProcesses,
              this.attribution.owners(
                lastProcesses,
                processRoots.read(),
                processRoots.readGroups(),
              ),
              processMs,
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
