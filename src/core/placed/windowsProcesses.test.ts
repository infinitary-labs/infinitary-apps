import { describe, expect, it } from "vitest";
import { groupsFromJobs } from "./windowsProcesses";

// Windows has no process groups, so a program's group is the smallest job the
// app made that holds it (INF-4253). Numbers are shaped like the Windows live
// proof's: a crewmate shell 15884 led a job, and a heavy run it started, led by
// 16020, leads a job made later inside it, which also holds the run's 16100.
describe("each Windows program's group from the app's jobs", () => {
  it("puts a heavy run's programs in the run's job, inside its shell's", () => {
    const groups = groupsFromJobs(
      new Map([
        [15884, [15884, 16020, 16100]],
        [16020, [16020, 16100]],
      ]),
    );
    expect(Object.fromEntries(groups)).toEqual({ 15884: 15884, 16020: 16020, 16100: 16020 });
  });

  it("gives the later job a tie, once the shell that led the outer one has ended", () => {
    // The shell ended and the jobs now list the same programs; the run's job,
    // made later, is the inner one, so the run's line still finds its group.
    const groups = groupsFromJobs(
      new Map([
        [15884, [16020, 16100]],
        [16020, [16020, 16100]],
      ]),
    );
    expect(Object.fromEntries(groups)).toEqual({ 16020: 16020, 16100: 16020 });
  });
});
