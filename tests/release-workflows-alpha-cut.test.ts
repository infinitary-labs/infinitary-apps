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
  /** The gate step's own script, against GitHub's answers and the desktop-changes reading. */
  const runGate = async (
    runs: Run[],
    jobs: Record<number, { name: string; conclusion: string | null }[]>,
    desktop: { previous: string | null; changed: string[] },
    paused = "",
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
            expect(parameters).toMatchObject({ workflow_id: "release.yml", event: "workflow_run" });
            reads.push("release.yml");
            return { data: { workflow_runs: runs } };
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
    for (const [id, job] of Object.entries(release.jobs)) {
      if (id === "resolve") continue;
      const needs = typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
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
 */
describe("the next main check waits for the alpha cut", () => {
  type Job = { uses?: string; needs?: string | string[] };
  const main = loadYamlFile(".github/workflows/main.yml") as { jobs: Record<string, Job> };
  const release = loadYamlFile(".github/workflows/release.yml") as { "run-name": string };
  const wait = loadYamlFile(".github/workflows/alpha-wait.yml") as {
    jobs: { wait: { steps: { name: string; if?: string; with?: { script?: string } }[] } };
  };
  const [pauseStep, waitStep] = wait.jobs.wait.steps;
  const script = waitStep?.with?.script ?? "";
  const minute = 60_000;
  /** The name release.yml gives the rolling alpha cut from a main run. */
  const alphaName = (run_number: number) =>
    workflowString(release["run-name"], {
      github: { event_name: "workflow_run", event: { workflow_run: { run_number } } },
    });

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
      wait: workflowValue(waitStep?.if ?? "", {
        github: { event_name },
        vars: { ROLLING_ALPHA_PAUSED: paused },
      }),
    });
    expect(pauseStep?.name).toBe("Stop while the captain has paused the rolling pipeline");
    expect(decide("push", "true")).toEqual({ pause: true, wait: false });
    // Not paused, or a check started by hand: the wait runs as before.
    for (const [event_name, paused] of [
      ["push", ""],
      ["push", "false"],
      ["workflow_dispatch", "true"],
    ] as const)
      expect(decide(event_name, paused), `${event_name} ${paused}`).toEqual({
        pause: false,
        wait: true,
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
    run_number: number;
    status: string;
    conclusion: string | null;
    updated_at?: string;
    display_title?: string;
    html_url?: string;
  };
  /**
   * Runs the job's own script against GitHub's answers on a clock that moves
   * only when the script pauses. `alpha(minutes)` is the alpha run as GitHub
   * lists it that many minutes after the previous main check ended, and
   * `head(minutes)` main's newest commit then, and `others(minutes)` the
   * other rolling alpha runs GitHub lists then.
   */
  const runWait = async (options: {
    mains: Run[];
    alpha: (minutes: number) => Run | undefined;
    head: (minutes: number) => string;
    others?: (minutes: number) => Run[];
  }) => {
    const ended = Date.parse("2026-11-03T17:35:00Z");
    let now = ended + 5_000;
    const clock = { now: () => now, parse: (text: string) => Date.parse(text) };
    const elapsed = () => Math.floor((now - ended) / minute);
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
    const github = {
      rest: {
        actions: {
          getWorkflowRun: async ({ run_id }: { run_id: number }) => ({
            data: { id: run_id, run_number: 75 },
          }),
          listWorkflowRuns: async ({ workflow_id, ...filters }: Record<string, unknown>) => {
            if (workflow_id === "main.yml") {
              expect(filters).toMatchObject({ branch: "main", event: "push", status: "completed" });
              return { data: { workflow_runs: options.mains } };
            }
            expect({ workflow_id, event: filters.event }).toEqual({
              workflow_id: "release.yml",
              event: "workflow_run",
            });
            const alpha = options.alpha(elapsed());
            const older = {
              id: 41685039944,
              run_number: 85,
              status: "completed",
              conclusion: "skipped",
              display_title: "release",
            };
            const others = options.others?.(elapsed()) ?? [];
            return { data: { workflow_runs: [...(alpha ? [alpha] : []), ...others, older] } };
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
    await new AsyncFunction("core", "github", "context", "setTimeout", "Date", script)(
      { summary },
      github,
      context,
      fakeTimeout,
      clock,
    );
    return {
      minutes: elapsed(),
      cancelled,
      summary: summaries.join("\n"),
      runId: context.runId,
      sha: context.sha,
    };
  };
  const previous = (conclusion: string, run_number = 73): Run => ({
    id: 41680000000 + run_number,
    run_number,
    status: "completed",
    conclusion,
    updated_at: "2026-11-03T17:35:00Z",
  });
  const alphaRun = (status: string, conclusion: string | null = null): Run => ({
    id: 41685700000,
    run_number: 88,
    status,
    conclusion,
    display_title: alphaName(73),
    html_url: "https://github.com/example/project/actions/runs/41685700000",
  });
  const cut = (minutes: number) => (at: number) =>
    at < 1 ? undefined : at < minutes ? alphaRun("in_progress") : alphaRun("completed", "success");

  it("waits while the alpha is cut, then gives way to the newer merges queued behind it", async () => {
    const result = await runWait({
      mains: [previous("cancelled", 74), previous("success")],
      alpha: cut(120),
      head: () => "b2c0ffee00000000000000000000000000000000",
    });
    expect(result.minutes).toBeGreaterThanOrEqual(120);
    expect(result.cancelled).toEqual([result.runId]);
    expect(result.summary).toContain("ended success");
  });

  it("starts the check after the cut when no merge arrived meanwhile, and when the cut failed", async () => {
    for (const conclusion of ["success", "failure"]) {
      const result = await runWait({
        mains: [previous("success")],
        alpha: (at) =>
          at < 1
            ? undefined
            : at < 30
              ? alphaRun("in_progress")
              : alphaRun("completed", conclusion),
        head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
      });
      expect(result.minutes).toBeGreaterThanOrEqual(30);
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
    expect(ended.minutes).toBe(0);
    expect(ended.cancelled).toEqual([]);
    const first = await runWait({
      mains: [previous("cancelled")],
      alpha: () => undefined,
      head: () => "b2c0ffee00000000000000000000000000000000",
    });
    expect(first.minutes).toBe(0);
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
    });
    const result = await runWait({
      mains: [previous("success")],
      alpha: () => alphaRun("completed", "skipped"),
      // A re-run lists the run in progress again under its own id.
      others: (at) => [at < 45 ? older("in_progress") : older("completed", "success")],
      head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    });
    expect(result.minutes).toBeGreaterThanOrEqual(45);
    expect(result.cancelled).toEqual([]);
    // With no earlier main check that ran, an alpha in flight still holds it.
    const first = await runWait({
      mains: [previous("cancelled")],
      alpha: () => undefined,
      others: (at) => [at < 20 ? older("queued") : older("completed", "failure")],
      head: () => "b2c0ffee00000000000000000000000000000000",
    });
    expect(first.minutes).toBeGreaterThanOrEqual(20);
    expect(first.cancelled).toEqual([first.runId]);
  });

  it("stops waiting for an alpha run GitHub never started, and for one that outlasts a job", async () => {
    const never = await runWait({
      mains: [previous("success")],
      alpha: () => undefined,
      head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    });
    expect(never.minutes).toBeGreaterThanOrEqual(10);
    expect(never.minutes).toBeLessThan(15);
    expect(never.cancelled).toEqual([]);
    const stuck = await runWait({
      mains: [previous("success")],
      alpha: () => alphaRun("queued"),
      head: () => "9d6f4a248f3b1c1e1c2b8c4a6f1d0e2a3b4c5d6e",
    });
    expect(stuck.minutes).toBeLessThan(360);
    expect(stuck.summary).toContain("had not ended");
  });
});
