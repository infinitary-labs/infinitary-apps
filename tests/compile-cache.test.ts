import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { COMPILE_CACHE_FOLDER } from "../src/main/compileCache.ts";
import { scratchDir } from "./helpers/scratchDirs.ts";

/**
 * The app turns on Node's compile cache in its data folder before its code
 * loads, so a start reads that code already compiled (the captain's "load
 * less code at start"). A cache is process-wide and cannot be turned off
 * again, so each start runs in a Node of its own, as the app's does.
 */

const repo = resolve(__dirname, "..");
// Each start is one Node loading the TypeScript compiler: measured at 0.4 s
// at its fastest, three starts to a test.
vi.setConfig({ testTimeout: 10_000 });

function start(dataDir: string, build: string): string {
  const script = `
    import { startCompileCache } from ${JSON.stringify(join(repo, "src/main/compileCache.ts"))};
    import { createRequire } from "node:module";
    const loaded = startCompileCache(${JSON.stringify(dataDir)}, ${JSON.stringify(build)});
    createRequire(${JSON.stringify(join(repo, "package.json"))})("typescript");
    loaded?.();
    process.stdout.write(loaded ? "on" : "off");
  `;
  const env = { ...process.env };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
  });
}

describe("the compile cache", () => {
  test("a start writes the compiled code into its build's folder and removes an older build's", () => {
    const dataDir = scratchDir("compile-cache-");
    const older = join(dataDir, COMPILE_CACHE_FOLDER, "older-build");
    mkdirSync(older, { recursive: true });
    expect(start(dataDir, "this-build")).toBe("on");
    const folder = join(dataDir, COMPILE_CACHE_FOLDER, "this-build");
    expect(readdirSync(folder).length).toBeGreaterThan(0);
    expect(existsSync(older)).toBe(false);
  });

  test("the first start, before the data folder exists, caches nothing and makes no folder", () => {
    const dataDir = join(scratchDir("compile-cache-first-"), "not-yet");
    expect(start(dataDir, "this-build")).toBe("off");
    expect(existsSync(dataDir)).toBe(false);
  });
});
