import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BUILD_SCRIPTS_THAT_SHIP_NOTHING, isDesktopPath } from "../scripts/desktop-build.ts";
import {
  githubScript,
  loadYamlFile,
  read,
  root,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** When a rolling alpha is cut and how main's next check waits for it (release.yml, alpha-wait.yml). */

/**
 * An alpha with nothing new to build (INF-2465, docs/alpha.md): the captain
 * asked that "the rolling alpha release pipeline on main only runs when there
 * are desktop app code changes", and wrote in "as long as there's one main
 * alpha release still happening, don't start any new alpha cuts. doesn't
 * matter what changes are in each".
 */
describe("an alpha with nothing new to build", () => {
  type Step = {
    id?: string;
    if?: string;
    env?: Record<string, string>;
    with?: { script?: string };
  };
  type Job = {
    name?: string;
    if?: string;
    needs?: string | string[];
    outputs?: Record<string, string>;
    steps?: Step[];
  };
  const release = loadYamlFile(".github/workflows/release.yml") as { jobs: Record<string, Job> };
  const resolveSteps = release.jobs.resolve?.steps ?? [];
  const gate = resolveSteps.find((step) => step.id === "gate");

  /**
   * Real merges on main, with the files each changed (git diff --name-only
   * <merge>^ <merge>, read 2026-11-03). alpha.80, alpha.81 and the cut after
   * them held only the first three.
   */
  const merges: { merge: string; cuts: boolean; files: string[] }[] = [
    {
      merge: "7456a513707b8a746d4726259bf2ed68ad2a14d3",
      cuts: false,
      files: [
        "docs/e2e-contracts.md",
        "release-notes/changes/panel-press-after-expand.json",
        "tests/e2e/panel-tasks.spec.ts",
      ],
    },
    {
      merge: "bed09e54a662a8b7d14372999257282134e6ad23",
      cuts: false,
      files: [
        "ios/Infinitary/InfinitaryUITests/PhoneJourney.swift",
        "release-notes/changes/phone-choice-close-question.json",
        "tests/helpers/phoneHome.ts",
      ],
    },
    {
      merge: "29ff1007988bdbc94eed6466c21fb6495975cd40",
      cuts: false,
      files: [
        "docs/ios.md",
        "release-notes/changes/phone-preview-witness-recovery.json",
        "scripts/test-phone.ts",
        "tests/helpers/phoneKeyboard.ts",
        "tests/phone-keyboard.test.ts",
      ],
    },
    {
      merge: "1417dbf1d67045c3fa8c9e3ae2af21585fd21fc6",
      cuts: false,
      files: ["release-notes/changes/alpha-internal-coverage.json"],
    },
    {
      merge: "2d86878688ced9573e4cbf9d8c0451ccddb25e2a",
      cuts: false,
      files: [
        ".github/workflows/release.yml",
        "docs/alpha.md",
        "release-notes/changes/alpha-proof-wording.json",
      ],
    },
    {
      merge: "930dae5fda5178c3a52d251b87f2ea6074f31f55",
      cuts: true,
      files: [
        "docs/delivery-rigor.md",
        "release-notes/changes/merge-click-waits-for-checks.json",
        "src/core/orchestrator/crewSupervisor.test.ts",
        "src/core/orchestrator/crewSupervisor.ts",
        "src/core/orchestrator/firstmateAgent.test.ts",
        "src/core/orchestrator/firstmateAgent.ts",
        "src/core/prompts/contract-revisions/merge-click-is-not-a-checks-pass.md",
        "src/shared/holds.ts",
      ],
    },
    {
      merge: "dbb090a3d06340fec2c1917a776f80fcb35724c5",
      cuts: true,
      files: [
        "docs/model-lists.md",
        "docs/routing.md",
        "package.json",
        "pnpm-lock.yaml",
        "release-notes/changes/gpt-6-1-terra-medium.json",
        "src/core/models/modelListing.test.ts",
        "src/shared/modelSlots.ts",
      ],
    },
    {
      merge: "2062ce0b2556950742f6a8645c2ace1ea0c08756",
      cuts: true,
      files: [
        "docs/architecture.md",
        "electron-builder.yml",
        "packaging/build/icon.icns",
        "release-notes/changes/mac-small-icon.json",
        "scripts/render-app-icns.mjs",
        "scripts/render-app-icon.mjs",
        "tests/app-icon.test.ts",
      ],
    },
  ];

  it.each(merges)(
    "cuts an alpha for $merge only when it changed the desktop build: $cuts",
    ({ cuts, files }) => {
      expect(files.some(isDesktopPath)).toBe(cuts);
    },
  );

  it("never counts a test file inside a listed folder", () => {
    expect(isDesktopPath("src/core/orchestrator/crewSupervisor.test.ts")).toBe(false);
    expect(isDesktopPath("src/renderer/src/cards/Card.test.tsx")).toBe(false);
    expect(isDesktopPath("tsconfig.web.json")).toBe(true);
    expect(isDesktopPath("tsconfig/other.json")).toBe(false);
  });

  /**
   * The scripts the release's install, build and packaging run: package.json's
   * install and build scripts, the vite config's imports, the builder configs'
   * hooks, the Linux build job's commands, and every script they import.
   */
  it("lists every script the build runs, or says why it ships nothing", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const named = (text: string) =>
      [...text.matchAll(/(?:^|[\s"'(])\.?\/?(scripts\/[\w./-]+\.(?:[cm]?[jt]s|sh))/g)].map(
        (match) => match[1] as string,
      );
    const reached = new Set<string>();
    for (const name of ["postinstall", "prebuild", "build"])
      for (const script of named(pkg.scripts[name] ?? "")) reached.add(script);
    for (const config of ["electron-builder.yml", "electron-builder.linux.yml"]) {
      const values = JSON.stringify(loadYamlFile(config));
      for (const match of values.matchAll(/"\.?\/?(scripts\/[\w./-]+)"/g))
        reached.add(match[1] as string);
    }
    const linux = loadYamlFile(".github/workflows/linux-packages.yml") as {
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    for (const step of linux.jobs.build?.steps ?? [])
      for (const script of named(step.run ?? "")) reached.add(script);
    const resolveImport = (from: string, specifier: string) => {
      const base = join(dirname(from), specifier).replace(/\\/g, "/");
      return [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`].find(
        (path) => existsSync(join(root, path)) && !path.endsWith("/"),
      );
    };
    const importsOf = (path: string) =>
      [...read(path).matchAll(/(?:from\s+|import\(\s*|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g)]
        .map((match) => resolveImport(path, match[1] as string))
        .filter((found): found is string => found !== undefined);
    for (const path of importsOf("electron.vite.config.ts")) reached.add(path);
    const queue = [...reached];
    const missing: string[] = [];
    while (queue.length > 0) {
      const path = queue.shift() as string;
      if (path in BUILD_SCRIPTS_THAT_SHIP_NOTHING) continue;
      if (!isDesktopPath(path)) missing.push(path);
      if (!path.startsWith("scripts/")) continue;
      for (const found of importsOf(path)) {
        if (reached.has(found)) continue;
        reached.add(found);
        queue.push(found);
      }
    }
    expect(missing).toEqual([]);
    // The walk reaches what the plan named, so it reads the build at all.
    expect([...reached]).toEqual(
      expect.arrayContaining([
        "scripts/generate-self-source.mjs",
        "scripts/moduleRunner.ts",
        "scripts/frame-lib.ts",
        "scripts/mark-mac-installation.mjs",
        "scripts/linux-recipes.ts",
        "scripts/clone-or-copy.ts",
      ]),
    );
    for (const exempt of Object.keys(BUILD_SCRIPTS_THAT_SHIP_NOTHING))
      expect(reached.has(exempt), exempt).toBe(true);
  });

  type Run = { id: number; run_number: number; status: string; html_url: string };
  /**
   * The gate step's own script, against GitHub's answers and the
   * desktop-changes reading: `runs` are the rolling alphas main started,
   * `requested` the release runs dispatched by hand.
   */
  const runGate = async (
    runs: Run[],
    jobs: Record<number, { name: string; conclusion: string | null }[]>,
    desktop: { previous: string | null; changed: string[] },
    paused = "",
    requested: Run[] = [],
  ) => {
    const script = gate?.with?.script;
    expect(typeof script).toBe("string");
    const outputs: Record<string, string> = {};
    const summaries: string[] = [];
    const summary = {
      addHeading: () => summary,
      addRaw: (text: string) => {
        summaries.push(text);
        return summary;
      },
      write: async () => {},
    };
    const commands: string[][] = [];
    const reads: string[] = [];
    const childProcess = {
      execFileSync: (_command: string, args: string[]) => {
        commands.push(args);
        return JSON.stringify(desktop);
      },
    };
    const github = {
      paginate: async (
        method: (p: Record<string, unknown>) => Promise<unknown>,
        parameters: Record<string, unknown>,
      ) => method(parameters),
      rest: {
        actions: {
          listWorkflowRuns: async (parameters: Record<string, unknown>) => {
            expect(parameters).toMatchObject({ workflow_id: "release.yml" });
            expect(["workflow_run", "workflow_dispatch"]).toContain(parameters.event);
            reads.push(`release.yml ${parameters.event}`);
            return {
              data: { workflow_runs: parameters.event === "workflow_run" ? runs : requested },
            };
          },
          listJobsForWorkflowRun: async ({ run_id }: { run_id: number }) => jobs[run_id] ?? [],
        },
      },
    };
    const context = { repo: { owner: "example", repo: "project" }, runNumber: 90 };
    // The step's PAUSED is the repository variable it names.
    const variable = workflowString(gate?.env?.PAUSED ?? "", {
      vars: { ROLLING_ALPHA_PAUSED: paused },
    });
    // The workspace is this checkout, where the step imports the job-name
    // reader (scripts/ci-job-names.mjs); desktop-changes is the stand-in.
    const fakeProcess = {
      env: { SOURCE: "29ff10079a", GITHUB_WORKSPACE: root, PAUSED: variable },
    };
    const fakeRequire = (name: string) => {
      expect(["node:child_process", "node:url"]).toContain(name);
      return name === "node:url" ? { pathToFileURL } : childProcess;
    };
    await githubScript(script as string, ["core", "github", "context", "process", "require"])(
      {
        setOutput: (key: string, value: string) => {
          outputs[key] = value;
        },
        summary,
      },
      github,
      context,
      fakeProcess,
      fakeRequire,
    );
    return { skip: outputs.skip, summary: summaries.join("\n"), commands, reads };
  };
  // The notes job as an automatic alpha names it (docs/testing.md, "CI job
  // names"), reading the trigger from the resolve job's output.
  const trigger = workflowString(release.jobs.resolve?.outputs?.trigger as string, {
    github: { event_name: "workflow_run" },
    inputs: {},
  });
  const notesJob = workflowString(release.jobs.notes?.name as string, {
    needs: { resolve: { outputs: { trigger } } },
    matrix: { part: "check" },
  });
  const url = (n: number) => `https://github.com/example/project/actions/runs/${n}`;

  it("starts no cut while an earlier alpha is still being cut, whatever it holds", async () => {
    const cutting = { id: 89, run_number: 89, status: "in_progress", html_url: url(89) };
    const result = await runGate(
      [cutting],
      { 89: [{ name: notesJob, conclusion: null }] },
      { previous: "0.6.2-alpha.81", changed: ["src/main/app.ts"] },
    );
    expect(result.skip).toBe("true");
    expect(result.summary).toContain(url(89));
    expect(result.commands).toEqual([]);
  });

  it("ignores an earlier run still deciding, a skipped one, a finished one and a later one", async () => {
    const runs: Run[] = [
      { id: 91, run_number: 91, status: "in_progress", html_url: url(91) },
      { id: 89, run_number: 89, status: "in_progress", html_url: url(89) },
      { id: 88, run_number: 88, status: "in_progress", html_url: url(88) },
      { id: 87, run_number: 87, status: "completed", html_url: url(87) },
    ];
    const jobs = {
      91: [{ name: notesJob, conclusion: null }],
      89: [{ name: "Resolve the source commit and version", conclusion: null }],
      88: [{ name: notesJob, conclusion: "skipped" }],
      87: [{ name: notesJob, conclusion: "success" }],
    };
    const cut = await runGate(runs, jobs, {
      previous: "0.6.2-alpha.81",
      changed: ["src/main/app.ts"],
    });
    expect(cut.skip).toBe("false");
    expect(cut.commands).toEqual([
      [
        `${root}/scripts/release-notes.ts`,
        "desktop-changes",
        "--repo",
        root,
        "--source",
        "29ff10079a",
      ],
    ]);
  });

  /**
   * INF-3648: rolling alpha run 510 numbered itself 0.7.0-alpha.510 from the
   * newest stable tag, v0.6.5, while run 509 was still promoting
   * 0.7.0-alpha.503 to stable 0.7.0. The stable tagged v0.7.0 only when it
   * published, the alpha feed then carried 0.7.0, which outranks every
   * 0.7.0 alpha, and the alpha's update check found no update to offer.
   */
  describe("a stable being promoted", () => {
    /** A dispatched release's job name, as the workflow file names it for `inputs`. */
    const requestedJob = (job: string, inputs: Record<string, unknown>) => {
      const event = { github: { event_name: "workflow_dispatch" }, inputs };
      if (job === "resolve") return workflowString(release.jobs.resolve?.name as string, event);
      const trigger = workflowString(release.jobs.resolve?.outputs?.trigger as string, event);
      return workflowString(release.jobs[job]?.name as string, {
        needs: { resolve: { outputs: { trigger } } },
      });
    };
    /** Run 509's jobs while run 510 decided: chosen, its notes checked, the Mac build signing. */
    const promotionJobs = (inputs: Record<string, unknown>) => [
      { name: requestedJob("resolve", inputs), conclusion: "success" },
      { name: requestedJob("phone", inputs), conclusion: "success" },
      { name: requestedJob("release", inputs), conclusion: null },
    ];
    const stable = { channel: "stable", promote: "0.7.0-alpha.503", dry_run: false };
    const changed = { previous: "0.7.0-alpha.508", changed: ["src/core/pi/forgeTools.ts"] };

    it("starts no rolling cut while a stable promotion is still going", async () => {
      const promoting = { id: 509, run_number: 509, status: "in_progress", html_url: url(509) };
      const result = await runGate([], { 509: promotionJobs(stable) }, changed, "", [promoting]);
      expect(promotionJobs(stable)[0]?.name).toBe("Requested stable · Select source and version");
      expect(result.skip).toBe("true");
      expect(result.summary).toContain(url(509));
      expect(result.summary).toContain("A stable is being promoted");
      // It decides before the desktop reading, which a stable makes moot.
      expect(result.commands).toEqual([]);
    });

    it("cuts beside a stable rehearsal, a requested alpha, a finished stable and a run with no job yet", async () => {
      const runs: Run[] = [
        { id: 511, run_number: 511, status: "in_progress", html_url: url(511) },
        { id: 512, run_number: 512, status: "in_progress", html_url: url(512) },
        { id: 509, run_number: 509, status: "completed", html_url: url(509) },
        { id: 513, run_number: 513, status: "queued", html_url: url(513) },
      ];
      const jobs = {
        511: promotionJobs({ ...stable, dry_run: true }),
        512: promotionJobs({ channel: "alpha", dry_run: false }),
        509: promotionJobs(stable).map((job) => ({ ...job, conclusion: "success" })),
      };
      const result = await runGate([], jobs, changed, "", runs);
      expect(jobs[511][0]?.name).toBe("Requested stable rehearsal · Select source and version");
      expect(result.skip).toBe("false");
      expect(result.reads).toEqual(["release.yml workflow_run", "release.yml workflow_dispatch"]);
      expect(result.commands).toHaveLength(1);
    });
  });

  it("ends green when nothing the desktop app is built from changed, and cuts with no previous release", async () => {
    const quiet = await runGate([], {}, { previous: "0.6.2-alpha.81", changed: [] });
    expect(quiet.skip).toBe("true");
    expect(quiet.summary).toContain("0.6.2-alpha.81");
    expect((await runGate([], {}, { previous: null, changed: [] })).skip).toBe("false");
  });

  /**
   * PERS-51, the captain: "add a "pause/resume" button on the rolling alpha
   * panel for me to pause/resume the rolling pipeline manually", with manual
   * alphas still running. ROLLING_ALPHA_PAUSED holds the rolling cut alone.
   */
  it("cuts no rolling alpha while the captain has paused the rolling pipeline", async () => {
    const paused = await runGate(
      [],
      {},
      { previous: "0.6.2-alpha.81", changed: ["src/main/app.ts"] },
      "true",
    );
    expect(paused.skip).toBe("true");
    expect(paused.summary).toContain("Paused by the captain");
    expect(paused.summary).toContain("29ff10079a");
    expect(paused.reads).toEqual([]);
    expect(paused.commands).toEqual([]);
    for (const resumed of ["", "false"]) {
      const result = await runGate(
        [],
        {},
        { previous: "0.6.2-alpha.81", changed: ["src/main/app.ts"] },
        resumed,
      );
      expect(result.skip, resumed).toBe("false");
    }
  });

  /** Every job's result, as Actions decides it: an `if:` without a status function also needs its needs to succeed. */
  const results = (skip: string) => {
    const result: Record<string, string> = { resolve: "success" };
    const outputs = {
      skip,
      verify_required: skip === "true" ? "" : "true",
      main_run: skip === "true" ? "" : url(73),
    };
    const needsOf = (job: { needs?: string | string[] }) =>
      typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
    // Jobs are decided after every job they need, whatever order the file lists them in.
    const pending = Object.entries(release.jobs).filter(([id]) => id !== "resolve");
    const ordered: typeof pending = [];
    while (pending.length) {
      const index = pending.findIndex(([, job]) =>
        needsOf(job).every((need) => ordered.some(([id]) => id === need) || need === "resolve"),
      );
      if (index < 0) throw new Error("the release workflow's jobs need each other in a cycle");
      ordered.push(...pending.splice(index, 1));
    }
    for (const [id, job] of ordered) {
      const needs = needsOf(job);
      const context = {
        needs: Object.fromEntries(
          needs.map((need) => [
            need,
            { result: result[need], ...(need === "resolve" ? { outputs } : {}) },
          ]),
        ),
      };
      const condition = (job.if ?? "").replace(/^\$\{\{\s*|\s*\}\}$/g, "") || "true";
      const succeeded = needs.every((need) => result[need] === "success");
      const run = /\b(always|success|failure|cancelled)\(\)/.test(condition)
        ? workflowValue(condition, context, {
            success: succeeded,
            failure: false,
            always: true,
            cancelled: false,
          })
        : succeeded && workflowValue(condition, context);
      result[id] = run === true ? "success" : "skipped";
    }
    return result;
  };

  it("runs no later job when it skips, and every job of a cut otherwise", () => {
    const skipped = results("true");
    expect(
      Object.entries(skipped).filter(([id, value]) => id !== "resolve" && value !== "skipped"),
    ).toEqual([]);
    const cut = results("false");
    // INF-2480: a rolling alpha runs every journey itself, so its verify call runs too.
    for (const id of [
      "notes",
      "verify",
      "phone",
      "linux",
      "release",
      "update",
      "upload",
      "publish",
    ])
      expect(cut[id], id).toBe("success");
    // The gate's skip reaches the resolve job's own later steps and outputs.
    expect(release.jobs.resolve?.outputs?.skip).toContain("steps.gate.outputs.skip");
    for (const id of ["main-proof", "resolve", "destination", "verification"]) {
      const step = resolveSteps.find((candidate) => candidate.id === id);
      expect(
        workflowValue(step?.if ?? "true", {
          steps: { gate: { outputs: { skip: "true" } } },
          github: { event_name: "workflow_run" },
          inputs: {},
        }),
        id,
      ).toBe(false);
    }
  });

  it("decides only for a rolling alpha", () => {
    for (const event_name of ["workflow_run", "workflow_dispatch"])
      expect(workflowValue(gate?.if ?? "", { github: { event_name } })).toBe(
        event_name === "workflow_run",
      );
  });
});

/**
 * INF-2465, the captain: "i want to make it so that the next main check keeps
 * queueing all merges until the alpha is actually cut successfully, not while
 * the alpha cut is still happening". main.yml's first job waits for the alpha
 * cut from the previous main check, found by the name release.yml gives it.
 * INF-2834, the captain's pick: "Make main's wait for an alpha cut hold no
 * machine. 590 hosted minutes a day, with no change to anyone's wait." The
 * wait sits in the concurrency group each rolling alpha run holds.
 */
describe("the next main check waits for the alpha cut", () => {
  type Job = { uses?: string; needs?: string | string[] };
  type Step = { name: string; if?: string; with?: { script?: string } };
  type WaitJob = {
    if?: string;
    strategy?: { matrix: { run: string } };
    concurrency?: { group: string; "cancel-in-progress": boolean };
    steps: Step[];
  };
  const main = loadYamlFile(".github/workflows/main.yml") as { jobs: Record<string, Job> };
  const release = loadYamlFile(".github/workflows/release.yml") as {
    "run-name": string;
    concurrency: { group: string; "cancel-in-progress": string };
  };
  const wait = loadYamlFile(".github/workflows/alpha-wait.yml") as {
    jobs: { find: WaitJob; wait: WaitJob; ended: WaitJob };
  };
  const [pauseStep, findStep] = wait.jobs.find.steps;
  const minute = 60_000;
  /** The name release.yml gives the rolling alpha cut from a main run. */
  const alphaName = (run_number: number) =>
    workflowString(release["run-name"], {
      github: { event_name: "workflow_run", event: { workflow_run: { run_number } } },
    });
  /** The concurrency group release.yml's rolling alpha cut from a main run holds. */
  const alphaGroup = (run_number: number) =>
    workflowString(release.concurrency.group, {
      github: {
        event_name: "workflow_run",
        event: { workflow_run: { run_number } },
        run_id: 41685700000,
        ref_name: "main",
      },
      inputs: {},
    });
  /** The groups the wait job joins, one job each, for the alphas the find job names. */
  const joined = (alphas: string) =>
    (
      workflowValue(wait.jobs.wait.strategy?.matrix.run ?? "", {
        needs: { find: { outputs: { alphas } } },
      }) as number[]
    ).map((run) => workflowString(wait.jobs.wait.concurrency?.group ?? "", { matrix: { run } }));

  it("holds every check of a main run behind the wait, and names a requested release plainly", () => {
    expect(main.jobs["alpha-wait"]?.uses).toBe("./.github/workflows/alpha-wait.yml");
    // The swept batch's sort (INF-2430's plan, piece 3) runs no check: it
    // only decides whether the full check runs, and ends a landing run at once.
    for (const [id, job] of Object.entries(main.jobs))
      if (!["alpha-wait", "sort"].includes(id))
        expect([job.needs].flat(), id).toContain("alpha-wait");
    expect(alphaName(73)).toBe("Alpha from main run 73");
    expect(
      workflowString(release["run-name"], { github: { event_name: "workflow_dispatch" } }),
    ).toBe("release");
  });

  it("gives each rolling alpha a group of its own, the one main's wait joins", () => {
    expect(alphaGroup(73)).not.toBe(alphaGroup(74));
    // A requested release keeps its own run's group
    // (tests/release-workflows-rehearsal.test.ts holds those).
    const requested = workflowString(release.concurrency.group, {
      github: { event_name: "workflow_dispatch", run_id: 41685700000, ref_name: "main" },
      inputs: { channel: "alpha", dry_run: false },
    });
    expect(requested).not.toBe(alphaGroup(73));
    // A rolling alpha is never cancelled for whatever joins its group.
    expect(workflowValue(release.concurrency["cancel-in-progress"], { inputs: {} })).toBe(false);
    expect(wait.jobs.wait.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(joined("[73,70]")).toEqual([alphaGroup(73), alphaGroup(70)]);
    // With nothing being cut, no wait job starts at all.
    for (const [alphas, runs] of [
      ["[]", false],
      ["[73]", true],
    ] as const)
      expect(
        workflowValue(wait.jobs.wait.if ?? "", { needs: { find: { outputs: { alphas } } } }),
      ).toBe(runs);
  });

  /**
   * PERS-51, the captain: "add a "pause/resume" button on the rolling alpha
   * panel for me to pause/resume the rolling pipeline manually", answered
   * "Stop now", "the next merge starts a check that covers the pause" and
   * "Pause holds only the automatic pipeline".
   */
  it("cancels a pushed main check while paused, before any check behind the wait starts", async () => {
    const decide = (event_name: string, paused: string) => ({
      pause: workflowValue(pauseStep?.if ?? "", {
        github: { event_name },
        vars: { ROLLING_ALPHA_PAUSED: paused },
      }),
      find: workflowValue(findStep?.if ?? "", {
        github: { event_name },
        vars: { ROLLING_ALPHA_PAUSED: paused },
      }),
    });
    expect(pauseStep?.name).toBe("Stop while the captain has paused the rolling pipeline");
    expect(decide("push", "true")).toEqual({ pause: true, find: false });
    // Approved queue-owned merges enter the same rolling-main pause boundary.
    expect(decide("repository_dispatch", "true")).toEqual({ pause: true, find: false });
    // Not paused, or a check started by hand: the wait runs as before.
    for (const [event_name, paused] of [
      ["push", ""],
      ["push", "false"],
      ["workflow_dispatch", "true"],
    ] as const)
      expect(decide(event_name, paused), `${event_name} ${paused}`).toEqual({
        pause: false,
        find: true,
      });

    // The step's own script: it cancels its own run, then never lets the job succeed.
    const order: string[] = [];
    const summaries: string[] = [];
    const summary = {
      addHeading: (text: string) => {
        summaries.push(text);
        return summary;
      },
      addRaw: (text: string) => {
        summaries.push(text);
        return summary;
      },
      write: async () => {},
    };
    const context = {
      repo: { owner: "example", repo: "project" },
      runId: 41690000001,
      sha: "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    };
    const github = {
      rest: {
        actions: {
          cancelWorkflowRun: async (parameters: Record<string, unknown>) => {
            order.push(`cancel ${parameters.run_id}`);
            return {};
          },
        },
      },
    };
    const fakeTimeout = (done: () => void, ms: number) => {
      order.push(`pause ${ms / 60_000} minutes`);
      done();
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("core", "github", "context", "setTimeout", pauseStep?.with?.script)(
      { summary, setFailed: (text: string) => order.push(`failed: ${text}`) },
      github,
      context,
      fakeTimeout,
    );
    expect(order[0]).toBe(`cancel ${context.runId}`);
    expect(order[1]).toMatch(/^pause \d+ minutes$/);
    expect(order[2]).toMatch(/^failed: /);
    expect(summaries[0]).toBe("Paused by the captain");
    expect(summaries.join("\n")).toContain(context.sha);
  });

  type Run = {
    id: number;
    event?: string;
    run_number: number;
    status: string;
    conclusion: string | null;
    updated_at?: string;
    display_title?: string;
    html_url?: string;
    /** A rolling alpha's main run, and false when its run holds no group, as one from before the groups. */
    main?: number;
    grouped?: boolean;
  };
  /**
   * Runs the wait as GitHub runs it, against GitHub's answers on a clock that
   * moves only when a script pauses or GitHub holds a job. The find and ended
   * jobs run their own scripts on a machine; each wait job is held, on no
   * machine, while a run in progress holds its group, as GitHub holds "the
   * queued job or workflow" while "another job or workflow using the same
   * concurrency group in the repository is in progress" (GitHub's workflow
   * syntax, `concurrency`). `alpha(minutes)` is the alpha run as GitHub lists
   * it that many minutes after the previous main check ended, `head(minutes)`
   * main's newest commit then, and `others(minutes)` the other rolling alpha
   * runs GitHub lists then. `minutes` is when main's checks start, and
   * `machine` the minutes the wait held a machine.
   */
  const runWait = async (options: {
    mains: Run[];
    alpha: (minutes: number) => Run | undefined;
    head: (minutes: number) => string;
    others?: (minutes: number) => Run[];
  }) => {
    const ended = Date.parse("2026-11-03T17:35:00Z");
    let now = ended + 5_000;
    let machine = 0;
    const clock = { now: () => now, parse: (text: string) => Date.parse(text) };
    const elapsed = () => (now - ended) / minute;
    const older: Run = {
      id: 41685039944,
      run_number: 85,
      status: "completed",
      conclusion: "skipped",
      display_title: "release",
    };
    const listed = () => {
      const alpha = options.alpha(elapsed());
      return [...(alpha ? [alpha] : []), ...(options.others?.(elapsed()) ?? []), older];
    };
    const cancelled: number[] = [];
    const summaries: string[] = [];
    const summary = {
      addHeading: () => summary,
      addRaw: (text: string) => {
        summaries.push(text);
        return summary;
      },
      write: async () => {},
    };
    const outputs: Record<string, string> = {};
    const core = {
      summary,
      setOutput: (key: string, value: string) => {
        outputs[key] = value;
      },
    };
    const github = {
      rest: {
        actions: {
          getWorkflowRun: async ({ run_id }: { run_id: number }) => ({
            data: { id: run_id, run_number: 75 },
          }),
          listWorkflowRuns: async ({ workflow_id, ...filters }: Record<string, unknown>) => {
            if (workflow_id === "main.yml") {
              expect(filters).toMatchObject({ branch: "main", status: "completed" });
              expect(filters.event).toBeUndefined();
              return { data: { workflow_runs: options.mains } };
            }
            expect({ workflow_id, event: filters.event }).toEqual({
              workflow_id: "release.yml",
              event: "workflow_run",
            });
            return { data: { workflow_runs: listed() } };
          },
          cancelWorkflowRun: async ({ run_id }: { run_id: number }) => {
            cancelled.push(run_id);
            return {};
          },
        },
        repos: {
          getBranch: async ({ branch }: { branch: string }) => {
            expect(branch).toBe("main");
            return { data: { commit: { sha: options.head(elapsed()) } } };
          },
        },
      },
    };
    const context = {
      repo: { owner: "example", repo: "project" },
      runId: 41690000001,
      sha: "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    };
    const fakeTimeout = (done: () => void, ms: number) => {
      now += ms;
      done();
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const onMachine = async (script: string | undefined, env: Record<string, string> = {}) => {
      const start = now;
      await new AsyncFunction("core", "github", "context", "setTimeout", "Date", "process", script)(
        core,
        github,
        context,
        fakeTimeout,
        clock,
        { env },
      );
      machine += now - start;
    };
    await onMachine(findStep?.with?.script);
    const needs: Record<string, { result: string; outputs?: Record<string, string> }> = {
      find: { result: "success", outputs },
      wait: { result: "skipped" },
    };
    const legs = workflowValue(wait.jobs.wait.if ?? "", { needs })
      ? joined(outputs.alphas ?? "")
      : [];
    if (legs.length) {
      // GitHub holds the wait jobs while a run in progress holds a group they
      // join; a run still waiting to be put in its group holds none.
      const holding = () =>
        listed().some(
          (run) =>
            run.main !== undefined &&
            run.grouped !== false &&
            ["queued", "in_progress", "waiting"].includes(run.status) &&
            legs.includes(alphaGroup(run.main)),
        );
      while (holding() && elapsed() < 2_000) now += 10_000;
      needs.wait = { result: "success" };
    }
    if (workflowValue(wait.jobs.ended.if ?? "", { needs }))
      await onMachine(wait.jobs.ended.steps[0]?.with?.script, { WAITED: outputs.alphas ?? "" });
    return {
      minutes: elapsed(),
      machine: machine / minute,
      legs,
      cancelled,
      summary: summaries.join("\n"),
      runId: context.runId,
    };
  };
  const previous = (conclusion: string, run_number = 73): Run => ({
    event: "push",
    id: 41680000000 + run_number,
    run_number,
    status: "completed",
    conclusion,
    updated_at: "2026-11-03T17:35:00Z",
  });
  const alphaRun = (status: string, conclusion: string | null = null, grouped = true): Run => ({
    id: 41685700000,
    run_number: 88,
    status,
    conclusion,
    display_title: alphaName(73),
    html_url: "https://github.com/example/project/actions/runs/41685700000",
    main: 73,
    grouped,
  });
  /** The alpha GitHub starts six seconds after the main check ended, cut for `minutes`. */
  const cut =
    (minutes: number, conclusion = "success") =>
    (at: number) =>
      at < 0.1
        ? undefined
        : at < minutes
          ? alphaRun("in_progress")
          : alphaRun("completed", conclusion);

  it("waits while the alpha is cut, on no machine, then gives way to the newer merges queued behind it", async () => {
    const result = await runWait({
      mains: [previous("cancelled", 74), previous("success")],
      alpha: cut(120),
      head: () => "b2c0ffee00000000000000000000000000000000",
    });
    expect(result.legs).toEqual([alphaGroup(73)]);
    // Main's checks start when the cut ends, as the minute's poll let them before.
    expect(result.minutes).toBeGreaterThanOrEqual(120);
    expect(result.minutes).toBeLessThan(121);
    expect(result.machine).toBeLessThan(1);
    expect(result.cancelled).toEqual([result.runId]);
    expect(result.summary).toContain("ended success");
  });

  it("starts the check after the cut when no merge arrived meanwhile, and when the cut failed", async () => {
    for (const conclusion of ["success", "failure"]) {
      const result = await runWait({
        mains: [previous("success")],
        alpha: cut(30, conclusion),
        head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
      });
      expect(result.minutes).toBeGreaterThanOrEqual(30);
      expect(result.minutes).toBeLessThan(31);
      expect(result.machine).toBeLessThan(1);
      expect(result.cancelled).toEqual([]);
      expect(result.summary).toContain(`ended ${conclusion}`);
    }
  });

  it("starts at once when the previous alpha already ended or no main check ran before", async () => {
    const ended = await runWait({
      mains: [previous("failure")],
      alpha: () => alphaRun("completed", "success"),
      head: () => "b2c0ffee00000000000000000000000000000000",
    });
    expect(ended.legs).toEqual([]);
    expect(ended.minutes).toBeLessThan(0.5);
    expect(ended.cancelled).toEqual([]);
    const first = await runWait({
      mains: [previous("cancelled")],
      alpha: () => undefined,
      head: () => "b2c0ffee00000000000000000000000000000000",
    });
    expect(first.legs).toEqual([]);
    expect(first.minutes).toBeLessThan(0.5);
  });

  /**
   * INF-2780, the captain: "i thought we made it so that while an alpha is
   * being cut, we don't start another main check - why do we still seem to
   * have multiple in parallel?" Main run 152 started while alpha.156, cut from
   * main run 148, was re-run after its first attempt failed, because the wait
   * read only the alpha of main run 151, which ended at once.
   */
  it("waits while any alpha is cut, including an older one re-run after it ended", async () => {
    const older = (status: string, conclusion: string | null = null): Run => ({
      id: 42130788825,
      run_number: 160,
      status,
      conclusion,
      display_title: alphaName(70),
      html_url: "https://github.com/example/project/actions/runs/42130788825",
      main: 70,
    });
    const result = await runWait({
      mains: [previous("success")],
      alpha: () => alphaRun("completed", "skipped"),
      // A re-run lists the run in progress again under its own id.
      others: (at) => [at < 45 ? older("in_progress") : older("completed", "success")],
      head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    });
    expect(result.legs).toEqual([alphaGroup(70)]);
    expect(result.minutes).toBeGreaterThanOrEqual(45);
    expect(result.machine).toBeLessThan(1);
    expect(result.cancelled).toEqual([]);
    // With no earlier main check that ran, an alpha in flight still holds it.
    const first = await runWait({
      mains: [previous("cancelled")],
      alpha: () => undefined,
      others: (at) => [at < 20 ? older("queued") : older("completed", "failure")],
      head: () => "b2c0ffee00000000000000000000000000000000",
    });
    expect(first.minutes).toBeGreaterThanOrEqual(20);
    expect(first.machine).toBeLessThan(1);
    expect(first.cancelled).toEqual([first.runId]);
  });

  it("joins an alpha's group only once GitHub has put the alpha in it", async () => {
    const result = await runWait({
      mains: [previous("success")],
      // Listed at once, but waiting half a minute for its group.
      alpha: (at) =>
        at < 0.5
          ? alphaRun("pending")
          : at < 60
            ? alphaRun("in_progress")
            : alphaRun("completed", "success"),
      head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    });
    expect(result.legs).toEqual([alphaGroup(73)]);
    expect(result.minutes).toBeGreaterThanOrEqual(60);
    expect(result.machine).toBeGreaterThanOrEqual(0.4);
    expect(result.machine).toBeLessThan(1);
  });

  it("waits on no machine for as long as a cut runs, past a job's own limit", async () => {
    const result = await runWait({
      mains: [previous("success")],
      alpha: cut(400),
      head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    });
    expect(result.minutes).toBeGreaterThanOrEqual(400);
    expect(result.machine).toBeLessThan(1);
    expect(result.summary).toContain("ended success");
  });

  it("stops waiting for an alpha run GitHub never started, and polls as before for one outside its group", async () => {
    const never = await runWait({
      mains: [previous("success")],
      alpha: () => undefined,
      head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    });
    expect(never.legs).toEqual([]);
    expect(never.minutes).toBeGreaterThanOrEqual(10);
    expect(never.minutes).toBeLessThan(11);
    expect(never.cancelled).toEqual([]);
    // A run from before the groups holds none: the ended job polls for it,
    // and starts the check before a job's own limit.
    const ungrouped = await runWait({
      mains: [previous("success")],
      alpha: (at) => (at < 0.1 ? undefined : alphaRun("queued", null, false)),
      head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    });
    expect(ungrouped.legs).toEqual([alphaGroup(73)]);
    expect(ungrouped.minutes).toBeGreaterThan(340);
    expect(ungrouped.minutes).toBeLessThan(360);
    expect(ungrouped.summary).toContain("had not ended");
  });
});
