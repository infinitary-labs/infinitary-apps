import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SIGNED_BUILD_STEP } from "../scripts/installer-reuse";
import { SIGNING_TEAMS } from "../scripts/release-signing-team.ts";
import { releaseSource } from "../src/core/update/releaseSource";
import {
  loadYamlFile,
  read,
  root,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** The casks, the installer and update checks, the private alpha and the Linux packages. */

describe("the cask republication workflow", () => {
  type Step = {
    id?: string;
    name?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
  };
  const workflow = loadYamlFile(".github/workflows/republish-casks.yml") as {
    on: {
      push?: { branches: string[]; paths: string[] };
      pull_request?: unknown;
      workflow_dispatch?: { inputs: Record<string, Record<string, unknown>> };
    };
    permissions: Record<string, string>;
    concurrency: Record<string, unknown>;
    jobs: Record<string, { if: string; "runs-on": string; steps: Step[]; environment?: string }>;
  };
  const publish = workflow.jobs.republish!;
  const preview = workflow.jobs.preview!;
  /** The steps a passing run on `ref` with `inputs` takes, in order; null when the job does not start. */
  const ranSteps = (
    ref: string,
    inputs: Record<string, unknown>,
    repository = releaseSource.repository,
  ): Step[] | null => {
    const contexts = { github: { ref, repository }, inputs };
    const active = [publish, preview].filter((job) => workflowValue(job.if, contexts) === true);
    expect(active.length).toBeLessThanOrEqual(1);
    const [job] = active;
    if (!job) return null;
    const outcomes: Record<string, { outcome: string }> = {};
    const ran: Step[] = [];
    for (const candidate of job.steps) {
      const runs =
        candidate.if === undefined ||
        workflowValue(candidate.if, { ...contexts, steps: outcomes }) === true;
      if (candidate.id) outcomes[candidate.id] = { outcome: runs ? "success" : "skipped" };
      if (runs) ran.push(candidate);
    }
    return ran;
  };
  const names = (steps: Step[] | null) => (steps ?? []).map((each) => each.id ?? each.name);
  const PUSHES = /publish-tap\.sh (live|republish)\b(?!-)|git push/;
  const TOKEN = /secrets\./;

  it("runs when what the casks are written from reaches main, and on demand, never on a pull request", () => {
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(workflow.on.push?.paths).toEqual(
      expect.arrayContaining([
        ".github/workflows/republish-casks.yml",
        "packaging/alpha-notice.txt",
        "scripts/publish-tap.sh",
        "scripts/tap-publication.ts",
        "src/core/update/tapPublication.ts",
        "src/core/update/updateChannels.ts",
        "src/core/update/releaseBuilds.ts",
      ]),
    );
    for (const path of workflow.on.push?.paths ?? []) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
    expect(workflow.on.workflow_dispatch?.inputs.dry_run).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "republish-casks", "cancel-in-progress": false });
  });

  // INF-621: a cask proof may use the disposable image, but the override
  // must never move a publishing job away from its normal runner.
  it("allows an isolated runner only for a dry run", () => {
    expect(workflow.on.workflow_dispatch?.inputs.mac_runner).toMatchObject({
      type: "string",
      required: false,
    });
    const runner = (inputs: Record<string, unknown>, vars: Record<string, string>) =>
      workflowValue((inputs.dry_run ? preview : publish)["runs-on"], { inputs, vars });
    expect(
      runner({ dry_run: true, mac_runner: "mini-mac-inf621-proof" }, { MAC_RUNNER: "mini-mac" }),
    ).toBe("mini-mac-inf621-proof");
    expect(
      runner({ dry_run: false, mac_runner: "mini-mac-inf621-proof" }, { MAC_RUNNER: "mini-mac" }),
    ).toBe("mini-mac");
    expect(runner({}, { MAC_RUNNER: "mini-mac" })).toBe("mini-mac");
    expect(runner({ dry_run: true }, {})).toBe("macos-15");
  });

  it("republishes only from main, with the tap token in one step, and a dry run anywhere pushes nothing", () => {
    expect(publish.environment).toBe("desktop-release");
    expect(preview.environment).toBeUndefined();
    // A push to main carries no inputs; a live run on demand says dry_run false.
    for (const inputs of [{}, { dry_run: false }]) {
      const ran = ranSteps("refs/heads/main", inputs);
      expect(names(ran)).toContain("tap");
      expect(names(ran)).not.toContain("tap-rehearsal");
      expect(
        names((ran ?? []).filter((each) => TOKEN.test(JSON.stringify(each.env ?? {})))),
      ).toEqual(["tap"]);
      expect((ran ?? []).find((each) => each.id === "tap")?.run).toMatch(
        /scripts\/publish-tap\.sh republish \|/,
      );
    }
    for (const ref of ["refs/heads/main", "refs/heads/a-branch"]) {
      const ran = ranSteps(ref, { dry_run: true });
      expect(names(ran)).toEqual(
        expect.arrayContaining(["tap-rehearsal", "Keep the rehearsed casks", "Summarize"]),
      );
      expect(names(ran)).not.toContain("tap");
      for (const each of ran ?? []) {
        expect(each.run ?? "", each.name).not.toMatch(PUSHES);
        expect(JSON.stringify(each.env ?? {}), each.name).not.toMatch(TOKEN);
      }
    }
    // Any other ref may only rehearse: a live run there does not start.
    expect(ranSteps("refs/heads/a-branch", { dry_run: false })).toBeNull();
    expect(ranSteps("refs/heads/a-branch", {})).toBeNull();
    // Nor does a push to the Firstmate 3000 repository's main, before it is
    // archived (FI3-1780 step 11): only Infinitary's own repository writes
    // Infinitary's tap, and Firstmate 3000's casks move only with a release.
    expect(ranSteps("refs/heads/main", {}, "kunchenguid/firstmate-3000")).toBeNull();
    expect(
      names(ranSteps("refs/heads/main", { dry_run: true }, "kunchenguid/firstmate-3000")),
    ).toContain("tap-rehearsal");
  });
});

// Captain's "Prepare reuse": selecting old copies must skip the signing job,
// not skip either installed-check job or silently select a fresh build.
it("selects only the complete installed checks for reuse, without a signing job", () => {
  type Job = {
    if?: string;
    with?: Record<string, string>;
    steps?: { id?: string; name?: string; if?: string; run?: string; uses?: string }[];
  };
  const installer = loadYamlFile(".github/workflows/mac-installer.yml") as {
    jobs: Record<string, Job>;
  };
  const verify = loadYamlFile(".github/workflows/verify.yml") as { jobs: Record<string, Job> };
  const selected = (job: Job | undefined, contexts: Record<string, unknown>) => {
    if (!job) throw new Error("The verification job is missing");
    return Boolean(workflowValue(job.if ?? "${{ true }}", contexts));
  };
  // A fresh build checks its own copies in its job; reused copies get the
  // installed job, with the same check.
  const checks = (job: Job | undefined) =>
    (job?.steps ?? []).filter((step) => step.run?.includes("scripts/check-installed-updates.mjs"));
  expect(checks(installer.jobs.build)).toHaveLength(1);
  expect(checks(installer.jobs.installed)).toHaveLength(1);
  for (const reuse of ["", "reviewed declaration"]) {
    const inputs = { reuse };
    const github = { repository: "infinitary-labs/infinitary", ref: "refs/heads/inf/rehearsal" };
    expect(selected(installer.jobs.build, { inputs, github })).toBe(!reuse);
    expect(
      selected(installer.jobs.installed, {
        inputs,
        needs: { build: { result: reuse ? "skipped" : "success" } },
      }),
    ).toBe(Boolean(reuse));
    expect(
      selected(installer.jobs.installed, { inputs, needs: { build: { result: "failure" } } }),
    ).toBe(false);
  }
  // The reuse check reads the build's signing step by this name.
  expect(installer.jobs.build?.steps?.find((step) => step.id === "fixtures")).toMatchObject({
    name: SIGNED_BUILD_STEP,
  });
  const source = "28114f4d9a20fee71369281701e2601315a24601";
  const github = {
    repository: "infinitary-labs/infinitary-apps",
    sha: source,
    ref: "refs/heads/main",
  };
  expect(selected(installer.jobs.build, { github, inputs: { reuse: "", ref: source } })).toBe(true);
  expect(
    selected(installer.jobs.build, { github, inputs: { reuse: "", ref: "inf/rehearsal" } }),
  ).toBe(false);
  expect(
    selected(installer.jobs.build, {
      github: { ...github, ref: "refs/heads/inf/rehearsal" },
      inputs: { reuse: "", ref: source },
    }),
  ).toBe(false);
  expect(
    selected(installer.jobs.build, { github, inputs: { reuse: "verified artifact", ref: source } }),
  ).toBe(false);
  const release = loadYamlFile(".github/workflows/release.yml") as { jobs: Record<string, Job> };
  const gate = release.jobs["signed-installer"];
  const needs = { resolve: { outputs: { installer_source: source, trigger: "Automatic alpha" } } };
  expect(selected(gate, { needs })).toBe(true);
  const ref = workflowValue(gate?.with?.ref ?? "", { needs });
  expect(ref).toBe(source);
  const workflow_ref = `${github.repository}/.github/workflows/release.yml@refs/heads/main`;
  expect(
    selected(installer.jobs.build, {
      github: { ...github, sha: "newer main", workflow_ref },
      inputs: { reuse: "", ref },
    }),
  ).toBe(true);
  expect(
    selected(installer.jobs.build, {
      github: {
        ...github,
        sha: "newer main",
        workflow_ref: workflow_ref.replace("release.yml", "verify.yml"),
      },
      inputs: { reuse: "", ref },
    }),
  ).toBe(false);
  for (const installer_only of [false, true]) {
    const reused = {
      inputs: { installer_only, installer_reuse: "reviewed declaration", ref: "reviewed source" },
    };
    for (const name of ["lane", "linux-tests", "linux-e2e"])
      expect(selected(verify.jobs[name], reused)).toBe(false);
    expect(selected(verify.jobs.installer, reused)).toBe(true);
    expect(workflowValue(verify.jobs.installer?.with?.reuse ?? "", reused)).toBe(
      reused.inputs.installer_reuse,
    );
  }
});

// DOP-42 supplies the virtual-only label for INF-643's approved signed rerun.
// A real-Mac setting cannot redirect these.
it("keeps installer verification on the selected disposable runners", () => {
  const { jobs } = loadYamlFile(".github/workflows/mac-installer.yml") as {
    jobs: {
      build: { "runs-on": string };
      installed: { name: string; "runs-on": string };
    };
  };
  const vars = { MAC_RUNNER: "mini-mac-real", REAL_MAC_RUNNER: "mini-mac-real" };
  expect(workflowString(jobs.build["runs-on"], { vars, inputs: {} })).toBe("mini-mac-virtual");
  expect(workflowString(jobs.installed["runs-on"], { vars })).toBe("mini-mac-virtual");
  // The check name PR readings and diagnoses are keyed to, with its caller's
  // trigger (docs/testing.md, "CI job names").
  expect(workflowString(jobs.installed.name, { inputs: { trigger: "Manual request" } })).toBe(
    "Manual request · Install and update (Mac; Apple silicon)",
  );
});

// INF-1900 direction D: the release's update check runs in a disposable
// Apple silicon Mac once the signing job handed off, updating to the
// release's own signed zip. The captain: Intel is a best-effort side effect,
// with no hosted Mac runs. The promotion gate reads its job by this name.
it("runs the update check on Apple silicon only, updating from the signing job's handoff", () => {
  const { jobs } = loadYamlFile(".github/workflows/mac-update.yml") as {
    jobs: Record<string, { name: string; "runs-on": string; strategy?: unknown }>;
  };
  expect(
    Object.values(jobs).map((job) => [
      workflowString(job.name, { inputs: { trigger: "Automatic alpha" } }),
      workflowValue(job["runs-on"], { inputs: {}, vars: {} }),
      job.strategy,
    ]),
  ).toEqual([
    [
      "Automatic alpha · Apply published-alpha update (Mac; Apple silicon)",
      "mini-mac-virtual",
      undefined,
    ],
  ]);
  const release = loadYamlFile(".github/workflows/release.yml") as {
    jobs: Record<
      string,
      {
        name: string;
        uses?: string;
        secrets?: unknown;
        with?: Record<string, string>;
        outputs?: Record<string, string>;
      }
    >;
  };
  // INF-2499: the update after signing is the release's only update check.
  const callers = Object.entries(release.jobs).filter(
    ([, job]) => job.uses === "./.github/workflows/mac-update.yml",
  );
  expect(callers.map(([id]) => id)).toEqual(["update"]);
  const [[, update]] = callers as [[string, (typeof release.jobs)[string]]];
  expect(update.secrets).toBeUndefined();
  // It fetches only the zip's artifact of the signing job's handoff (INF-3193).
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
  expect(update.with?.handoff_id).toBe("${{ needs.release.outputs.handoff_zip_id }}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
  expect(update.with?.zip_sha256).toBe("${{ needs.release.outputs.sha256 }}");
  expect(update.with?.trigger).toBe(release.jobs.verify?.with?.trigger);
  // The trigger is the resolve job's output (INF-2539), read into this name.
  const trigger = workflowString(release.jobs.resolve?.outputs?.trigger ?? "", {
    github: { event_name: "workflow_dispatch" },
    // What main.yml's last job dispatches an automatic alpha with (INF-3738).
    inputs: {
      channel: "alpha",
      candidate: "a".repeat(40),
      main_run: "43086357186",
      main_run_number: "541",
    },
  });
  expect(workflowString(update.name, { needs: { resolve: { outputs: { trigger } } } })).toBe(
    "Automatic alpha · Published-alpha update check",
  );
});

// INF-5571: the captain chose "Apple silicon only" for the signed installer
// check, so every caller - a release and a request alike - runs one installed
// check, on Apple silicon, and no Intel Mac.
it("runs the installed check on Apple silicon only, for every caller", () => {
  type Job = { "runs-on"?: string; strategy?: unknown; steps?: { run?: string }[] };
  const installer = loadYamlFile(".github/workflows/mac-installer.yml") as {
    on: { workflow_call: { inputs: Record<string, unknown> } };
    jobs: Record<string, Job>;
  };
  const verify = loadYamlFile(".github/workflows/verify.yml") as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    jobs: { installer: { with: Record<string, string> } };
  };
  expect(Object.keys(installer.jobs)).toEqual(["build", "installed"]);
  const installed = installer.jobs.installed;
  expect(installed?.strategy).toBeUndefined();
  const queues = { MAC_QUEUES: JSON.stringify({ light: "q-light" }) };
  expect(workflowString(installed?.["runs-on"] ?? "", { vars: queues })).toBe("q-light");
  for (const job of [installed, installer.jobs.build])
    expect(job?.steps?.some((step) => step.run?.includes('process.arch !== "arm64"'))).toBe(true);
  // No caller can ask for a chip any more.
  expect(installer.on.workflow_call.inputs).not.toHaveProperty("chip");
  expect(verify.on.workflow_dispatch.inputs).not.toHaveProperty("installer_chip");
  expect(verify.jobs.installer.with).not.toHaveProperty("chip");
});

describe("the private alpha (roadmap 1.2)", () => {
  it("publishes the selected source's finalized downloads and verifies them without a sign-in", () => {
    const workflow = loadYamlFile(".github/workflows/release.yml") as {
      jobs: Record<
        "release" | "upload" | "publish",
        { env: Record<string, string>; steps: { id?: string; env?: Record<string, string> }[] }
      >;
    };
    const job = workflow.jobs.release;
    const publication = workflow.jobs.publish;
    const context = {
      needs: {
        resolve: {
          outputs: {
            release_repository: releaseSource.repository,
            tag_name: "v1.2.3",
            public_tag: "infinitary-v1.2.3",
            zip_name: "Infinitary-1.2.3-universal.zip",
          },
        },
      },
    };
    expect(workflowValue(job.env.TAG_NAME ?? "", context)).toBe("v1.2.3");
    expect(workflowValue(job.env.RELEASE_REPOSITORY ?? "", context)).toBe(releaseSource.repository);
    // The public tag belongs to the tap steps alone (INF-2539's audit): the
    // jobs' own environment carries the private tag under one name.
    expect(job.env.PUBLIC_TAG).toBeUndefined();
    const taps = workflow.jobs.upload.steps.filter((step) => step.env?.PUBLIC_TAG !== undefined);
    expect(taps.map((step) => step.id)).toEqual(["adopt", "upload"]);
    for (const step of taps)
      expect(workflowValue(step.env?.PUBLIC_TAG ?? "", context), step.id).toBe("infinitary-v1.2.3");
    // The upload and publication jobs publish under the same names (INF-1716).
    expect(publication.env).toEqual(job.env);
    for (const [name, value] of Object.entries(workflow.jobs.upload.env))
      expect(value, name).toBe(job.env[name]);
    // Cloudflare's copies are fetched back from the job's own DOWNLOAD_URL,
    // the address published under that name; the fetch-back gives the token
    // only to the record's reader (tests/release-workflows-handoff.test.ts).
    const fetchBack = publication.steps.find((step) => step.id === "fetch-back");
    expect(fetchBack).toBeDefined();
    expect(Object.keys(fetchBack?.env ?? {})).not.toContain("DOWNLOAD_URL");
  });
});

describe("the Linux packages", () => {
  // INF-2163's retention change, which the captain started: a passing
  // journey run keeps its result file, demos and requested picture evidence, and a failed phone
  // check keeps its result bundles 1 day, a recording run 3.
  it("keeps a passing journey run's results and evidence, and a failed phone check's bundles 1 day", () => {
    type Step = { if?: string; uses?: string; with?: Record<string, unknown> };
    const source = loadYamlFile(".github/workflows/source-journeys.yml") as {
      jobs: { "source-desktop": { steps: Step[] } };
    };
    const uploads = source.jobs["source-desktop"].steps.filter((step) =>
      String(step.with?.name ?? "").startsWith("source-desktop-"),
    );
    const kept = (outcome: string) =>
      uploads
        .filter((step) => workflowValue(step.if ?? "", { steps: { journeys: { outcome } } }))
        .map((step) => String(step.with?.path).trim().split("\n"));
    expect(kept("success")).toEqual([
      [
        "Application Support/firstmate/playwright-report/source-results.json",
        "Application Support/firstmate/test-results/runs/*/*/demo/",
        "Application Support/firstmate/test-results/runs/*/*/evidence/",
      ],
    ]);
    for (const outcome of ["failure", "cancelled", "skipped"]) {
      expect(kept(outcome)).toHaveLength(1);
      expect(kept(outcome)[0]).toContain("Application Support/firstmate/test-results/");
    }
    const phone = loadYamlFile(".github/workflows/phone.yml") as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    // A device's job may name its uploads by its matrix device (INF-2970's fix 1), and the shared
    // app build by its run attempt, so each name is read as the iPhone's first attempt reads it;
    // the bundles are the upload the gathering job's phone-results* pattern collects.
    const bundles = Object.values(phone.jobs)
      .flatMap((job) => job.steps ?? [])
      .find(
        (step) =>
          step.uses?.startsWith("actions/upload-artifact") &&
          workflowString(String(step.with?.name ?? ""), {
            inputs: {},
            matrix: { device: "iphone" },
            github: { run_attempt: 1 },
          }).startsWith("phone-results"),
      );
    const days = (recording: boolean) =>
      workflowValue(String(bundles?.with?.["retention-days"]), { inputs: { recording } });
    expect([days(false), days(true)]).toEqual([1, 3]);
  });

  // INF-2834's chosen fix: every push to a pull request re-ran every package
  // check, so no pull request starts it; a task requests it once, at its
  // final version, as it requests its edited journeys.
  it("runs only on request or inside a release, never on a pull request", () => {
    const workflow = loadYamlFile(".github/workflows/linux-packages.yml") as {
      on: Record<string, unknown>;
    };
    expect(Object.keys(workflow.on).toSorted()).toEqual(["workflow_call", "workflow_dispatch"]);
  });

  it("checks each package on a clean copy of its system and keeps the files on the run alone", () => {
    const workflow = loadYamlFile(".github/workflows/linux-packages.yml") as {
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          strategy?: { matrix: { include: Array<Record<string, string>> } };
          steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    expect(workflow.permissions).toEqual({ contents: "read" });
    const text = read(".github/workflows/linux-packages.yml");
    expect(text).not.toMatch(/gh release|softprops|--publish always|publish-release-asset/);
    const upload = workflow.jobs.build?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    // INF-1838: keep the same-run package handoff, not weeks of large binaries.
    // INF-2163's retention change: a pull request's packages 1 day, a release's 3.
    // Since INF-2834 a pull request's packages come from its task's request.
    expect(upload?.with?.name).toBe("linux-packages");
    const kept = (inputs: Record<string, string>) =>
      workflowValue(String(upload?.with?.["retention-days"]), { inputs });
    const { version } = JSON.parse(read("package.json")) as { version: string };
    // A request names no version; a release names the version it publishes.
    expect([kept({}), kept({ version })]).toEqual([1, 3]);
    const systems = (workflow.jobs.check?.strategy?.matrix.include ?? []).map(
      (entry) => `${entry.system} ${entry.image ?? entry.runner}`,
    );
    expect(systems).toEqual([
      "ubuntu-host ubuntu-24.04",
      "ubuntu-host ubuntu-26.04",
      "ubuntu ubuntu:24.04",
      "ubuntu ubuntu:26.04",
      "fedora fedora:latest",
      "arch archlinux:latest",
      "appimage fedora:latest",
      "nix ubuntu-24.04",
    ]);
  });
});

// INF-1613's submitted unblock answer: absent storage never stops a stable's tap
// release; partial configuration is an error, not an accidental silent installer
// opt-out. An alpha's Windows installer reaches testers only through storage
// (INF-5230's plan), so a live alpha without it refuses before anything is signed.
it("selects Homebrew/Linux-only for a stable before storage setup, refuses an alpha without storage and partial R2 configuration", () => {
  const workflow = loadYamlFile(".github/workflows/release.yml") as {
    jobs: { release: { steps: { id?: string; run?: string }[] } };
  };
  const command = workflow.jobs.release.steps.find((step) => step.id === "visibility")?.run;
  if (!command) throw new Error("Missing download activation command");
  for (const channel of ["stable", "alpha"])
    for (const configuration of ["absent", "complete", "partial"]) {
      const folder = scratchDir("infinitary-r2-activation-");
      const output = join(folder, "output");
      const result = spawnSync("bash", ["-e", "-c", command], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          CHANNEL: channel,
          R2_ENDPOINT: configuration === "absent" ? "" : "https://account.r2.cloudflarestorage.com",
          R2_BUCKET: configuration === "absent" ? "" : "installers",
          HAS_ACCESS_KEY: configuration === "absent" ? "false" : "true",
          HAS_SECRET_KEY: configuration === "complete" ? "true" : "false",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: join(folder, "summary"),
        },
      });
      if (configuration === "partial") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Incomplete download storage configuration");
      } else if (configuration === "absent" && channel === "alpha") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Download storage is not configured");
        expect(existsSync(output)).toBe(false);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(`direct=${configuration === "complete"}\n`);
      }
    }
});

// The trial release in the new project found the signing step's credentials
// empty: a called workflow reads its job environment's credentials only when
// its caller hands its secrets on, and the release passed none. The build reads
// its credentials from mac-installer-signing (docs/public-ci.md), the
// certificate of the team releases sign with.
it("signs the installer test copies with its own environment's credentials", () => {
  const installer = loadYamlFile(".github/workflows/mac-installer.yml") as {
    on: { workflow_call: { secrets?: unknown } };
    jobs: {
      build: {
        environment?: string;
        env: Record<string, string>;
        steps: { env?: Record<string, string> }[];
      };
    };
  };
  expect(installer.on.workflow_call.secrets).toBeUndefined();
  expect(installer.jobs.build.environment).toBe("mac-installer-signing");
  const read = installer.jobs.build.steps.flatMap((step) =>
    Object.values(step.env ?? {}).flatMap((value) =>
      [...value.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]),
    ),
  );
  const team =
    SIGNING_TEAMS[
      (JSON.parse(readFileSync("packaging/release-identity.json", "utf8")) as { teamId: string })
        .teamId
    ];
  expect(read).toContain(`${team?.secrets}MAC_DEVELOPER_ID_CERT_P12`);
  expect(installer.jobs.build.env.SIGN_IDENTITY).toBe(team?.identity);
  for (const caller of ["release.yml", "verify.yml"]) {
    const { jobs } = loadYamlFile(`.github/workflows/${caller}`) as {
      jobs: Record<string, { uses?: string; secrets?: unknown }>;
    };
    for (const job of Object.values(jobs).filter(
      (job) => job.uses === "./.github/workflows/mac-installer.yml",
    ))
      expect(job.secrets).toBe("inherit");
  }
});
