import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { isProfileRetired } from "../../src/core/storage/retiredProfile";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { RUN_WORDS } from "../../src/main/runCommand";
import { APP_IDENTITIES } from "../../src/shared/codeNames";
import * as m from "../../src/shared/i18n/messages.generated";
import { userDataFolderOf } from "../../src/shared/userDataFolders";
import { scratchDir } from "../helpers/scratchDirs";
import { endCommands, run, runEnv } from "./commandRun";
import { readSavedData } from "./savedData";

/**
 * Infinitary started by a command at the one-time move (docs/run.md,
 * "Before it starts"; INF-5468's plan, piece 3: a new version "stops that
 * copy cleanly and carries on", and "The run command does the same"): the
 * built app as `<app> run` finds Firstmate 3000's folder held by an older
 * copy's run, asks it to save and stop, brings the saved work over, and
 * starts fully from its own folder with no window and no question. Data: a
 * hermetic HOME (`runEnv`) whose Firstmate 3000 folder holds a
 * freshly made record with one task, and a stand-in older run - Node,
 * started under the older Linux program's name - that holds the folder by
 * Chromium's lock and saves and exits on the ordinary stop. The run has no
 * isolated folder, since the move wakes only for this build's own folder of
 * its flavor. Each step of the take-over, and the question and the stop
 * around it, is src/main/runHandOver.integration.test.ts.
 */

// A full start whose folder is not isolated reads a Mac's own Keychain, which
// no journey may reach; Linux has none, and its run starts on Xvfb.
test.skip(process.platform !== "linux", "a run that is not isolated reads a Mac's own Keychain");

/** The stand-in older run: holds the folder by Chromium's lock, and saves and exits on the ordinary stop. */
const OLDER_RUN = `
const { appendFileSync, rmSync, symlinkSync } = require("node:fs");
const { hostname } = require("node:os");
const { join } = require("node:path");
const [from, log] = process.argv.slice(2);
const lock = join(from, "SingletonLock");
symlinkSync(hostname() + "-" + process.pid, lock);
process.on("SIGTERM", () => {
  appendFileSync(log, "asked to stop\\n");
  rmSync(lock, { force: true });
  appendFileSync(log, "saved\\n");
  process.exit(0);
});
appendFileSync(log, "holding\\n");
setInterval(() => {}, 1000);
`;

const olderRuns: ChildProcess[] = [];

test.afterEach(() => {
  endCommands();
  for (const child of olderRuns.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/** Starts the older run under Firstmate 3000's Linux program name, and waits until it holds the folder. */
async function olderRun(from: string) {
  const dir = scratchDir("infinitary-run-hand-over-older-");
  const script = join(dir, "older-run.cjs");
  const log = join(dir, "older-run.log");
  writeFileSync(script, OLDER_RUN);
  writeFileSync(log, "");
  const child = spawn(process.execPath, [script, from, log, "run"], {
    // The name the program check reads (`/proc/<pid>/cmdline`, src/core/folderMove/takeOver.ts).
    argv0: join(dir, "firstmate-3000"),
    stdio: "ignore",
  });
  olderRuns.push(child);
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const said = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  await expect.poll(said).toContain("holding");
  return { ended, said };
}

test("a run takes over from an older copy's run, brings the saved work over, and starts from its own folder", async () => {
  const env = await runEnv(scratchDir("infinitary-run-hand-over-"));
  delete env.INFINITARY_USER_DATA_DIR;
  // Electron's app data on Linux follows XDG_CONFIG_HOME, which runEnv points into its throwaway HOME.
  const appData = env.XDG_CONFIG_HOME;
  if (!appData) throw new Error("runEnv should name XDG_CONFIG_HOME inside its HOME.");
  // A run from source with nothing isolating it opens the person's own folders, the release's.
  const from = join(appData, userDataFolderOf("fm", "release"));
  const to = join(appData, userDataFolderOf("inf", "release"));
  const db = openDatabase(from);
  seedTask(new TaskService({ db, strict: true }), {
    id: "older-task",
    title: "Write the release notes",
    status: "completed",
  });
  db.close();
  const older = await olderRun(from);

  const ran = run(env);
  await ran.started();
  // The older run saved and ended by itself on the ordinary stop.
  expect(await older.ended).toEqual({ code: 0, signal: null });
  expect(older.said()).toEqual(["holding", "asked to stop", "saved"]);
  ran.child.kill("SIGTERM");
  expect(await ran.exited, ran.error()).toBe(0);

  const names = { from: APP_IDENTITIES.fm.app.release, to: APP_IDENTITIES.inf.app.release };
  const lines = ran.lines();
  expect(lines.slice(0, 4)).toEqual([
    m.handoverStoppingTitle({ from: names.from }),
    m.handoverStoppingText(names),
    m.handoverRunMoving(names),
    m.handoverRunContinueLater({ to: names.to }),
  ]);
  expect(lines).toContain(m.handoverRunChecking());
  // Once the work is in, the run goes on with no question and starts fully.
  expect(lines.slice(-3)).toEqual([
    m.handoverRunMoved(names),
    RUN_WORDS.started,
    RUN_WORDS.stopped,
  ]);
  expect(isProfileRetired(from)).toBe(true);
  // The run opened the moved record from its own folder and closed it cleanly.
  expect(readSavedData(to, (saved) => saved.prepare("SELECT id, title FROM tasks").all())).toEqual([
    { id: "older-task", title: "Write the release notes" },
  ]);
});
