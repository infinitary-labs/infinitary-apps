import { describe, expect, it } from "vitest";
import { macBookResourcesView } from "./macBookResourceReading";
import { panelComputerResources, validMemoryUsedBytes } from "./resources";

describe("panelComputerResources", () => {
  it("gives a panel installed memory, the figure and pressure, and no raw counts", () => {
    const projected = panelComputerResources(macBookResourcesView);
    const fresh = projected.computers[0]?.reading;
    expect(fresh).toEqual({
      status: "fresh",
      ageMs: 40,
      memoryUsedBytes: 16_436_215_808,
      observation: {
        status: "sampled",
        epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
        sequence: 1,
        sampleMs: 250,
        cpu: { logicalCpus: 10, idleFraction: 0.4 },
        memory: { totalBytes: 25_769_803_776, memoryPressure: "normal" },
      },
    });
    expect(projected.computers[1]?.reading).toEqual({ status: "unknown", reason: "stale" });
  });

  it("omits the figure when the reading has none, rather than reporting zero", () => {
    const first = macBookResourcesView.computers[0];
    if (first?.reading.status !== "fresh") throw new Error("fixture");
    const { memoryUsedBytes: _dropped, ...reading } = first.reading;
    const projected = panelComputerResources({
      computers: [{ ...first, reading }],
    });
    const fresh = projected.computers[0]?.reading;
    expect(fresh?.status).toBe("fresh");
    expect(fresh && "memoryUsedBytes" in fresh).toBe(false);
  });
});

describe("validMemoryUsedBytes", () => {
  it("accepts a figure up to installed memory and refuses one past it", () => {
    expect(validMemoryUsedBytes(100, undefined)).toBe(true);
    expect(validMemoryUsedBytes(100, 100)).toBe(true);
    expect(validMemoryUsedBytes(100, 101)).toBe(false);
  });
});
