import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { npmRegistryStandIn, pnpmInstall } from "./helpers/npmRegistryStandIn";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * pnpm leaves out an optional package whose download failed and exits 0: a
 * batch's hosted Linux journeys installed without the Claude SDK's Linux
 * package after npm's registry timed out on it, and the Claude journeys then
 * failed with "Cannot find module". scripts/check-installed-packages.ts runs
 * first in the project's own postinstall and refuses such an install. This
 * runs the project's own pnpm against a stand-in registry publishing a
 * package shaped as the SDK is: a main package whose native part for each
 * platform is an optional package.
 */

const repoRoot = join(__dirname, "..");
const script = "scripts/check-installed-packages.ts";

/** The project's own package.json, whose postinstall runs the check first. */
const own = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  type: string;
  scripts: { postinstall: string };
};

describe(script, () => {
  let folder: string;
  let registry: Awaited<ReturnType<typeof npmRegistryStandIn>> | undefined;

  beforeEach(() => {
    folder = scratchDir("infinitary-installed-packages-");
  });

  afterEach(async () => {
    await registry?.close();
    registry = undefined;
    rmSync(folder, { recursive: true, force: true });
  });

  // The project's own pnpm, twice (docs/test-cohorts.md, "Budgets").
  it("refuses an install that left out an optional package it could not download", {
    timeout: 20_000,
  }, async () => {
    const elsewhere = process.platform === "win32" ? "linux" : "win32";
    registry = await npmRegistryStandIn(folder, [
      {
        manifest: {
          name: "sdk",
          version: "1.0.0",
          main: "index.js",
          optionalDependencies: { "sdk-native": "1.0.0", "sdk-other": "1.0.0" },
        },
        files: { "index.js": 'module.exports = require("sdk-native/part");\n' },
      },
      {
        // This platform's native part, which arrives slowly.
        manifest: {
          name: "sdk-native",
          version: "1.0.0",
          os: [process.platform],
          cpu: [process.arch],
        },
        files: { "part.js": "module.exports = 'native';\n", "blob.bin": "x".repeat(64 * 1024) },
        seconds: 1.5,
      },
      {
        // Another platform's, which pnpm skips without downloading it.
        manifest: { name: "sdk-other", version: "1.0.0", os: [elsewhere] },
        files: { "part.js": "module.exports = 'other';\n" },
      },
    ]);
    const project = join(folder, "project");
    // The project's own postinstall starts with the check, which reads the
    // install in the folder it runs in.
    mkdirSync(join(project, "scripts"), { recursive: true });
    cpSync(join(repoRoot, script), join(project, script));
    const manifest = {
      type: own.type,
      dependencies: { sdk: "1.0.0" },
      scripts: { postinstall: own.scripts.postinstall.split("&&")[0]?.trim() },
    };

    // Waits longer than the slow download: the install is whole, and the
    // other platform's skipped package passes the check.
    const whole = await pnpmInstall(folder, registry.registry, manifest, {}, [
      "install",
      "--no-frozen-lockfile",
    ]);
    expect(whole.status, whole.output).toBe(0);
    expect(registry.tarballRequests("sdk-native")).toBe(1);
    expect(registry.tarballRequests("sdk-other")).toBe(0);

    // From that lockfile with an empty store, as a hosted job starts, and
    // waits shorter than the download: pnpm gives up on the native part,
    // leaves it out, and the check refuses the install, naming it.
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    rmSync(join(folder, "store"), { recursive: true, force: true });
    rmSync(join(folder, "cache"), { recursive: true, force: true });
    const dropped = await pnpmInstall(
      folder,
      registry.registry,
      manifest,
      { pnpm_config_fetch_timeout: "300", pnpm_config_fetch_retries: "1" },
      ["install", "--frozen-lockfile"],
    );
    expect(registry.tarballRequests("sdk-native")).toBe(3);
    expect(dropped.status, dropped.output).not.toBe(0);
    expect(dropped.output).toMatch(/sdk-native \(sdk-native@1\.0\.0[^)]*\), needed by sdk@1\.0\.0/);
  });
});
