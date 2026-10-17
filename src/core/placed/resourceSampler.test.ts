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
