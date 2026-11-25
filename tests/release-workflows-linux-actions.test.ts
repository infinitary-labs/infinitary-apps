import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contexts,
  expectNothingOfTheSource,
  type Job,
  OWN,
  packageJsonRead,
  runJob,
  SOURCE,
  SOURCE_ELECTRON,
  SOURCE_PNPM,
  type Step,
} from "./helpers/releaseLocalActions";
import { loadYamlFile, workflowString } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// release.yml's linux job calls linux-packages.yml with the release's source
// commit, which for a stable is its alpha's own commit (scripts/resolve-release.sh).
// Alpha 0.6.3-alpha.250's commit predates .github/actions/electron-download
// and .github/actions/linux-packages, which the workflow's jobs used from
// that checkout, so its promotion stopped at a missing action.yml before
// anything published. Each job now takes every local action from the
// workflow's own commit and runs it against the release's source.

const { jobs } = loadYamlFile(".github/workflows/linux-packages.yml") as {
  jobs: Record<string, Job>;
};

describe("linux-packages.yml's local actions in a stable built from an older alpha", () => {
  for (const [name, job] of Object.entries(jobs)) {
    it(`finds every local action of its ${name} job in the workflow's own commit`, () => {
      const { workspace, actions } = runJob(job);
      expect(actions.length).toBeGreaterThan(0);
      for (const { folder } of actions)
        expect(relative(workspace, folder)).toMatch(/^\.release-tooling\/\.github\/actions\//);
    });

    it(`runs nothing of the older source's own in the actions of its ${name} job`, () => {
      const { workspace, actions } = runJob(job);
      expectNothingOfTheSource(workspace, actions);
    });
  }

  it("restores the Electron download of the source it installs, not the workflow's", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const { workspace, actions } = runJob(job);
      const pkg = packageJsonRead(workspace, actions, "electron-download");
      expect([name, pkg.devDependencies.electron]).toEqual([name, SOURCE_ELECTRON]);
    }
  });

  // .github/actions/pnpm reads the version from the package.json in its
  // working-directory (tests/pnpm-action.test.ts runs that step).
  it("sets up the pnpm the source pins, not the workflow's", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const { workspace, actions } = runJob(job);
      const pkg = packageJsonRead(workspace, actions, "pnpm");
      expect([name, pkg.packageManager]).toEqual([name, SOURCE_PNPM]);
    }
  });
});

// The runner's virtual screen is Xvfb alone, which GitHub's hosted Ubuntu
// images hold, so a check downloads nothing for it from the runner's own
// mirrors: an alpha's Arch check failed when Ubuntu's mirror stalled three
// list refreshes for xdotool and ImageMagick. An older check, as a stable
// built from its alpha's commit runs, works the AppImage's screen from the
// runner with both, so that leg still gets them there.
describe("linux-packages.yml's virtual screen", () => {
  const check = jobs.check as Job & {
    strategy: { matrix: { include: Array<{ system: string }> } };
  };
  const systems = [...new Set(check.strategy.matrix.include.map((entry) => entry.system))];
  const install = check.steps.find((step) => step.name === "Install the virtual screen") as
    | (Step & { env?: Record<string, string> })
    | undefined;
  /**
   * The packages the step's shell asks the apt helper for on one leg, with
   * the check's source at `ref`: its environment as GitHub evaluates it, and
   * a stand-in helper that prints what it is given.
   */
  const named = (system: string, ref: string) => {
    const workspace = scratchDir("linux-packages-screen-");
    mkdirSync(join(workspace, "scripts"));
    writeFileSync(join(workspace, "scripts/apt-install.sh"), 'printf "%s\\n" "$@"\n', {
      mode: 0o755,
    });
    const env = Object.fromEntries(
      Object.entries(install?.env ?? {}).map(([name, value]) => [
        name,
        workflowString(value, {
          ...contexts,
          matrix: { system },
          inputs: { ...contexts.inputs, ref },
        }),
      ]),
    );
    const result = spawnSync("bash", ["-e", "-c", String(install?.run)], {
      cwd: workspace,
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.split("\n").filter((arg) => arg !== "" && !arg.startsWith("-"));
  };

  it("asks the runner for Xvfb alone when the check is the workflow's own", () => {
    expect(systems).toContain("appimage");
    for (const system of systems) expect([system, named(system, OWN)]).toEqual([system, ["xvfb"]]);
  });

  it("gives an older source's AppImage check the screen tools it runs on the runner", () => {
    for (const system of systems)
      expect([system, named(system, SOURCE)]).toEqual([
        system,
        system === "appimage" ? ["xvfb", "xdotool", "imagemagick"] : ["xvfb"],
      ]);
  });
});
