import { describe, expect, it } from "vitest";
import { jobCores } from "../scripts/job-cores.ts";

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
