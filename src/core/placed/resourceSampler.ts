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

export type ResourceSamplerOptions = {
  /** The host supplies memory facts; core never reaches into Electron. A Mac read is async. */
  memory?: () => ResourceMemory | null | Promise<ResourceMemory | null>;
  cpus?: () => CpuInfo[];
  processes?: () => Promise<ProcessReading[] | null>;
  /** Monotonic, so a clock correction cannot make an old reading new. */
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
};

/** Demand-only sampling, shared by the home and work mode. No idle polling or saved history. */
export class ResourceSampler {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private readonly attribution = new ProcessAttribution();
  private pending: Promise<ResourceObservation> | undefined;

  constructor(private readonly options: ResourceSamplerOptions = {}) {}

  /** Simultaneous readers share one bounded window, not independent CPU baselines. */
  read(): Promise<ResourceObservation> {
    if (this.pending) return this.pending;
    const pending = this.sample().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private async sample(): Promise<ResourceObservation> {
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
      const firstProcesses = readProcess ? await readProcess() : null;
      const processStart = now();
      if (firstProcesses) this.attribution.owners(firstProcesses, processRoots.read());
      const first = readCpus();
      const start = now();
      const pause = this.options.wait ?? wait;
      await pause(RESOURCE_SAMPLE_MS);
      // Timers can wake just before their requested millisecond. Finish the
      // window rather than presenting that as missing CPU information.
      const remaining = RESOURCE_SAMPLE_MS - (now() - start);
      if (remaining > 0) await pause(Math.ceil(remaining));
      const last = readCpus();
      const sampleMs = now() - start;
      if (sampleMs < RESOURCE_SAMPLE_MS || sampleMs > RESOURCE_MAX_SAMPLE_MS)
        return unknown("interrupted");
      if (first.length === 0 || first.length !== last.length || last.length > 65_536)
        return unknown("interrupted");
      const lastProcesses = readProcess ? await readProcess() : null;
      const processMs = now() - processStart;
      const processes =
        firstProcesses && lastProcesses
          ? processResources(
              firstProcesses,
              lastProcesses,
              this.attribution.owners(lastProcesses, processRoots.read()),
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
