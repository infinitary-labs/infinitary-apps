import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";

// Integration budget (docs/test-cohorts.md): two Node children that stop on a
// real trap instruction; a child that freezes instead is ended at the bound.
const FROZEN_AFTER_MS = 5_000;

/** proper-lockfile as Pi's coding agent loads it, which makes signal-exit listen. */
const LOCKFILE = createRequire(
  realpathSync(
    resolve(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/package.json"),
  ),
).resolve("proper-lockfile");

/**
 * A Node process that loads proper-lockfile as the app does, before or after
 * the main entry keeps faults fatal, then stops on a trap instruction as
 * Chromium's fatal checks do (V8's `%SystemBreak`).
 */
function trapAfterLoading(order: "lockfile-first" | "fix-first") {
  const script = join(scratchDir("fault-signals-"), "trap.mjs");
  const fix = pathToFileURL(resolve(__dirname, "faultSignals.ts")).href;
  const load = `createRequire(import.meta.url)(${JSON.stringify(LOCKFILE)});`;
  const keep = `(await import(${JSON.stringify(fix)})).keepFaultSignalsFatal();`;
  writeFileSync(
    script,
    [
      'import { createRequire } from "node:module";',
      ...(order === "lockfile-first" ? [load, keep] : [keep, load]),
      "await new Promise((done) => setImmediate(done));",
      "%SystemBreak();",
    ].join("\n"),
  );
  return spawnSync(process.execPath, ["--allow-natives-syntax", script], {
    timeout: FROZEN_AFTER_MS,
    // A frozen process never runs a listener for a gentler signal.
    killSignal: "SIGKILL",
    encoding: "utf8",
  });
}

// INF-5226: the app froze at full processor use on Electron's fatal helper
// check, the trap looping on a SIGTRAP listener, instead of ending.
// The difference shows only on arm64, where the trap instruction runs again
// after a handler returns; on x64 it resumes after itself, so without the
// fix the child still ends, by signal-exit raising SIGTRAP again.
describe.skipIf(process.platform === "win32")("a fault in the main process", () => {
  it.each(["fix-first", "lockfile-first"] as const)(
    "ends the process with proper-lockfile loaded (%s)",
    (order) => {
      const child = trapAfterLoading(order);
      expect(child.stderr).toBe("");
      expect(child.signal).toBe("SIGTRAP");
    },
    FROZEN_AFTER_MS * 2,
  );
});
