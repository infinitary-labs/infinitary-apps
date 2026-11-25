import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expectNothingOfTheSource,
  type Job,
  packageJsonRead,
  runJob,
  SOURCE_ELECTRON,
  SOURCE_PNPM,
} from "./helpers/releaseLocalActions";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// release.yml's windows job calls windows.yml with the release's source
// commit, which for a stable is its alpha's own commit, as it calls
// linux-packages.yml. Each job takes every local action, and the zip reader
// its build runs, from the workflow's own commit, so a stable whose alpha
// predates one of them still builds and checks its installer.

const { jobs } = loadYamlFile(".github/workflows/windows.yml") as {
  jobs: Record<string, Job>;
};

describe("windows.yml's local actions in a stable built from an older alpha", () => {
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

    it(`runs the workflow's own action scripts in its ${name} job`, () => {
      const { workspace } = runJob(job);
      for (const step of job.steps)
        for (const [script] of (step.run ?? "").matchAll(/\S*\.github\/actions\/\S+/g)) {
          expect(script, step.name).toMatch(/^\.release-tooling\//);
          expect(existsSync(join(workspace, script)), `${script} is checked out`).toBe(true);
        }
    });
  }

  it("restores the Electron download of the source it installs, not the workflow's", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const { workspace, actions } = runJob(job);
      const pkg = packageJsonRead(workspace, actions, "electron-download");
      expect([name, pkg.devDependencies.electron]).toEqual([name, SOURCE_ELECTRON]);
    }
  });

  it("sets up the pnpm the source pins, not the workflow's", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const { workspace, actions } = runJob(job);
      const pkg = packageJsonRead(workspace, actions, "pnpm");
      expect([name, pkg.packageManager]).toEqual([name, SOURCE_PNPM]);
    }
  });
});
