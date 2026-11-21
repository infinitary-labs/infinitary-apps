import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RUN_FORCE_DIR } from "../../src/core/helper/runForce";
import { RUN_STOP_FILE, RUN_STOP_FOR_FILE } from "../../src/core/helper/windowsTask";
import { describeCapture } from "../../src/core/hostEnv";
import { writeLoginShellStub } from "../../src/core/loginShellStub";
import { openDatabase } from "../../src/core/storage/db";
import {
  SAVED_DATA_REFUSAL_MESSAGE,
  SAVED_DATA_REFUSAL_TITLE,
} from "../../src/core/storage/savedDataCompatibility";
import {
  RUN_LAST_STOP,
  RUN_MARKER,
  RUN_SETTINGS_EXIT,
  RUN_UPDATED_EXIT,
  RUN_WORDS,
  type RunStop,
} from "../../src/main/runCommand";
import { readRunSettings } from "../../src/main/runSettings";
import { runLabelOf } from "../../src/shared/codeNames";
import { recordNewerMigration } from "../helpers/database";
import { scratchDir } from "../helpers/scratchDirs";
import { endCommands, run, runEnv } from "./commandRun";
import { readSavedData } from "./savedData";
import { serviceManagerStandIn } from "./serviceManagerStandIn";

/**
 * Infinitary started by a command (docs/run.md; INF-1228's approved plan,
 * piece 1, "infinitary run"): the built app started as `<app> run`, as a
 * boot entry, a login or a terminal would start it, runs the whole app with
 * no window until a stop signal stops it, and ends with its reason when it
 * cannot go on. Data: a throwaway data folder and HOME through the hermetic
 * environment `launchApp` uses (`runEnv`, tests/e2e/commandRun.ts). The
 * window opened beside it has its own journeys (run-window.spec.ts).
 */

/** The search path a boot entry starts a program with on a Mac. */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

test.afterEach(endCommands);

/** The lines a run that cannot go on says, apart from Chromium's own notes on stderr. */
const said = (error: string) => error.split("\n").filter((line) => line && !line.startsWith("["));

test("a command starts the whole app with no window, and a stop signal stops it cleanly", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const ran = run(await runEnv(userDataDir));
  await ran.started();
  // The record is the app's own, open while it runs, with a note that a command runs it.
  expect(existsSync(join(userDataDir, RUN_MARKER))).toBe(true);
  ran.child.kill("SIGTERM");
  expect(await ran.exited, ran.error()).toBe(0);
  expect(ran.lines()).toEqual([RUN_WORDS.started, RUN_WORDS.stopped]);
  expect(existsSync(join(userDataDir, RUN_MARKER))).toBe(false);
  // The core opened the app's own record and closed it cleanly.
  expect(
    readSavedData(userDataDir, (db) => db.prepare("SELECT COUNT(*) AS n FROM tasks").get()),
  ).toEqual({ n: 0 });
});

test("a second command while one runs says Infinitary is already open and exits 1", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const first = run(await runEnv(userDataDir));
  await first.started();
  const second = run(await runEnv(userDataDir));
  expect(await second.exited).toBe(1);
  expect(said(second.error())).toEqual(RUN_WORDS.alreadyOpen);
  expect(first.child.exitCode).toBeNull();
  first.child.kill("SIGTERM");
  expect(await first.exited, first.error()).toBe(0);
});

/**
 * INF-1228's plan: "Both accounts run the one app in Applications. After you
 * update it, the command must exit so its starter runs the new version".
 * The installed program is a stand-in file the test replaces, as an update
 * replaces the app's.
 */
test("once the installed app is replaced, the run stops and ends for its starter to start the new version", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const program = join(scratchDir("infinitary-run-command-program-"), "Infinitary");
  writeFileSync(program, "this version\n");
  const ran = run(
    await runEnv(userDataDir, {
      INFINITARY_RUN_PROGRAM: program,
      INFINITARY_RUN_PROGRAM_EVERY_MS: "200",
    }),
  );
  await ran.started();
  writeFileSync(`${program}.new`, "the new version\n");
  renameSync(`${program}.new`, program);
  expect(await ran.exited, ran.error()).toBe(RUN_UPDATED_EXIT);
  expect(ran.lines()).toEqual([RUN_WORDS.started, ...RUN_WORDS.updated, RUN_WORDS.stopped]);
});

/**
 * INF-1228's approved plan, piece 4: "`--settings <file>` names a file of
 * settings. With it, the app finds programs where the file says and asks no
 * login shell." The person's shell is a stand-in that notes every ask, and
 * the starter's path is the system folders, as a boot entry's is.
 */
test("with a settings file, a run searches the file's folders and asks no login shell", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const shellDir = scratchDir("infinitary-run-command-shell-");
  const shell = writeLoginShellStub(shellDir, {});
  const env = await runEnv(userDataDir, { SHELL: shell.shell, PATH: SYSTEM_PATH });

  // Without one, the core asks the person's shell as it starts.
  const asked = run(env);
  await asked.started();
  asked.child.kill("SIGTERM");
  expect(await asked.exited, asked.error()).toBe(0);
  // The interactive ask and the fallback asked beside it, both noted before the next run.
  await expect
    .poll(() => (existsSync(shell.log) ? readFileSync(shell.log, "utf8").trim().split("\n") : []))
    .toEqual(expect.arrayContaining(["-ilc", "-lc"]));
  rmSync(shell.log);

  const folders = [join(shellDir, "tools", "bin"), "/usr/bin", "/bin"];
  const settings = join(shellDir, "infinitary.json");
  writeFileSync(settings, `${JSON.stringify({ path: folders }, null, 2)}\n`);
  const ran = run(env, ["--settings", settings]);
  await ran.started();
  expect(ran.notes()).toContain(
    `[host-env] ${describeCapture({ source: "settings", entries: folders })}`,
  );
  ran.child.kill("SIGTERM");
  expect(await ran.exited, ran.error()).toBe(0);
  expect(ran.lines()).toEqual([RUN_WORDS.started, RUN_WORDS.stopped]);
  expect(existsSync(shell.log)).toBe(false);
});

test("a settings file a run cannot use ends it with 78 and why, kept as its last stop", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const settings = join(scratchDir("infinitary-run-command-settings-"), "infinitary.json");
  // A misspelled setting, which a run that ignored it would search nothing of.
  writeFileSync(settings, JSON.stringify({ paths: ["/opt/homebrew/bin", "/usr/bin", "/bin"] }));
  const ran = run(await runEnv(userDataDir), ["--settings", settings]);
  expect(await ran.exited, ran.error()).toBe(RUN_SETTINGS_EXIT);
  const reading = readRunSettings(settings);
  if (reading.ok) throw new Error("The misspelled file was read as settings.");
  const words = RUN_WORDS.settings(reading.file, reading.reason);
  expect(said(ran.error())).toEqual(words);
  expect(ran.lines()).toEqual([]);
  // What status reads as the last stop (docs/run.md, "Reading status").
  expect(
    JSON.parse(readFileSync(join(userDataDir, RUN_LAST_STOP), "utf8")) as RunStop,
  ).toMatchObject({ reason: "start-failed", exitCode: RUN_SETTINGS_EXIT, lines: words });
  expect(existsSync(join(userDataDir, RUN_MARKER))).toBe(false);
});

// The review of INF-5409: a run its own agent started reads a stop or force stop asked of it only
// once its folder and saved data are accepted. On saved data from a newer version it ends with
// the refusal, leaving the stops left in the folder unread - the one for any run Windows reads and
// the one naming a run every system reads - making no folder of force stops, and asking this
// account's service manager nothing, so the agent's job stays as it was.
test("a run on saved data from a newer version ends with its refusal and recovers nothing on the folder", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const db = openDatabase(userDataDir);
  recordNewerMigration(db);
  db.close();
  const now = new Date().toISOString();
  const stops = [
    [join(userDataDir, RUN_STOP_FILE), `${JSON.stringify({ at: now })}\n`],
    [
      join(userDataDir, RUN_STOP_FOR_FILE),
      `${JSON.stringify({ at: now, pid: process.pid, startedAt: now })}\n`,
    ],
  ] as const;
  // e2e-fixture: input -- the stops a window leaves for a run, which a refusing run must leave unread
  for (const [file, asked] of stops) writeFileSync(file, asked);
  const manager = serviceManagerStandIn(scratchDir("infinitary-run-command-home-"));
  const ran = run(await runEnv(userDataDir, manager.env), ["--agent", runLabelOf("dev")]);
  expect(await ran.exited, ran.error()).toBe(1);
  expect(said(ran.error())).toEqual(
    RUN_WORDS.refusal({ title: SAVED_DATA_REFUSAL_TITLE, message: SAVED_DATA_REFUSAL_MESSAGE }),
  );
  for (const [file, asked] of stops) expect(readFileSync(file, "utf8")).toBe(asked);
  expect(existsSync(join(userDataDir, RUN_FORCE_DIR))).toBe(false);
  expect(manager.asks()).toEqual([]);
});

// The review of INF-5409: a stop asked while a run's first mate starts is the run's end. The run
// stops once that start is done with, as a quit stops it, keeps the stop as its reason, and ends
// with 0; it starts no first mate after the stop. Held by a development file at the core's start,
// before its saved data is accepted, and once that start returned to the startup, after it: there
// the startup's own disposal waits for the held start and closes the core it opened.
for (const [when, setting] of [
  ["before its saved data is accepted", "INFINITARY_RUN_START_HOLD"],
  ["after its saved data is accepted", "INFINITARY_RUN_STARTED_HOLD"],
] as const) {
  test(`a stop signal while the first mate starts ends the run cleanly, with the stop as its reason, ${when}`, async () => {
    const userDataDir = scratchDir("infinitary-run-command-");
    const hold = join(scratchDir("infinitary-run-command-hold-"), "hold");
    // e2e-fixture: input -- holds the run's start back until the stop is asked
    writeFileSync(hold, "");
    const ran = run({ ...(await runEnv(userDataDir)), [setting]: hold });
    await expect.poll(() => existsSync(`${hold}.reached`)).toBe(true);
    ran.child.kill("SIGTERM");
    rmSync(hold);
    expect(await ran.exited, ran.error()).toBe(0);
    expect(ran.lines()).toEqual([RUN_WORDS.stopped]);
    expect(
      JSON.parse(readFileSync(join(userDataDir, RUN_LAST_STOP), "utf8")) as RunStop,
    ).toMatchObject({ reason: "signal", exitCode: 0 });
    expect(existsSync(join(userDataDir, RUN_MARKER))).toBe(false);
    if (setting === "INFINITARY_RUN_STARTED_HOLD") {
      // The core opened the app's own record and closed it cleanly, its log folded back in.
      expect(existsSync(join(userDataDir, "firstmate.db-wal"))).toBe(false);
      expect(
        readSavedData(userDataDir, (db) => db.prepare("SELECT COUNT(*) AS n FROM tasks").get()),
      ).toEqual({ n: 0 });
    }
  });
}

test("words after run say how to use it and exit 2", async () => {
  const ran = run(await runEnv(scratchDir("infinitary-run-command-")), ["--anything"]);
  expect(await ran.exited).toBe(2);
  expect(said(ran.error())).toEqual(RUN_WORDS.usage);
});
