import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import releaseConfig from "../packaging/release-source.json" with { type: "json" };
import { legacyJobName, splitLevel, TRIGGERS } from "../scripts/ci-job-names.mjs";
import { coveringBatch, verifyMainEvidence } from "../scripts/main-alpha-proof.mjs";
import { runJobNames, type Scenario } from "./helpers/ciJobNames";
import { loadYamlFile, workflowString } from "./helpers/releaseWorkflows";

// INF-2410's approved scheme (the captain: "i want to distinguish what
// triggered the job and what they check"; scheme "A. Trigger first"): every
// job's name is `Trigger · Purpose (platform or device; group or round)`, and
// a called workflow's jobs carry their caller's trigger on every level.
// Names are evaluated from the workflow files for each trigger that starts them.

const pass = { result: "success" };
const releaseNeeds = {
  resolve: {
    ...pass,
    outputs: { skip: "false", verify_required: "true" },
  },
  ...Object.fromEntries(
    ["notes", "verify", "linux", "phone", "release", "update"].map((id) => [id, pass]),
  ),
};
// A main check that waited for the alpha cut from main run 204, as run
// 42232009514 did, so the wait's own jobs are named too (alpha-wait.yml).
// What main.yml's last job dispatches release.yml with (INF-3738).
const automaticAlpha = {
  channel: "alpha",
  candidate: "a".repeat(40),
  main_run: "43086357186",
  main_run_number: "541",
};
const waitedForAlpha = { outputs: { alphas: "[204]", waited: "true" } };
const docsPublisher = {
  repository: releaseConfig.repository,
  ref: "refs/heads/main",
  actor: "kunchenguid",
};
const SCENARIOS: { file: string; trigger: string; scenario: Scenario }[] = [
  { file: "ci.yml", trigger: "Pull request", scenario: { github: { event_name: "pull_request" } } },
  {
    file: "ci.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" } },
  },
  {
    file: "main.yml",
    trigger: "Main push",
    scenario: {
      github: { event_name: "push", sha: "a".repeat(40) },
      needs: { find: waitedForAlpha, sort: { outputs: { kind: "full" } } },
    },
  },
  {
    file: "main.yml",
    trigger: "Main push",
    scenario: {
      github: { event_name: "push", sha: "a".repeat(40) },
      needs: { find: waitedForAlpha, sort: { outputs: { kind: "covered", batch: "41700000001" } } },
    },
  },
  {
    file: "main.yml",
    trigger: "Manual request",
    scenario: {
      github: { event_name: "workflow_dispatch" },
      needs: { find: waitedForAlpha, sort: { outputs: { kind: "full" } } },
    },
  },
  {
    file: "release.yml",
    trigger: "Automatic alpha",
    scenario: {
      github: { event_name: "workflow_dispatch" },
      inputs: automaticAlpha,
      needs: releaseNeeds,
    },
  },
  {
    // An alpha that reuses main's checks runs only the journeys part (INF-2480).
    file: "release.yml",
    trigger: "Automatic alpha",
    scenario: {
      github: { event_name: "workflow_dispatch" },
      inputs: automaticAlpha,
      needs: {
        ...releaseNeeds,
        resolve: {
          ...pass,
          outputs: { ...releaseNeeds.resolve.outputs, main_run: "https://example.test/runs/1" },
        },
      },
    },
  },
  ...["alpha", "stable"].flatMap((channel) =>
    [false, true].map((dry_run) => ({
      file: "release.yml",
      trigger: `Requested ${channel}${dry_run ? " rehearsal" : ""}`,
      scenario: {
        github: { event_name: "workflow_dispatch" },
        inputs: { channel, dry_run },
        needs: releaseNeeds,
      },
    })),
  ),
  {
    file: "ios-release.yml",
    trigger: "Requested TestFlight",
    scenario: {
      github: { event_name: "workflow_dispatch" },
      inputs: { version: "0.2.0" },
      needs: { resolve: { ...pass, outputs: { mode: "release" } }, phone: pass, testflight: pass },
    },
  },
  {
    file: "ios-release.yml",
    trigger: "Requested TestFlight status",
    scenario: {
      github: { event_name: "workflow_dispatch" },
      inputs: { version: "0.2.0", check_build: "41.1" },
      needs: { resolve: { ...pass, outputs: { mode: "status" } } },
    },
  },
  ...[{ suite: "full" }, { suite: "alone" }].map((inputs) => ({
    file: "source-journeys.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" }, inputs },
  })),
  {
    file: "journeys.yml",
    trigger: "Manual request",
    scenario: {
      github: { event_name: "workflow_dispatch", sha: "a".repeat(40) },
      needs: {
        "choose-journeys": {
          ...pass,
          outputs: {
            count: "1",
            "linux-count": "2",
            linux: JSON.stringify({
              include: [
                { lane: "desktop", files: "tests/e2e/a.spec.ts", estimatedMs: 1, part: "1/2" },
                { lane: "parallel", files: "tests/e2e/b.spec.ts", estimatedMs: 1, part: "2/2" },
              ],
            }),
          },
        },
      },
    },
  },
  ...[{}, { waits: true }, { evidence_run: "41700000002" }].map((inputs) => ({
    file: "phone.yml",
    trigger: "Manual request",
    scenario: {
      github: { event_name: "workflow_dispatch" },
      inputs,
    },
  })),
  {
    file: "linux-packages.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" } },
  },
  // One round, and three side by side on the one installer.
  ...["[1]", "[1,2,3]"].map((rounds) => ({
    file: "windows.yml",
    trigger: "Manual request",
    scenario: {
      github: { event_name: "workflow_dispatch" },
      needs: { build: { result: "success", outputs: { rounds } } },
    },
  })),
  {
    file: "replay.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" } },
  },
  {
    file: "prompt-budget.yml",
    trigger: "Main push",
    scenario: { github: { event_name: "push" } },
  },
  {
    file: "prompt-budget.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" } },
  },
  {
    file: "size-warning.yml",
    trigger: "Main push",
    scenario: { github: { event_name: "push" } },
  },
  {
    file: "size-warning.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" } },
  },
  {
    file: "agent-memory.yml",
    trigger: "Main push",
    scenario: { github: { event_name: "push" } },
  },
  {
    file: "agent-memory.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" } },
  },
  {
    file: "republish-casks.yml",
    trigger: "Main push",
    scenario: {
      github: {
        event_name: "push",
        ref: "refs/heads/main",
        repository: releaseConfig.repository,
      },
    },
  },
  {
    file: "republish-casks.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" }, inputs: { dry_run: true } },
  },
  {
    file: "verify.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" }, inputs: { full_system: true } },
  },
  {
    file: "verify.yml",
    trigger: "Manual request",
    scenario: {
      github: { event_name: "workflow_dispatch" },
      inputs: { installer_only: true },
      needs: { build: pass },
    },
  },
  {
    file: "windows-feasibility.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" } },
  },
  // INF-3759's plan, pieces 2 and 3: a pushed task branch runs a pull
  // request's one job, named for the push.
  { file: "ci.yml", trigger: "Branch push", scenario: { github: { event_name: "push" } } },
  // The docs site's check (docs/docs-site.md, "The check").
  {
    file: "docs-site.yml",
    trigger: "Pull request",
    scenario: { github: { event_name: "pull_request" } },
  },
  { file: "docs-site.yml", trigger: "Branch push", scenario: { github: { event_name: "push" } } },
  // The docs site's publish run (docs/docs-site.md, "Publishing"), on main
  // by the operator it is limited to.
  {
    file: "docs-site-publish.yml",
    trigger: "Main push",
    scenario: { github: { event_name: "push", ...docsPublisher } },
  },
  {
    file: "docs-site-publish.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch", ...docsPublisher } },
  },
  {
    file: "docs-site-publish.yml",
    trigger: "Requested stable",
    scenario: {
      github: {
        event_name: "workflow_run",
        ...docsPublisher,
        event: { workflow_run: { conclusion: "success", head_branch: "main" } },
      },
    },
  },
  // An outside contributor's pull request (contributors.yml, docs/public-ci.md
  // "Outside contributors"), whose change edits a journey and reaches the
  // Windows installer, so the batch's full check, the startup fixtures, the
  // edited journey's rounds and the Windows build all run under its trigger.
  {
    file: "contributors.yml",
    trigger: "Pull request",
    scenario: {
      github: {
        event_name: "pull_request",
        repository: "infinitary-labs/infinitary",
        sha: "a".repeat(40),
        event: { pull_request: { head: { repo: { full_name: "someone/infinitary" } } } },
      },
      needs: {
        paths: {
          ...pass,
          outputs: {
            base: "b".repeat(40),
            journeys: "tests/e2e/critical-path.spec.ts",
            windows: "true",
          },
        },
        "choose-journeys": {
          ...pass,
          outputs: {
            count: "1",
            "linux-count": "1",
            linux: JSON.stringify({
              include: [
                {
                  lane: "desktop",
                  files: "tests/e2e/critical-path.spec.ts",
                  estimatedMs: 1,
                  part: "1/1",
                },
              ],
            }),
          },
        },
      },
    },
  },
  // The contributor agreement check (contributor-agreement.yml, docs/public-ci.md
  // "Outside contributors"): an outside pull request, and a reply on one.
  {
    file: "contributor-agreement.yml",
    trigger: "Pull request",
    scenario: { github: { event_name: "pull_request_target" } },
  },
  {
    file: "contributor-agreement.yml",
    trigger: "Pull request comment",
    scenario: {
      github: { event_name: "issue_comment", event: { issue: { pull_request: { url: "u" } } } },
    },
  },
  // The check-file flag (check-file-flag.yml, docs/public-ci.md "Outside
  // contributors"): an outside pull request, and a run started by hand.
  {
    file: "check-file-flag.yml",
    trigger: "Pull request",
    scenario: { github: { event_name: "pull_request_target" } },
  },
  {
    file: "check-file-flag.yml",
    trigger: "Manual request",
    scenario: { github: { event_name: "workflow_dispatch" } },
  },
  // A batch pull request's run (batch-pull-request.yml), whose one job calls
  // batch-checks.yml on the pull request's version; its checks passed, so
  // its last job runs.
  {
    file: "batch-pull-request.yml",
    trigger: "Merge batch",
    scenario: {
      github: {
        event_name: "pull_request",
        head_ref: "infinitary-batch/rehearsal",
        base_ref: "main",
        repository: "infinitary-labs/infinitary-apps",
        event: {
          pull_request: {
            head: { sha: "a".repeat(40), repo: { full_name: "infinitary-labs/infinitary-apps" } },
          },
          repository: { default_branch: "main" },
        },
      },
      needs: {
        batch: { result: "success", outputs: { tree: "b".repeat(40), base: "c".repeat(40) } },
        sweep: { result: "success" },
        "critical-path": { result: "success" },
        startup: { result: "success" },
        confirm: { result: "skipped" },
      },
    },
  },
];

describe("CI job names (INF-2410 scheme A, trigger first)", () => {
  const workflows = readdirSync(
    fileURLToPath(new URL("../.github/workflows/", import.meta.url)),
  ).filter((file) => file.endsWith(".yml"));
  type Workflow = {
    on: Record<string, { inputs?: Record<string, { required?: boolean; default?: unknown }> }>;
    jobs: Record<
      string,
      {
        name?: string;
        uses?: string;
        with?: Record<string, unknown>;
        outputs?: Record<string, string>;
      }
    >;
  };
  const workflow = (file: string) => loadYamlFile(`.github/workflows/${file}`) as Workflow;

  it("covers every workflow", () => {
    const called = new Set([
      "alpha-wait.yml",
      "batch-checks.yml",
      "linux-startup.yml",
      "mac-installer.yml",
      "mac-update.yml",
    ]);
    const files = workflows.filter((file) => !called.has(file));
    expect(new Set(SCENARIOS.map((each) => each.file))).toEqual(new Set(files));
  });

  // INF-2539's audit: a called workflow's trigger is its caller's to say, on
  // one path. A workflow only a caller starts requires it, with no fallback
  // of its own to drift from the caller's; every call passes it.
  it("takes a called workflow's trigger from its caller alone", () => {
    const callOnly: string[] = [];
    for (const file of workflows) {
      const { on, jobs } = workflow(file);
      const input = on.workflow_call?.inputs?.trigger;
      if (input && Object.keys(on).length === 1) {
        callOnly.push(file);
        expect(input, file).toMatchObject({ required: true });
        expect(input.default, file).toBeUndefined();
      }
      for (const [id, job] of Object.entries(jobs)) {
        if (!job.uses) continue;
        const child = job.uses.replace(/^\.\/\.github\/workflows\//, "");
        expect(workflow(child).on.workflow_call?.inputs?.trigger, `${file}:${id}`).toBeDefined();
        expect(job.with?.trigger, `${file}:${id}`).toEqual(expect.any(String));
      }
    }
    expect(callOnly.toSorted()).toEqual([
      "alpha-wait.yml",
      "batch-checks.yml",
      "linux-startup.yml",
      "mac-installer.yml",
      "mac-update.yml",
    ]);
  });

  // A release says what started it once, in its resolve job's `trigger`
  // output; every later job's name and every workflow it calls read that.
  it("names a release's later jobs from the resolve job's trigger", () => {
    const { jobs } = workflow("release.yml");
    const trigger = (github: Record<string, unknown>, inputs: Record<string, unknown>) =>
      workflowString(jobs.resolve?.outputs?.trigger ?? "", { github, inputs });
    expect(trigger({ event_name: "workflow_dispatch" }, automaticAlpha)).toBe("Automatic alpha");
    expect(trigger({ event_name: "workflow_dispatch" }, { channel: "alpha", dry_run: true })).toBe(
      "Requested alpha rehearsal",
    );
    expect(trigger({ event_name: "workflow_dispatch" }, {})).toBe("Requested stable");
    const later = {
      needs: { resolve: { outputs: { trigger: "Any trigger" } } },
      inputs: {},
      matrix: { part: "check" },
    };
    for (const [id, job] of Object.entries(jobs)) {
      if (id === "resolve") continue;
      expect(workflowString(job.name ?? id, later), id).toMatch(/^Any trigger · /);
      if (job.uses)
        expect(workflowString(String(job.with?.trigger), later), id).toBe("Any trigger");
    }
  });

  it.each(
    SCENARIOS.map(
      (each) =>
        [
          `${each.file}: ${each.trigger} ${JSON.stringify(each.scenario.inputs ?? {})}`,
          each,
        ] as const,
    ),
  )(
    "%s leads every level of every job's name with the trigger that started it",
    (_label, { file, trigger, scenario }) => {
      const names = runJobNames(file, scenario);
      expect(names.length).toBeGreaterThan(0);
      expect(TRIGGERS).toContain(trigger);
      for (const name of names) {
        for (const level of name.split(" / ")) {
          expect(splitLevel(level), name).toMatchObject({ trigger });
        }
      }
      expect(new Set(names).size, names.join("\n")).toBe(names.length);
    },
  );

  // INF-2480: main runs its checks part, with no Linux journeys, so the
  // alpha's proof reuses its checks and the alpha runs every journey itself.
  it("names main's full check so the alpha's proof reads both lanes, with no Linux journeys", () => {
    const source = "a".repeat(40);
    const names = runJobNames("main.yml", SCENARIOS[2]!.scenario);
    expect(names.filter((name) => name.includes("Linux journeys"))).toEqual([]);
    // INF-2646: the Linux checks are the code checks and build and the test groups beside them.
    expect(names).toEqual(
      expect.arrayContaining([
        "Main push · Desktop checks / Main push · Code checks and build (Linux)",
        "Main push · Desktop checks / Main push · Unit tests (Linux; group 1/3)",
        "Main push · Desktop checks / Main push · Unit tests (Linux; group 2/3)",
        "Main push · Desktop checks / Main push · Unit tests (Linux; group 3/3)",
        "Main push · Desktop checks / Main push · Integration tests (Linux; group 1/2)",
        "Main push · Desktop checks / Main push · Integration tests (Linux; group 2/2)",
        "Main push · Desktop checks / Main push · Environment checks (Linux; group 1/2)",
        "Main push · Desktop checks / Main push · Environment checks (Linux; group 2/2)",
        "Main push · Desktop checks / Main push · Browser tests (Linux)",
        // INF-2779: the Mac lane is three jobs.
        "Main push · Desktop checks / Main push · Native tests, replay and package (Mac)",
        "Main push · Desktop checks / Main push · Parallel journeys (Mac)",
        "Main push · Desktop checks / Main push · Desktop journeys (Mac)",
      ]),
    );
    const run = {
      id: 1,
      run_attempt: 1,
      path: ".github/workflows/main.yml",
      event: "push",
      head_branch: "main",
      head_sha: source,
      status: "completed",
      conclusion: "success",
      head_repository: { full_name: "infinitary-labs/infinitary-apps" },
      repository: { full_name: "infinitary-labs/infinitary-apps" },
      html_url: "https://github.com/infinitary-labs/infinitary-apps/actions/runs/1",
    };
    const jobs = names.map((name) => ({
      name,
      run_id: 1,
      run_attempt: 1,
      head_sha: source,
      status: "completed",
      conclusion: "success",
    }));
    expect(verifyMainEvidence(run, jobs, "infinitary-labs/infinitary-apps", source)).toMatchObject({
      runId: 1,
      journeys: false,
    });
    // A missing Mac lane is still an incomplete check, and so is any one of its three jobs.
    const short = jobs.filter((job) => !job.name.endsWith("(Mac)"));
    expect(() => verifyMainEvidence(run, short, "infinitary-labs/infinitary-apps", source)).toThrow(
      "every full-check owner",
    );
    const macJobs = jobs.filter((job) => job.name.endsWith("(Mac)"));
    expect(macJobs).toHaveLength(3);
    for (const missing of macJobs)
      expect(
        () =>
          verifyMainEvidence(
            run,
            jobs.filter((job) => job !== missing),
            "infinitary-labs/infinitary-apps",
            source,
          ),
        missing.name,
      ).toThrow("every full-check owner");
    // So is any Linux test group missing a part, or one part that did not
    // pass: a skipped part counts for nothing (INF-2646).
    const linux = names.filter((name) =>
      /^Main push · Desktop checks \/ .* \(Linux(; group \d+\/\d+)?\)$/.test(name),
    );
    expect(linux).toHaveLength(9);
    for (const name of linux) {
      const without = jobs.filter((job) => job.name !== name);
      expect(
        () => verifyMainEvidence(run, without, "infinitary-labs/infinitary-apps", source),
        name,
      ).toThrow("every full-check owner");
      const skipped = jobs.map((job) =>
        job.name === name ? { ...job, conclusion: "skipped" } : job,
      );
      expect(
        () => verifyMainEvidence(run, skipped, "infinitary-labs/infinitary-apps", source),
        name,
      ).toThrow("every full-check owner");
    }
    // A run from before the split, its Linux checks in one job, still proves them.
    const before = [
      ...jobs.filter((job) => !linux.includes(job.name)),
      {
        ...jobs[0]!,
        name: "Main push · Desktop checks / Main push · Code, build and all test groups (Linux)",
      },
    ];
    expect(
      verifyMainEvidence(run, before, "infinitary-labs/infinitary-apps", source),
    ).toMatchObject({
      runId: 1,
    });
  });

  // The batch run's own job names, and the proof they give, are held in
  // tests/batch-pull.test.ts.
  it("names a covered push so the alpha follows it to the batch run", () => {
    const covered = runJobNames("main.yml", SCENARIOS[3]!.scenario).map((name) => ({
      name,
      run_id: 1,
      run_attempt: 1,
      head_sha: "a".repeat(40),
      status: "completed",
      conclusion: "success",
    }));
    expect(coveringBatch(covered)).toBe(41700000001);
  });

  it("reads a name from before the scheme as it was, and a partly renamed one as no known job", () => {
    expect(legacyJobName("verify / linux-e2e / journeys (desktop 3/4)")).toBe(
      "verify / linux-e2e / journeys (desktop 3/4)",
    );
    expect(legacyJobName("sweep / mac")).toBe("verify / mac");
    expect(legacyJobName("verify / Main push · Code, build and all test groups (Linux)")).toBe(
      "verify / Main push · Code, build and all test groups (Linux)",
    );
    expect(
      legacyJobName("Someone · Desktop checks / Someone · Code, build and all test groups (Linux)"),
    ).toBe("Someone · Desktop checks / Someone · Code, build and all test groups (Linux)");
  });
});
