import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compileFunction, constants } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  proveMain,
  verifyBatchEvidence,
  verifyMainEvidence,
} from "../scripts/main-alpha-proof.mjs";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows.ts";

// INF-2259 accepted override: a fully passing rolling-main source becomes an
// alpha without repeating its broad checks. Names, source and identity follow
// main run 41366596692's API reading, less its phone call, which main no
// longer makes (INF-2492). That live run was NOT passing: tests explicitly
// drive completed states to exercise the future handoff protocol.
const source = "6073f484509752eb55ee1b1c85c38b82b4909cc3";
const repository = "infinitary-labs/infinitary";
function completedMain() {
  const run = {
    id: 41366596692,
    run_attempt: 1,
    path: ".github/workflows/main.yml",
    event: "push",
    head_branch: "main",
    head_sha: source,
    status: "completed",
    conclusion: "success",
    head_repository: { full_name: repository },
    repository: { full_name: repository },
    html_url: "https://github.com/infinitary-labs/infinitary/actions/runs/41366596692",
  };
  const names = [
    "verify / linux-checks",
    "verify / mac",
    // INF-2340 (captain's route "alone-at-author"): main's full check runs no
    // run-alone shards, so a complete run is the parallel and desktop shards.
    ...["parallel", "desktop"].flatMap((lane) =>
      [1, 2, 3, 4].map((shard) => `verify / linux-e2e / journeys (${lane} ${shard}/4)`),
    ),
  ];
  const jobs = names.map((name) => ({
    name,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: source,
    status: "completed",
    conclusion: "success",
  }));
  return { run, jobs };
}

describe("exact-main alpha verification inheritance", () => {
  it("inherits complete full-check owners at exactly the alpha source", () => {
    const { run, jobs } = completedMain();
    expect(verifyMainEvidence(run, jobs, repository, source)).toEqual({
      source,
      runId: run.id,
      attempt: run.run_attempt,
      url: run.html_url,
    });
  });

  it("accepts the latest successful per-job executions on the same source after a partial rerun", () => {
    const { run, jobs } = completedMain();
    // GitHub's filter=latest keeps untouched passed jobs at their original
    // attempt; their version is unchanged and their proof is not stale.
    expect(verifyMainEvidence({ ...run, run_attempt: 2 }, jobs, repository, source).source).toBe(
      source,
    );
  });

  it.each(["failure", "cancelled", "skipped", "timed_out"])(
    "refuses %s in any required full-check owner",
    (conclusion) => {
      const { run, jobs } = completedMain();
      jobs.find((job) => job.name === "verify / mac")!.conclusion = conclusion;
      expect(() => verifyMainEvidence(run, jobs, repository, source)).toThrow(
        "every full-check owner",
      );
    },
  );

  // INF-2492 (the captain: "remove phone check from main altogether"): main's
  // run is the desktop check alone, so a run that ended failed has a failed
  // desktop job and never cuts an alpha.
  it("refuses a main run that ended failed", () => {
    const { run, jobs } = completedMain();
    jobs.find((job) => job.name.startsWith("verify / linux-e2e / "))!.conclusion = "failure";
    expect(() =>
      verifyMainEvidence({ ...run, conclusion: "failure" }, jobs, repository, source),
    ).toThrow("rolling-main push");
  });

  it("refuses missing shards, future attempts, different sources and non-main runs", () => {
    const { run, jobs } = completedMain();
    expect(() => verifyMainEvidence(run, jobs.slice(0, -1), repository, source)).toThrow(
      "every full-check owner",
    );
    expect(() =>
      verifyMainEvidence(
        run,
        jobs.map((job) => ({ ...job, run_attempt: 2 })),
        repository,
        source,
      ),
    ).toThrow("completed attempt");
    expect(() =>
      verifyMainEvidence(run, jobs, repository, "aa46269bb969bd40890eb07ace70b28fd00a3de1"),
    ).toThrow("exact source");
    expect(() =>
      verifyMainEvidence({ ...run, event: "workflow_dispatch" }, jobs, repository, source),
    ).toThrow("rolling-main push");
    expect(() =>
      verifyMainEvidence({ ...run, conclusion: "cancelled" }, jobs, repository, source),
    ).toThrow("rolling-main push");
    expect(() =>
      verifyMainEvidence(
        { ...run, head_repository: { full_name: "someone/fork" } },
        jobs,
        repository,
        source,
      ),
    ).toThrow("rolling-main push");
  });
});

// INF-2430 piece 3, the captain's approved plan: "The release run accepts a
// matching batch as its proof, through scripts/main-alpha-proof.mjs." A main
// push whose files are exactly a green batch's runs no full check; main.yml
// names the batch run, and the batch run's verdict job names its tree. The
// tree is source 6073f48's, from git.
const tree = "bdb685323ef83592182b68619173bb710f03440f";
const batchId = 41600000001;
function coveredMain() {
  const { run } = completedMain();
  const names = ["sort", `covered by batch ${batchId}`, "verify", "startup / runtime-facts"];
  const jobs = names.map((name) => ({
    name,
    run_id: run.id,
    run_attempt: 1,
    head_sha: source,
    status: "completed",
    conclusion: name === "verify" ? "skipped" : "success",
  }));
  return { run, jobs };
}
function sweptBatch() {
  const run = {
    id: batchId,
    run_attempt: 2,
    path: ".github/workflows/batch.yml",
    event: "status",
    head_branch: "main",
    head_sha: "aa46269bb969bd40890eb07ace70b28fd00a3de1",
    status: "completed",
    conclusion: "success",
    head_repository: { full_name: repository },
    repository: { full_name: repository },
    html_url: `https://github.com/infinitary-labs/infinitary/actions/runs/${batchId}`,
  };
  const names = [
    "compose",
    "sweep / Validate verification selection",
    "sweep / linux-checks",
    "sweep / mac",
    ...["parallel", "desktop"].flatMap((lane) =>
      [1, 2, 3, 4].map((shard) => `sweep / linux-e2e / journeys (${lane} ${shard}/4)`),
    ),
    `verdict (tree ${tree})`,
  ];
  // The rerun's jobs carry its attempt; the rest keep their first.
  const jobs = names.map((name) => ({
    name,
    run_id: run.id,
    run_attempt: name === "sweep / mac" || name.startsWith("verdict") ? 2 : 1,
    head_sha: run.head_sha,
    status: "completed",
    conclusion: "success",
  }));
  return { run, jobs };
}
function readings(main = coveredMain(), batch = sweptBatch()) {
  return {
    rest: {
      actions: {
        listJobsForWorkflowRun: "jobs",
        getWorkflowRun: async ({ run_id }: { run_id: number }) => {
          expect(run_id).toBe(batch.run.id);
          return { data: batch.run };
        },
      },
      git: {
        getCommit: async ({ commit_sha }: { commit_sha: string }) => {
          expect(commit_sha).toBe(source);
          return { data: { sha: source, tree: { sha: tree } } };
        },
      },
    },
    paginate: async (method: string, parameters: { run_id: number; filter: string }) => {
      expect(method).toBe("jobs");
      expect(parameters.filter).toBe("latest");
      return parameters.run_id === main.run.id ? main.jobs : batch.jobs;
    },
  };
}
const repo = { owner: "infinitary-labs", repo: "infinitary" };

describe("an alpha from a swept batch", () => {
  it("accepts a covered main push by its batch run's full check on the same files", async () => {
    const { run } = coveredMain();
    expect(await proveMain(readings(), repo, run, source)).toEqual({
      source,
      runId: run.id,
      attempt: run.run_attempt,
      url: sweptBatch().run.html_url,
    });
  });

  it("still proves a full main run by its own check", async () => {
    const main = completedMain();
    expect((await proveMain(readings(main), repo, main.run, source)).url).toBe(main.run.html_url);
  });

  it("refuses a batch that swept other files, a rehearsal, or a failed sweep owner", () => {
    const { run, jobs } = sweptBatch();
    expect(verifyBatchEvidence(run, jobs, repository, tree).url).toBe(run.html_url);
    expect(() => verifyBatchEvidence(run, jobs, repository, "0".repeat(40))).toThrow("other files");
    const rehearsal = jobs.map((job) =>
      job.name.startsWith("verdict") ? { ...job, name: `rehearsal (tree ${tree})` } : job,
    );
    expect(() => verifyBatchEvidence(run, rehearsal, repository, tree)).toThrow("other files");
    const red = jobs.map((job) =>
      job.name === "sweep / mac" ? { ...job, conclusion: "failure" } : job,
    );
    expect(() => verifyBatchEvidence(run, red, repository, tree)).toThrow("every full-check owner");
    expect(() =>
      verifyBatchEvidence(
        run,
        jobs.filter((job) => !job.name.includes("desktop 4/4")),
        repository,
        tree,
      ),
    ).toThrow("every full-check owner");
    expect(() =>
      verifyBatchEvidence({ ...run, path: ".github/workflows/verify.yml" }, jobs, repository, tree),
    ).toThrow("successful batch run");
  });

  it("refuses a covered main run with a failed job or at another source", async () => {
    const main = coveredMain();
    const failed = {
      ...main,
      jobs: main.jobs.map((job) => (job.name === "sort" ? { ...job, conclusion: "failure" } : job)),
    };
    await expect(proveMain(readings(failed), repo, failed.run, source)).rejects.toThrow(
      "every job it ran",
    );
    await expect(
      proveMain(readings(), repo, main.run, "aa46269bb969bd40890eb07ace70b28fd00a3de1"),
    ).rejects.toThrow("exact source");
  });
});

type WorkflowStep = {
  id?: string;
  if?: string;
  env?: Record<string, string>;
  with?: { script?: string };
};
const workflow = loadYamlFile(".github/workflows/release.yml");
const jobs = workflow.jobs as Record<string, { if?: string; steps?: WorkflowStep[] }>;
const job = (name: string) => {
  const result = jobs[name];
  if (!result) throw new Error(`No release job ${name}`);
  return result;
};

describe("automatic alpha workflow handoff (INF-2259)", () => {
  it("starts only a completed successful main event, pins that source and inherits its observed full proof", async () => {
    expect((workflow.on as Record<string, unknown>).workflow_run).toEqual({
      workflows: ["main"],
      types: ["completed"],
      branches: ["main"],
    });
    const { run, jobs: readings } = completedMain();
    const contexts = {
      github: {
        event_name: "workflow_run",
        sha: "aa46269bb969bd40890eb07ace70b28fd00a3de1",
        event: { workflow_run: run },
      },
      inputs: {},
      steps: { "main-proof": { outputs: { source } } },
    };
    expect(workflowValue(job("resolve").if!, contexts)).toBe(true);
    // INF-2492: main runs no phone check, so only a successful main run starts a cut.
    for (const [conclusion, starts] of [
      ["failure", false],
      ["cancelled", false],
    ] as const)
      expect(
        workflowValue(job("resolve").if!, {
          ...contexts,
          github: { ...contexts.github, event: { workflow_run: { ...run, conclusion } } },
        }),
        conclusion,
      ).toBe(starts);
    const proof = job("resolve").steps!.find((step) => step.id === "main-proof")!;
    const env = Object.fromEntries(
      Object.entries(proof.env!).map(([key, value]) => [key, workflowString(value, contexts)]),
    );
    expect(env).toMatchObject({ SOURCE: source, CHANNEL: "alpha", MAIN_RUN: String(run.id) });
    const outputs: Record<string, unknown> = {};
    const summary = { addHeading: () => summary, addRaw: () => summary, write: async () => {} };
    // Execute the unchanged action body with Node's real module loader;
    // Vitest's realm does not install a loader on newly constructed async functions.
    const execute = compileFunction(
      `return (async () => {\n${proof.with!.script}\n})()`,
      ["github", "context", "core", "process", "require"],
      { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    );
    await execute(
      {
        rest: {
          actions: {
            getWorkflowRun: async (parameters: { run_id: number }) => {
              expect(parameters.run_id).toBe(run.id);
              return { data: run };
            },
            listJobsForWorkflowRun: "latest-job-executions",
          },
        },
        paginate: async (method: string, parameters: { run_id: number; filter: string }) => {
          expect(method).toBe("latest-job-executions");
          expect(parameters).toMatchObject({ run_id: run.id, filter: "latest" });
          return readings;
        },
      },
      { repo: { owner: "infinitary-labs", repo: "infinitary" } },
      {
        setOutput: (name: string, value: unknown) => {
          outputs[name] = value;
        },
        summary,
      },
      { env: { ...env, GITHUB_WORKSPACE: fileURLToPath(new URL("../", import.meta.url)) } },
      createRequire(import.meta.url),
    );
    expect(outputs).toEqual({ inherited: "true", source, url: run.html_url });
    const resolver = job("resolve").steps!.find((step) => step.id === "resolve")!;
    expect(workflowString(resolver.env!.CANDIDATE!, contexts)).toBe(source);
    expect(workflowString(resolver.env!.CHANNEL!, contexts)).toBe("alpha");
  });

  it("omits only broad verification, retaining signing prerequisites, the signed update and publication checks", () => {
    const { run } = completedMain();
    const needs = {
      resolve: {
        result: "success",
        outputs: { verify_required: "true", full_verify_required: "false", main_run: run.html_url },
      },
      notes: { result: "success" },
      verify: { result: "skipped" },
      linux: { result: "success" },
      phone: { result: "success" },
      rehearse: { result: "success" },
      release: { result: "success" },
      update: { result: "success" },
    };
    expect(workflowValue(job("verify").if!, { needs })).toBe(false);
    for (const name of ["rehearse", "release", "update", "publish"])
      expect(workflowValue(job(name).if!, { needs }), name).toBe(true);
    for (const failed of ["notes", "linux", "phone", "rehearse", "release", "update"])
      expect(
        workflowValue(job("publish").if!, { needs: { ...needs, [failed]: { result: "failure" } } }),
        failed,
      ).toBe(false);
    expect(
      workflowValue(job("release").if!, { needs: { ...needs, rehearse: { result: "failure" } } }),
    ).toBe(false);
    expect(
      workflowValue(job("publish").if!, {
        needs: {
          ...needs,
          resolve: { ...needs.resolve, outputs: { ...needs.resolve.outputs, main_run: "" } },
        },
      }),
    ).toBe(false);
  });
});
