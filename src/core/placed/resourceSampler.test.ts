import type { CpuInfo } from "node:os";
import type { ResourceMemory } from "@shared/resources";
import { describe, expect, it } from "vitest";
import { ResourceSampler } from "./resourceSampler";

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
    const sampler = new ResourceSampler({
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
});
