import type { CpuInfo } from "node:os";
import type { ResourceMemory } from "@shared/resources";
import { describe, expect, it } from "vitest";
import { type CpuWindow, ResourceSampler } from "./resourceSampler";

/**
 * INF-213: the memory seam is asynchronous because a Mac sample reads vm_stat
 * and the pressure sysctl. The observation must carry what that promise returns.
 */
describe("ResourceSampler awaits the memory read", () => {
  it("reports the memory a promise returns", async () => {
    const memory: ResourceMemory = {
      totalBytes: 8 * 1024 ** 3,
      freeBytes: 2 * 1024 ** 3,
      availableBytes: 3 * 1024 ** 3,
    };
    let clock = 0;
    let idle = 10;
    const cpu = (): CpuInfo[] => [
      {
        model: "test",
        speed: 1,
        times: { user: 1, nice: 0, sys: 1, idle: idle++, irq: 0 },
      },
    ];
    const observation = await new ResourceSampler({
      memory: async () => memory,
      cpus: cpu,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    }).read();
    expect(observation.status).toBe("sampled");
    if (observation.status === "sampled") expect(observation.memory).toEqual(memory);
  });
});

/** INF-1685: cover every refresh interval, retaining the short window after a quiet spell.
 * The CPU delta is a recorded available core from placementCpu.ts (INF-1129).
 * A manual clock makes skipped windows and wrong reported spans deterministic.
 */
describe("accepted CPU refresh windows", () => {
  it("shares concurrent reads, reuses the completed endpoint, and resets after five seconds", async () => {
    let clock = 0;
    let reads = 0;
    const pauses: number[] = [];
    const intervals: CpuWindow[] = []; // INF-2228: expose actual reused CPU endpoints, not request start.

    const sampler = new ResourceSampler({
      observed: (observation, _processes, _started, _window, cpuWindow) => {
        if (observation.status === "sampled" && cpuWindow) intervals.push(cpuWindow);
      },
      memory: () => ({ totalBytes: 8 * 1024 ** 3, freeBytes: 3 * 1024 ** 3 }),
      cpus: () => {
        const n = ++reads;
        return [
          {
            model: "Recorded CPU",
            speed: 0,
            times: { user: n * 70, nice: 0, sys: n * 120, idle: n * 60, irq: 0 },
          },
        ];
      },
      now: () => clock,
      wait: async (ms) => {
        pauses.push(ms);
        clock += ms;
      },
    });
    const first = sampler.read();
    expect(sampler.read()).toBe(first);
    expect(await first).toMatchObject({ status: "sampled", sampleMs: 250 });
    expect(reads).toBe(2);
    clock += 1750;
    expect(await sampler.read()).toMatchObject({ status: "sampled", sampleMs: 1750 });
    expect(reads).toBe(3);
    clock += 5000;
    expect(await sampler.read()).toMatchObject({ status: "sampled", sampleMs: 5000 });
    expect(reads).toBe(4);
    clock += 5001;
    expect(await sampler.read()).toMatchObject({ status: "sampled", sampleMs: 250 });
    expect(reads).toBe(6);
    expect(pauses).toEqual([250, 250]);
    expect(intervals.map(({ start, end }) => [start, end])).toEqual([
      [0, 250],
      [250, 2000],
      [2000, 7000],
      [12001, 12251],
    ]);
    expect(new Set(intervals.map(({ epoch }) => epoch)).size).toBe(1);
  });

  it("finishes a too-short refresh and refuses reset counters or changed processor counts", async () => {
    let clock = 0;
    let count = 1;
    let reset = false;
    const sampler = new ResourceSampler({
      memory: () => ({ totalBytes: 8 * 1024 ** 3, freeBytes: 3 * 1024 ** 3 }),
      cpus: () =>
        Array.from({ length: count }, () => ({
          model: "Recorded CPU",
          speed: 0,
          times: {
            user: reset ? 0 : clock * 70,
            nice: 0,
            sys: 0,
            idle: reset ? 0 : clock * 60,
            irq: 0,
          },
        })),
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    });
    expect(await sampler.read()).toMatchObject({ status: "sampled" });
    clock += 100;
    expect(await sampler.read()).toMatchObject({ status: "sampled", sampleMs: 250 });
    reset = true;
    clock += 1750;
    expect(await sampler.read()).toMatchObject({ status: "unknown", reason: "interrupted" });
    reset = false;
    count = 2;
    clock += 1750;
    expect(await sampler.read()).toMatchObject({ status: "unknown", reason: "interrupted" });
  });

  /**
   * A Mac run of processResources.integration.test.ts read an interrupted refresh: the
   * 69 ms wait that should finish its 250 ms window woke after 68.56 ms, leaving 249.62 ms.
   * Each wait here wakes half a millisecond early, as that one did. Fails when an early
   * wake of the finishing wait reads as an interrupted window.
   */
  it("finishes a window whose waits wake before their millisecond", async () => {
    let clock = 0;
    const pauses: number[] = [];
    const sampler = new ResourceSampler({
      memory: () => ({ totalBytes: 8 * 1024 ** 3, freeBytes: 3 * 1024 ** 3 }),
      cpus: () => [
        {
          model: "Recorded CPU",
          speed: 0,
          times: { user: clock * 70, nice: 0, sys: 0, idle: clock * 60, irq: 0 },
        },
      ],
      now: () => clock,
      wait: async (ms) => {
        pauses.push(ms);
        clock += ms - 0.5;
      },
    });
    const first = await sampler.read();
    expect(first).toMatchObject({ status: "sampled" });
    if (first.status === "sampled") expect(first.sampleMs).toBeGreaterThanOrEqual(250);
    expect(pauses).toEqual([250, 1]);
    pauses.length = 0;
    clock += 181.06;
    const refreshed = await sampler.read();
    expect(refreshed).toMatchObject({ status: "sampled" });
    if (refreshed.status === "sampled") expect(refreshed.sampleMs).toBeGreaterThanOrEqual(250);
    expect(pauses).toEqual([69, 1]);
  });
});
