import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

const require = createRequire(import.meta.url);

/**
 * Electron 43's published tarball dropped the `postinstall` lifecycle script
 * that used to download Electron.app (the registry metadata still lists one;
 * the tarball's own package.json has none). scripts/ensure-electron-installed.mjs
 * runs electron's own installer from our postinstall to close that gap.
 *
 * These tests exercise the script as the real postinstall step will: as a
 * child process, against a real (fake) `electron` package on disk, asserting
 * on its actual exit code and side effects - not on the script's source text.
 */

const repoRoot = join(__dirname, "..");
const scriptPath = join(repoRoot, "scripts", "ensure-electron-installed.mjs");

function runScript(cwd: string) {
  return spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });
}

function writeFakeElectronPackage(projectDir: string, installJs: string) {
  const electronDir = join(projectDir, "node_modules", "electron");
  mkdirSync(electronDir, { recursive: true });
  writeFileSync(
    join(electronDir, "package.json"),
    JSON.stringify({ name: "electron", version: "1.0.0" }),
  );
  writeFileSync(join(electronDir, "install.js"), installJs);
  return electronDir;
}

describe("ensure-electron-installed.mjs", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = scratchDir("infinitary-electron-install-");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("invokes electron's own installer when the binary is missing", () => {
    const electronDir = writeFakeElectronPackage(
      projectDir,
      `
      const fs = require("fs");
      const path = require("path");
      fs.writeFileSync(path.join(__dirname, "invoked.marker"), "1");
      process.exit(0);
      `,
    );

    const result = runScript(projectDir);

    expect(result.status).toBe(0);
    expect(existsSync(join(electronDir, "invoked.marker"))).toBe(true);
  });

  it("fails pnpm install loudly when electron's installer fails", () => {
    writeFakeElectronPackage(
      projectDir,
      `
      console.error("simulated: could not reach the Electron CDN");
      process.exit(1);
      `,
    );

    const result = runScript(projectDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/electron/i);
    expect(result.stderr).toMatch(/pnpm install/i);
  });
});

describe("ensure-electron-installed.mjs against the real electron package", () => {
  it("leaves require('electron') resolving to a binary that exists on disk", () => {
    // By the time tests run, `pnpm install` has already run this repo's real
    // postinstall (this same script, for real). Re-running it here proves
    // the idempotent fast path against the real electron/install.js, and
    // proves the actual acceptance criterion: require("electron") resolves
    // to a real, existing binary.
    const result = runScript(repoRoot);
    expect(result.status).toBe(0);

    const electronPath = require.resolve("electron");
    expect(existsSync(electronPath)).toBe(true);
  });
});

// Main's check run 42287797114 failed when electron's installer took a 504
// from GitHub's release server, which a hosted runner reached on every
// install. .github/actions/electron-download keeps that download in the
// Actions cache; tests/workflow-hygiene.test.ts holds every cached install
// to it. These run its own step and electron's own installer.
describe(".github/actions/electron-download", () => {
  type Step = { id?: string; if?: string; run?: string; with?: Record<string, string> };
  const { runs } = loadYamlFile(".github/actions/electron-download/action.yml") as {
    runs: { steps: [record: Step, cache: Step] };
  };
  const [record, cache] = runs.steps;
  let folder: string;

  beforeEach(() => {
    folder = scratchDir("infinitary-electron-download-");
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** The record step's run, as a hosted runner runs it in this checkout. */
  function runRecordStep() {
    const env = join(folder, "env");
    const output = join(folder, "output");
    writeFileSync(env, "");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", record.run ?? ""], {
      cwd: repoRoot,
      env: { ...hostEnv(), RUNNER_TEMP: folder, GITHUB_ENV: env, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const lines = (file: string) =>
      Object.fromEntries(
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      ) as Record<string, string>;
    return { env: lines(env), outputs: lines(output) };
  }

  it("runs only on a GitHub-hosted runner, as setup-node's package cache does", () => {
    for (const step of [record, cache]) {
      const hosted = { runner: { environment: "github-hosted" } };
      expect(workflowValue(step.if ?? "", hosted)).toBe(true);
      expect(workflowValue(step.if ?? "", { runner: { environment: "self-hosted" } })).toBe(false);
    }
  });

  it("saves the folder electron's installer reads, under the Electron version the lockfile installs", () => {
    const { env, outputs } = runRecordStep();
    const lockfile = loadYamlFile("pnpm-lock.yaml") as {
      importers: { ".": { devDependencies: { electron: { version: string } } } };
    };
    const installed = lockfile.importers["."].devDependencies.electron.version;
    const contexts = {
      runner: { os: "Linux", arch: "X64" },
      steps: { [record.id ?? ""]: { outputs } },
    };
    expect(workflowString(cache.with?.key ?? "", contexts)).toBe(`electron-Linux-X64-${installed}`);
    expect(workflowString(cache.with?.path ?? "", contexts)).toBe(env.electron_config_cache);

    // Electron's own installer, the pinned version's, with a stand-in for its
    // downloader that records where it was told to cache and downloads nothing.
    const real = dirname(require.resolve("electron/package.json"));
    const electronDir = join(folder, "project", "node_modules", "electron");
    mkdirSync(electronDir, { recursive: true });
    for (const file of ["install.js", "package.json", "checksums.json"])
      copyFileSync(join(real, file), join(electronDir, file));
    const downloader = join(folder, "project", "node_modules", "@electron", "get");
    mkdirSync(downloader, { recursive: true });
    writeFileSync(join(downloader, "package.json"), JSON.stringify({ name: "@electron/get" }));
    writeFileSync(
      join(downloader, "index.js"),
      `exports.downloadArtifact = async (details) => {
        require("fs").writeFileSync(process.env.ASKED, JSON.stringify({ cacheRoot: details.cacheRoot, version: details.version }));
        throw new Error("stand-in: no download");
      };`,
    );
    const asked = join(folder, "asked.json");
    spawnSync(process.execPath, [join(electronDir, "install.js")], {
      env: { ...hostEnv(), ...env, ASKED: asked },
      encoding: "utf8",
    });
    expect(JSON.parse(readFileSync(asked, "utf8"))).toEqual({
      cacheRoot: env.electron_config_cache,
      version: installed,
    });
  });
});
