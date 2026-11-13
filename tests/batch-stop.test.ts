import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODE_CHECKS, codeChecksState, WATCH, watch } from "../scripts/batch-stop.mjs";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows.ts";

// The captain's pick on INF-3925: "Stop a batch at its first code-check
// failure, in both today's batch checks and the per-person batch checks"
// (docs/testing.md, "The swept batch"). The reading is the shipped queue's
// batch run 839 as GitHub listed its jobs: its code checks failed at
// 09:10:20, four minutes in, and the run went on until 09:49.
type RecordedJob = {
  name: string;
  created_at: string;
  started_at: string;
  completed_at: string | null;
  conclusion: string | null;
};
const run839 = JSON.parse(
  readFileSync(new URL("./fixtures/batch-stop/queue-run-839.json", import.meta.url), "utf8"),
) as RecordedJob[];

/** The run's jobs as GitHub listed them at `time`: created, then queued, running or ended. */
const readingAt = (time: string) =>
  run839
    .filter((job) => job.created_at <= time)
    .map((job) => ({
      name: job.name,
      status:
        job.completed_at && job.completed_at <= time
          ? "completed"
          : job.started_at <= time
            ? "in_progress"
            : "queued",
      conclusion: job.completed_at && job.completed_at <= time ? job.conclusion : null,
    }));
const codeChecks = run839.find((job) => job.name.endsWith(CODE_CHECKS))!;

describe("the code checks' watch", () => {
  it("reads batch run 839's code checks as failed when they failed, with the journeys still running", () => {
    expect(codeChecks.completed_at).toBe("2026-11-12T09:10:20Z");
    expect(codeChecksState(readingAt("2026-11-12T09:06:40Z"))).toBe("running");
    expect(codeChecksState(readingAt("2026-11-12T09:10:19Z"))).toBe("running");
    const failed = readingAt("2026-11-12T09:10:20Z");
    expect(codeChecksState(failed)).toBe("failed");
    // What the stop saves: every journey and the Mac jobs had not ended.
    expect(failed.filter((job) => job.status !== "completed").length).toBeGreaterThan(15);
  });

  it("lets a batch whose code checks passed run on", () => {
    const passedRun = readingAt("2026-11-12T09:12:00Z").map((job) =>
      job.name.endsWith(CODE_CHECKS) ? { ...job, conclusion: "success" } : job,
    );
    expect(codeChecksState(passedRun)).toBe("passed");
  });

  it("ends a watch on a run with no code checks only once nothing else runs", () => {
    const withoutChecks = (time: string) =>
      readingAt(time).filter((job) => !job.name.endsWith(CODE_CHECKS));
    const watching = {
      name: `Batch checks / Merge batch${WATCH}`,
      status: "in_progress",
      conclusion: null,
    };
    expect(codeChecksState([...withoutChecks("2026-11-12T09:20:00Z"), watching])).toBe("running");
    expect(codeChecksState([...withoutChecks("2026-11-12T09:50:00Z"), watching])).toBe("absent");
  });

  it("names the failure once the code checks fail, reading again past a refused reading", async () => {
    const times = [
      "2026-11-12T09:06:40Z",
      "refused",
      "2026-11-12T09:09:00Z",
      "2026-11-12T09:10:30Z",
    ];
    const outputs: Record<string, string> = {};
    const warnings: string[] = [];
    let reads = 0;
    const github = {
      rest: { actions: { listJobsForWorkflowRun: "jobs" } },
      paginate: async (_method: string, request: { run_id: number; filter: string }) => {
        expect(request).toMatchObject({ run_id: 43188445742, filter: "latest" });
        const time = times[reads++]!;
        if (time === "refused") throw new Error("Server Error");
        return readingAt(time);
      },
    };
    await watch({
      github,
      context: { repo: { owner: "infinitary-labs", repo: "infinitary" }, runId: 43188445742 },
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
        notice: () => {},
        warning: (words: string) => warnings.push(words),
      },
      everySeconds: 0,
    });
    expect(reads).toBe(4);
    expect(warnings).toHaveLength(1);
    expect(outputs).toEqual({ code_checks: "failure" });
  });
});

type Job = {
  if?: string;
  name?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  strategy?: { matrix: Record<string, unknown> };
  steps?: { run?: string; with?: Record<string, string> }[];
};
const jobsOf = (file: string) =>
  (loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> }).jobs;
const github = { run_id: "43188445742", run_attempt: "1" };
const lead = `batch-stop-${github.run_id}-${github.run_attempt}-`;

/** Every concurrency group a job takes across its matrix, for the inputs its caller passes. */
function groups(job: Job, inputs: Record<string, unknown>): string[] {
  const matrix = job.strategy!.matrix;
  const value = (raw: unknown) =>
    typeof raw === "string" && raw.includes("${{") ? workflowValue(raw, { inputs }) : raw;
  const entries = matrix.include
    ? (value(matrix.include) as Record<string, unknown>[])
    : (value(matrix.lane) as string[]).map((lane) => ({ lane }));
  return entries.map((entry) =>
    workflowString(job.concurrency!.group, { github, inputs, matrix: entry }),
  );
}

// Both batch check files: the shipped queue's (in its own run and in its
// confirm) and a batch pull request's.
describe.each([
  {
    file: "infinitary-batch-checks.yml",
    inputs: { failed_jobs: "" },
    confirm: {
      failed_jobs: "Merge batch · Desktop checks / Merge batch · Parallel journeys (Mac)",
    },
  },
  { file: "batch-checks.yml", inputs: { trigger: "Merge batch" }, confirm: undefined },
])("$file stops at a failed code check", ({ file, inputs, confirm }) => {
  const jobs = jobsOf(file);

  it("stops every job of the sweep but its code checks, each through that job's own concurrency group", () => {
    const sweep = jobs.sweep!;
    expect(sweep.uses).toBe("./.github/workflows/verify.yml");
    const verify = jobsOf("verify.yml");
    const sweepInputs = { trigger: "Merge batch", ...sweep.with } as Record<string, unknown>;
    const journeys = verify["linux-e2e"]!;
    expect(journeys.uses).toBe("./.github/workflows/source-journeys.yml");
    const sweepGroups = [
      ...groups(verify.lane!, sweepInputs),
      ...groups(verify["linux-tests"]!, sweepInputs),
      ...groups(jobsOf("source-journeys.yml")["source-desktop"]!, {
        "artifact-suffix": "source",
        ...journeys.with,
      }),
    ];
    // Each group is this run attempt's own, so no other run is stopped, and
    // no two jobs share one.
    for (const group of sweepGroups) expect(group.startsWith(lead), group).toBe(true);
    expect(new Set(sweepGroups).size).toBe(sweepGroups.length);
    const stop = jobs.stop!;
    expect(stop.concurrency!["cancel-in-progress"]).toBe(true);
    const stopped = (stop.strategy!.matrix.job as string[]).map((job) =>
      workflowString(stop.concurrency!.group, { github, inputs, matrix: { job } }),
    );
    expect(stopped.sort()).toEqual(
      sweepGroups.filter((group) => group !== `${lead}verify-lane-linux-checks`).sort(),
    );
    // A stop never cancels a whole called check: GitHub then ends the batch
    // cancelled, which the queue reads as no verdict.
    for (const id of ["sweep", "critical-path", "startup"])
      expect(jobs[id]!.concurrency, id).toBeUndefined();
  });

  it("stops only after failed code checks", () => {
    const stop = jobs.stop!;
    expect(stop.needs).toBe("watch");
    const runs = (code_checks: string) =>
      workflowValue(stop.if!, {
        inputs,
        needs: { watch: { result: "success", outputs: { code_checks } } },
      });
    expect(runs("failure")).toBe(true);
    expect(runs("success")).toBe(false);
    expect(runs("")).toBe(false);
    expect(workflowString(stop.name!, { inputs, matrix: { job: "verify-lane-mac" } })).toBe(
      "Merge batch · Stop after failed code checks (verify-lane-mac)",
    );
  });

  it("watches with the batch-stop script, and never fails the batch by watching", () => {
    const watcher = jobs.watch!;
    expect(watcher["continue-on-error"]).toBe(true);
    expect(workflowString(watcher.name!, { inputs }).endsWith(WATCH)).toBe(true);
    expect(watcher.steps![0]!.with!["sparse-checkout"]).toBe("scripts/batch-stop.mjs");
    if (confirm) {
      expect(workflowValue(watcher.if!, { inputs: confirm })).toBe(false);
      expect(workflowValue(watcher.if!, { inputs })).toBe(true);
    }
  });
});
