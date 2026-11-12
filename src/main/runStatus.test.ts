import { readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { markRunning, RUN_LAST_STOP, RUN_MARKER, RUN_UPDATED_EXIT, RUN_WORDS } from "./runCommand";
import {
  accountKeychainPath,
  keychainLockFromFlags,
  readKeychainLock,
  runEnvironment,
} from "./runEnvironment";
import {
  readRunStatus,
  runStatusCommand,
  STATUS_WORDS,
  statusCommand,
  statusText,
} from "./runStatus";

/** INF-1228 piece 2: status reports the command, its last stop and what its environment lacks. */
const started = new Date("2026-10-25T17:00:00Z");
function fixture() {
  const dir = scratchDir("run-status-");
  const end = markRunning(
    dir,
    process.pid,
    started,
    runEnvironment({
      platform: "darwin",
      env: {},
      ownDisplay: false,
      keychain: () => keychainLockFromFlags(0),
      now: started,
    }),
  );
  symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
  return { dir, end };
}

describe("the status command", () => {
  it("selects status without consuming work status or a development entry", () => {
    expect(statusCommand(["/app", "status", "--json"], false)).toEqual(["--json"]);
    expect(statusCommand(["/electron", "/repo", "status"], true)).toEqual([]);
    expect(statusCommand(["/app", "--no-sandbox", "status"], false)).toEqual([]);
    expect(statusCommand(["/app", "work", "status"], false)).toBeNull();
    expect(statusCommand(["/electron", "status"], true)).toBeNull();
  });

  it("reports a fresh account without creating its data folder", () => {
    const dir = join(scratchDir("run-status-fresh-"), "not-created");
    const result = runStatusCommand(["--json"], dir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      running: false,
      lastStop: null,
      environment: null,
      problems: [],
    });
    expect(() => statSync(dir)).toThrow();
    expect(runStatusCommand([], dir).out).toContain(STATUS_WORDS.noStop);
    expect(runStatusCommand(["--anything"], dir)).toEqual({
      code: 2,
      out: "",
      error: `${STATUS_WORDS.usage.join("\n")}\n`,
    });
  });

  it("reports a live lock holder and its observed limitations without changing either record", () => {
    const { dir } = fixture();
    const before = readFileSync(join(dir, RUN_MARKER), "utf8");
    const result = runStatusCommand(["--json"], dir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      running: true,
      run: { pid: process.pid },
      environment: { keychain: "locked", display: "unknown" },
    });
    expect(statusText(readRunStatus(dir))).toContain(STATUS_WORDS.keychain.locked);
    expect(readFileSync(join(dir, RUN_MARKER), "utf8")).toBe(before);
  });

  it("notes a run as running before a Mac's Keychain reading arrives, and adds the reading once it does", async () => {
    // A defect found by INF-1659's check on a disposable Mac: the run waited
    // for that reading, which waits for the app to be ready, which waits for
    // the run's start to return, so a run on the account's own folder never started.
    const dir = scratchDir("run-status-pending-");
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
    let arrive: (keychain: "unlocked") => void = () => {};
    const reading = new Promise<"unlocked">((resolve) => {
      arrive = resolve;
    }).then((keychain) =>
      runEnvironment({ platform: "darwin", env: {}, ownDisplay: false, keychain: () => keychain }),
    );
    const end = markRunning(dir, process.pid, started, reading);
    expect(readRunStatus(dir)).toMatchObject({ running: true, environment: null });
    arrive("unlocked");
    await reading;
    expect(readRunStatus(dir)).toMatchObject({
      running: true,
      environment: { keychain: "unlocked" },
    });
    expect(statusText(readRunStatus(dir))).toContain(STATUS_WORDS.keychain.unlocked);
    end();
    expect(readRunStatus(dir).lastStop).toMatchObject({ environment: { keychain: "unlocked" } });
  });

  it("writes no note for a Keychain reading that arrives after the run ended", async () => {
    const dir = scratchDir("run-status-late-");
    let arrive: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      arrive = resolve;
    }).then(() =>
      runEnvironment({ platform: "darwin", env: {}, ownDisplay: false, keychain: () => "locked" }),
    );
    const end = markRunning(dir, process.pid, started, reading);
    end({ reason: "start-failed", exitCode: 1, lines: ["It could not start."] });
    arrive();
    await reading;
    expect(() => statSync(join(dir, RUN_MARKER))).toThrow();
    expect(readRunStatus(dir).lastStop).toMatchObject({ reason: "start-failed" });
  });

  it("keeps the reason and exit code when the live marker is removed", () => {
    const { dir, end } = fixture();
    end({ reason: "updated", exitCode: RUN_UPDATED_EXIT, lines: [...RUN_WORDS.updated] });
    rmSync(join(dir, "SingletonLock"));
    const result = readRunStatus(dir);
    expect(result).toMatchObject({
      running: false,
      lastStop: { reason: "updated", exitCode: RUN_UPDATED_EXIT, startedAt: started.toISOString() },
    });
    expect(statusText(result)).toContain(RUN_WORDS.updated[0]);
    expect(statSync(join(dir, RUN_LAST_STOP)).mode & 0o777).toBe(0o600);
    expect(() => statSync(join(dir, RUN_MARKER))).toThrow();
    end(); // A second shutdown cannot replace the first reason.
    expect(readRunStatus(dir).lastStop?.reason).toBe("updated");
  });

  it("does not pass an earlier clean stop off as the reason for a later forced stop", () => {
    const { dir, end } = fixture();
    end();
    markRunning(dir, process.pid, new Date(started.getTime() + 1000));
    const status = readRunStatus(dir, () => false);
    expect(status).toMatchObject({
      running: false,
      lastStop: { reason: "unrecorded", stoppedAt: null, exitCode: null },
    });
    expect(statusText(status)).toContain(STATUS_WORDS.interrupted);
    // A recycled PID without the lock is no longer this run.
    rmSync(join(dir, "SingletonLock"));
    expect(readRunStatus(dir).running).toBe(false);
  });

  it("keeps malformed, incompatible and unreadable records unknown instead of stopped", () => {
    const dir = scratchDir("run-status-bad-");
    for (const value of [
      "{",
      "null",
      JSON.stringify({ pid: -1, startedAt: started.toISOString() }),
      JSON.stringify({ pid: process.pid, startedAt: "not a date" }),
    ]) {
      writeFileSync(join(dir, RUN_MARKER), value);
      const result = runStatusCommand(["--json"], dir);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.out)).toMatchObject({
        running: null,
        problems: [STATUS_WORDS.unreadable],
      });
    }
    rmSync(join(dir, RUN_MARKER));
    writeFileSync(join(dir, RUN_LAST_STOP), "{}");
    expect(runStatusCommand(["--json"], dir).code).toBe(1);
  });

  it("does not claim a window's lock is a command, and reads the original marker format", () => {
    const { dir, end } = fixture();
    end(); // An older command must not borrow this newer command's environment reading.
    writeFileSync(
      join(dir, RUN_MARKER),
      JSON.stringify({ pid: process.pid, startedAt: started.toISOString() }),
    );
    expect(readRunStatus(dir)).toMatchObject({ running: true, environment: null });
    rmSync(join(dir, RUN_MARKER));
    expect(readRunStatus(dir)).toMatchObject({
      running: null,
      problems: [STATUS_WORDS.otherProcess],
    });
  });

  it("keeps no screen, an owned display and an unknown Keychain distinct", () => {
    const base = {
      platform: "linux" as const,
      env: {},
      ownDisplay: false,
      keychain: () => {
        throw new Error("Linux must not ask the Mac Keychain");
      },
    };
    expect(runEnvironment(base)).toMatchObject({ display: "none", keychain: "not-applicable" });
    expect(runEnvironment({ ...base, ownDisplay: true })).toMatchObject({ display: "own" });
    expect(runEnvironment({ ...base, env: { DISPLAY: ":99" } })).toMatchObject({
      display: "session",
    });
    // Security.framework's actual bit field: read/write permission bits do not mean unlocked.
    expect(keychainLockFromFlags(2 | 4)).toBe("locked");
    expect(keychainLockFromFlags(1 | 2 | 4)).toBe("unlocked");
  });
});

describe("the Keychain a run reads", () => {
  // INF-1416: started at boot by a system job, the default Keychain was the
  // Mac's System Keychain, unlocked, while the account's own stayed locked.
  it("reads the account's own path through the host and preserves its status", async () => {
    expect(accountKeychainPath("/Users/fm")).toBe("/Users/fm/Library/Keychains/login.keychain-db");
    const missing = accountKeychainPath(scratchDir("run-keychain-"));
    const paths: string[] = [];
    expect(
      await readKeychainLock(async (path) => {
        paths.push(path);
        return "absent";
      }, missing),
    ).toBe(process.platform === "darwin" ? "absent" : "not-applicable");
    expect(paths).toEqual(process.platform === "darwin" ? [missing] : []);
    // The real missing-file reading now belongs to claudeKeychainAccess.integration.test.ts.
  });
});
