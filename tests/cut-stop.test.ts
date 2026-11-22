import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  cut,
  cutFailures,
  cutState,
  STOP_CUT,
  UPLOAD,
  WATCH,
  watch,
} from "../scripts/batch-stop.mjs";
import { runJobs } from "./helpers/ciJobNames.ts";
import {
  githubScript,
  loadYamlFile,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows.ts";
import { scratchDir } from "./helpers/scratchDirs.ts";

// INF-6038's approved plan: an alpha cut, rehearsals included, stops at its
// first failed job (docs/alpha.md, "Failed alpha checks"). The readings are
// two cuts as GitHub listed their jobs. The cut from main run 19 failed at
// 12:13:08, when its Linux serial journey group 2/3 failed 36 minutes in,
// and ran on until 14:30:10, its signed installer check the last to end. The
// cut from main run 22 passed and published.
type RecordedJob = {
  name: string;
  created_at: string;
  started_at: string;
  completed_at: string | null;
  conclusion: string | null;
};
const recorded = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/batch-stop/${file}`, import.meta.url), "utf8"),
  ) as RecordedJob[];
const run19 = recorded("alpha-run-19.json");
const run22 = recorded("alpha-run-22.json");

const trigger = "Automatic alpha";
const watching = {
  name: `${trigger}${WATCH}`,
  status: "in_progress",
  conclusion: null,
  completed_at: null,
};

/**
 * A cut's jobs as GitHub lists them at `time`, the watch among them: created,
 * then queued, running or ended. A job skipped behind another lists as
 * completed before it started, so it reads as ended once created.
 */
const readingAt = (run: RecordedJob[], time: string) => [
  watching,
  ...run
    .filter((job) => job.created_at <= time)
    .map((job) => {
      const ended = job.completed_at !== null && job.completed_at <= time;
      return {
        name: job.name,
        status: ended ? "completed" : job.started_at <= time ? "in_progress" : "queued",
        conclusion: ended ? job.conclusion : null,
        completed_at: ended ? job.completed_at : null,
      };
    }),
];

/** Runs the watch with the cut's rule over a run's readings every half minute from `from`. */
async function watchCut(run: RecordedJob[], from: string, refused: string[] = []) {
  const outputs: Record<string, string> = {};
  const notices: string[] = [];
  const warnings: string[] = [];
  let time = Date.parse(from);
  let last = "";
  const github = {
    rest: { actions: { listJobsForWorkflowRun: "jobs" } },
    paginate: async (_method: string, request: { run_id: number; filter: string }) => {
      expect(request).toMatchObject({ run_id: 44899938191, filter: "latest" });
      last = new Date(time).toISOString().replace(".000Z", "Z");
      time += 30_000;
      if (refused.includes(last)) throw new Error("Server Error");
      return readingAt(run, last);
    },
  };
  await watch({
    github,
    context: { repo: { owner: "infinitary-labs", repo: "infinitary-apps" }, runId: 44899938191 },
    core: {
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      notice: (words: string) => notices.push(words),
      warning: (words: string) => warnings.push(words),
    },
    everySeconds: 0,
    rule: cut,
  });
  return { outputs, notices, warnings, last };
}

describe("the cut's watch", () => {
  it("stops the cut from main run 19 at its failed journey group, with signing and the signed installer check still running", async () => {
    const failed = run19.find((job) => job.conclusion === "failure")!;
    expect(failed.completed_at).toBe("2026-11-21T12:13:08Z");
    // A reading refused just before the failure is read again.
    const { outputs, warnings, last } = await watchCut(run19, "2026-11-21T11:39:30Z", [
      "2026-11-21T12:12:30Z",
    ]);
    expect(warnings).toHaveLength(1);
    // The first reading after the failure stops it.
    expect(last).toBe("2026-11-21T12:13:30Z");
    expect(outputs).toEqual({ stop: "failed", failed: "App journeys (Linux; serial group 2/3)" });
    // What the stop saves: the run went on until 14:30:10.
    const running = readingAt(run19, last)
      .filter((job) => job.status !== "completed" && !job.name.endsWith(WATCH))
      .map((job) => job.name.split(" · ").at(-1));
    expect(running).toEqual(
      expect.arrayContaining([
        "Build, sign and notarize (Mac)",
        "Build signed test copies (Mac)",
        "Parallel journeys (Mac)",
      ]),
    );
  });

  it("lets the cut from main run 22 run to its upload, and ends once the upload is listed", async () => {
    const { outputs, notices, last } = await watchCut(run22, "2026-11-22T00:15:38Z");
    expect(outputs).toEqual({ stop: "none" });
    expect(notices).toEqual([cut.none]);
    const upload = run22.find((job) => UPLOAD.some((end) => job.name.endsWith(end)))!;
    expect(
      last >= upload.created_at && Date.parse(last) - Date.parse(upload.created_at) < 30_000,
    ).toBe(true);
  });

  it("never stops on the watch, its stops, a cancelled job or a failed upload", () => {
    const reading = readingAt(run22, "2026-11-22T01:20:00Z").map((job) =>
      job.name.endsWith(" · Upload every download")
        ? {
            ...job,
            status: "completed",
            conclusion: "failure",
            completed_at: "2026-11-22T01:20:00Z",
          }
        : job,
    );
    const others = [
      { name: `${trigger}${WATCH}`, status: "completed", conclusion: "failure", completed_at: "x" },
      {
        name: `${trigger}${STOP_CUT}sign)`,
        status: "completed",
        conclusion: "failure",
        completed_at: "x",
      },
      {
        name: `${trigger} · Build, sign and notarize (Mac)`,
        status: "completed",
        conclusion: "cancelled",
        completed_at: "x",
      },
    ];
    expect(cutFailures([...reading, ...others])).toEqual([]);
    // A job that timed out is a failure.
    expect(cutFailures([{ ...others[2]!, conclusion: "timed_out" }])).toEqual([
      "Build, sign and notarize (Mac)",
    ]);
  });

  it("ends a watch on a cut with no upload only once two readings find nothing else running", async () => {
    // Run 19 as it ended, with the skipped upload under its unevaluated name.
    expect(cutState(readingAt(run19, "2026-11-21T14:30:10Z"))).toBe("quiet");
    expect(cutState(readingAt(run19, "2026-11-21T14:00:00Z"))).toBe("running");
    const passing = run19.map((job) => ({
      ...job,
      conclusion: job.conclusion === "failure" ? "success" : job.conclusion,
    }));
    const { outputs, last } = await watchCut(passing, "2026-11-21T14:29:30Z");
    expect(outputs).toEqual({ stop: "none" });
    // Its last job ended at 14:30:09; the readings at 14:30:30 and 14:31:00 find nothing running.
    expect(last).toBe("2026-11-21T14:31:00Z");
  });
});

type Job = {
  if?: string;
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  strategy?: { matrix: { job: string[] } };
  steps?: {
    id?: string;
    if?: string;
    uses?: string;
    run?: string;
    "continue-on-error"?: boolean;
    with?: Record<string, string>;
    env?: Record<string, string>;
  }[];
};
const release = (loadYamlFile(".github/workflows/release.yml") as { jobs: Record<string, Job> })
  .jobs;
// A run from main, as every cut is: the signed installer's build runs only
// for the release workflow on main.
const github_ = {
  event_name: "workflow_dispatch",
  repository: "infinitary-labs/infinitary-apps",
  ref: "refs/heads/main",
  sha: "a".repeat(40),
  workflow_ref: "infinitary-labs/infinitary-apps/.github/workflows/release.yml@refs/heads/main",
  run_id: "44899938191",
  run_attempt: "2",
};
const lead = `batch-stop-${github_.run_id}-${github_.run_attempt}-`;

/** A job's own name, without its callers' or the trigger it leads with. */
const own = (name: string) => name.split(" / ").at(-1)!.replace(`${trigger} · `, "");

/**
 * The cut's jobs that never need a stop, each with why: they end before any
 * stoppable job starts, end in seconds, or never start after a failure.
 */
const EXEMPT: Record<string, string> = {
  "Select source and version": "the watch waits for it",
  "Check compatible phone release": "every stoppable job waits for it",
  "Check release notes": "every stoppable job waits for it",
  "Check release notes · catalog": "every stoppable job waits for it",
  "Check verification request": "ends in seconds, before any lane starts",
  "Watch for a stop": "the watch itself",
  "Upload every download": "starts only once every job before it passed",
  "Check every copy and switch downloads": "starts only once the upload passed",
};

describe("release.yml stops the cut at its first failed job", () => {
  // An automatic alpha that runs every part a cut can: every lane of the
  // full check (as one without reusable proof does), the Windows installer
  // and the signed installer check. A cut that reuses main's proof runs a
  // subset of the same jobs.
  const pass = { result: "success" };
  const jobs = runJobs("release.yml", {
    github: github_,
    inputs: { channel: "alpha", main_run: "44899900000", main_run_number: "19" },
    needs: {
      resolve: {
        ...pass,
        outputs: {
          trigger,
          skip: "false",
          channel: "alpha",
          dry_run: "false",
          verify_required: "true",
          main_journeys: "false",
          main_run: "",
          installer_source: "a".repeat(40),
        },
      },
      ...Object.fromEntries(
        [
          "notes",
          "phone",
          "verify",
          "linux",
          "windows",
          "release",
          "update",
          "signed-installer",
          "upload",
        ].map((id) => [id, pass]),
      ),
      build: { ...pass, outputs: { rounds: "[1]" } },
    },
  }).filter((each) => !own(each.name).startsWith("Stop the cut ("));

  it("gives every job a cut runs but the exempt ones its own stop, which the stop matrix names", () => {
    const stoppable = jobs.filter((each) => !(own(each.name) in EXEMPT));
    // Each exempt job is one the cut runs, so the list never outlives its job.
    const ends = new Set(jobs.map((each) => own(each.name)));
    for (const name of Object.keys(EXEMPT)) expect(ends.has(name), name).toBe(true);
    expect(stoppable.length).toBe(36);
    const groups = stoppable.map((each) => {
      const group = each.job.concurrency?.group;
      expect(group, each.name).toBeDefined();
      const value = workflowString(group!, { ...each.contexts, github: github_ });
      // Its own run attempt's, never another run's, and never cancelling
      // itself: only the stop enters it with cancel-in-progress.
      expect(value.startsWith(lead), each.name).toBe(true);
      expect(each.job.concurrency!["cancel-in-progress"], each.name).toBeUndefined();
      return value;
    });
    expect(new Set(groups).size).toBe(groups.length);
    const stop = release.stop!;
    expect(stop.concurrency!["cancel-in-progress"]).toBe(true);
    const stopped = stop.strategy!.matrix.job.map((job) =>
      workflowString(stop.concurrency!.group, { github: github_, matrix: { job } }),
    );
    expect(stopped.sort()).toEqual(groups.sort());
  });

  // The watch's output `stop`: `failed` on a stop, `none` otherwise.
  const needsFor = (stop: string) => ({
    needs: {
      resolve: { result: "success", outputs: { trigger } },
      watch: {
        result: stop === "failed" ? "failure" : "success",
        outputs: { stop, failed: "App journeys (Linux; serial group 2/3)" },
      },
    },
  });

  it("stops only after a failed job, though the watch that found it failed", () => {
    const stop = release.stop!;
    expect(stop.needs).toEqual(["resolve", "watch"]);
    const runs = (watched: string) => workflowValue(stop.if!, needsFor(watched));
    expect(runs("failed")).toBe(true);
    expect(runs("none")).toBe(false);
    expect(runs("")).toBe(false);
    expect(workflowString(stop.name!, { ...needsFor("failed"), matrix: { job: "sign" } })).toBe(
      `${trigger}${STOP_CUT}sign)`,
    );
  });

  it("watches every run that builds, a rehearsal's too, with the workflow's own script", () => {
    const watcher = release.watch!;
    expect(watcher.needs).toBe("resolve");
    const watches = (skip: string) =>
      workflowValue(watcher.if!, { needs: { resolve: { outputs: { skip } } } });
    expect(watches("false")).toBe(true);
    expect(watches("true")).toBe(false);
    expect(workflowString(watcher.name!, needsFor("none"))).toBe(`${trigger}${WATCH}`);
    expect(watcher.permissions).toEqual({ contents: "read", actions: "read" });
    expect(watcher.outputs).toEqual({
      stop: "${{ steps.watch.outputs.stop }}",
      failed: "${{ steps.watch.outputs.failed }}",
    });
    // Only a stop fails it: a watch that broke passes.
    const [script, fail] = watcher.steps!;
    expect(script!.id).toBe("watch");
    expect(script!["continue-on-error"]).toBe(true);
    const failsOn = (stop: string) =>
      workflowValue(fail!.if!, { steps: { watch: { outputs: { stop } } } });
    expect(failsOn("failed")).toBe(true);
    expect(failsOn("none")).toBe(false);
    expect(failsOn("")).toBe(false);
  });

  it("runs its script on run 19's readings: the workflow's own copy of the cut's rule, which names the failed job", async () => {
    const [script] = release.watch!.steps!;
    const outputs: Record<string, string> = {};
    const asked: unknown[] = [];
    // The first reading after the journey group failed, so the watch stops
    // at once rather than waiting its half minute between readings.
    let time = Date.parse("2026-11-21T12:13:30Z");
    const github = {
      rest: {
        repos: {
          getContent: async (request: unknown) => {
            asked.push(request);
            return {
              data: readFileSync(new URL("../scripts/batch-stop.mjs", import.meta.url), "utf8"),
            };
          },
        },
        actions: { listJobsForWorkflowRun: "jobs" },
      },
      paginate: async () => {
        const at = new Date(time).toISOString().replace(".000Z", "Z");
        time += 30_000;
        return readingAt(run19, at);
      },
    };
    const core = {
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      notice: () => {},
      warning: () => {},
    };
    const temp = scratchDir("infinitary-cut-watch-");
    const context = {
      repo: { owner: "infinitary-labs", repo: "infinitary-apps" },
      runId: 44899938191,
      sha: github_.sha,
    };
    await githubScript(script!.with!.script!, ["github", "context", "core", "process", "require"])(
      github,
      context,
      core,
      { ...process, env: { ...process.env, RUNNER_TEMP: temp } },
      createRequire(import.meta.url),
    );
    expect(asked).toEqual([
      {
        owner: "infinitary-labs",
        repo: "infinitary-apps",
        path: "scripts/batch-stop.mjs",
        ref: github_.sha,
        mediaType: { format: "raw" },
      },
    ]);
    expect(outputs).toEqual({ stop: "failed", failed: "App journeys (Linux; serial group 2/3)" });
  });

  // The captain's careful pick: the signing on the real Mac holds the signing
  // material, and its cleanup must still run when the stop cancels it.
  it("removes the signing keychain after a cancel, by the path the restore creates it at", () => {
    const steps = release.release!.steps!;
    const restore = steps.find((step) => step.id === "developer_id_cert")!;
    const remove = steps.find((step) => step.run?.includes("security delete-keychain"))!;
    expect(remove.if).toBe("always()");
    expect(remove.env!.KEYCHAIN_PATH).toBe(restore.env!.KEYCHAIN_PATH);
    expect(restore.run).toContain(
      'security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"',
    );
    expect(restore.run).not.toMatch(/^\s*KEYCHAIN_PATH=/m);
    expect(steps.at(-1)).toBe(remove);
  });
});
