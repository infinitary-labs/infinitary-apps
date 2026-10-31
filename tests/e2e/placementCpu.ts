import type { CpuInfo } from "node:os";
import { expect } from "@playwright/test";
import type { LaunchedApp } from "./launch";

/**
 * INF-1129, captain-approved controlled processor readings. CPU-time deltas
 * from two real 250 ms windows on a ten-core Mac: busy during typecheck,
 * available before it. Fields are user, nice, sys, idle and irq. Replay only
 * these counters; the app still samples memory and compatibility itself.
 */
const WINDOWS = {
  busy: [
    [210, 0, 50, 0, 0],
    [210, 0, 30, 0, 0],
    [210, 0, 40, 0, 0],
    [210, 0, 40, 0, 0],
    [220, 0, 30, 0, 0],
    [210, 0, 40, 0, 0],
    [230, 0, 20, 0, 0],
    [220, 0, 20, 0, 0],
    [220, 0, 20, 0, 0],
    [230, 0, 30, 0, 0],
  ],
  available: [
    [70, 0, 120, 60, 0],
    [90, 0, 90, 70, 0],
    [60, 0, 80, 110, 0],
    [60, 0, 50, 140, 0],
    [50, 0, 40, 160, 0],
    [40, 0, 30, 180, 0],
    [110, 0, 20, 110, 0],
    [100, 0, 30, 120, 0],
    [110, 0, 20, 110, 0],
    [110, 0, 30, 120, 0],
  ],
} satisfies Record<string, [number, number, number, number, number][]>;

type Phase = keyof typeof WINDOWS;
type ReplayScope = { placementCpuReplay: { phase: Phase } };

/** Derived from the captured counters, not a second pin of the sampled result. */
export function replayedCpu(phase: Phase) {
  const counters = WINDOWS[phase];
  return {
    logicalCpus: counters.length,
    idleFraction:
      counters.reduce((sum, cpu) => sum + cpu[3], 0) /
      counters.reduce((sum, cpu) => sum + cpu.reduce((sum, time) => sum + time, 0), 0),
  };
}

/** Read the real feed through its published read, also renewing sampling demand. */
export function homeReading(app: LaunchedApp) {
  return computerReading(app, null);
}

/** The same feed's reading for one computer: `null` is the home, else a paired device. */
export function computerReading(app: LaunchedApp, computerId: string | null) {
  return app.page.evaluate(async (computerId) => {
    const view = await window.infinitary.plugins.read("computers.resources", {});
    return view.computers.find((row) => row.computerId === computerId)?.reading;
  }, computerId);
}

/**
 * Override the isolated Electron process's OS input, never product code or
 * the runner's CPU. No timer makes it ready: only the journey's release does.
 * Counters remain monotonic across release, including a sample spanning it.
 */
export async function holdCpuBusy(app: LaunchedApp): Promise<() => Promise<void>> {
  await app.app.evaluate((_, windows) => {
    const os = process.getBuiltinModule("node:os");
    const scope = globalThis as unknown as ReplayScope;
    const state = { phase: "busy" as Phase };
    scope.placementCpuReplay = state;
    const fields = ["user", "nice", "sys", "idle", "irq"] as const;
    const counters: CpuInfo[] = windows.busy.map(() => ({
      model: "Recorded CPU",
      speed: 0,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    }));
    os.cpus = () =>
      counters.map((cpu, index) => {
        const delta = windows[state.phase][index];
        if (!delta) throw new Error("The CPU replay lost a processor");
        for (const [fieldIndex, field] of fields.entries())
          cpu.times[field] += delta[fieldIndex] ?? 0;
        // A sampler keeps its first read: never mutate the object it got.
        return { ...cpu, times: { ...cpu.times } };
      });
    process.getBuiltinModule("node:module").syncBuiltinESMExports();
  }, WINDOWS);
  // Drain a pre-existing real sample/cache before the journey asks for a task.
  await expect
    .poll(() => homeReading(app), { timeout: 90_000 })
    .toMatchObject({
      status: "fresh",
      observation: { cpu: replayedCpu("busy") },
    });
  return () =>
    app.app.evaluate(() => {
      (globalThis as unknown as ReplayScope).placementCpuReplay.phase = "available";
    });
}

/**
 * The same recorded "available" counters for an in-process helper, which
 * samples this test process's own `node:os` (`startHelper`), so a journey
 * that compares the home with such a helper reads neither from the runner's
 * actual load. Call before the helper starts; the returned function restores
 * the real counters.
 */
export function replayHelperCpuAvailable(): () => void {
  const os = process.getBuiltinModule("node:os");
  const real = os.cpus;
  const counters: CpuInfo[] = WINDOWS.available.map(() => ({
    model: "Recorded CPU",
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }));
  const fields = ["user", "nice", "sys", "idle", "irq"] as const;
  os.cpus = () =>
    counters.map((cpu, index) => {
      const delta = WINDOWS.available[index];
      if (!delta) throw new Error("The CPU replay lost a processor");
      for (const [fieldIndex, field] of fields.entries())
        cpu.times[field] += delta[fieldIndex] ?? 0;
      return { ...cpu, times: { ...cpu.times } };
    });
  const sync = () => process.getBuiltinModule("node:module").syncBuiltinESMExports();
  sync();
  return () => {
    os.cpus = real;
    sync();
  };
}
