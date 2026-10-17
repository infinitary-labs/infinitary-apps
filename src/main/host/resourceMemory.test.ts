import { describe, expect, it } from "vitest";
import { macPagesFromVmStat, macPressureFromSysctl, withMacMemoryFacts } from "./resourceMemory";

/**
 * INF-213: the 4:10:05 PM vm_stat of this MacBook, page size 16 KiB as vm_stat
 * prints it. The saved sample omitted that header line; the parser reads it.
 */
const MACBOOK_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    15979.
Pages active:                                 566399.
Pages inactive:                               553134.
Pages speculative:                             13408.
Pages wired down:                             223532.
Pages purgeable:                               18976.
File-backed pages:                            265899.
`;

const electron = {
  totalBytes: 24 * 1024 ** 3,
  freeBytes: 15_979 * 16_384,
  purgeableBytes: 18_976 * 16_384,
  fileBackedBytes: 265_899 * 16_384,
};

describe("macOS memory facts from the real 4:10:05 PM reading", () => {
  it("reads inactive and speculative pages, and keeps Electron's facts when the system read fails", () => {
    expect(macPagesFromVmStat(MACBOOK_VM_STAT)).toEqual({
      inactiveBytes: 553_134 * 16_384,
      speculativeBytes: 13_408 * 16_384,
    });
    expect(macPressureFromSysctl("1\n")).toBe("normal");
    expect(macPressureFromSysctl("2")).toBe("warning");
    expect(macPressureFromSysctl("4")).toBe("critical");
    expect(macPressureFromSysctl("8")).toBe("critical");
    expect(withMacMemoryFacts(electron, null)).toEqual(electron);
    expect(
      withMacMemoryFacts(electron, {
        inactiveBytes: 553_134 * 16_384,
        speculativeBytes: 13_408 * 16_384,
        memoryPressure: "normal",
      }).inactiveBytes,
    ).toBe(553_134 * 16_384);
  });
});
