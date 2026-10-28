import { describe, expect, it } from "vitest";
import { linuxSwapFromMeminfo, macSwapFromSysctl, withMacMemoryFacts } from "./resourceMemory";

// INF-1621: swap occupancy is a separate physical observation, never an installed-memory allowance.
describe("swap occupancy", () => {
  it("reads this Mac's zero-swap response without mistaking an unavailable response for zero", () => {
    expect(macSwapFromSysctl("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\n")).toBe(0);
    expect(macSwapFromSysctl("unavailable")).toBeUndefined();
    const base = { totalBytes: 24 * 1024 ** 3, freeBytes: 15979 * 16384 };
    // The MacBook in the accepted plan held 6.3 GB swap; it need not fit installed free memory.
    expect(
      withMacMemoryFacts(base, { swapUsedBytes: 6.3 * 1024 ** 3 }).swapUsedBytes,
    ).toBeUndefined();
    const swapUsedBytes = macSwapFromSysctl(
      "total = 7372.80M used = 6451.20M free = 921.60M (encrypted)",
    );
    expect(withMacMemoryFacts(base, { swapUsedBytes }).swapUsedBytes).toBe(swapUsedBytes);
  });

  it("keeps Linux KiB distinct from Mac MiB and rejects inverted or missing counters", () => {
    const noSwap = "SwapTotal:             0 kB\nSwapFree:              0 kB\n";
    expect(linuxSwapFromMeminfo(noSwap)).toBe(0);
    expect(linuxSwapFromMeminfo("SwapFree: 0 kB")).toBeUndefined();
    expect(linuxSwapFromMeminfo("SwapTotal: 0 kB\nSwapFree: 1 kB\n")).toBeUndefined();
  });
});
