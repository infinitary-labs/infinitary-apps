import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { legacyJobName } from "../scripts/ci-job-names.mjs";
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
        xdotool:
          '#!/bin/sh\nif [ "$1" = getmouselocation ]; then echo "x:2559 y:1599 screen:0 window:0"; fi\n',
        pnpm: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n',
        node: '#!/bin/sh\nprintf "node %s\\n" "$*" >> "$COMMAND_LOG"\n',
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
        xdotool:
          '#!/bin/sh\nif [ "$1" = getmouselocation ]; then echo "x:2559 y:1599 screen:0 window:0"; fi\n',
        node: '#!/bin/sh\nprintf "node %s\\n" "$*" >> "$COMMAND_LOG"\n',
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
          step.uses === "actions/upload-artifact@v4" &&
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
// INF-2582 direction A (the captain's "A: wait once and trim the soak" and "iPhone only; iPad
// waits for the release check"): the chooser's reached parts go to the iPhone alone, and its
// edited parts' two further passes ride the same gate. The selections are real chooser outputs'
// shapes: a complete selection, one with edited tests, one that leaves reached parts to the iPhone,
// a proper subset, and a proper subset whose one edited part repeats (INF-2811).
// INF-2970's fix 1: each device's job runs the same selection on its own device; the gate itself
// leaves the iPhone-only parts and the further passes off the iPad (scripts/phone-test-plan.ts).
it.each(
  [
    { mode: "in-turn", parts: "cards-form", full: "true", iphone: "", repeat: "", selected: [] },
    {
      mode: "together",
      parts: "cards-form talk-tasks",
      full: "true",
      iphone: "",
      repeat: "cards-form",
      selected: ["--repeat-part", "cards-form"],
    },
    {
      mode: "",
      parts: "join-read talk-tasks rest",
      full: "true",
      iphone: "join-read rest",
      repeat: "talk-tasks",
      selected: [
        "--iphone-part",
        "join-read",
        "--part",
        "talk-tasks",
        "--iphone-part",
        "rest",
        "--repeat-part",
        "talk-tasks",
      ],
    },
    {
      mode: "",
      parts: "join-read talk-tasks",
      full: "false",
      iphone: "",
      repeat: "",
      selected: ["--part", "join-read", "--part", "talk-tasks"],
    },
    {
      mode: "",
      parts: "talk-drafts",
      full: "false",
      iphone: "",
      repeat: "talk-drafts",
      selected: ["--part", "talk-drafts", "--repeat-part", "talk-drafts"],
    },
  ].flatMap((selection) =>
    [
      { device: "ipad", args: ["--ipad"] },
      { device: "iphone", args: [] },
    ].map((each) => ({ ...selection, ...each })),
  ),
)(
  "runs the $device directly for $mode/$full/$iphone/$repeat without a local clone",
  ({ mode, parts, full, iphone, repeat, selected, device, args }) => {
    const phone = loadYamlFile(".github/workflows/phone.yml") as {
      jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
    };
    const command = phone.jobs["native-phone"]!.steps.find((step) => step.id === "both")!.run!;
    const call = recordedWorkflowCall(command, {
      PHONE_VIRTUAL_MAC: mode,
      PHONE_DEVICE: device,
      PHONE_PARTS: parts,
      PHONE_FULL: full,
      PHONE_IPHONE_PARTS: iphone,
      PHONE_REPEAT_PARTS: repeat,
    });
    expect(call.slice(0, -1)).toEqual([
      "node",
      "scripts/test-phone.ts",
      ...args,
      ...selected,
      "--simulators",
      "1",
      "--evidence",
    ]);
    expect(call.at(-1)).toMatch(new RegExp(`/phone/${device}$`));
  },
);

// INF-2582 direction A: the phone release checks each device in its own call, on its own phone Mac,
// every part with full discovery, each device's evidence in its own folder; an unknown device starts nothing.
it.each([
  { device: "ipad", args: ["--ipad"] },
  { device: "iphone", args: [] },
])("runs every part on the $device alone for a device call", ({ device, args }) => {
  const phone = loadYamlFile(".github/workflows/phone.yml") as {
    jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
  };
  const command = phone.jobs["native-phone"]!.steps.find((step) => step.id === "both")!.run!;
  const call = recordedWorkflowCall(command, {
    PHONE_DEVICE: device,
    PHONE_PARTS: "",
    PHONE_FULL: "",
    PHONE_IPHONE_PARTS: "",
    PHONE_REPEAT_PARTS: "",
  });
  expect(call.slice(0, -1)).toEqual([
    "node",
    "scripts/test-phone.ts",
    ...args,
    "--simulators",
    "1",
    "--evidence",
  ]);
  expect(call.at(-1)).toMatch(new RegExp(`/phone/${device}$`));
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
  const github = { event_name: "workflow_dispatch", workflow: "verify", sha: head };
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
    // A request's inputs, with verify.yml's own defaults for those it leaves out.
    const dispatched = (given: Record<string, unknown>) => ({
      ...Object.fromEntries(
        Object.entries(verify.on.workflow_dispatch?.inputs ?? {}).flatMap(([name, input]) =>
          "default" in input ? [[name, input.default]] : [],
        ),
      ),
      ...given,
    });
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

    const runs = (id: string, inputs: Record<string, unknown>) =>
      verify.jobs[id]?.if === undefined ||
      workflowValue(verify.jobs[id]?.if ?? "", { inputs }) === true;
    const lanes = (inputs: Record<string, unknown>) =>
      workflowValue(verify.jobs.lane?.strategy?.matrix.lane ?? "", { inputs });
    expect(Object.keys(verify.jobs).filter((id) => runs(id, full))).toEqual([
      "request",
      "linux-e2e",
      "lane",
      "linux-tests",
    ]);
    expect(lanes(full)).toEqual(["linux-checks", "mac", "parallel", "desktop"]);
    expect(Object.keys(verify.jobs).filter((id) => runs(id, mac))).toEqual(["request", "lane"]);
    expect(lanes(mac)).toEqual(["mac", "parallel", "desktop"]);

    // Each lane on a Mac, and with the steps a full request runs there.
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
    for (const lane of lanes(mac) as string[]) {
      expect(
        workflowValue(verify.jobs.lane?.["runs-on"] ?? "", {
          matrix: { lane },
          inputs: mac,
          vars: { MAC_RUNNER: "mini-mac" },
        }),
        lane,
      ).toBe("mini-mac");
      expect(ran(lane, mac), lane).toEqual(ran(lane, full));
      expect(ran(lane, mac), lane).toContain(lane === "mac" ? "dev-signing" : "e2e");
    }
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
    // Refused on a light Linux machine, never in the phone guests' line; the phone release's
    // call, which passes its resolved source, stays on GitHub's hosted Ubuntu.
    const runner = (inputs: Record<string, string>) =>
      workflowValue(phone.jobs.request?.["runs-on"] ?? "", {
        inputs,
        vars: {
          MAC_QUEUES: JSON.stringify({ phone: "mini-mac-phone" }),
          LINUX_QUEUES: JSON.stringify({ light: "shell-pc-light" }),
        },
      });
    expect(runner({})).toBe("shell-pc-light");
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
      "Phone request: every_part=true affected=false parts= device=both task=INF-2576 reason=Shared phone setup changed\n",
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
