import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requestJobs } from "../scripts/affected-phone";
import { legacyJobName } from "../scripts/ci-job-names.mjs";
import { PHONE_PART_TIMES, PHONE_PARTS } from "../scripts/phone-test-plan";
import { hostEnv } from "../src/core/hostEnv";
import {
  loadYamlFile,
  recordedWorkflowCall,
  root,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** The Linux journey suites, the phone check and manual verification requests (source-journeys.yml, phone.yml, verify.yml). */

// INF-658's approved plan: execute the actual Linux journey command, not a
// source-text pin. Disposable command stand-ins record the selected interface.
describe("budgeted pull-request journey workflow (INF-658)", () => {
  type Job = {
    name: string;
    strategy: { matrix: { include: string } };
    steps: {
      name?: string;
      run?: string;
      if?: string;
      uses?: string;
      with?: Record<string, string>;
    }[];
  };
  const source = loadYamlFile(".github/workflows/source-journeys.yml") as {
    jobs: Record<string, Job>;
  };
  const job = source.jobs["source-desktop"];
  // INF-1417: split fresh-state checks four ways.
  // INF-2340 (captain's route "alone-at-author"): the full suite on main and
  // in an alpha adds no fresh-state jobs; only a request for them does.
  // INF-2987 (captain: "Group journeys by measured time, add Linux groups"):
  // the full suite runs the parallel lanes in six groups and the serial lane
  // in three, nine jobs, so the swept batch stays within GitHub's twenty
  // hosted jobs at once.
  it("splits the full suite nine ways, a requested fresh-state pass four and affected files by lane", () => {
    type Group = { lane: string; shard: number; groups: number };
    const groups = (suite: string, lane = "parallel") =>
      workflowValue(job?.strategy.matrix.include ?? "", { inputs: { suite, lane } }) as Group[];
    const of = (lane: string, count: number) =>
      Array.from({ length: count }, (_, at) => ({ lane, shard: at + 1, groups: count }));
    expect(groups("full")).toEqual([...of("parallel", 6), ...of("desktop", 3)]);
    expect(groups("alone")).toEqual(of("alone", 4));
    expect(groups("affected", "desktop")).toEqual(of("desktop", 1));
    // A release's stable promotion reads every Linux journeys job by name,
    // as it was named before the trigger-first rename (scripts/ci-job-names.mjs).
    const name = (suite: string, matrix: Group) =>
      workflowString(job?.name ?? "", { inputs: { suite, trigger: "Main push" }, matrix });
    for (const group of groups("alone")) {
      expect(name("alone", group)).toBe(
        `Main push · Fresh-start app journeys (Linux; group ${group.shard}/4)`,
      );
      expect(legacyJobName(name("alone", group))).toBe(`journeys (run alone ${group.shard}/4)`);
    }
    const [serial] = groups("full").filter(
      (group) => group.lane === "desktop" && group.shard === 2,
    );
    expect(name("full", serial as Group)).toBe(
      "Main push · App journeys (Linux; serial group 2/3)",
    );
    expect(legacyJobName(name("full", serial as Group))).toBe("journeys (desktop 2/3)");
    const [sixth] = groups("full").filter(
      (group) => group.lane === "parallel" && group.shard === 6,
    );
    expect(legacyJobName(name("full", sixth as Group))).toBe("journeys (parallel 6/6)");
  });
  it.each(["parallel", "desktop"])(
    "runs the %s affected and full files through their lane",
    (lane) => {
      const dir = scratchDir("infinitary-journey-placement-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const commands: Record<string, string> = {
        "xvfb-run": '#!/bin/sh\nshift 3\nexec "$@"\n',
        pnpm: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n',
        // The pointer's park answers as on the screen's last pixel.
        node: '#!/bin/sh\ncase "$1" in */park-pointer.ts) exit 0 ;; esac\nprintf "node %s\\n" "$*" >> "$COMMAND_LOG"\n',
      };
      for (const [name, body] of Object.entries(commands)) {
        const path = join(bin, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
      }
      const command = job?.steps.find((step) =>
        step.name?.startsWith("Run the journeys with"),
      )?.run;
      expect(command).toBeDefined();
      const count = lane === "desktop" ? 3 : 6;
      for (const { suite, shard } of [
        { suite: "affected", shard: 1 },
        ...Array.from({ length: count }, (_, at) => ({ suite: "full", shard: at + 1 })),
      ]) {
        const log = join(dir, `${suite}-${shard}.log`);
        const files =
          lane === "desktop"
            ? "tests/e2e/keyboard-routing.spec.ts"
            : "tests/e2e/task-browser.spec.ts";
        const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command ?? ""], {
          env: {
            ...hostEnv(),
            PATH: `${bin}:${hostEnv().PATH}`,
            COMMAND_LOG: log,
            GITHUB_ENV: join(dir, `${suite}-env`),
            REPEAT_BASE: "origin/main",
            RUNNER_OS: "Linux",
            SUITE: suite,
            LANE: lane,
            FILES: files,
            SCREEN: "2560x1600x24",
            SHARD: String(shard),
            GROUP_COUNT: String(suite === "full" ? count : 1),
          },
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        const call = readFileSync(log, "utf8");
        expect(call.includes("--project=desktop")).toBe(lane === "desktop");
        expect(call.includes("--project=application")).toBe(lane === "parallel");
        // INF-2340: the affected files' rounds end with their run-alone pass.
        if (suite === "affected")
          expect(call.trim()).toBe(
            `node scripts/journey-runs.ts --base origin/main --files ${files} --alone-out playwright-report/alone -- ${lane === "desktop" ? "--project=desktop" : "--project=renderer --project=application"}`,
          );
        // INF-2374: keep the full sweep's styles coverage and lane order.
        // INF-2987: each job runs its group of measured time.
        else
          expect(call.trim()).toBe(
            `node scripts/journey-groups.ts --platform linux --lane ${lane} --group ${shard}/${count} -- --no-deps ${lane === "desktop" ? "--project=desktop" : "--project=styles --project=renderer --project=application"}`,
          );
      }
    },
  );
  // INF-1417: execute each fresh-state share's real shell entry point, both in
  // full verification and the hosted-only proof request, preserving result retention.
  // INF-2340: only the requested pass runs every spec file alone.
  it.each([1, 2, 3, 4].map((shard) => ({ suite: "alone", shard })))(
    "runs fresh-state share $shard in $suite and keeps its distinct result",
    ({ suite, shard }) => {
      const dir = scratchDir("infinitary-journey-alone-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const commands: Record<string, string> = {
        "xvfb-run": '#!/bin/sh\nshift 3\nexec "$@"\n',
        // The pointer's park answers as on the screen's last pixel.
        node: '#!/bin/sh\ncase "$1" in */park-pointer.ts) exit 0 ;; esac\nprintf "node %s\\n" "$*" >> "$COMMAND_LOG"\n',
        pnpm: '#!/bin/sh\nprintf "pnpm %s\\n" "$*" >> "$COMMAND_LOG"\n',
      };
      for (const [name, body] of Object.entries(commands)) {
        const path = join(bin, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
      }
      const command = job?.steps.find((step) =>
        step.name?.startsWith("Run the journeys with"),
      )?.run;
      const log = join(dir, "alone.log");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command ?? ""], {
        env: {
          ...hostEnv(),
          PATH: `${bin}:${hostEnv().PATH}`,
          COMMAND_LOG: log,
          GITHUB_ENV: join(dir, "github-env"),
          RUNNER_OS: "Linux",
          SUITE: suite,
          LANE: "alone",
          SCREEN: "2560x1600x24",
          SHARD: String(shard),
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const [, selected, out] =
        /^node scripts\/e2e-alone\.ts --shard (\S+) --out (\S+)$/.exec(
          readFileSync(log, "utf8").trim(),
        ) ?? [];
      expect(selected).toBe(`${shard}/4`);
      expect(out, "the job runs the pass alone, over every spec file").toBeTruthy();
      // Kept on the requested pass's jobs and an affected job's, never a full suite's.
      const onAlone = (step: { if?: string } | undefined) =>
        workflowValue(step?.if ?? "", { inputs: { suite }, matrix: { lane: "alone" } }) === true &&
        workflowValue(step?.if ?? "", {
          inputs: { suite: "affected" },
          matrix: { lane: "desktop" },
        }) === true &&
        workflowValue(step?.if ?? "", {
          inputs: { suite: "full" },
          matrix: { lane: "desktop" },
        }) === false;
      const kept = job?.steps.find(
        (step) =>
          step.uses?.startsWith("actions/upload-artifact@") &&
          step.with?.path === `Application Support/firstmate/${out}/`,
      );
      expect(
        workflowString(kept?.with?.name ?? "", {
          inputs: { suite },
          matrix: { lane: "alone", shard },
        }),
      ).toBe(`e2e-alone-${shard}`);
      expect(
        workflowString(kept?.with?.name ?? "", {
          inputs: { suite: "affected", "artifact-suffix": "overflow-0" },
          matrix: { lane: "desktop", shard: 1 },
        }),
      ).toBe("e2e-alone-overflow-0-desktop");
      expect(onAlone(kept)).toBe(true);
      const summarize = job?.steps.find((step) => step.run?.includes("--summarize"));
      expect(summarize?.run).toContain(
        `node scripts/e2e-alone.ts --summarize ${out} | tee -a "$GITHUB_STEP_SUMMARY"`,
      );
      expect(onAlone(summarize)).toBe(true);
    },
  );
});

// INF-2202: execute the actual gate shell with former overrides still present;
// both devices stay in the placed guest, one simulator at a time, with selection intact.
// INF-4496's fix 2: every gate reads and keeps its run's earlier passes in the file the workflow names.
const PASSES = "/runner/temp/phone-passes/passes.json";

// INF-5387's plan, piece 2: a dealt job's gate runs exactly the passes the chooser dealt it, of one device or several,
// from one build, with every device's evidence in its own folder; only the request's first job runs the phone's Swift
// package tests, since its Mac part reuses their build. The jobs are the chooser's for today's complete request.
it.each(
  requestJobs(
    {
      devices: ["every"],
      kept: PHONE_PARTS.map((part) => part.name),
      iphoneOnly: [],
      ipadParts: [],
      duoParts: [],
      repeats: [],
      repeatTests: {},
      full: true,
      named: false,
    },
    JSON.parse(readFileSync(join(root, PHONE_PART_TIMES), "utf8")),
  ).map((job) => ({ key: job.key, passes: job.passes })),
)("runs exactly the passes of dealt $key", ({ key, passes }) => {
  const phone = loadYamlFile(".github/workflows/phone.yml") as {
    jobs: Record<string, { steps: { id?: string; run?: string; env?: Record<string, string> }[] }>;
  };
  const gate = phone.jobs["native-phone"]!.steps.find((step) => step.id === "both")!;
  const matrix = { key, passes };
  const env = (name: string) =>
    workflowString(gate.env![name]!, { matrix, runner: { temp: "/runner/temp" } });
  const call = recordedWorkflowCall(gate.run!, {
    PHONE_DEVICE: env("PHONE_DEVICE"),
    PHONE_PLAN: env("PHONE_PLAN"),
    PHONE_FIRST_JOB: env("PHONE_FIRST_JOB"),
    PHONE_PASSES: PASSES,
  });
  // The recorder writes one line an argument, and GitHub's toJSON writes the plan over several.
  const end = call.findIndex((arg) => arg.startsWith("--") && arg !== "--plan");
  expect(call.slice(0, 3)).toEqual(["node", "scripts/test-phone.ts", "--plan"]);
  expect(JSON.parse(call.slice(3, end).join("\n"))).toEqual(passes);
  expect(call.slice(end, -1)).toEqual([
    ...(key === "job-1" ? [] : ["--skip-package-tests"]),
    "--passes",
    PASSES,
    "--evidence",
  ]);
  expect(call.at(-1)).toMatch(/\/phone$/);
});

// INF-2582 direction A: a call of one device checks every part on that device, with full discovery, its evidence in
// its own folder; an unknown device starts nothing.
it.each([
  { device: "ipad", args: ["--device", "ipad"] },
  { device: "duo", args: ["--device", "duo"] },
  { device: "iphone", args: ["--device", "iphone"] },
])("runs every part on the $device alone for a device call", ({ device, args }) => {
  const phone = loadYamlFile(".github/workflows/phone.yml") as {
    jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
  };
  const command = phone.jobs["native-phone"]!.steps.find((step) => step.id === "both")!.run!;
  const call = recordedWorkflowCall(command, {
    PHONE_DEVICE: device,
    PHONE_PASSES: PASSES,
  });
  expect(call.slice(0, -1)).toEqual([
    "node",
    "scripts/test-phone.ts",
    ...args,
    "--passes",
    PASSES,
    "--evidence",
  ]);
  expect(call.at(-1)).toMatch(new RegExp(`/phone/${device}$`));
});

// INF-4241 piece 8: the phone release's call names no device, so one gate runs every device from one build and keeps
// each device's evidence in that device's own folder inside the one evidence folder.
it("runs every part on every device in one gate for the job of every device", () => {
  const phone = loadYamlFile(".github/workflows/phone.yml") as {
    jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
  };
  const command = phone.jobs["native-phone"]!.steps.find((step) => step.id === "both")!.run!;
  const call = recordedWorkflowCall(command, {
    PHONE_DEVICE: "every",
    PHONE_PASSES: PASSES,
  });
  expect(call.slice(0, -1)).toEqual([
    "node",
    "scripts/test-phone.ts",
    "--every-device",
    "--passes",
    PASSES,
    "--evidence",
  ]);
  expect(call.at(-1)).toMatch(/\/phone$/);
});

it("refuses an unknown phone device before the gate starts", () => {
  const phone = loadYamlFile(".github/workflows/phone.yml") as {
    jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
  };
  const command = phone.jobs["native-phone"]!.steps.find((step) => step.id === "both")!.run!;
  const folder = scratchDir("infinitary-phone-device-");
  const bin = join(folder, "bin");
  mkdirSync(bin);
  const started = join(folder, "started");
  writeFileSync(join(bin, "node"), `#!/bin/sh\necho started > "${started}"\n`, { mode: 0o755 });
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command], {
    cwd: folder,
    encoding: "utf8",
    env: {
      ...hostEnv(),
      PATH: `${bin}:${hostEnv().PATH}`,
      RUNNER_TEMP: folder,
      PHONE_DEVICE: "watch",
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unknown phone device: watch");
  expect(existsSync(started)).toBe(false);
});

// INF-2374 approved plan: Linux-only full proof must not silently buy full Mac
// verification. Exercise the actual request shells and Actions expressions.
describe("explicit manual verification scope (INF-2374)", () => {
  type Step = {
    id?: string;
    name?: string;
    run?: string;
    if?: string;
    env?: Record<string, string>;
  };
  type Job = {
    needs?: string;
    if?: string;
    "runs-on"?: string;
    steps?: Step[];
    strategy?: { matrix: Record<string, string> };
    uses?: string;
    with?: Record<string, unknown>;
  };
  type Workflow = {
    on: Record<string, { inputs: Record<string, { options?: string[]; default?: unknown }> }>;
    jobs: Record<string, Job>;
  };
  const verify = loadYamlFile(".github/workflows/verify.yml") as Workflow;
  const source = loadYamlFile(".github/workflows/source-journeys.yml") as Workflow;
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    env: hostEnv(),
    encoding: "utf8",
  }).trim();
  function runRequest(step: Step, context: Record<string, unknown>) {
    const dir = scratchDir("infinitary-request-scope-");
    const summary = join(dir, "summary");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run ?? ""], {
      cwd: root,
      env: {
        ...hostEnv(),
        GITHUB_STEP_SUMMARY: summary,
        ...Object.fromEntries(
          Object.entries(step.env ?? {}).map(([key, value]) => [
            key,
            workflowString(value, context),
          ]),
        ),
      },
      encoding: "utf8",
    });
    return { ...result, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
  }
  const request = verify.jobs.request?.steps?.[0];
  const linuxRequest = source.jobs["source-desktop"]?.steps?.find(
    (step) => step.name === "Record the manual Linux request",
  );
  const github = {
    event_name: "workflow_dispatch",
    workflow: "verify",
    sha: head,
    repository: "infinitary-labs/infinitary-apps",
    ref: "refs/heads/main",
  };
  // A request's inputs, with verify.yml's own defaults for those it leaves out.
  const dispatched = (given: Record<string, unknown>) => ({
    ...Object.fromEntries(
      Object.entries(verify.on.workflow_dispatch?.inputs ?? {}).flatMap(([name, input]) =>
        "default" in input ? [[name, input.default]] : [],
      ),
    ),
    ...given,
  });
  // Which jobs a request runs; a request runs no batch confirm, even after a test group failed.
  const runs = (id: string, inputs: Record<string, unknown>) =>
    verify.jobs[id]?.if === undefined ||
    workflowValue(verify.jobs[id]?.if ?? "", {
      inputs,
      needs: { "linux-tests": { result: "failure" } },
    }) === true;
  /** The project's own Mac, which MAC_RUNNER names; with no variables the Mac jobs go to
   * GitHub's Macs. */
  const ownMac = { MAC_RUNNER: "mini-mac" };
  const lanes = (inputs: Record<string, unknown>, vars: Record<string, unknown> = ownMac) =>
    workflowValue(verify.jobs.lane?.strategy?.matrix.lane ?? "", { inputs, vars });
  const valid = {
    full_system: true,
    ref: head,
    task: "INF-2374",
    reason: "Qualify changed workflow routing",
  };

  it("stops absent or contradictory manual selections before dependent work, preserving installer modes", () => {
    expect(request).toBeDefined();
    for (const id of ["linux-e2e", "lane", "linux-tests", "installer"])
      expect(verify.jobs[id]?.needs).toBe("request");
    for (const inputs of [
      {},
      { ...valid, full_system: false },
      { ...valid, task: "" },
      { ...valid, reason: "" },
      { ...valid, ref: "main" },
      { ...valid, ref: "" },
      { ...valid, installer_only: true },
      { ...valid, installer_reuse: "reviewed declaration" },
    ]) {
      const result = runRequest(request!, { github, inputs });
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.summary).toBe("");
    }
    for (const inputs of [
      valid,
      { installer_only: true },
      { installer_reuse: "reviewed declaration" },
      { installer_only: true, installer_reuse: "reviewed declaration" },
    ]) {
      const result = runRequest(request!, { github, inputs });
      expect(result.status, result.stderr).toBe(0);
      expect(result.summary).toContain(`source=${head}`);
    }
    const result = runRequest(request!, { github, inputs: valid });
    expect(result.summary).toContain(`task=${valid.task} reason=${valid.reason}`);
  });

  it("refuses an invalid fresh installer request instead of silently skipping the signer", () => {
    for (const [ref, source] of [
      ["refs/heads/inf/rehearsal", head],
      ["refs/heads/main", "inf/rehearsal"],
    ]) {
      const result = runRequest(request!, {
        github: { ...github, ref },
        inputs: { installer_only: true, ref: source },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Request fresh signed installer verification from main");
    }
    const legacy = {
      ...github,
      repository: "infinitary-labs/infinitary",
      ref: "refs/heads/inf/rehearsal",
    };
    expect(
      runRequest(request!, { github: legacy, inputs: { installer_only: true, ref: head } }).status,
    ).toBe(0);
  });

  it("leaves main and release reusable callers outside the manual opt-in", () => {
    for (const workflow of ["main", "release"]) {
      const caller = loadYamlFile(`.github/workflows/${workflow}.yml`) as Workflow;
      expect(
        Object.values(caller.jobs).some(
          (job) => (job as { uses?: string }).uses === "./.github/workflows/verify.yml",
        ),
      ).toBe(true);
      for (const event_name of ["push", "workflow_dispatch"]) {
        const result = runRequest(request!, {
          github: { ...github, workflow, event_name },
          inputs: {},
        });
        expect(result.status, result.stderr).toBe(0);
      }
    }
    // A verify dispatch's reusable Linux child must not be mistaken for a direct Linux request.
    expect(workflowValue(linuxRequest?.if ?? "", { github })).toBe(false);
  });

  it("propagates a failed Linux journey command instead of reporting success", () => {
    const dir = scratchDir("infinitary-full-linux-failure-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // The virtual display's child fails as a real failed journey would.
    writeFileSync(join(bin, "xvfb-run"), "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    const command = source.jobs["source-desktop"]?.steps?.find((step) =>
      step.name?.startsWith("Run the journeys with"),
    )?.run;
    expect(command).toBeDefined();
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command!], {
      env: {
        ...hostEnv(),
        PATH: `${bin}:${hostEnv().PATH}`,
        GITHUB_ENV: join(dir, "env"),
        RUNNER_OS: "Linux",
        SUITE: "full",
        LANE: "parallel",
        SHARD: "1",
        SCREEN: "2560x1600x24",
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(17);
  });

  it("binds direct Linux full requests to an exact checkout and records task and reason", () => {
    expect(source.on.workflow_dispatch?.inputs.suite?.options).toEqual(["alone", "full"]);
    expect(Object.keys(source.jobs)).toEqual(["source-desktop"]);
    const context = { github: { ...github, workflow: "Source desktop journeys" } };
    expect(workflowValue(linuxRequest?.if ?? "", context)).toBe(true);
    for (const inputs of [{ suite: "alone" }, { ...valid, suite: "full" }]) {
      const result = runRequest(linuxRequest!, { ...context, inputs });
      expect(result.status, result.stderr).toBe(0);
      expect(result.summary).toContain(`source=${head}`);
    }
    for (const inputs of [
      { ...valid, ref: "main" },
      { ...valid, ref: "0".repeat(40) },
      { ...valid, task: "" },
      { ...valid, reason: "" },
    ]) {
      expect(
        runRequest(linuxRequest!, { ...context, inputs: { ...inputs, suite: "full" } }).status,
      ).not.toBe(0);
    }
  });

  // INF-2850, the captain's pick: "Give a manual check request a choice that
  // runs only the Mac jobs." A Mac runner's trial requested the full check and
  // ran every Linux job beside the three Mac ones. A Mac-only request is held
  // to the same exact source, task and reason, and past the request check it
  // runs the three Mac jobs alone, each with the steps a full request gives it.
  it("runs only the three Mac jobs for an explained Mac-only request", () => {
    const macOnly = {
      mac_only: true,
      ref: head,
      task: "INF-2850",
      reason: "Trial a Mac runner's split jobs before its queue takes them",
    };
    const full = dispatched(valid);
    const mac = dispatched(macOnly);
    const accepted = runRequest(request!, { github, inputs: mac });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.summary).toContain("full_system=false mac_only=true");
    expect(accepted.summary).toContain(`source=${head} task=${macOnly.task}`);
    for (const inputs of [
      { ...macOnly, ref: "main" },
      { ...macOnly, task: "" },
      { ...macOnly, reason: "" },
      { ...macOnly, full_system: true },
      { ...macOnly, installer_only: true },
      { mac_only: true, installer_reuse: "reviewed declaration" },
    ]) {
      const refused = runRequest(request!, { github, inputs: dispatched(inputs) });
      expect(refused.status, JSON.stringify(inputs)).not.toBe(0);
      expect(refused.summary).toBe("");
    }

    expect(Object.keys(verify.jobs).filter((id) => runs(id, full))).toEqual([
      "request",
      "linux-e2e",
      "lane",
      "linux-tests",
    ]);
    expect(lanes(full)).toEqual(["linux-checks", "mac", "parallel", "desktop-1", "desktop-2"]);
    expect(Object.keys(verify.jobs).filter((id) => runs(id, mac))).toEqual(["request", "lane"]);
    expect(lanes(mac)).toEqual(["mac", "parallel", "desktop-1", "desktop-2"]);
    // On GitHub's Macs the parallel journeys are four jobs.
    const hosted = ["parallel-1", "parallel-2", "parallel-3", "parallel-4"];
    expect(lanes(full, {})).toEqual(["linux-checks", "mac", ...hosted, "desktop-1", "desktop-2"]);
    expect(lanes(mac, {})).toEqual(["mac", ...hosted, "desktop-1", "desktop-2"]);

    const ran = (lane: string, inputs: Record<string, unknown>) => {
      const outcomes: Record<string, { outcome: string }> = {};
      const commands: string[] = [];
      for (const step of verify.jobs.lane?.steps ?? []) {
        const runsStep =
          step.if === undefined ||
          workflowValue(step.if, { matrix: { lane }, inputs, steps: outcomes }) === true;
        if (step.id) outcomes[step.id] = { outcome: runsStep ? "success" : "skipped" };
        if (runsStep && step.run) commands.push(step.id ?? step.name ?? step.run);
      }
      return commands;
    };
    for (const [vars, machine] of [
      [ownMac, "mini-mac"],
      [{}, "macos-15"],
    ] as const)
      for (const lane of lanes(mac, vars) as string[]) {
        expect(
          workflowValue(verify.jobs.lane?.["runs-on"] ?? "", {
            matrix: { lane },
            inputs: mac,
            vars,
          }),
          lane,
        ).toBe(machine);
        expect(ran(lane, mac), lane).toEqual(ran(lane, full));
        expect(ran(lane, mac), lane).toContain(lane === "mac" ? "dev-signing" : "e2e");
      }
  });
  // INF-5097's plan, piece 2, the captain's pick: "Every Linux test and journey the batch
  // runs". A change sent back from its batch passes the batch's Linux jobs before it goes
  // back in line, on the project's Linux machines and with no Mac job. Held to the same
  // exact source, task and reason as the other explained requests.
  it("runs every Linux job the batch runs, and no Mac job, for an explained Linux-only request", () => {
    const linuxOnly = dispatched({
      linux_only: true,
      ref: head,
      task: "INF-5097",
      reason: "Sent back from its batch: prove every Linux check before it rejoins the line",
    });
    const accepted = runRequest(request!, { github, inputs: linuxOnly });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.summary).toContain("mac_only=false linux_only=true");
    expect(accepted.summary).toContain(`source=${head} task=INF-5097`);
    for (const inputs of [
      { ...linuxOnly, ref: "main" },
      { ...linuxOnly, task: "" },
      { ...linuxOnly, reason: "" },
      { ...linuxOnly, full_system: true },
      { ...linuxOnly, mac_only: true },
      { ...linuxOnly, installer_only: true },
    ]) {
      const refused = runRequest(request!, { github, inputs });
      expect(refused.status, JSON.stringify(inputs)).not.toBe(0);
      expect(refused.summary).toBe("");
    }

    // The jobs it runs: the code checks lane alone, every test group, every journey in the
    // full suite (the critical path among them) and the startup fixtures the batch runs in
    // a job of its own; a full request and the batch's call leave the startup job out.
    expect(Object.keys(verify.jobs).filter((id) => runs(id, linuxOnly))).toEqual([
      "request",
      "linux-e2e",
      "startup",
      "lane",
      "linux-tests",
    ]);
    expect(lanes(linuxOnly)).toEqual(["linux-checks"]);
    expect(runs("startup", dispatched(valid))).toBe(false);
    expect(runs("startup", { part: "all", confirm: true, all_journeys: true })).toBe(false);
    const batch = loadYamlFile(".github/workflows/batch-checks.yml") as {
      jobs: Record<string, { uses?: string }>;
    };
    expect(verify.jobs.startup?.uses).toBe(batch.jobs.startup?.uses);
    expect(verify.jobs["linux-e2e"]?.with?.suite).toBe("full");
    expect(verify.jobs.startup?.with?.ref).toBe("${{ inputs.ref }}");

    // On the project's own Linux machines, never GitHub's hosted ones or a Mac.
    const vars = { LINUX_RUNNER: "pc-linux", MAC_RUNNER: "mini-mac" };
    expect(
      workflowValue(verify.jobs.lane?.["runs-on"] ?? "", {
        matrix: { lane: "linux-checks" },
        inputs: linuxOnly,
        vars,
      }),
    ).toBe("pc-linux");
    expect(
      workflowValue(verify.jobs["linux-tests"]?.["runs-on"] ?? "", { inputs: linuxOnly, vars }),
    ).toBe("pc-linux");
    expect(
      workflowValue(String(verify.jobs["linux-e2e"]?.with?.hosted), { inputs: linuxOnly }),
    ).toBe(false);
  });
});

// INF-2576, the captain's choice "A, write the rules and add the phone workflow guard": a
// branch request for every phone part names its task and reason before it waits for a phone
// guest; touched, named and wait-clock requests, main and the release's call pass as before.
describe("the phone check request guard (INF-2576)", () => {
  type Step = { name?: string; run?: string; env?: Record<string, string> };
  type Job = { needs?: string | string[]; "runs-on"?: string; steps?: Step[] };
  const phone = loadYamlFile(".github/workflows/phone.yml") as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    jobs: Record<string, Job>;
  };
  const step = phone.jobs.request?.steps?.find(
    (candidate) => candidate.name === "Validate and record the manual phone request",
  );
  const branch = { event_name: "workflow_dispatch", ref: "refs/heads/fm/task-7ccc549e" };
  function runGuard(github: Record<string, string>, inputs: Record<string, unknown>) {
    const dir = scratchDir("infinitary-phone-request-");
    const summary = join(dir, "summary");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step?.run ?? ""], {
      cwd: root,
      env: {
        ...hostEnv(),
        GITHUB_STEP_SUMMARY: summary,
        ...Object.fromEntries(
          Object.entries(step?.env ?? {}).map(([key, value]) => [
            key,
            workflowString(value, { github, inputs }),
          ]),
        ),
      },
      encoding: "utf8",
    });
    return { ...result, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
  }

  it("holds the device gate behind the request check", () => {
    expect(step).toBeDefined();
    expect(phone.jobs["native-phone"]?.needs).toBe("request");
    expect(phone.on.workflow_dispatch.inputs).toHaveProperty("task");
    expect(phone.on.workflow_dispatch.inputs).toHaveProperty("reason");
    expect(phone.on.workflow_dispatch.inputs).toHaveProperty("device");
    // Refused on the fast gate line the journeys' chooser takes (INF-5387's plan, piece 1), never in
    // the phone guests' line; the phone release's call, which passes its resolved source, stays on
    // GitHub's hosted Ubuntu.
    const runner = (inputs: Record<string, string>) =>
      workflowValue(phone.jobs.request?.["runs-on"] ?? "", {
        inputs,
        vars: {
          MAC_QUEUES: JSON.stringify({ phone: "mini-mac-phone" }),
          LINUX_QUEUES: JSON.stringify({ light: "shell-pc-light", gate: "shell-pc-gate" }),
        },
      });
    expect(runner({})).toBe("shell-pc-gate");
    expect(runner({ source_commit: "a".repeat(40) })).toBe("ubuntu-24.04");
  });

  it("refuses a branch request for every part without a task and reason", () => {
    for (const inputs of [
      {},
      { affected: false, parts: "" },
      { recording: true },
      { task: "INF-2576" },
      { reason: "Hero pictures" },
    ]) {
      const result = runGuard(branch, inputs);
      expect(result.status, JSON.stringify(inputs)).not.toBe(0);
      expect(result.stdout).toContain("requires a task and reason");
      expect(result.summary).toBe("");
    }
  });

  it("passes narrower requests, an explained every-part request, main and the release's call", () => {
    for (const [github, inputs] of [
      [branch, { affected: true }],
      [branch, { parts: "cards" }],
      [branch, { waits: true }],
      [branch, { evidence_run: "41700000002" }],
      [branch, { task: "INF-2576", reason: "Shared phone setup changed" }],
      [{ event_name: "workflow_dispatch", ref: "refs/heads/main" }, {}],
      [{ event_name: "workflow_call", ref: "refs/heads/main" }, { source_commit: "a".repeat(40) }],
    ] as const) {
      const result = runGuard(github, inputs);
      expect(result.status, `${JSON.stringify(inputs)} ${result.stdout}`).toBe(0);
    }
    // GitHub fills an unsent boolean input with its default, false.
    const explained = { affected: false, task: "INF-2576", reason: "Shared phone setup changed" };
    expect(runGuard(branch, explained).summary).toBe(
      "Phone request: every_part=true affected=false parts= device=every task=INF-2576 reason=Shared phone setup changed\n",
    );
  });

  // INF-3205: a request may name one device, as the phone release's call does, and every route
  // refuses any other before a phone Mac is taken.
  it("passes a request for one device and records it", () => {
    for (const device of ["ipad", "iphone"]) {
      const result = runGuard(branch, { affected: true, device });
      expect(result.status, result.stdout).toBe(0);
      expect(result.summary).toBe(
        `Phone request: every_part=false affected=true parts= device=${device} task= reason=\n`,
      );
    }
    const call = { event_name: "workflow_call", ref: "refs/heads/main" };
    for (const device of ["ipad", "iphone"])
      expect(runGuard(call, { source_commit: "a".repeat(40), device }).status).toBe(0);
  });

  // INF-4071 (the captain's "Only the change's own edits"): a re-run after a pass names that version, which narrows
  // an affected request alone, by its full commit id.
  it("passes an affected request that names its last pass and records it", () => {
    const lastPass = "e6cd7bd67".padEnd(40, "0");
    const result = runGuard(branch, { affected: true, last_pass: lastPass });
    expect(result.status, result.stdout).toBe(0);
    expect(result.summary).toBe(
      `Phone request: every_part=false affected=true parts= device=every last_pass=${lastPass} task= reason=\n`,
    );
    expect(phone.on.workflow_dispatch.inputs).toHaveProperty("last_pass");
  });

  it("refuses a last pass that is not a full commit id or narrows no affected request", () => {
    const lastPass = "e6cd7bd67".padEnd(40, "0");
    for (const [inputs, words] of [
      [{ affected: true, last_pass: "e6cd7bd67" }, "must be a full commit id"],
      [{ affected: true, last_pass: "main" }, "must be a full commit id"],
      [
        { affected: true, parts: "cards-form", last_pass: lastPass },
        "narrows an affected request only",
      ],
      [{ parts: "cards-form", last_pass: lastPass }, "narrows an affected request only"],
    ] as const) {
      const result = runGuard(branch, inputs);
      expect(result.status, JSON.stringify(inputs)).not.toBe(0);
      expect(result.stdout).toContain(words);
      expect(result.summary).toBe("");
    }
  });

  it("refuses an unknown device on every route before a phone Mac is taken", () => {
    for (const [github, inputs] of [
      [branch, { affected: true, device: "watch" }],
      [branch, { affected: true, device: "ipad,iphone" }],
      [{ event_name: "workflow_dispatch", ref: "refs/heads/main" }, { device: "iPad" }],
      [
        { event_name: "workflow_call", ref: "refs/heads/main" },
        { source_commit: "a".repeat(40), device: "both" },
      ],
    ] as const) {
      const result = runGuard(github, inputs);
      expect(result.status, JSON.stringify(inputs)).not.toBe(0);
      expect(result.stdout).toContain(`Unknown phone device: ${inputs.device}`);
      expect(result.summary).toBe("");
    }
  });
});
