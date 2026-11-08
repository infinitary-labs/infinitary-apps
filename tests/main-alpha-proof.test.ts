import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compileFunction, constants } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  alphaVerification,
  linuxChecksPassed,
  proveMain,
  verifyBatchEvidence,
  verifyMainEvidence,
} from "../scripts/main-alpha-proof.mjs";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows.ts";

// INF-2259 accepted override: a fully passing rolling-main source becomes an
// alpha without repeating its broad checks. Source and identity follow main
// run 41366596692's API reading. That live run was NOT passing: tests
// explicitly drive completed states to exercise the future handoff protocol.
const source = "6073f484509752eb55ee1b1c85c38b82b4909cc3";
const repository = "infinitary-labs/infinitary";
// Job names follow main run 41657804530's reading (run 73), less its phone
// jobs, which main no longer starts (INF-2492). INF-2340 (captain's route
// "alone-at-author"): main's full check ran no run-alone shards, so its
// journeys were the parallel and desktop shards.
const linuxJourneys = ["parallel", "desktop"].flatMap((lane) =>
  [1, 2, 3, 4].map((shard) => `verify / linux-e2e / journeys (${lane} ${shard}/4)`),
);
const checks = [
  "alpha-wait / Wait for the previous main check's alpha cut",
  "verify / Validate verification selection",
  "verify / linux-checks",
  "verify / mac",
  "startup / runtime-facts",
];
const installer = "verify / Verify signed installer and updater";
// INF-2480 (the captain: "old set at the release check only, from the first
// piece on"): main.yml now calls verify.yml's checks part, so its run has no
// Linux journey; a run from before it carried every journey.
function completedMain({ journeys = false }: { journeys?: boolean } = {}) {
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
  const job = (name: string, conclusion = "success") => ({
    name,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: source,
    status: "completed",
    conclusion,
  });
  const jobs = [
    ...checks.map((name) => job(name)),
    ...(journeys ? linuxJourneys.map((name) => job(name)) : []),
    job(installer, "skipped"),
  ];
  return { run, jobs };
}

describe("exact-main alpha verification inheritance", () => {
  it("inherits main's checks at exactly the alpha source, with no journeys of its own", () => {
    const { run, jobs } = completedMain();
    expect(verifyMainEvidence(run, jobs, repository, source)).toEqual({
      source,
      runId: run.id,
      attempt: run.run_attempt,
      url: run.html_url,
      journeys: false,
    });
  });

  it("says a main run from before INF-2480 also ran every Linux journey", () => {
    const { run, jobs } = completedMain({ journeys: true });
    expect(verifyMainEvidence(run, jobs, repository, source).journeys).toBe(true);
    // A partial set does not vouch for every journey.
    expect(verifyMainEvidence(run, jobs.slice(0, -2), repository, source).journeys).toBe(false);
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
      for (const owner of ["verify / mac", "verify / linux-checks"]) {
        const { run, jobs } = completedMain();
        jobs.find((job) => job.name === owner)!.conclusion = conclusion;
        expect(() => verifyMainEvidence(run, jobs, repository, source), owner).toThrow(
          "every full-check owner",
        );
      }
    },
  );

  // INF-2492 (the captain: "remove phone check from main altogether"): main's
  // run is the desktop check alone, so a run that ended failed has a failed
  // desktop job and never cuts an alpha.
  it("refuses a main run that ended failed", () => {
    const { run, jobs } = completedMain();
    jobs.find((job) => job.name === "startup / runtime-facts")!.conclusion = "failure";
    expect(() =>
      verifyMainEvidence({ ...run, conclusion: "failure" }, jobs, repository, source),
    ).toThrow("rolling-main push");
  });

  it("refuses a missing owner, future attempts, different sources and non-main runs", () => {
    const { run, jobs } = completedMain();
    expect(() =>
      verifyMainEvidence(
        run,
        jobs.filter((job) => job.name !== "verify / mac"),
        repository,
        source,
      ),
    ).toThrow("every full-check owner");
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
    // The sweep runs every journey (batch.yml), so the alpha reuses them and
    // runs none itself (the captain on INF-2508: "Keep every journey in the
    // batch, and let an alpha reuse them").
    expect(await proveMain(readings(), repo, run, source)).toEqual({
      source,
      runId: run.id,
      attempt: run.run_attempt,
      url: sweptBatch().run.html_url,
      journeys: true,
    });
  });

  it("still proves a full main run by its own check", async () => {
    const main = completedMain();
    expect(await proveMain(readings(main), repo, main.run, source)).toMatchObject({
      url: main.run.html_url,
      journeys: false,
    });
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
    const failedShard = jobs.map((job) =>
      job.name.endsWith("(desktop 4/4)") ? { ...job, conclusion: "failure" } : job,
    );
    expect(() => verifyBatchEvidence(run, failedShard, repository, tree)).toThrow(
      "every full-check owner",
    );
    // A sweep with a partial journey set still proves its checks but
    // vouches for no journey, so the alpha runs every journey itself.
    const partial = jobs.filter((job) => !job.name.endsWith("(desktop 4/4)"));
    expect(verifyBatchEvidence(run, partial, repository, tree).journeys).toBe(false);
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

// The captain's pick on INF-3052, "Nothing more: the batch's run and its
// recheck together passed every test". The jobs follow batch run
// 42456966779's reading: its checks failed one Linux journey group, its
// confirm ran that group's failed file three rounds and passed, and the run
// ended failed. Its confirm's last job, which then skipped, passes since
// INF-3052 and names the tree and base as the batch checks file now does.
const recheckTree = "7b9afd34b68fe3837ccb676cd2cdfbdd606036ea";
const recheckBase = "80d25e5dd6e80f5c6a6cdc60c33bffbf7195b769";
function recheckedBatch() {
  const run = {
    id: 42456966779,
    run_attempt: 1,
    path: ".github/workflows/infinitary-queue.yml",
    event: "status",
    head_branch: "main",
    head_sha: recheckBase,
    status: "completed",
    conclusion: "failure",
    head_repository: { full_name: repository },
    repository: { full_name: repository },
    html_url: "https://github.com/infinitary-labs/infinitary/actions/runs/42456966779",
  };
  const checks = "Batch checks / Merge batch · ";
  const desktop = `${checks}Desktop checks / Merge batch · `;
  const linux = `${desktop}Linux journeys / Merge batch · App journeys (Linux; `;
  const read: [string, string][] = [
    ["Form the batch", "success"],
    ["Answer the pause", "skipped"],
    [
      `${checks}Critical-path journey / Merge batch · Selected app journeys (Linux; serial)`,
      "success",
    ],
    [`${desktop}Check verification request`, "success"],
    [
      `${checks}Confirm failed tests (\${{ (((matrix.platform == 'mac') && 'Mac') || 'Linux') }})`,
      "skipped",
    ],
    [`${desktop}Code checks and build (Linux)`, "success"],
    ...[1, 2].map((n): [string, string] => [
      `${desktop}Integration tests (Linux; group ${n}/2)`,
      "success",
    ]),
    ...[1, 2, 3].map((n): [string, string] => [
      `${desktop}Unit tests (Linux; group ${n}/3)`,
      "success",
    ]),
    ...[1, 2].map((n): [string, string] => [
      `${desktop}Environment checks (Linux; group ${n}/2)`,
      "success",
    ]),
    [`${desktop}Browser tests (Linux)`, "success"],
    [`${desktop}Native tests, replay and package (Mac)`, "success"],
    [`${desktop}Parallel journeys (Mac)`, "success"],
    [`${desktop}Desktop journeys (Mac)`, "success"],
    ...[1, 2, 3, 4, 5, 6].map((n): [string, string] => [
      `${linux}parallel group ${n}/6)`,
      n === 1 ? "failure" : "success",
    ]),
    ...[1, 2, 3].map((n): [string, string] => [`${linux}serial group ${n}/3)`, "success"]),
    [`${desktop}Signed installer checks`, "skipped"],
    ["Read the failures", "success"],
    [`${checks}Batch passed (tree \${{ inputs.tree }})`, "skipped"],
    ["Batch confirm / Merge batch · Confirm failed tests (Linux)", "success"],
    ["Batch confirm / Merge batch · Critical-path journey", "skipped"],
    [
      `Batch confirm / Merge batch · Batch passed (tree ${recheckTree}; base ${recheckBase})`,
      "success",
    ],
    ["Batch confirm / Merge batch · Desktop checks", "skipped"],
    ["Batch verdict", "success"],
  ];
  const jobs = read.map(([name, conclusion]) => ({
    name,
    run_id: run.id,
    run_attempt: 1,
    head_sha: recheckBase,
    status: "completed",
    conclusion,
  }));
  return { run, jobs };
}

describe("an alpha from a batch that passed on its confirm (INF-3052)", () => {
  it("accepts its checks and every journey, which the run and its confirm passed together", () => {
    const { run, jobs } = recheckedBatch();
    expect(verifyBatchEvidence(run, jobs, repository, recheckTree)).toEqual({
      runId: run.id,
      attempt: 1,
      url: run.html_url,
      journeys: true,
    });
  });

  it("refuses it when the confirm did not pass, or passed on other files", () => {
    const { run, jobs } = recheckedBatch();
    expect(() => verifyBatchEvidence(run, jobs, repository, "0".repeat(40))).toThrow(
      "successful batch run",
    );
    // Batch run 42456966779 as it ran: its confirm's last job skipped.
    const asRun = jobs.map((job) =>
      job.name.startsWith("Batch confirm / Merge batch · Batch passed")
        ? { ...job, conclusion: "skipped" }
        : job,
    );
    expect(() => verifyBatchEvidence(run, asRun, repository, recheckTree)).toThrow(
      "successful batch run",
    );
    // A failure the confirm did not answer, such as a cancelled owner, still refuses.
    const cancelled = jobs.map((job) =>
      job.name.endsWith("(Mac)") && job.name.includes("Native")
        ? { ...job, conclusion: "cancelled" }
        : job,
    );
    expect(() => verifyBatchEvidence(run, cancelled, repository, recheckTree)).toThrow(
      "every full-check owner",
    );
  });
});

// What a published alpha's own release run proved, for its stable. Names
// follow alpha run 41685154411's reading (run 86), whose verify call skipped
// and is listed as one job named `verify`, beside its release jobs.
const releaseJobs = [
  "Resolve the source commit and version",
  "Check the release notes",
  "Wait for the phone",
  "linux / build",
  "Build, sign and notarize while the checks run",
  "Update from the last published alpha / Apple silicon",
];
const named = (name: string, conclusion = "success") => ({
  name,
  status: "completed",
  conclusion,
});
describe("an alpha's own verification (INF-2480)", () => {
  it("reads a skipped verify call as no lane run, as every automatic alpha before INF-2480", () => {
    expect(
      alphaVerification([...releaseJobs.map((name) => named(name)), named("verify", "skipped")]),
    ).toBe("none");
  });

  it("reads the whole check, and the journeys part an alpha reusing main's checks runs", () => {
    const all = [
      "verify / Validate verification selection",
      "verify / linux-checks",
      "verify / mac",
      ...linuxJourneys,
    ].map((name) => named(name));
    expect(
      alphaVerification([
        ...releaseJobs.map((name) => named(name)),
        ...all,
        named(installer, "skipped"),
      ]),
    ).toBe("all");
    const journeys = all.filter((job) => job.name !== "verify / linux-checks");
    expect(alphaVerification([...journeys, named(installer, "skipped")])).toBe("journeys");
  });

  it("refuses a failed, pending, partial or missing lane", () => {
    const journeys = ["verify / Validate verification selection", "verify / mac", ...linuxJourneys];
    const run = (names: string[], change?: [string, Record<string, string>]) =>
      alphaVerification(
        names.map((name) => ({ ...named(name), ...(change?.[0] === name ? change[1] : {}) })),
      );
    expect(run(journeys, ["verify / mac", { conclusion: "failure" }])).toBeNull();
    expect(
      run(journeys, [
        "verify / linux-e2e / journeys (desktop 1/4)",
        { status: "in_progress", conclusion: "" },
      ]),
    ).toBeNull();
    expect(
      run(journeys, ["verify / Validate verification selection", { conclusion: "cancelled" }]),
    ).toBeNull();
    expect(run(journeys.slice(0, -1))).toBeNull();
    expect(run(journeys.filter((name) => name !== "verify / mac"))).toBeNull();
    // A call that failed before any lane started is listed alone, not skipped.
    expect(alphaVerification([named("verify", "failure")])).toBeNull();
    // A whole check with a failed linux-checks is not a journeys part.
    expect(
      run(
        [...journeys, "verify / linux-checks"],
        ["verify / linux-checks", { conclusion: "failure" }],
      ),
    ).toBeNull();
  });

  // INF-2646 (the captain approved INF-2641's split): the Linux checks are
  // the code checks and build and every test group's complete set, each
  // passed; one missing, red or skipped part leaves them unproven.
  it("reads the split Linux checks only when every test group's complete set passed", () => {
    const split = [
      "verify / Code checks and build (Linux)",
      ...[1, 2, 3].map((part) => `verify / Unit tests (Linux; group ${part}/3)`),
      ...[1, 2].map((part) => `verify / Integration tests (Linux; group ${part}/2)`),
      ...[1, 2].map((part) => `verify / Environment checks (Linux; group ${part}/2)`),
      "verify / Browser tests (Linux)",
    ];
    const whole = [
      "verify / Validate verification selection",
      ...split,
      "verify / mac",
      ...linuxJourneys,
    ];
    const run = (names: string[], change?: [string, Record<string, string>]) =>
      alphaVerification([
        ...releaseJobs.map((name) => named(name)),
        ...names.map((name) => ({ ...named(name), ...(change?.[0] === name ? change[1] : {}) })),
        named(installer, "skipped"),
      ]);
    expect(run(whole)).toBe("all");
    expect(linuxChecksPassed(split.map((name) => named(name)))).toBe(true);
    for (const name of split) {
      expect(run(whole.filter((each) => each !== name)), name).toBeNull();
      for (const conclusion of ["failure", "skipped", "cancelled"])
        expect(run(whole, [name, { conclusion }]), `${name} ${conclusion}`).toBeNull();
      expect(run(whole, [name, { status: "in_progress", conclusion: "" }]), name).toBeNull();
    }
    // A part listed twice in place of another, or one of another count, is not the set.
    const third = "verify / Unit tests (Linux; group 3/3)";
    expect(
      run([...whole.filter((name) => name !== third), "verify / Unit tests (Linux; group 2/3)"]),
    ).toBeNull();
    expect(run([...whole, "verify / Integration tests (Linux; group 3/3)"])).toBeNull();
    // Main's checks read the same way, a run from before the split by its one job.
    const main = completedMain();
    const splitMain = [
      ...main.jobs.filter(({ name }) => name !== "verify / linux-checks"),
      ...split.map((name) => ({ ...main.jobs[0]!, name })),
    ];
    expect(verifyMainEvidence(main.run, splitMain, repository, source).runId).toBe(main.run.id);
    expect(() =>
      verifyMainEvidence(
        main.run,
        splitMain.filter(({ name }) => name !== "verify / Browser tests (Linux)"),
        repository,
        source,
      ),
    ).toThrow("every full-check owner");
  });

  // INF-2779 (the captain approved three Mac jobs): the Mac lanes are the
  // native tests, replay and package and the two journey jobs, each passed,
  // and the journeys part is the two journey jobs; one missing, red or
  // skipped job leaves them unproven. A run from before reads by its one job.
  it("reads the split Mac lanes only when each of their jobs passed", () => {
    const native = "verify / Native tests, replay and package (Mac)";
    const macJourneys = ["verify / Parallel journeys (Mac)", "verify / Desktop journeys (Mac)"];
    const whole = [
      "verify / Validate verification selection",
      "verify / linux-checks",
      native,
      ...macJourneys,
      ...linuxJourneys,
    ];
    const run = (names: string[], change?: [string, Record<string, string>]) =>
      alphaVerification([
        ...releaseJobs.map((name) => named(name)),
        ...names.map((name) => ({ ...named(name), ...(change?.[0] === name ? change[1] : {}) })),
        named(installer, "skipped"),
      ]);
    expect(run(whole)).toBe("all");
    const journeys = whole.filter((name) => name !== "verify / linux-checks" && name !== native);
    expect(run(journeys)).toBe("journeys");
    for (const name of [native, ...macJourneys]) {
      expect(run(whole.filter((each) => each !== name)), name).toBeNull();
      for (const conclusion of ["failure", "skipped", "cancelled"])
        expect(run(whole, [name, { conclusion }]), `${name} ${conclusion}`).toBeNull();
      expect(run(whole, [name, { status: "in_progress", conclusion: "" }]), name).toBeNull();
    }
    for (const name of macJourneys) {
      expect(run(journeys.filter((each) => each !== name)), name).toBeNull();
      expect(run(journeys, [name, { conclusion: "failure" }]), name).toBeNull();
    }
    // Main's checks read the same way.
    const main = completedMain();
    const splitMain = [
      ...main.jobs.filter(({ name }) => name !== "verify / mac"),
      ...[native, ...macJourneys].map((name) => ({ ...main.jobs[0]!, name })),
    ];
    expect(verifyMainEvidence(main.run, splitMain, repository, source).runId).toBe(main.run.id);
    for (const name of [native, ...macJourneys])
      expect(
        () =>
          verifyMainEvidence(
            main.run,
            splitMain.filter((job) => job.name !== name),
            repository,
            source,
          ),
        name,
      ).toThrow("every full-check owner");
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
    expect(outputs).toEqual({ inherited: "true", source, url: run.html_url, journeys: "false" });
    const resolver = job("resolve").steps!.find((step) => step.id === "resolve")!;
    expect(workflowString(resolver.env!.CANDIDATE!, contexts)).toBe(source);
    expect(workflowString(resolver.env!.CHANNEL!, contexts)).toBe("alpha");
  });

  // The captain on INF-2508: "Keep every journey in the batch, and let an
  // alpha reuse them". The unchanged step body proves a covered main run by
  // its swept batch, which ran every journey on the alpha source's files.
  it("hands an alpha from a swept batch every journey the batch ran", async () => {
    const main = coveredMain();
    const batch = sweptBatch();
    const proof = job("resolve").steps!.find((step) => step.id === "main-proof")!;
    const outputs: Record<string, unknown> = {};
    const said: string[] = [];
    const summary = {
      addHeading: () => summary,
      addRaw: (text: string) => {
        said.push(text);
        return summary;
      },
      write: async () => {},
    };
    const execute = compileFunction(
      `return (async () => {\n${proof.with!.script}\n})()`,
      ["github", "context", "core", "process", "require"],
      { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    );
    const github = readings(main, batch);
    await execute(
      {
        ...github,
        rest: {
          ...github.rest,
          actions: {
            ...github.rest.actions,
            getWorkflowRun: async ({ run_id }: { run_id: number }) =>
              run_id === main.run.id
                ? { data: main.run }
                : github.rest.actions.getWorkflowRun({ run_id }),
          },
        },
      },
      { repo },
      {
        setOutput: (name: string, value: unknown) => {
          outputs[name] = value;
        },
        summary,
      },
      {
        env: {
          MAIN_RUN: String(main.run.id),
          SOURCE: source,
          CHANNEL: "alpha",
          GITHUB_WORKSPACE: fileURLToPath(new URL("../", import.meta.url)),
        },
      },
      createRequire(import.meta.url),
    );
    expect(outputs).toEqual({
      inherited: "true",
      source,
      url: batch.run.html_url,
      journeys: "true",
    });
    expect(said.join(" ")).toContain(
      `in ${batch.run.html_url}, with every journey: every lane is reused`,
    );
  });

  // That alpha omits its verify call and still passes the signed update and
  // publication checks before it publishes.
  it("omits every lane for an alpha whose swept batch ran every journey, retaining the update and publication checks", () => {
    const batch = sweptBatch();
    const needs = {
      resolve: {
        result: "success",
        outputs: { verify_required: "true", main_run: batch.run.html_url, main_journeys: "true" },
      },
      notes: { result: "success" },
      verify: { result: "skipped" },
      linux: { result: "success" },
      phone: { result: "success" },
      release: { result: "success" },
      update: { result: "success" },
      upload: { result: "success" },
    };
    expect(workflowValue(job("verify").if!, { needs })).toBe(false);
    for (const name of ["release", "update", "upload", "publish"])
      expect(workflowValue(job(name).if!, { needs }), name).toBe(true);
    for (const name of ["upload", "publish"])
      for (const failed of ["notes", "linux", "phone", "release", "update"])
        expect(
          workflowValue(job(name).if!, { needs: { ...needs, [failed]: { result: "failure" } } }),
          `${name} after a failed ${failed}`,
        ).toBe(false);
    for (const unfinished of ["failure", "cancelled"])
      for (const name of ["update", "upload", "publish"])
        expect(
          workflowValue(job(name).if!, { needs: { ...needs, verify: { result: unfinished } } }),
          `${name} with verify ${unfinished}`,
        ).toBe(false);
  });

  // INF-2480 (the captain: "old set at the release check only, from the first
  // piece on"): main's run carries no journey, so an alpha that reuses main's
  // checks still runs every journey itself before it publishes.
  it("runs every journey and omits only main's checks, retaining signing prerequisites, the signed update and publication checks", () => {
    const { run } = completedMain();
    const needs = {
      resolve: {
        result: "success",
        outputs: { verify_required: "true", main_run: run.html_url, main_journeys: "false" },
      },
      notes: { result: "success" },
      verify: { result: "success" },
      linux: { result: "success" },
      phone: { result: "success" },
      release: { result: "success" },
      update: { result: "success" },
      upload: { result: "success" },
    };
    expect(workflowValue(job("verify").if!, { needs })).toBe(true);
    const part = (job("verify") as { with?: Record<string, string> }).with?.part ?? "";
    expect(workflowString(part, { needs })).toBe("journeys");
    for (const name of ["release", "update", "upload", "publish"])
      expect(workflowValue(job(name).if!, { needs }), name).toBe(true);
    for (const name of ["upload", "publish"])
      for (const failed of ["notes", "verify", "linux", "phone", "release", "update"])
        expect(
          workflowValue(job(name).if!, { needs: { ...needs, [failed]: { result: "failure" } } }),
          `${name} after a failed ${failed}`,
        ).toBe(false);
    for (const unfinished of ["skipped", "cancelled"])
      for (const name of ["update", "upload", "publish"])
        expect(
          workflowValue(job(name).if!, { needs: { ...needs, verify: { result: unfinished } } }),
          `${name} with verify ${unfinished}`,
        ).toBe(false);
    // An alpha with no reusable main proof runs the whole check.
    const unproven = {
      ...needs,
      resolve: { ...needs.resolve, outputs: { ...needs.resolve.outputs, main_run: "" } },
    };
    expect(workflowValue(job("verify").if!, { needs: unproven })).toBe(true);
    expect(workflowString(part, { needs: unproven })).toBe("all");
  });
});
