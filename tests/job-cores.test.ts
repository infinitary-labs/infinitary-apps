import { describe, expect, it } from "vitest";
import { ciJourneyWorkers, journeyRunNeeds } from "../scripts/heavy-run-place.ts";
import { inMemoryWorkers, jobCores, TEST_PROCESS_MEMORY_BYTES } from "../scripts/job-cores.ts";
import { E2E_MAX_WORKERS } from "./e2e/lanes.ts";

// A compute Mac's Linux guest's own readings: 11 cores and 9,065 MiB of
// memory with no swap (INF-5103).
const GUEST = { cores: 11, memoryBytes: 9065 * 1024 ** 2 };
// This Mac mini's own readings: 14 cores and 64 GiB.
const MAC_MINI = { cores: 14, memoryBytes: 64 * 1024 ** 3 };

// INF-2112: a check's test workers count the job's own size, which the Mac
// mini's placement service names, and the whole machine where it names none.
describe("jobCores", () => {
  it("counts the job's named size", () => {
    expect(jobCores({ RUNNER_UP_CORES: "12" }, 14)).toBe(12);
    expect(jobCores({ RUNNER_UP_CORES: "2" }, 14)).toBe(2);
  });

  it("counts the whole machine where no usable size is named", () => {
    for (const named of [undefined, "", "0", "-4", "2.5", "twelve"]) {
      expect(jobCores(named === undefined ? {} : { RUNNER_UP_CORES: named }, 14)).toBe(14);
    }
  });
});

describe("inMemoryWorkers", () => {
  // INF-5103, the bug a compute Mac's Linux guest found: a worker per core but
  // one started ten in-memory workers there, and one died in the middle of
  // src/core/placed/pressureLeftovers.test.ts; the same files with ten workers
  // peaked at 11.2 GiB on a Mac. The guest's own readings stand in for the computer.
  it("starts no more workers than the computer's memory holds beside Vitest's own process", () => {
    const workers = inMemoryWorkers(GUEST);
    expect((workers + 1) * TEST_PROCESS_MEMORY_BYTES).toBeLessThanOrEqual(GUEST.memoryBytes);
    expect(workers).toBeLessThan(GUEST.cores - 1);
    expect(workers).toBeGreaterThan(1);
  });

  it("keeps a worker per core but one where memory is no bound", () => {
    expect(inMemoryWorkers(MAC_MINI)).toBe(13);
  });
});

describe("ciJourneyWorkers", () => {
  // INF-5216, the bug the same guest found: by cores alone a journey request
  // started ten workers there, which need 15.5 GiB at the measured share each.
  // The guest ran out of memory, and knowledge-gate.spec.ts and
  // device-sign-ins.spec.ts failed waiting on frames and timers that stalled.
  it("starts no more journey workers than the job's memory holds beside the runner", () => {
    const workers = ciJourneyWorkers({ ...GUEST, most: E2E_MAX_WORKERS });
    const needs = (count: number) => journeyRunNeeds(count).memoryMib * 1024 ** 2;
    expect(needs(workers)).toBeLessThanOrEqual(GUEST.memoryBytes);
    expect(needs(workers + 1)).toBeGreaterThan(GUEST.memoryBytes);
    expect(workers).toBeLessThan(Math.min(E2E_MAX_WORKERS, GUEST.cores));
  });

  it("keeps a worker per core up to the most where memory is no bound", () => {
    expect(ciJourneyWorkers({ ...MAC_MINI, most: E2E_MAX_WORKERS })).toBe(
      Math.min(E2E_MAX_WORKERS, MAC_MINI.cores),
    );
  });
});
