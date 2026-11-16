/**
 * The home's record of the jobs a close kept running, and which closes keep
 * them (INF-4381's approved plan, piece 1, done criteria 3 and 4, and the
 * captain's answer that a discarded task's job is removed;
 * docs/leftover-programs.md, "A job the captain asked to keep").
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import {
  KEEPING_CLOSES,
  keepsAtClose,
  type LeftoversReport,
  leftoversLine,
} from "@shared/leftoverPrograms";
import { taskClosedReasonSchema } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { KEPT_JOBS_FILE, keptJobsAt } from "./keptJobs";
import { keptRoot } from "./taskStops";

const JOB = {
  id: "s2",
  label: "nightly photo backup",
  check: "systemctl --user is-active photo-backup.timer",
  remove: "systemctl --user disable --now photo-backup.timer",
  folder: "/home/someone/.config/infinitary/kept/task-7-s2",
  account: "someone",
};

describe("kept jobs", () => {
  it("keeps at a merge, release or answer, and removes at a discard, cancel or failure", () => {
    const keeping = taskClosedReasonSchema.options.filter(
      (reason) => keepsAtClose(reason) === "keep",
    );
    expect(keeping).toEqual([...KEEPING_CLOSES]);
    for (const reason of ["discarded", "cancelled", "failed", "superseded"] as const)
      expect(keepsAtClose(reason)).toBe("remove");
    // A close whose reason is unknown keeps nothing the captain did not take.
    expect(keepsAtClose(null)).toBe("remove");
  });

  it("records each kept job once, readable only by the user, by computer and folder", () => {
    const tasksDir = join(scratchDir("infinitary-kept-jobs-"), "crewmates");
    const record = keptJobsAt(tasksDir, () => 1_700_000_000_000);
    expect(record.list()).toEqual([]);
    expect(record.record([JOB], { computer: null, task: "task-7", key: "INF-7" })).toHaveLength(1);
    // The same close order answered again carries the same job.
    expect(record.record([JOB], { computer: null, task: "task-7", key: "INF-7" })).toEqual([]);
    // The same folder on a computer that runs work is another job.
    record.record([JOB], { computer: "device-mini", task: "task-8", key: "INF-8" });
    const file = join(keptRoot(tasksDir), KEPT_JOBS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A restart reads the same file.
    expect(keptJobsAt(tasksDir).list()).toEqual([
      {
        computer: null,
        account: JOB.account,
        label: JOB.label,
        check: JOB.check,
        remove: JOB.remove,
        folder: JOB.folder,
        task: "task-7",
        key: "INF-7",
        at: 1_700_000_000_000,
      },
      expect.objectContaining({ computer: "device-mini", task: "task-8", key: "INF-8" }),
    ]);
  });

  it("names each kept, removed and handed-on job on the close's one line", () => {
    const base: LeftoversReport = { stops: [], programs: [], holders: "checked" };
    expect(leftoversLine({ ...base, kept: [JOB] })).toBe(
      'At close: job "nightly photo backup" keeps running.',
    );
    expect(
      leftoversLine({
        ...base,
        stops: [{ label: "scratch machine", outcome: "ran" }],
        removed: [
          { label: "nightly photo backup", outcome: "ran" },
          { label: "hourly sync", outcome: "failed", exitCode: 3 },
        ],
      }),
    ).toBe(
      'Leftovers at close: stop "scratch machine" ran; job "nightly photo backup" was removed; job "hourly sync" could not be removed (exit 3).',
    );
    expect(leftoversLine({ ...base, handedTo: "INF-9", handedKeeps: 2 })).toBe(
      "Leftovers at close: its 2 kept jobs went to INF-9.",
    );
  });
});
