import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type CheckEnv, check, damage, parseSums } from "../scripts/linux-package-sums.ts";
import { writeRelease } from "../scripts/linux-recipes.ts";
import {
  loadYamlFile,
  PUBLISHES,
  root,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2878: run 42292187705's Ubuntu 24.04 container job installed a copy of
// the Ubuntu package that its download step had cut short while reporting
// success, and apt failed with "Invalid archive member header". Each check
// job now compares its copy with the build's own SHA256SUMS before
// installing, fetches a damaged copy once more, and fails naming each file
// when the second copy is damaged too.

const DEB = "infinitary-0.1.30-linux-amd64.deb";
const RPM = "infinitary-0.1.30-x86_64.rpm";
const APPIMAGE = "infinitary-0.1.30-linux-x86_64.AppImage";
const FILES: Record<string, string> = {
  [DEB]: "!<arch>\ndebian-binary   ".repeat(4096),
  [RPM]: "rpm bytes ".repeat(2048),
  [APPIMAGE]: "appimage bytes ".repeat(8192),
  "aur/PKGBUILD": "pkgname=infinitary-bin\n",
  "nix/package.nix": "{ stdenv }: stdenv.mkDerivation { }\n",
};

/** The build's folder and its SHA256SUMS, written as `sha256sum` writes it. */
function built(): { dir: string; sums: string } {
  const dir = scratchDir("linux-package-sums-");
  const lines: string[] = [];
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
    lines.push(`${createHash("sha256").update(text).digest("hex")}  ${file}\n`);
  }
  const sums = lines.join("");
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  // A job output keeps no final newline.
  return { dir, sums: sums.trimEnd() };
}

/** A copy of the build's folder, as a download would leave it. */
function copied(from: string): string {
  const dir = join(scratchDir("linux-package-copy-"), "linux-packages");
  cpSync(from, dir, { recursive: true });
  return dir;
}

function run(env: CheckEnv): { code: number; lines: string[]; whole: string | undefined } {
  const output = join(scratchDir("linux-package-output-"), "output");
  writeFileSync(output, "");
  const lines: string[] = [];
  const code = check({ ...env, GITHUB_OUTPUT: output }, (line) => lines.push(line));
  const whole = /^whole=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1];
  return { code, lines, whole };
}

describe("a check job's copy of the Linux packages", () => {
  it("passes a whole copy and keeps it", () => {
    const build = built();
    const dir = copied(build.dir);
    expect(damage(dir, build.sums)).toEqual([]);
    const { code, lines, whole } = run({
      PACKAGES: dir,
      SUMS: build.sums,
      ATTEMPT: "first",
      FINISHED: dir,
    });
    expect([code, whole]).toEqual([0, "true"]);
    expect(lines.join("\n")).toContain(
      `${DEB}, ${RPM}, ${APPIMAGE}, aur/PKGBUILD, nix/package.nix, SHA256SUMS`,
    );
    expect(existsSync(join(dir, DEB))).toBe(true);
  });

  it("names a cut-short first copy, says the download stopped early, and clears it for the next fetch", () => {
    const build = built();
    const dir = copied(build.dir);
    truncateSync(join(dir, DEB), 1000);
    const { code, lines, whole } = run({
      PACKAGES: dir,
      SUMS: build.sums,
      ATTEMPT: "first",
      FINISHED: "",
    });
    expect([code, whole]).toEqual([0, "false"]);
    expect(lines).toHaveLength(1);
    const [line] = lines as [string];
    expect(line).toMatch(/^::warning title=Damaged download%2C fetched again::/);
    expect(line).toContain(`${DEB} differs: 1000 bytes with SHA-256 `);
    expect(line).toContain("The download step stopped before it finished");
    expect(line).toContain("the job fetches the packages again");
    expect(line).not.toContain(RPM);
    expect(existsSync(dir)).toBe(false);
  });

  it("fails on a damaged second copy, naming every file and that the download itself finished", () => {
    const build = built();
    const dir = copied(build.dir);
    rmSync(join(dir, RPM));
    writeFileSync(join(dir, "nix/package.nix"), "{ }: null\n");
    writeFileSync(join(dir, "SHA256SUMS"), "");
    const { code, lines, whole } = run({
      PACKAGES: dir,
      SUMS: build.sums,
      ATTEMPT: "again",
      FINISHED: dir,
    });
    expect([code, whole]).toEqual([1, "false"]);
    const [line] = lines as [string];
    expect(line).toMatch(/^::error title=Damaged download%2C twice::/);
    expect(line).toContain(`${RPM} is missing`);
    expect(line).toContain("nix/package.nix differs: ");
    expect(line).toContain("SHA256SUMS differs from the build's list");
    expect(line).toContain("The download step finished, so the copy changed on its way here");
    expect(line).toContain("Nothing was installed");
    expect(existsSync(dir)).toBe(true);
  });

  it("names a copy that lost its own SHA256SUMS", () => {
    const build = built();
    const dir = copied(build.dir);
    rmSync(join(dir, "SHA256SUMS"));
    expect(damage(dir, build.sums)).toEqual(["SHA256SUMS is missing"]);
  });

  it("refuses to pass a copy when the build passed no list, or one it cannot read", () => {
    const build = built();
    const dir = copied(build.dir);
    for (const sums of [
      "",
      "   \n",
      "not a checksum",
      `${"0".repeat(64)}  ../outside`,
      `${"0".repeat(64)}  /etc/passwd`,
    ]) {
      const { code, lines, whole } = run({
        PACKAGES: dir,
        SUMS: sums,
        ATTEMPT: "first",
        FINISHED: dir,
      });
      expect([code, whole], sums).toEqual([1, undefined]);
      expect(lines[0], sums).toMatch(/^::error title=No list to check the packages against::/);
    }
    expect(existsSync(join(dir, DEB))).toBe(true);
    expect(() => parseSums(`${"a".repeat(64)} *${DEB}`)).not.toThrow();
  });
});

type Step = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
};

const ACTION = ".github/actions/linux-packages";
const action = loadYamlFile(`${ACTION}/action.yml`) as {
  inputs: Record<string, { required?: boolean }>;
  runs: { using: string; steps: Step[] };
};

/**
 * The repository file a check step of the action runs, as the shell finds it
 * from GITHUB_ACTION_PATH, the folder the job checked the action out in.
 */
function scriptOf(step: Step): string | undefined {
  const [, path, command] =
    /^node "\$GITHUB_ACTION_PATH\/([^"]+)" (\w+)$/.exec(step.run ?? "") ?? [];
  if (path === undefined || command !== "check") return undefined;
  return relative(root, resolve(root, ACTION, path));
}

/** One download as actions/download-artifact leaves it: whole, cut short, or failed outright. */
type Download = "whole" | "cut-short" | "failed";

/**
 * The action's steps run in order for one job, each download leaving the
 * copy `downloads` names, its conditions read as GitHub Actions reads them
 * and its shell steps run as the check script they call. `given` is the
 * build and the inputs the job's step passes, a check job's by default.
 * Answers whether the job goes on to install, and what it printed.
 */
function fetchInJob(
  downloads: Download[],
  given?: { build: ReturnType<typeof built>; inputs: { sums: string; path: string } },
): {
  passed: boolean;
  fetches: number;
  lines: string[];
  installed: string | undefined;
} {
  const build = given?.build ?? built();
  const inputs = given?.inputs ?? {
    sums: build.sums,
    path: join(scratchDir("linux-package-job-"), "linux-packages"),
  };
  const { path } = inputs;
  const steps: Record<string, { outcome: string; outputs: Record<string, string> }> = {};
  const lines: string[] = [];
  let failed = false;
  let fetches = 0;
  for (const step of action.runs.steps) {
    const status = { success: !failed, failure: failed, always: true, cancelled: false };
    const condition =
      step.if === undefined
        ? !failed
        : workflowValue(`success() && (${step.if})`, { steps, inputs }, status);
    if (condition !== true) continue;
    const outputs: Record<string, string> = {};
    let ok = true;
    if (step.uses?.startsWith("actions/download-artifact@")) {
      expect(step.with?.name).toBe("linux-packages");
      // The download lands where the step says, which must be the job's folder.
      const into = workflowString(step.with?.path ?? "", { inputs });
      expect(into).toBe(path);
      const download = downloads[fetches++] ?? "whole";
      if (download !== "failed") {
        mkdirSync(join(into, ".."), { recursive: true });
        cpSync(build.dir, into, { recursive: true });
      }
      if (download === "whole") outputs["download-path"] = into;
      if (download === "cut-short") truncateSync(join(into, DEB), 4096);
      ok = download !== "failed";
    } else {
      // The script beside the action, wherever the job checked the action out.
      expect([step.shell, scriptOf(step)]).toEqual(["bash", "scripts/linux-package-sums.ts"]);
      const env = Object.fromEntries(
        Object.entries(step.env ?? {}).map(([name, value]) => [
          name,
          workflowString(value, { steps, inputs }),
        ]),
      );
      const output = join(scratchDir("linux-package-output-"), "output");
      writeFileSync(output, "");
      ok = check({ ...env, GITHUB_OUTPUT: output }, (line) => lines.push(line)) === 0;
      for (const [, name, value] of readFileSync(output, "utf8").matchAll(/^(\w+)=(.*)$/gm))
        outputs[name as string] = value as string;
    }
    if (step.id) steps[step.id] = { outcome: ok ? "success" : "failure", outputs };
    if (!ok && step["continue-on-error"] !== true) failed = true;
  }
  const installed =
    !failed && existsSync(join(path, DEB)) ? readFileSync(join(path, DEB), "utf8") : undefined;
  return { passed: !failed, fetches, lines, installed };
}

describe("the check job's fetch of the Linux packages", () => {
  it("takes the build's list and the folder, and runs as a composite action", () => {
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs).toSorted()).toEqual(["path", "sums"]);
  });

  it("fetches once when the first copy is whole", () => {
    const job = fetchInJob(["whole"]);
    expect([job.passed, job.fetches]).toEqual([true, 1]);
    expect(job.installed).toBe(FILES[DEB]);
    expect(job.lines.some((line) => line.startsWith("::"))).toBe(false);
  });

  it("fetches again after a copy cut short, and goes on with the whole second copy", () => {
    const job = fetchInJob(["cut-short", "whole"]);
    expect([job.passed, job.fetches]).toEqual([true, 2]);
    expect(job.installed).toBe(FILES[DEB]);
    expect(job.lines[0]).toMatch(
      /^::warning title=Damaged download%2C fetched again::.*stopped before it finished/,
    );
    expect(job.lines[1]).toMatch(/^Every file of this copy matches/);
  });

  it("fetches again after a download that failed outright", () => {
    const job = fetchInJob(["failed", "whole"]);
    expect([job.passed, job.fetches]).toEqual([true, 2]);
    expect(job.lines[0]).toContain(`${DEB} is missing`);
  });

  it("stops the job before anything installs when the second copy is damaged too", () => {
    const job = fetchInJob(["cut-short", "cut-short"]);
    expect([job.passed, job.fetches, job.installed]).toEqual([false, 2, undefined]);
    expect(job.lines[1]).toMatch(
      /^::error title=Damaged download%2C twice::.*infinitary-0\.1\.30-linux-amd64\.deb differs: 4096 bytes/,
    );
  });

  it("is how every check job of linux-packages.yml gets the packages, with the build's own list", () => {
    const workflow = loadYamlFile(".github/workflows/linux-packages.yml") as {
      jobs: Record<string, { outputs?: Record<string, string>; steps: Step[] }>;
    };
    const { build, check: checkJob } = workflow.jobs as Record<
      string,
      { outputs?: Record<string, string>; steps: Step[] }
    >;
    // The list the build's files step wrote reaches each check job as the build's output.
    const list = built().sums;
    const sums = workflowString(build?.outputs?.sums ?? "", {
      steps: { files: { outputs: { sums: list } } },
    });
    expect(sums).toBe(list);
    const steps = checkJob?.steps ?? [];
    // The workflow's own copy of the action (tests/release-workflows-linux-actions.test.ts).
    const fetch = steps.findIndex((step) => step.uses === `./.release-tooling/${ACTION}`);
    const install = steps.findIndex((step) => step.name === "Install, open and run a crew turn");
    expect(fetch).toBeGreaterThan(-1);
    expect(fetch).toBeLessThan(install);
    expect(steps.filter((step) => step.uses?.startsWith("actions/download-artifact"))).toEqual([]);
    const contexts = { needs: { build: { outputs: { sums } } }, runner: { temp: "/runner/temp" } };
    const given = Object.fromEntries(
      Object.entries(steps[fetch]?.with ?? {}).map(([name, value]) => [
        name,
        workflowString(value, contexts),
      ]),
    );
    const read = steps[install]?.run ?? "";
    expect(read).toContain('"$RUNNER_TEMP/linux-packages"');
    expect(given).toEqual({ sums: list, path: "/runner/temp/linux-packages" });
  });
});

// INF-2879: release.yml's upload job, and a rehearsal's publication job,
// fetched the same artifact with no check and rendered SHA256SUMS from
// whatever arrived, so a copy cut short as run 42292187705's was would have
// published a damaged Ubuntu package with a list that matched it. Each now
// fetches through the same action, against the linux job's own list.

type Job = { uses?: string; outputs?: Record<string, string>; steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

const release = loadYamlFile(".github/workflows/release.yml") as Workflow;
const packagesWorkflow = loadYamlFile(".github/workflows/linux-packages.yml") as Workflow & {
  on: { workflow_call: { outputs?: Record<string, { value: string }> } };
};

/**
 * The list a caller of linux-packages.yml reads as `needs.<job>.outputs.sums`:
 * the build's files step wrote `list`, the build job passes it on, and the
 * workflow hands it to its caller.
 */
function listOfLinuxJob(list: string): string {
  const build = workflowString(packagesWorkflow.jobs?.build?.outputs?.sums ?? "", {
    steps: { files: { outputs: { sums: list } } },
  });
  return workflowString(packagesWorkflow.on.workflow_call.outputs?.sums?.value ?? "", {
    jobs: { build: { outputs: { sums: build } } },
  });
}

/** Each release job that fetches the packages, and the step that renders the release's Linux files from them. */
const RELEASE_FETCHES = [
  { job: "upload", renders: "linux-files" },
  { job: "publish", renders: "rehearsal-files" },
] as const;

function releaseFetch(job: string, renders: string) {
  const steps = release.jobs?.[job]?.steps ?? [];
  return {
    steps,
    fetch: steps.findIndex((step) => step.name === "Fetch the Linux packages"),
    render: steps.findIndex((step) => step.id === renders),
    tooling: steps.findIndex((step) => step.with?.path === ".release-tooling"),
  };
}

function releaseInputs(step: Step | undefined, list: string, temp: string): Record<string, string> {
  const contexts = {
    needs: { linux: { outputs: { sums: listOfLinuxJob(list) } } },
    runner: { temp },
  };
  return Object.fromEntries(
    Object.entries(step?.with ?? {}).map(([name, value]) => [
      name,
      workflowString(value, contexts),
    ]),
  );
}

describe("a release's fetch of the Linux packages", () => {
  it("hands the build's own list to the release that calls linux-packages.yml", () => {
    expect(release.jobs?.linux?.uses).toBe("./.github/workflows/linux-packages.yml");
    const list = built().sums;
    expect(listOfLinuxJob(list)).toBe(list);
  });

  for (const { job, renders } of RELEASE_FETCHES)
    it(`checks the ${job} job's copy with the workflow's own action, against the linux job's list, before it renders anything`, () => {
      const { steps, fetch, render, tooling } = releaseFetch(job, renders);
      expect(fetch).toBeGreaterThan(-1);
      expect(steps[fetch]?.uses).toBe(`./.release-tooling/${ACTION}`);
      // The workflow's own copy of the action and of the script it runs, as
      // the launch gate is (INF-1768): a stable checks out an older alpha's
      // commit, which may predate both. It is in place whenever the fetch runs.
      expect([tooling > -1, tooling < fetch, steps[tooling]?.if]).toEqual([true, true, undefined]);
      expect(steps[tooling]).toMatchObject({
        uses: expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/),
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        with: { ref: "${{ github.sha }}", "sparse-checkout-cone-mode": false },
      });
      const sparse = String(steps[tooling]?.with?.["sparse-checkout"]).trim().split("\n");
      const scripts = new Set(action.runs.steps.map(scriptOf).filter((path) => path !== undefined));
      expect(scripts).toEqual(new Set(["scripts/linux-package-sums.ts"]));
      expect(sparse).toEqual(expect.arrayContaining([`${ACTION}/`, ...scripts]));
      const list = built().sums;
      expect(releaseInputs(steps[fetch], list, "/runner/temp")).toEqual({
        sums: list,
        path: "/runner/temp/linux-packages",
      });
      expect(render).toBeGreaterThan(fetch);
      expect(steps[render]?.run).toContain('--packages "$RUNNER_TEMP/linux-packages"');
      expect(steps[fetch]?.if).toBe(steps[render]?.if);
    });

  it("publishes nothing in the upload job before its copy is checked", () => {
    const { steps, fetch } = releaseFetch("upload", "linux-files");
    for (const step of steps.slice(0, fetch))
      expect([step.name, PUBLISHES.test(step.run ?? "")]).toEqual([step.name, false]);
  });

  it("renders the release's Linux files only from a copy that matches the linux job's list", () => {
    const { steps, fetch, render } = releaseFetch("upload", "linux-files");
    // The render step runs only when every step before it succeeded.
    expect(steps[render]?.if).toBeUndefined();
    const scenarios: Array<[Download[], boolean]> = [
      [["whole"], true],
      [["cut-short", "whole"], true],
      [["failed", "whole"], true],
      [["cut-short", "cut-short"], false],
    ];
    for (const [downloads, rendered] of scenarios) {
      const build = built();
      const temp = scratchDir("linux-release-job-");
      const inputs = releaseInputs(steps[fetch], build.sums, temp) as {
        sums: string;
        path: string;
      };
      const job = fetchInJob(downloads, { build, inputs });
      expect(job.passed, downloads.join(", ")).toBe(rendered);
      if (!job.passed) continue;
      // linux-files: node scripts/linux-recipes.ts release --packages "$RUNNER_TEMP/linux-packages" --out "$RUNNER_TEMP/linux-release"
      const out = join(temp, "linux-release");
      writeRelease({ version: "0.1.30", packages: inputs.path, out });
      const published = parseSums(readFileSync(join(out, "SHA256SUMS"), "utf8"));
      const made = parseSums(build.sums);
      for (const file of [DEB, RPM, APPIMAGE])
        expect(published.find((entry) => entry.file === file)?.sha256, file).toBe(
          made.find((entry) => entry.file === file)?.sha256,
        );
    }
  });

  it("is how every workflow and action but its own fetches the Linux packages", () => {
    const fetchers: string[] = [];
    const fetchesPackages = (step: Step) =>
      step.uses?.startsWith("actions/download-artifact") === true &&
      step.with?.name === "linux-packages";
    for (const file of readdirSync(join(root, ".github/workflows")).filter((name) =>
      /\.ya?ml$/.test(name),
    ))
      for (const [name, job] of Object.entries(
        (loadYamlFile(`.github/workflows/${file}`) as Workflow).jobs ?? {},
      ))
        if ((job.steps ?? []).some(fetchesPackages)) fetchers.push(`${file}: ${name}`);
    for (const folder of readdirSync(join(root, ".github/actions"))) {
      const path = `.github/actions/${folder}/action.yml`;
      if (folder === "linux-packages" || !existsSync(join(root, path))) continue;
      const steps = (loadYamlFile(path) as { runs?: { steps?: Step[] } }).runs?.steps ?? [];
      if (steps.some(fetchesPackages)) fetchers.push(path);
    }
    expect(fetchers).toEqual([]);
  });
});
