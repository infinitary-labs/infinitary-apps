import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CheckEnv, check, damage, parseSums } from "../scripts/linux-package-sums.ts";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";
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

const action = loadYamlFile(".github/actions/linux-packages/action.yml") as {
  inputs: Record<string, { required?: boolean }>;
  runs: { using: string; steps: Step[] };
};

/** One download as actions/download-artifact leaves it: whole, cut short, or failed outright. */
type Download = "whole" | "cut-short" | "failed";

/**
 * The action's steps run in order for one job, each download leaving the
 * copy `downloads` names, its conditions read as GitHub Actions reads them
 * and its shell steps run as the check script they call. Answers whether the
 * job goes on to install, and what it printed.
 */
function fetchInJob(downloads: Download[]): {
  passed: boolean;
  fetches: number;
  lines: string[];
  installed: string | undefined;
} {
  const build = built();
  const path = join(scratchDir("linux-package-job-"), "linux-packages");
  const inputs = { sums: build.sums, path };
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
    if (step.uses === "actions/download-artifact@v4") {
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
      expect([step.shell, step.run]).toEqual(["bash", "node scripts/linux-package-sums.ts check"]);
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
    const fetch = steps.findIndex((step) => step.uses === "./.github/actions/linux-packages");
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
    // The install step reads the packages from the same folder.
    const read = steps[install]?.run ?? "";
    expect(read).toContain('"$RUNNER_TEMP/linux-packages"');
    expect(given).toEqual({ sums: list, path: "/runner/temp/linux-packages" });
  });
});
