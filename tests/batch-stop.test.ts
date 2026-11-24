import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { failedLine, roundLine } from "../scripts/batch-confirm.ts";
import {
  CODE_CHECKS,
  codeChecksFailure,
  codeChecksState,
  confirmedAgain,
  failedConfirms,
  runState,
  WATCH,
  watch,
} from "../scripts/batch-stop.mjs";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows.ts";

// The captain's pick on INF-3925: "Stop a batch at its first code-check
// failure, in both today's batch checks and the per-person batch checks"
// (docs/testing.md, "The swept batch"). The reading is a batch run of the
// team queue this project ran then, run 839, as GitHub listed its jobs: its
// code checks failed at 09:10:20, four minutes in, and the run went on until
// 09:49.
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
    // Run 839's reading lists no steps, so the words name the job alone.
    expect(outputs).toEqual({
      stop: "code-checks",
      failed: "Code checks and build (Linux) failed",
    });
  });
});

// INF-4305's finding: a batch whose size check refused one file showed one
// failed code check beside twenty failed stops and nineteen cancelled checks.
// The reading is that batch run as GitHub listed its jobs once it ended.
type ListedJob = {
  name: string;
  status: string;
  conclusion: string | null;
  steps: { name: string; conclusion: string | null }[];
};
const sizeCheckRun = JSON.parse(
  readFileSync(new URL("./fixtures/batch-stop/batch-run-size-check.json", import.meta.url), "utf8"),
) as ListedJob[];

describe("what the stopped batch names", () => {
  it("names the code checks' failed step from the batch run whose size check refused a file", () => {
    expect(codeChecksState(sizeCheckRun)).toBe("failed");
    expect(codeChecksFailure(sizeCheckRun)).toBe(
      'Code checks and build (Linux) failed at "Run pnpm check"',
    );
  });
});

// The captain's pick on INF-5113, "Start now: stop at a failed confirm": a
// confirm that fails again on the test files it named stops the batch, and
// one that named no test file never does. The readings are two batch runs as
// GitHub listed their jobs once they ended, and the tail of each failed
// confirm's log: PR #1790's, whose unit, integration and environment groups
// failed again while its serial journeys, its Mac journeys and its Windows
// check ran on, and PR #1768's, whose test machine dropped out, so its two
// confirms failed naming no test file and its rerun passed.
type BatchJob = RecordedJob & { id: number };
const batchRun = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/batch-stop/${file}`, import.meta.url), "utf8"),
  ) as BatchJob[];
const confirmLogs = JSON.parse(
  readFileSync(new URL("./fixtures/batch-stop/confirm-logs.json", import.meta.url), "utf8"),
) as Record<string, string>;

/**
 * A run's jobs as the watch reads them at `time` under this rule: the watch
 * itself still running, and its stops not created yet, as they wait on it.
 * (The recorded runs' own watch ended once their code checks passed.)
 */
const watchedAt = (run: BatchJob[], time: string) =>
  run
    .filter(
      (job) => job.created_at <= time && !/ · (Stop after|Batch stopped because) /.test(job.name),
    )
    .map((job) => {
      const watching = job.name.endsWith(" · Watch the code checks");
      const ended = !watching && job.completed_at !== null && job.completed_at <= time;
      return {
        id: job.id,
        name: watching ? `Merge batch · Batch checks / Merge batch${WATCH}` : job.name,
        status: ended ? "completed" : job.started_at <= time ? "in_progress" : "queued",
        conclusion: ended ? job.conclusion : null,
      };
    });

/** Runs the watch over a run's readings every half minute from `from`, giving each failed confirm's recorded log. */
async function watchRun(run: BatchJob[], from: string) {
  const outputs: Record<string, string> = {};
  const notices: string[] = [];
  const logsRead: number[] = [];
  let time = Date.parse(from);
  let last = "";
  const github = {
    rest: {
      actions: {
        listJobsForWorkflowRun: "jobs",
        downloadJobLogsForWorkflowRun: async ({ job_id }: { job_id: number }) => {
          logsRead.push(job_id);
          return { data: confirmLogs[String(job_id)]! };
        },
      },
    },
    paginate: async () => {
      last = new Date(time).toISOString().replace(".000Z", "Z");
      time += 30_000;
      return watchedAt(run, last);
    },
  };
  await watch({
    github,
    context: { repo: { owner: "infinitary-labs", repo: "infinitary" }, runId: 1 },
    core: {
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      notice: (words: string) => notices.push(words),
      warning: () => {},
    },
    everySeconds: 0,
  });
  return { outputs, notices, logsRead, last };
}

describe("a confirm that failed again", () => {
  const run1790 = batchRun("batch-run-1790.json");
  const run1768 = batchRun("batch-run-1768.json");

  it("reads the files a confirm's log says failed again, in the lines the confirm prints", () => {
    expect(confirmedAgain(confirmLogs["135365404620"]!)).toEqual([
      "tests/workflow-hygiene.test.ts",
      "src/main/shell.beside.test.ts",
    ]);
    const files = ["tests/workflow-hygiene.test.ts", "src/main/shell.beside.test.ts"];
    const printed = (lines: string[]) =>
      lines.map((line) => `2026-11-19T05:38:54.5277272Z ${line}`).join("\n");
    expect(
      confirmedAgain(printed([roundLine(1, files), roundLine(2, files), failedLine(2)])),
    ).toEqual(files);
    // Three rounds that passed, and a round cut off before it ended, say nothing failed again.
    expect(
      confirmedAgain(printed([roundLine(1, files), roundLine(2, files), roundLine(3, files)])),
    ).toEqual([]);
  });

  it("finds no file in PR #1768's confirms, whose failed jobs' logs named none", () => {
    const failed = failedConfirms(watchedAt(run1768, "2026-11-17T03:00:00Z"));
    expect(failed.map((job) => job.id)).toEqual([133784445832, 133784445795]);
    for (const job of failed) expect(confirmedAgain(confirmLogs[String(job.id)]!)).toEqual([]);
  });

  it("stops PR #1790's batch once its first confirm failed again, with its journeys and Windows check still running", async () => {
    const { outputs, logsRead, last } = await watchRun(run1790, "2026-11-19T05:18:00Z");
    expect(last).toBe("2026-11-19T05:40:00Z");
    expect(outputs).toEqual({
      stop: "confirm",
      failed:
        "Confirm failed Integration tests (Linux; group 1/2) failed again on tests/gitlabMergeReview.test.ts src/core/core.projects.test.ts src/core/placed/placedSignIns.test.ts",
    });
    expect(logsRead).toEqual([135365404593]);
    // What the stop saves: the run went on until 05:51:56.
    const running = watchedAt(run1790, last)
      .filter((job) => job.status !== "completed" && !job.name.endsWith(WATCH))
      .map((job) => job.name.split(" · ").at(-1));
    expect(running).toEqual(
      expect.arrayContaining([
        "App journeys (Linux; serial group 1/3)",
        "Desktop journeys (Mac)",
        "Build the Windows installer",
      ]),
    );
  });

  it("lets PR #1768's batch run to its end, as its confirms named no test file", async () => {
    const { outputs, notices, logsRead, last } = await watchRun(run1768, "2026-11-17T02:01:00Z");
    expect(outputs).toEqual({ stop: "none" });
    expect(logsRead.sort()).toEqual([133784445795, 133784445832]);
    expect(
      notices.filter((words) => words.includes("failed before it ran a test file")),
    ).toHaveLength(2);
    // It ends on the reading that finds the last check job ended.
    const lastJob = run1768.find((job) => job.name.includes(" · Batch passed ("))!;
    expect(
      last >= lastJob.completed_at! &&
        Date.parse(last) - Date.parse(lastJob.completed_at!) < 30_000,
    ).toBe(true);
    expect(runState(watchedAt(run1768, last))).toBe("ended");
  });
});

type Job = {
  if?: string;
  name?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  outputs?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  strategy?: { matrix: Record<string, unknown> };
  steps?: { run?: string; with?: Record<string, string> }[];
};
const jobsOf = (file: string) =>
  (loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> }).jobs;
const github = { run_id: "43188445742", run_attempt: "1" };
const lead = `batch-stop-${github.run_id}-${github.run_attempt}-`;

// verify.yml's parallel journeys are one job on the project's Macs and four
// on GitHub's, which MAC_QUEUES's native kind chooses: a stop covers both.
const placements: Record<string, string>[] = [
  {},
  { MAC_QUEUES: JSON.stringify({ native: "macos-15" }) },
];

function groups(job: Job, inputs: Record<string, unknown>): string[] {
  const matrix = job.strategy!.matrix;
  const value = (raw: unknown, vars: Record<string, string>) =>
    typeof raw === "string" && raw.includes("${{") ? workflowValue(raw, { inputs, vars }) : raw;
  const entries = placements.flatMap((vars) =>
    matrix.include
      ? (value(matrix.include, vars) as Record<string, unknown>[])
      : (value(matrix.lane, vars) as string[]).map((lane) => ({ lane })),
  );
  return [
    ...new Set(
      entries.map((entry) =>
        workflowString(job.concurrency!.group, { github, inputs, matrix: entry }),
      ),
    ),
  ];
}

describe("batch-checks.yml stops at a failed code check", () => {
  const jobs = jobsOf("batch-checks.yml");
  const inputs = { trigger: "Merge batch" };

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
    // The Windows check, when the batch reaches it, stops with the sweep.
    expect(jobs.windows!.uses).toBe("./.github/workflows/windows.yml");
    const windows = jobsOf("windows.yml");
    const windowsGroups = ["build", "check"].map((id) =>
      workflowString(windows[id]!.concurrency!.group, { github, inputs, matrix: { round: 1 } }),
    );
    // Each group is this run attempt's own, so no other run is stopped, and
    // no two jobs share one.
    const stoppable = [...sweepGroups, ...windowsGroups];
    for (const group of stoppable) expect(group.startsWith(lead), group).toBe(true);
    expect(new Set(stoppable).size).toBe(stoppable.length);
    const stop = jobs.stop!;
    expect(stop.concurrency!["cancel-in-progress"]).toBe(true);
    const stopped = (stop.strategy!.matrix.job as string[]).map((job) =>
      workflowString(stop.concurrency!.group, { github, inputs, matrix: { job } }),
    );
    expect(stopped.sort()).toEqual(
      stoppable.filter((group) => group !== `${lead}verify-lane-linux-checks`).sort(),
    );
    // A stop never cancels a whole called check: GitHub then ends the batch
    // cancelled, which is no verdict on it.
    for (const id of ["sweep", "critical-path", "startup", "windows"])
      expect(jobs[id]!.concurrency, id).toBeUndefined();
  });

  // The watch's output `stop`: what it found, or `none`.
  const needsFor = (stop: string) => ({
    watch: { result: "success", outputs: { stop } },
    stop: { result: "success" },
  });

  it("stops only after failed code checks or a confirm that failed again", () => {
    const stop = jobs.stop!;
    expect(stop.needs).toBe("watch");
    const runs = (watched: string) => workflowValue(stop.if!, { inputs, needs: needsFor(watched) });
    expect(runs("code-checks")).toBe(true);
    expect(runs("confirm")).toBe(true);
    expect(runs("none")).toBe(false);
    expect(runs("")).toBe(false);
    const name = (watched: string) =>
      workflowString(stop.name!, {
        inputs,
        needs: needsFor(watched),
        matrix: { job: "verify-lane-mac" },
      });
    expect(name("code-checks")).toBe(
      "Merge batch · Stop after failed code checks (verify-lane-mac)",
    );
    expect(name("confirm")).toBe("Merge batch · Stop after a failed confirm (verify-lane-mac)");
  });

  // INF-4305: the real failure stands out. The stops pass, and one failed job
  // of the batch's own names what failed, so the batch still fails; what each
  // step prints is tests/failure-annotations.test.ts's.
  it("fails one stopped job after the stops, only after a stop", () => {
    const stopped = jobs.stopped!;
    expect(stopped.needs).toEqual(["watch", "stop"]);
    const runs = (watched: string) =>
      workflowValue(stopped.if!, { inputs, needs: needsFor(watched) });
    expect(runs("code-checks")).toBe(true);
    expect(runs("confirm")).toBe(true);
    expect(runs("none")).toBe(false);
    expect(runs("")).toBe(false);
    const name = (watched: string) =>
      workflowString(stopped.name!, { inputs, needs: needsFor(watched) });
    expect(name("code-checks")).toBe("Merge batch · Batch stopped because the code checks failed");
    expect(name("confirm")).toBe("Merge batch · Batch stopped because a confirm failed again");
  });

  it("watches with the batch-stop script, and never fails the batch by watching", () => {
    const watcher = jobs.watch!;
    expect(watcher["continue-on-error"]).toBe(true);
    expect(workflowString(watcher.name!, { inputs }).endsWith(WATCH)).toBe(true);
    expect(watcher.steps![0]!.with!["sparse-checkout"]).toBe("scripts/batch-stop.mjs");
    expect(watcher.outputs).toEqual({
      stop: "${{ steps.watch.outputs.stop }}",
      failed: "${{ steps.watch.outputs.failed }}",
    });
  });
});
