import { describe, expect, it } from "vitest";
import { confirmFiles, confirmRound } from "../scripts/batch-confirm.ts";
import { legacyJobName } from "../scripts/ci-job-names.mjs";
import { RUNS_DIR } from "./e2e/runEvidence.ts";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows.ts";

// INF-2430 piece 3, the captain's approved plan for the swept batch, which
// since INF-3759's piece 3 runs on a batch pull request's own version
// (docs/testing.md, "The swept batch"). What the batch's checks run is held
// here, with main's sort of a push; how a batch pull request starts them,
// and how main's sort and the alpha's proof read its run, is held in
// tests/batch-pull.test.ts. The version is the rehearsal batch pull
// request's own.
const head = "12838aded2b76867210c8e5b58cbdc45c69794c8";
const inputs = { trigger: "Merge batch", head };

type Job = {
  if?: string;
  name?: string;
  uses?: string;
  needs?: unknown;
  "runs-on"?: string;
  with?: Record<string, unknown>;
  steps?: {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
  }[];
};
const workflow = (path: string) =>
  loadYamlFile(path) as {
    on: Record<string, { inputs?: Record<string, unknown> } | null>;
    jobs: Record<string, Job>;
  };
const MAC_QUEUES = JSON.stringify({
  split: "mini-mac-split",
  release_split: "mini-mac-release-split",
});

describe("batch-checks.yml", () => {
  const batch = workflow(".github/workflows/batch-checks.yml");

  it("sweeps with every journey, PC test groups and the Mac lanes on the release split line", () => {
    const sweep = batch.jobs.sweep!;
    expect(sweep.uses).toBe("./.github/workflows/verify.yml");
    expect(sweep.with).toMatchObject({
      hosted: true,
      fleet_tests: true,
      all_journeys: true,
      profile: "stable",
    });
    expect(workflowString(String(sweep.with!.ref), { inputs })).toBe(head);
    // The captain on INF-2508: "Keep every journey in the batch, and let an
    // alpha reuse them". The sweep calls the whole check, never a part, so
    // its journeys are there for the alpha to reuse.
    expect(sweep.with!.part).toBeUndefined();
    // INF-2779: the full check's three Mac jobs share one kind.
    expect(workflowString(String(sweep.with!.mac_runner), { vars: { MAC_QUEUES } })).toBe(
      "mini-mac-release-split",
    );
    expect(Object.values(batch.jobs).some((job) => job.uses?.endsWith("/phone.yml"))).toBe(false);
  });

  // INF-2507, and the captain on INF-2508: "the e2e journey + browser tests
  // should all run during the sweep batch". The critical path runs on the
  // batch's version in a job of its own, so it stays in the batch's check
  // whatever part of the full check the sweep runs; it is the same journey
  // every change that builds the app runs (ci.yml's critical-path step,
  // INF-2915).
  it("runs the critical path on the batch's version, on hosted Linux, in a job of its own", () => {
    const job = batch.jobs["critical-path"];
    const sweep = batch.jobs.sweep;
    const change = workflow(".github/workflows/ci.yml").jobs["typecheck-lint-build"]?.steps?.find(
      (step) => step.id === "critical-path",
    );
    expect(job?.uses).toBe("./.github/workflows/source-journeys.yml");
    expect(job?.with).toMatchObject({
      ref: sweep?.with?.ref,
      hosted: true,
      suite: "affected",
      lane: "desktop",
      files: "tests/e2e/critical-path.spec.ts",
    });
    expect(change?.run).toContain(`--files ${job?.with?.files} `);
    expect(change?.run).toContain("-- --project=desktop");
    const journeys = workflow(".github/workflows/source-journeys.yml").jobs["source-desktop"] as {
      "runs-on": string;
    };
    const vars = { LINUX_RUNNER: "shell-pc-linux" };
    expect(workflowString(journeys["runs-on"], { inputs: job?.with, vars })).toBe("ubuntu-24.04");
  });

  // The captain's pick on INF-3052, "In the batch check, beside the
  // critical-path journey": the startup fixtures run on the batch's version,
  // so they run before a merge.
  it("runs the Linux startup fixtures on the batch's version, on hosted Ubuntu", () => {
    const job = batch.jobs.startup!;
    expect(job.uses).toBe("./.github/workflows/linux-startup.yml");
    expect(job.with!.ref).toBe(batch.jobs.sweep!.with!.ref);
    const fixtures = workflow(".github/workflows/linux-startup.yml").jobs["runtime-facts"]!;
    expect(fixtures["runs-on"]).toBe("ubuntu-24.04");
    // The fixtures run on exactly the commit their caller names.
    const checkout = fixtures.steps!.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    expect(workflowString(String(checkout.with!.ref), { inputs: { ref: head } })).toBe(head);
  });
});

// The captain's pick on INF-3012, "A only: the confirm step": when a check
// fails, only the failed test files run again in the same run, three rounds,
// on the platform whose job failed. The files are ones this repository's
// sweeps failed.
describe("the batch's confirm", () => {
  const batch = workflow(".github/workflows/batch-checks.yml");
  const groupConfirm = workflow(".github/workflows/verify.yml").jobs["linux-tests-confirm"]!;
  const groups = (groupConfirm as { strategy: { matrix: { group: string[] } } }).strategy.matrix
    .group;

  it("confirms on the machines the sweep took, beside each Linux test group and after the checks", () => {
    const vars = { MAC_QUEUES };
    const runsOn = String(batch.jobs["confirm-later"]!["runs-on"]);
    expect(workflowString(runsOn, { matrix: { platform: "mac" }, vars })).toBe(
      "mini-mac-release-split",
    );
    expect(workflowString(runsOn, { matrix: { platform: "linux" }, vars })).toBe("ubuntu-24.04");
    // A Linux test group's own confirm, on the hosted Linux the batch's test groups take.
    expect(groupConfirm["runs-on"]).toBe("ubuntu-24.04");
  });

  // INF-3937: a failure that shows only in the confirm (a batch run's Mac
  // confirm, whose log named a trace, a picture and an error context the
  // machine took with it) has to be readable from the run, as the sweep's
  // journey jobs keep theirs (docs/testing.md, "The swept batch"). Both
  // confirms run the batch-confirm action in the checkout it names.
  it("keeps a failed round's result directories on the run, under a name of each platform's own", () => {
    const action = loadYamlFile(".github/actions/batch-confirm/action.yml") as {
      runs: { steps: (NonNullable<Job["steps"]>[number] & { "working-directory"?: string })[] };
    };
    const steps = action.runs.steps;
    const rounds = steps.find((step) => step.run?.includes("scripts/batch-confirm.ts"))!;
    const kept = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    const keeps = (outcome: string) =>
      workflowValue(
        kept.if!,
        { steps: { [rounds.id!]: { outcome } } },
        {
          success: outcome !== "failure",
          failure: outcome === "failure",
          always: true,
          cancelled: false,
        },
      );
    expect(["success", "failure", "skipped"].map(keeps)).toEqual([false, true, false]);
    // Each Playwright run's directory, where a failed journey's trace,
    // picture and error context land, sits inside the kept folder.
    const runs = `${rounds["working-directory"]}/${RUNS_DIR}/`;
    expect(runs.startsWith(String(kept.with!.path)), runs).toBe(true);
    for (const job of [batch.jobs["confirm-later"]!, groupConfirm]) {
      const checkout = job.steps!.find((step) => step.with?.path)!;
      expect(checkout.with!.path).toBe(rounds["working-directory"]);
    }
    // The confirms run in the batch's own run beside the sweep, whose Mac
    // lanes keep their own failures, and an artifact's name is the run's
    // once.
    const later = batch.jobs["confirm-later"]!.steps!.at(-1)!;
    const names = [
      ...["linux", "mac"].map((platform) =>
        workflowString(String(later.with!.artifact), { matrix: { platform } }),
      ),
      ...groups.map((_, index) =>
        workflowString(String(groupConfirm.steps!.at(-1)!.with!.artifact), {
          strategy: { "job-index": index },
        }),
      ),
    ];
    const lanes = workflow(".github/workflows/verify.yml").jobs.lane!.steps!.filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const sweepNames = ["linux-checks", "mac", "parallel", "desktop"].flatMap((lane) =>
      lanes.map((step) =>
        workflowString(String(step.with!.name), {
          matrix: { lane },
          inputs: { all_journeys: true },
        }),
      ),
    );
    expect(sweepNames).toContain("e2e-failures-mac");
    expect(names).toContain("confirm-later-failures-mac");
    expect(new Set([...names, ...sweepNames]).size).toBe(names.length + new Set(sweepNames).size);
  });

  it("finds each failed file as the logs name it, and runs Vitest files and journeys by their lanes", () => {
    const files = confirmFiles([
      "src/core/freeze/freezeRecorder.integration.test.ts",
      "knowledge-references.spec.ts",
    ]);
    expect(files).toEqual([
      "src/core/freeze/freezeRecorder.integration.test.ts",
      "tests/e2e/knowledge-references.spec.ts",
    ]);
    expect(() => confirmFiles(["tests/gone.test.ts"])).toThrow(/not in the batch's version/);
    const round = confirmRound(files, ["--workers=4"]);
    expect(round[0]).toEqual(["test", "src/core/freeze/freezeRecorder.integration.test.ts"]);
    expect(round[1]).toContain("--project=desktop");
    expect(round[2]).toEqual(
      expect.arrayContaining(["--project=application", "--workers=4", "--retries", "0"]),
    );
    expect(
      round
        .slice(1)
        .every((command) => command.at(-1) === "tests/e2e/knowledge-references.spec.ts"),
    ).toBe(true);
    expect(confirmRound(["src/core/freeze/freezeRecorder.integration.test.ts"])).toHaveLength(1);
  });
});

describe("main.yml's sort", () => {
  const main = workflow(".github/workflows/main.yml");
  const needs = (kind: string, result = "success") => ({
    needs: { sort: { result, outputs: { kind, batch: "41600000001" } } },
  });
  const runs = (id: "verify" | "startup", kind: string, result?: string) =>
    workflowValue(main.jobs[id]!.if!, needs(kind, result), {
      success: true,
      failure: false,
      always: true,
      cancelled: false,
    });

  it("runs the full check and the startup fixtures unless the push is covered", () => {
    for (const id of ["verify", "startup"] as const) {
      expect(runs(id, "full"), id).toBe(true);
      expect(runs(id, "covered"), id).toBe(false);
      // A sort that failed leaves the full check to run.
      expect(runs(id, "", "failure"), id).toBe(true);
    }
  });

  it("names the covering batch run in a job of its own", () => {
    const covered = main.jobs.covered!;
    expect(workflowValue(covered.if!, needs("covered"))).toBe(true);
    expect(workflowValue(covered.if!, needs("full"))).toBe(false);
    const name = workflowString(covered.name!, {
      ...needs("covered"),
      github: { event_name: "push" },
    });
    expect(name).toBe("Main push · Covered by batch run 41600000001");
    expect(legacyJobName(name)).toBe("covered by batch 41600000001");
  });
});
