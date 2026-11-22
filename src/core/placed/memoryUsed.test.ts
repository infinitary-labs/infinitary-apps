import type { ResourceMemory } from "@shared/resources";
import { describe, expect, it } from "vitest";
import { ComputerResources } from "./computerResources";
import { memoryUsedBytes } from "./memoryUsed";
import type { WorkDevices } from "./workDevices";

/**
 * INF-396, the plan the captain approved: one memory-used figure, by
 * Automatic's rule, and nothing counts as free once macOS warns. The pages
 * are the real 11:32:53 PM MacBook reading (16,384-byte pages).
 */
const PAGE = 16_384;
const INSTALLED = 25_769_803_776;
const pages = {
  free: 12_451,
  speculative: 3_279,
  inactive: 553_947,
  purgeable: 23_061,
  fileBacked: 353_399,
};

function macBook(pressure?: "normal" | "warning" | "critical"): ResourceMemory {
  return {
    totalBytes: INSTALLED,
    freeBytes: pages.free * PAGE,
    speculativeBytes: pages.speculative * PAGE,
    inactiveBytes: pages.inactive * PAGE,
    purgeableBytes: pages.purgeable * PAGE,
    fileBackedBytes: pages.fileBacked * PAGE,
    ...(pressure === undefined ? {} : { memoryPressure: pressure }),
  };
}

describe("memoryUsedBytes on the 11:32:53 PM MacBook reading", () => {
  it("counts 16,436,215,808 bytes used at normal pressure", () => {
    expect(memoryUsedBytes(macBook("normal"))).toBe(16_436_215_808);
  });

  it("counts every installed byte used when macOS warns or is critical", () => {
    expect(memoryUsedBytes(macBook("warning"))).toBe(INSTALLED);
    expect(memoryUsedBytes(macBook("critical"))).toBe(INSTALLED);
  });

  it("counts free, purgeable and file-backed bytes as free when pressure is absent", () => {
    expect(memoryUsedBytes(macBook())).toBe(19_397_885_952);
  });
});

describe("memoryUsedBytes tells Linux from a Mac by the reading's own fields", () => {
  it("counts a Linux reading as installed memory minus its available estimate", () => {
    expect(
      memoryUsedBytes({
        totalBytes: 8 * 1024 ** 3,
        freeBytes: 1 * 1024 ** 3,
        availableBytes: 3 * 1024 ** 3,
      }),
    ).toBe(5 * 1024 ** 3);
  });

  it("has no figure when the reading is neither Linux nor a Mac", () => {
    expect(
      memoryUsedBytes({ totalBytes: 8 * 1024 ** 3, freeBytes: 1 * 1024 ** 3 }),
    ).toBeUndefined();
  });
});

describe("ComputerResources.read stamps the figure on a fresh reading", () => {
  it("attaches the same figure the core function works out for that sample", async () => {
    const memory = macBook("normal");
    const resources = new ComputerResources({
      local: {
        read: async () => ({
          epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
          sequence: 1,
          status: "sampled",
          sampleMs: 250,
          cpu: { logicalCpus: 10, idleFraction: 0.4 },
          memory,
        }),
      },
      work: {
        ask: () => Promise.reject(new Error("No other computer is paired.")),
        inReach: () => false,
        version: () => undefined,
        onWorkDevice: () => () => {},
      } as unknown as WorkDevices,
      now: () => 1_000,
    });
    const reading = await resources.refresh(null);
    expect(reading).toMatchObject({
      status: "fresh",
      memoryUsedBytes: memoryUsedBytes(memory),
    });
    resources.dispose();
  });
});
