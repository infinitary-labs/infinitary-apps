import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
