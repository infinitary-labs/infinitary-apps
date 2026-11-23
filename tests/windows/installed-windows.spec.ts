import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { runLabelOf } from "@shared/codeNames";
import { HERE } from "@shared/deviceNames";
import { reportSummary } from "@shared/feed";
import { AUTOMATIC_COMPUTER, placementReason } from "@shared/placement";
import {
  STANDBY_FULL_ORDER,
  STANDBY_HELLO_ORDER,
  STANDBY_PIECE_ORDER,
  standbyHelloSchema,
} from "@shared/standby";
import koffi from "koffi";
import { startConnection } from "../../src/core/connection/connection";
import { thisDeviceUser } from "../../src/core/devices/deviceUser";
import { joinCommand } from "../../src/core/devices/joinCommand";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { DevicePairing } from "../../src/core/devices/pairing";
import type { CoreDispatch } from "../../src/core/dispatcher";
import { CoreEventBus } from "../../src/core/events";
import { serviceLabel } from "../../src/core/helper/background";
import { type RunAgentContext, stopRunAgent } from "../../src/core/helper/runAgent";
import {
  endRunByForce,
  RUN_FORCE_DIR,
  RUN_FORCE_WATCH_SOURCE,
  wakeRun,
} from "../../src/core/helper/runForce";
import {
  powerShellTaskLookup,
  RUN_RECORD_FILE,
  requestRunStop,
  runTaskFile,
  WORK_TASK_AGAIN,
} from "../../src/core/helper/windowsTask";
import { helperWords } from "../../src/core/helper/words";
import { readWindowsTable, resumeWindowsRun } from "../../src/core/placed/windowsProcesses";
import { onlyOwnerReaches, readAccessList } from "../../src/core/storage/ownerOnly";
import { GIT_FOR_WINDOWS } from "../../src/core/windowsGit";
import { START_HERE_ARG } from "../../src/main/besideRun";
import { PERSON_WORD_ARG, WORD_TEMP_DIR } from "../../src/main/personWordArg";
import { commandPipe, commandPipeHeld, RUN_LAST_STOP, RUN_MARKER } from "../../src/main/runCommand";
import { BOOT_WORDS } from "../../src/main/startAtBoot";
import { GIT_SETUP_WORDS } from "../../src/main/windowsGitSetup";
import { windowsAppUserModelId } from "../../src/main/windowsStartup";
import * as m from "../../src/shared/i18n/messages.generated";
import {
  CANCEL_PROMPT_MARKER,
  MOCK_COMPLETION_TEXT,
  SPAWN_PROMPT_MARKER,
} from "../e2e/mockProvider";
import { promptInput } from "../e2e/prompt";
import { dockFrameElement, reportLine, startedLine, taskKey } from "../e2e/rails";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { launchInstalled } from "../installed/installedApp";
import {
  JOB_PIDS_FILE,
  stepMark,
  WINDOWS_CREW_MARKER,
  WINDOWS_CREW_STEPS,
  windowsCrew,
} from "./windowsCrew";
import {
  childApps,
  closeShownWindow,
  consoleText,
  holdLockAsStandIn,
  messageWindows,
  openConsole,
  pressDialogButton,
  pressQuitKey,
  ps,
  removalEntries,
  runProcesses,
  runTask,
  type StandInHolder,
  screenshot,
  showsWindow,
  startMenuEntry,
  stillRunning,
  topAppProcesses,
  typeInConsole,
  uninstallerOf,
  workRunProcesses,
} from "./windowsMachine";

/**
 * The Windows installer on a fresh Windows 11 PC (docs/windows.md, "The
 * checks"; INF-4243's piece 1). windows.yml has run the installer the way
 * a person's double-click does, silently, with the app opening at its end.
 * The journey checks the install, presses the Git for Windows offer's
 * install button as a person would, checks that the window starts the
 * command with no window through this person's Task Scheduler and that
 * start-at-boot sets it to start at sign-in (INF-4243's piece 5), starts a
 * task in a project on Automatic, the default for one that lives elsewhere,
 * which once waited on every check Automatic makes of a PC (INF-4650), runs
 * its crew turn, whose commands use that Git, stops the crewmate's job, joins
 * a home as a computer that runs its work through Task Scheduler, once with
 * the line Devices shows another Windows user, its yes typed in a PowerShell
 * console, and once from the window's pasted link, starts that work again
 * after it crashed and leaves it when the home removes it (INF-4260's piece
 * 10), and removes the app.
 */

const evidence = process.env.INFINITARY_INSTALLED_EVIDENCE;

/** The profile a launch's copy was started with, from its command line (`askPersonWord`). */
function userDataDirOf(commandLine: string): string {
  const flag = "--user-data-dir=";
  const at = commandLine.indexOf(flag);
  if (at < 0) throw new Error(`no profile in ${commandLine}`);
  const rest = commandLine.slice(at + flag.length);
  // Quoted as a whole where it holds a space: the quote ends it, otherwise the next space.
  const quoted = commandLine[at - 1] === '"';
  const end = quoted ? rest.indexOf('"') : rest.search(/\s/);
  return end < 0 ? rest : rest.slice(0, end);
}
const keep = (name: string, text: string) => {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, name), text);
};

/** Preserve the other readings if a wedged app cannot answer this one. */
async function diagnosticReading<T>(read: Promise<T>): Promise<T | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ error: "No answer within 5 seconds" }), 5_000);
    });
    return await Promise.race([read, deadline]);
  } catch (error) {
    return { error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Separate a task that did not dispatch from a dispatch Activity did not show. */
async function keepMissedStart(page: Page, key: string): Promise<void> {
  if (!evidence) return;
  const task = page.evaluate(async (wanted) => {
    const row = (await window.infinitary.tasks.board()).tasks.find((task) => task.key === wanted);
    if (!row) return null;
    const detail = await window.infinitary.tasks.detail(row.id);
    return {
      projectId: row.projectId,
      status: row.status,
      activity: row.activity,
      assignee: row.assignee,
      startPolicy: row.startPolicy,
      startAttempt: row.startAttempt,
      startNotice: row.startNotice,
      queueWait: row.queueWait,
      executionDeviceId: row.executionDeviceId,
      events: detail.events.map(({ at, kind, text, feed }) => ({ at, kind, text, feed })),
    };
  }, key);
  const feed = page.evaluate(async (wanted) => {
    const lines = await window.infinitary.feed.recent();
    return lines.filter((line) => line.taskKey === wanted).map(({ at, event }) => ({ at, event }));
  }, key);
  const activity = (async () => {
    // Inspect the frame as it stands, rather than waiting for the drawn mark
    // the failed assertion already waited for.
    const [element] = await dockFrameElement(page, "activity").elementHandles();
    if (!element) return null;
    const drawn = (await element.getAttribute("data-frame-drawn")) !== null;
    const frame = await element.contentFrame();
    const rows = await frame?.locator("[data-feed-row]").evaluateAll((nodes) =>
      nodes.map((node) => ({
        key: node.querySelector("[data-feed-key]")?.textContent?.trim() ?? null,
        event: node.getAttribute("data-feed-event"),
      })),
    );
    return { drawn, rows };
  })();
  const [taskReading, feedReading, activityReading] = await Promise.all([
    diagnosticReading(task),
    diagnosticReading(feed),
    diagnosticReading(activity),
  ]);
  keep(
    "automatic-start-failure.json",
    JSON.stringify(
      { key, task: taskReading, feed: feedReading, activity: activityReading },
      null,
      2,
    ),
  );
}

/**
 * What a failed journey leaves for its diagnosis: the screen, the run's task
 * and programs, and the data folder's run records, which say why a run ended.
 */
test.afterEach(() => {
  const info = test.info();
  if (!evidence || info.status === info.expectedStatus) return;
  const dataDir = join(process.env.APPDATA as string, "infinitary");
  const read = (file: string) => {
    try {
      return readFileSync(join(dataDir, file), "utf8");
    } catch (error) {
      return String(error);
    }
  };
  const listed = () => {
    try {
      return readdirSync(dataDir);
    } catch (error) {
      return String(error);
    }
  };
  screenshot(join(evidence, "on-failure.png"));
  keep(
    "on-failure.json",
    JSON.stringify(
      {
        task: runTask(runLabelOf("release")),
        runs: runProcesses(),
        workRuns: workRunProcesses(),
        apps: topAppProcesses(),
        dataFolder: listed(),
        [RUN_MARKER]: read(RUN_MARKER),
        [RUN_LAST_STOP]: read(RUN_LAST_STOP),
        "work/work.log": read(join("work", "work.log")),
      },
      null,
      2,
    ),
  );
});

/**
 * A small Node project with one test file and a build, committed with the
 * found Git and pushed to its origin, a bare copy elsewhere on the PC: a
 * project that lives somewhere else runs on Automatic (docs/windows.md,
 * "Automatic on a Windows home").
 */
function nodeProject(git: string): string {
  const dir = scratchDir("infinitary-windows-repo-");
  const origin = scratchDir("infinitary-windows-origin-");
  execFileSync(git, ["init", "--bare", "--initial-branch=main", origin]);
  const run = (...args: string[]) => execFileSync(git, ["-C", dir, ...args]);
  run("init", "--initial-branch=main");
  run("config", "user.name", "Test");
  run("config", "user.email", "test@localhost");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "sum",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { build: "node build.mjs", test: "node --test" },
        packageManager: process.env.INFINITARY_WINDOWS_PNPM ?? undefined,
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src", "sum.mjs"), "export const sum = (a, b) => a + b;\n");
  writeFileSync(
    join(dir, "test", "sum.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../src/sum.mjs";\n\ntest("adds", () => assert.equal(sum(2, 3), 5));\n',
  );
  writeFileSync(
    join(dir, "build.mjs"),
    'import { mkdirSync, copyFileSync } from "node:fs";\nmkdirSync("dist", { recursive: true });\ncopyFileSync("src/sum.mjs", "dist/sum.mjs");\n',
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules\ndist\njob-pids.txt\n");
  run("add", "-A");
  run("commit", "-m", "init");
  run("remote", "add", "origin", origin);
  run("push", "origin", "main");
  return dir;
}

test("the Windows installer installs for this person, offers Git, starts the command through Task Scheduler, runs a crew turn, runs a home's work and removes cleanly", async () => {
  test.setTimeout(45 * 60_000);
  const appData = process.env.APPDATA as string;
  const localAppData = process.env.LOCALAPPDATA as string;
  let executable = "";

  await test.step("it installed for this person alone, with a Start menu entry carrying the app's identity", () => {
    const entries = removalEntries();
    keep("removal-entries.json", JSON.stringify(entries, null, 2));
    expect(entries.map((entry) => entry.hive)).toEqual(["HKCU"]);
    // The NSIS installer writes no InstallLocation: its uninstaller sits in the install's folder.
    const location = entries[0] ? dirname(uninstallerOf(entries[0])) : "";
    expect(location.toLowerCase().startsWith(join(localAppData, "Programs").toLowerCase())).toBe(
      true,
    );
    executable = join(location, "Infinitary.exe");
    expect(existsSync(executable)).toBe(true);
    process.env.INFINITARY_INSTALLED_APP = executable;
    const start = startMenuEntry();
    keep("start-menu.json", JSON.stringify(start, null, 2));
    expect(start?.appId).toBe(windowsAppUserModelId(true));
  });

  await test.step("it opened after install the way the Start menu opens it", async () => {
    await expect.poll(() => topAppProcesses().length, { timeout: 60_000 }).toBeGreaterThan(0);
    const top = topAppProcesses();
    keep("opened-after-install.json", JSON.stringify(top, null, 2));
    // A shell open of the Start menu entry: Explorer starts it, never the installer.
    expect(top.map((process) => process.parent.toLowerCase())).toEqual(["explorer.exe"]);
  });

  const gitRoot = join(localAppData, "Programs", "Git");
  await test.step("with no Git on the PC, it offers Git for Windows and installs it on the person's yes", async () => {
    const [opened] = topAppProcesses();
    if (!opened) throw new Error("the app is not running");
    // The PC had no Git: the offer's dialog is up before any window.
    await expect
      .poll(
        () =>
          pressDialogButton(
            opened.pid,
            GIT_SETUP_WORDS.ask.buttons[0],
            evidence && join(evidence, "git-offer-tree.json"),
          ),
        {
          timeout: 60_000,
          intervals: [500],
        },
      )
      .toBe(true);
    if (evidence) screenshot(join(evidence, "git-download.png"));
    // The download, its checks and Git's own installer, then the window.
    // Git's installer writes git.exe before the files it loads, so the check is
    // that the installed Git answers, not that its file exists.
    const gitVersion = (): string => {
      try {
        return execFileSync(join(gitRoot, "cmd", "git.exe"), ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return "";
      }
    };
    await expect
      .poll(gitVersion, { timeout: 10 * 60_000, intervals: [2_000] })
      .toBe(`git version ${GIT_FOR_WINDOWS.version}.windows.1`);
    keep("git-version.txt", gitVersion());
    // The app goes on to open its window once Git is in place.
    await expect
      .poll(
        () =>
          readdirSync(join(appData, "infinitary"), { withFileTypes: true }).some((entry) =>
            entry.name.endsWith(".db"),
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    if (evidence) screenshot(join(evidence, "first-window.png"));
  });

  await test.step("once Git is in place the window starts the command through this person's Task Scheduler, and start-at-boot sets it to start at sign-in", async () => {
    const dataDir = join(appData, "infinitary");
    const label = runLabelOf("release");
    const user = userInfo().username;
    const keepTask = (name: string) => keep(name, JSON.stringify(runTask(label), null, 2));
    const expectRunning = async (signInTriggers: string) => {
      await expect.poll(() => runTask(label)?.state, { timeout: 120_000 }).toBe("Running");
      const task = runTask(label);
      expect(task?.execute.toLowerCase()).toBe(executable.toLowerCase());
      // The task names its agent, which its run reads as the mark Task Scheduler gives no variable for.
      expect(task?.arguments).toBe(`run --agent ${label}`);
      expect(task?.userId.toLowerCase().endsWith(user.toLowerCase())).toBe(true);
      expect(task?.logonType).toBe("Interactive");
      expect(task?.signInTriggers).toBe(signInTriggers);
      // One command, which Task Scheduler started, never the window.
      await expect.poll(() => runProcesses().length, { timeout: 60_000 }).toBe(1);
      expect(runProcesses()[0]?.parent).not.toBe("explorer.exe");
    };
    const stopRun = async () => {
      // What the window's Stop does on Windows: ask through the data folder.
      expect(requestRunStop(dataDir)).toBe(true);
      await expect.poll(() => runProcesses().length, { timeout: 120_000 }).toBe(0);
      await expect.poll(() => runTask(label)?.state, { timeout: 60_000 }).toBe("Ready");
    };

    const windowOpened = async (): Promise<number> => {
      await expect.poll(() => topAppProcesses().length, { timeout: 60_000 }).toBeGreaterThan(0);
      const [window] = topAppProcesses().filter((process) => process.parent === "explorer.exe");
      if (!window) throw new Error("the window is not running");
      return window.pid;
    };
    // taskkill fails the whole tree when one of its programs ended on its own
    // between the walk and the kill (a helper the app had already closed), so
    // the claim is the poll after it: no program of the window is left.
    const closeWindow = async (pid: number) => {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
      await expect.poll(() => stillRunning([pid]), { timeout: 30_000 }).toEqual([]);
    };

    // The first window found no Git, so it offered it and ran its own first
    // mate: a command it started then could not have found Git.
    expect(runProcesses()).toEqual([]);
    expect(runTask(label)).toBe(null);
    const ownWindow = await windowOpened();
    // A second launch while that window holds the data folder's own lock (the review of INF-5409):
    // refused Electron's lock on this PC, it asks the window to answer through the lock itself,
    // and the window's answer ends it, starting no command and no second window. On this PC a
    // refused launch calls its holder a window only from that window's answer, never from what the
    // holder runs as (`holderIsWindow`), so the launch's own last line is the window's receipt: a
    // launch that ended at once, or on anything else, never says it.
    // A launch of the installed app, its words kept in the evidence once it ends.
    const startLaunch = (name: string, args: string[] = []) => {
      const launch = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
      let said = "";
      launch.stdout?.on("data", (chunk) => {
        said += String(chunk);
      });
      launch.stderr?.on("data", (chunk) => {
        said += String(chunk);
      });
      const ended = new Promise<number | null>((resolve) =>
        launch.once("exit", (exitCode) => {
          keep(name, said);
          resolve(exitCode);
        }),
      );
      return {
        pid: launch.pid ?? -1,
        said: () => said,
        ended,
        end: () => {
          if (launch.exitCode === null) launch.kill();
        },
      };
    };
    const refusedLaunch = async (name: string): Promise<string> => {
      const launch = startLaunch(name);
      expect(await launch.ended, launch.said()).toBe(0);
      return launch.said();
    };
    const ANSWERED = "[app] the launch found the folder held by a window";
    expect(await refusedLaunch("refused-launch.txt")).toContain(ANSWERED);
    expect(topAppProcesses().map((app) => app.pid)).toEqual([ownWindow]);
    expect(showsWindow(ownWindow)).toBe(true);
    expect(runProcesses()).toEqual([]);
    expect(runTask(label)).toBe(null);
    // The person closes that last window: on this PC the app keeps its first mate by the clock's
    // icon with no window, as a Mac keeps it in the Dock. A launch refused then is answered by
    // that same program, which opens its window again for the person, and ends; no second app and
    // no command start.
    expect(closeShownWindow(ownWindow)).toBe(true);
    await expect.poll(() => showsWindow(ownWindow), { timeout: 30_000 }).toBe(false);
    expect(topAppProcesses().map((app) => app.pid)).toEqual([ownWindow]);
    expect(await refusedLaunch("refused-launch-no-window.txt")).toContain(ANSWERED);
    await expect.poll(() => showsWindow(ownWindow), { timeout: 30_000 }).toBe(true);
    if (evidence) screenshot(join(evidence, "window-opened-again-for-a-launch.png"));
    expect(topAppProcesses().map((app) => app.pid)).toEqual([ownWindow]);
    expect(runProcesses()).toEqual([]);
    expect(runTask(label)).toBe(null);
    // The lock window Electron made for that window, by its class and the folder that titles it: a
    // stand-in holder (`holdLockAsStandIn`) copies it, as a window from before windows answered a
    // launch would hold the folder, answering nothing and holding no command's pipe, so a refused
    // launch has to tell that holder apart by what it shows (the review of INF-5409).
    const lockWindows = messageWindows(ownWindow);
    keep("lock-windows.json", JSON.stringify(lockWindows, null, 2));
    const lockWindow = lockWindows.find(
      (shown) => resolve(shown.title).toLowerCase() === resolve(dataDir).toLowerCase(),
    );
    if (!lockWindow) throw new Error("the window shows no lock window titled by its data folder");
    await closeWindow(ownWindow);

    const holders: StandInHolder[] = [];
    const launches: { end: () => void }[] = [];
    const standIn = async (): Promise<StandInHolder> => {
      const holder = await holdLockAsStandIn({
        lockFile: join(dataDir, "lockfile"),
        window: lockWindow,
        control: scratchDir("infinitary-windows-holder-"),
      });
      holders.push(holder);
      return holder;
    };
    // The one copy of the launch that shows the person its word (`askPersonWord`), once it runs.
    const wordCopy = async (launchPid: number) => {
      const copies = () =>
        childApps(launchPid).filter((app) => app.commandLine.includes(PERSON_WORD_ARG));
      await expect.poll(() => copies().length, { timeout: 60_000 }).toBe(1);
      const [copy] = copies();
      if (!copy) throw new Error("the launch shows no word");
      return copy;
    };
    const LEFT_OPEN = "[app] the launch found the folder held by a holder the person left open";
    const FREED = "[app] the launch found the folder held by nothing now";
    // How each launch ended: nothing else of the app runs on the folder, no command and no task.
    const nothingRuns = () => {
      expect(topAppProcesses()).toEqual([]);
      expect(runProcesses()).toEqual([]);
      expect(runTask(label)).toBe(null);
    };
    try {
      await test.step("a holder that shows nothing has the person asked, and their Leave it leaves it open and starts nothing when it quits", async () => {
        const holder = await standIn();
        const leaving = startLaunch("refused-launch-left-open.txt");
        launches.push(leaving);
        // Asked once by its own refused ask, then read twice with nothing shown: the person is asked.
        const copy = await wordCopy(leaving.pid);
        expect(holder.asks()).toBe(1);
        if (evidence) screenshot(join(evidence, "once-closed-question.png"));
        await expect
          .poll(
            () =>
              pressDialogButton(
                copy.pid,
                m.dialogLeaveIt(),
                evidence && join(evidence, "once-closed-tree.json"),
              ),
            { timeout: 60_000, intervals: [500] },
          )
          .toBe(true);
        expect(await leaving.ended, leaving.said()).toBe(0);
        expect(leaving.said()).toContain(LEFT_OPEN);
        // Left open: never asked again, and its quit later starts nothing, since the launch that
        // could have started again on it has ended.
        expect(holder.asks()).toBe(1);
        await holder.letGo();
        nothingRuns();
      });

      await test.step("a command's holder is waited for in silence; once its pipe goes the person is asked, a window that takes the folder then answers, the question is taken away unanswered, its private scratch stays theirs, and Ctrl+Q quits that window for good", async () => {
        const me = await thisDeviceUser({ platform: "win32" });
        if (!me || !("sid" in me)) throw new Error("Windows did not say which user this is");
        // The command's pipe, held by the check as a command holds it, counting each read of it.
        let pipeReads = 0;
        const pipe = createServer((socket) => {
          pipeReads += 1;
          socket.destroy();
        });
        await new Promise<void>((done) => pipe.listen(commandPipe(dataDir), done));
        const holder = await standIn();
        const turnover = startLaunch("refused-launch-window-took-over.txt");
        launches.push(turnover);
        try {
          // Asked once by its own refused ask, then read by its pipe again and again with nothing
          // shown: a command may hold the lock before it notes itself.
          await expect.poll(() => pipeReads, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
          expect(holder.asks()).toBe(1);
          expect(
            childApps(turnover.pid).filter((app) => app.commandLine.includes(PERSON_WORD_ARG)),
          ).toEqual([]);
          expect(stillRunning([turnover.pid])).toEqual([turnover.pid]);
        } finally {
          await new Promise((done) => pipe.close(done));
        }
        // The pipe gone while the lock stays held: another holder, never read, so it is asked once
        // more, and, still showing nothing on its next read, the person is asked.
        const copy = await wordCopy(turnover.pid);
        expect(holder.asks()).toBe(2);
        // The copy's own profile and its temporary folder, inside the data folder.
        const profile = userDataDirOf(copy.commandLine);
        const scratch = join(profile, WORD_TEMP_DIR);
        expect(existsSync(scratch)).toBe(true);
        // A file of the copy's scratch, which the next holder's start must leave where it is.
        const kept = join(scratch, "check-scratch.txt");
        writeFileSync(kept, "kept\n");
        await holder.letGoSeen();
        // Start it here takes the folder while the question is up, and runs its own first mate.
        const window = startLaunch("start-here-window.txt", [START_HERE_ARG]);
        launches.push(window);
        expect(await turnover.ended, turnover.said()).toBe(0);
        expect(turnover.said()).toContain(ANSWERED);
        // Taken away with no press: the copy ended with its launch.
        await expect.poll(() => stillRunning([copy.pid]), { timeout: 30_000 }).toEqual([]);
        expect(readFileSync(kept, "utf8")).toBe("kept\n");
        for (const folder of [profile, scratch]) {
          const sddl = ps<string>("(Get-Acl -LiteralPath $env:WORD_DIR).Sddl", {
            WORD_DIR: folder,
          });
          keep(`word-${basename(folder)}-access.txt`, sddl);
          expect(onlyOwnerReaches(readAccessList(sddl), me.sid)).toBe(true);
        }
        await expect.poll(() => showsWindow(window.pid), { timeout: 60_000 }).toBe(true);
        if (evidence) screenshot(join(evidence, "window-took-over.png"));
        expect(topAppProcesses().map((app) => app.pid)).toEqual([window.pid]);
        expect(runProcesses()).toEqual([]);
        // The person quits that window on purpose with its own key, which runs the tray's Quit.
        const quitKey = pressQuitKey(window.pid);
        const quitReading = JSON.stringify(quitKey, null, 2);
        keep("takeover-quit-input.json", quitReading);
        expect(quitKey.status, quitReading).toBe("sent");
        expect(await window.ended, window.said()).toBe(0);
        nothingRuns();
      });

      await test.step("the person's Open here waits for the holder to close, then opens the window, which starts the command", async () => {
        const holder = await standIn();
        const opening = startLaunch("refused-launch-open-here.txt");
        launches.push(opening);
        const copy = await wordCopy(opening.pid);
        await expect
          .poll(() => pressDialogButton(copy.pid, m.dialogOpenOnceClosed()), {
            timeout: 60_000,
            intervals: [500],
          })
          .toBe(true);
        await expect.poll(() => stillRunning([copy.pid]), { timeout: 30_000 }).toEqual([]);
        // Answered, it still waits for the holder: no window of its own while the folder is held.
        expect(stillRunning([opening.pid])).toEqual([opening.pid]);
        expect(topAppProcesses().map((app) => app.pid)).toEqual([opening.pid]);
        await holder.letGo();
        expect(await opening.ended, opening.said()).toBe(0);
        expect(opening.said()).toContain(FREED);
        // Started again, the launch opens its window and starts the command as any window does.
        await expect
          .poll(() => topAppProcesses().filter((app) => showsWindow(app.pid)).length, {
            timeout: 60_000,
          })
          .toBe(1);
        const [reopened] = topAppProcesses().filter((app) => showsWindow(app.pid));
        if (!reopened) throw new Error("the launch opened no window");
        await expectRunning("off");
        if (evidence) screenshot(join(evidence, "opened-once-closed.png"));
        await closeWindow(reopened.pid);
        await stopRun();
      });
    } finally {
      for (const launch of launches) launch.end();
      for (const holder of holders) holder.end();
    }

    // Opened again from the Start menu, the window registers the run's task,
    // its sign-in trigger off until Start at login turns it on, and asks
    // Task Scheduler to start it.
    try {
      execFileSync("explorer.exe", [`shell:AppsFolder\\${windowsAppUserModelId(true)}`]);
    } catch {
      // Explorer answers 1 when it hands the open on.
    }
    const window = await windowOpened();
    await expectRunning("off");
    // The installed command holds its pipe on this PC's own named pipes, by the folder it runs on,
    // which a window launch refused the lock tells a command by (the review of INF-5409); it goes
    // with the command.
    expect(await commandPipeHeld(commandPipe(dataDir))).toBe(true);
    keepTask("task-from-window.json");
    if (evidence) screenshot(join(evidence, "window-beside-command.png"));
    // A second launch while that window holds the folder (the review of INF-5409): refused
    // Electron's own lock on this PC, it is answered by that window and ends without starting the
    // app again, so the one window stays the only one and the person's later close of it stays.
    // A launch that started the app again would have done so before it ended.
    const windows = () => {
      const commands = new Set(runProcesses().map((run) => run.pid));
      return topAppProcesses()
        .map((app) => app.pid)
        .filter((pid) => !commands.has(pid));
    };
    // That window's receipt is what it does for the person: closed by them first, it keeps
    // working by the clock's icon, and the launch it receives opens it again, which a launch that
    // ended at once would leave closed.
    expect(closeShownWindow(window)).toBe(true);
    await expect.poll(() => showsWindow(window), { timeout: 30_000 }).toBe(false);
    expect(windows()).toEqual([window]);
    const second = spawn(executable, [], { stdio: "ignore" });
    const secondEnd = await new Promise<number | null>((resolve) =>
      second.once("exit", (code) => resolve(code)),
    );
    expect(secondEnd).toBe(0);
    await expect.poll(() => showsWindow(window), { timeout: 30_000 }).toBe(true);
    expect(windows()).toEqual([window]);
    // Closing the window leaves the command and its first mate running.
    await closeWindow(window);
    expect(runProcesses().length).toBe(1);
    expect(windows()).toEqual([]);
    await stopRun();
    expect(await commandPipeHeld(commandPipe(dataDir))).toBe(false);

    // `infinitary start-at-boot` turns the sign-in trigger on and starts it now.
    const set = execFileSync(executable, ["start-at-boot"], { encoding: "utf8" });
    keep("start-at-boot.txt", set);
    expect(set).toContain(BOOT_WORDS.windowsSet(user)[0]);
    await expectRunning("on");
    keepTask("task-from-start-at-boot.json");

    // Restart it and Start it here's force stop, on a running installed command (the review of
    // INF-5409): the installed run reads a force stop naming it by its process and start on a
    // thread of its own and ends itself, a stop naming another start ends nothing and is
    // withdrawn, and the stop is called ended only once no program runs under the run's number.
    // A bystander program the stop does not name keeps running. The run is named only once its
    // own note names the one command Task Scheduler started.
    const readMarker = (): { pid: number; startedAt: string } | null => {
      try {
        const marker = JSON.parse(readFileSync(join(dataDir, RUN_MARKER), "utf8"));
        return typeof marker?.pid === "number" && typeof marker.startedAt === "string"
          ? { pid: marker.pid, startedAt: marker.startedAt }
          : null;
      } catch {
        return null;
      }
    };
    await expect
      .poll(
        () => {
          const marker = readMarker();
          const [only] = runProcesses();
          return marker !== null && only !== undefined && marker.pid === only.pid;
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const marked = readMarker() as { pid: number; startedAt: string };
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      expect(
        await endRunByForce(
          dataDir,
          { pid: marked.pid, startedAt: new Date(0).toISOString() },
          undefined,
          3_000,
        ),
      ).toBe("withdrawn");
      expect(runProcesses().length).toBe(1);
      expect(await endRunByForce(dataDir, marked)).toBe("ended");
      expect(stillRunning([marked.pid])).toEqual([]);
      expect(stillRunning([bystander.pid ?? -1])).toEqual([bystander.pid]);
    } finally {
      bystander.kill();
    }
    await expect.poll(() => runProcesses().length, { timeout: 120_000 }).toBe(0);
    await expect.poll(() => runTask(label)?.state, { timeout: 60_000 }).toBe("Ready");

    // A run whose whole process is suspended, as a fully frozen first mate's (the review of
    // INF-5409), through the force stop Restart it and Start it here ask (`stopRunAgent`'s
    // force): the starter lets the run go on only through a handle to the program whose birth its
    // record keeps, which Windows itself reads (`readWindowsTable`), and reads the run by that birth
    // too. A record naming another birth is no run of the stop: nothing is asked or woken and the
    // run stays suspended; the run's own birth lets it go on, and it ends itself. A disposable program stands in for the run, heartbeating while it runs.
    await suspendedRunForce();

    // Task Scheduler's own answer for this task, which a refused removal reads before it lets
    // the task's file go (the review of INF-5409): there while it is registered.
    expect(await powerShellTaskLookup(process.env, label)).toBe("there");

    // `--off` takes the task away.
    const off = execFileSync(executable, ["start-at-boot", "--off"], { encoding: "utf8" });
    keep("start-at-boot-off.txt", off);
    expect(off).toContain(BOOT_WORDS.windowsOff(user)[0]);
    expect(runTask(label)).toBe(null);
    // And its not-found answer for that same task once it is gone.
    expect(await powerShellTaskLookup(process.env, label)).toBe("gone");
    expect(existsSync(runTaskFile(dataDir))).toBe(false);
    await expect.poll(() => topAppProcesses().length, { timeout: 30_000 }).toBe(0);
  });

  await test.step("a task in a project that lives elsewhere starts on this PC through Automatic, its crewmate's commands run in that Git's Git Bash, and stopping its job ends every program under it", async () => {
    const launched = await launchInstalled({ scenarios: [windowsCrew] });
    try {
      const { page, mockProvider } = launched;
      const health = await page.evaluate(() => window.infinitary.app.healthcheck());
      expect(health.platform).toBe("win32");
      const repo = nodeProject(join(gitRoot, "cmd", "git.exe"));
      const { repo: project } = await page.evaluate(
        (path) => window.infinitary.repos.setup({ kind: "adopt", path }),
        repo,
      );
      expect(project.runsOn).toBe(AUTOMATIC_COMPUTER);
      const title = `${WINDOWS_CREW_MARKER} in ${basename(repo)}`;
      const input = promptInput(page);
      await input.click();
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      const key = await taskKey(page, title);
      // Automatic compares on a fresh reading of the PC, which a start may wait a round for.
      try {
        await expect(startedLine(page, key)).toBeVisible({ timeout: 180_000 });
      } catch (error) {
        await keepMissedStart(page, key).catch((diagnosticError) => {
          console.warn(`Could not keep the Automatic start failure: ${String(diagnosticError)}`);
        });
        throw error;
      }
      // Automatic chose this PC, with none of its checks refusing it: the
      // installed app's start runs on the default model, which notes the
      // choice on the task rather than saving a placement record.
      const id = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
        (task) => task.key === key,
      )?.id;
      const { activityLog } = await page.evaluate(
        (taskId) => window.infinitary.tasks.detail(taskId),
        id ?? "",
      );
      keep("activity.json", JSON.stringify(activityLog ?? null, null, 2));
      const lines = (activityLog ?? []).flatMap((row) => [row, ...(row.folded ?? [])]);
      expect(lines.map((line) => line.text)).toContain(
        placementReason({ computerName: HERE.This }),
      );
      // The PC's own reading, as Automatic compares it: fresh, with a memory
      // figure. Each read renews sampling, so the first may still be stale.
      const homeReading = () =>
        page.evaluate(async () => {
          const view = await window.infinitary.plugins.read("computers.resources", {});
          return view.computers.find((row) => row.computerId === null)?.reading ?? null;
        });
      await expect
        .poll(async () => (await homeReading())?.status, { timeout: 30_000 })
        .toBe("fresh");
      const reading = await homeReading();
      keep("home-reading.json", JSON.stringify(reading, null, 2));
      expect(reading?.status === "fresh" ? reading.memoryUsedBytes : undefined).toBeGreaterThan(0);
      await expect(
        // The turn's report; a later turn the running job wakes may report again.
        reportLine(page, key)
          .filter({ hasText: reportSummary(MOCK_COMPLETION_TEXT) })
          .first(),
      ).toBeVisible({ timeout: 10 * 60_000 });
      const bodies = mockProvider.requestBodies().join("\n");
      keep("crew-requests.txt", bodies);
      for (const step of WINDOWS_CREW_STEPS)
        expect(bodies.includes(stepMark(step.id)), `${step.id}: ${step.command}`).toBe(true);
      if (evidence) await page.screenshot({ path: join(evidence, "crew-turn.png") });

      // The job's program and its own child, both still running.
      const pidsFile = await jobPidsFile(join(gitRoot, "cmd", "git.exe"), repo);
      const pids = readFileSync(pidsFile, "utf8").trim().split(" ").map(Number);
      keep("job-pids.txt", pids.join(" "));
      expect(stillRunning(pids)).toEqual(pids);
      await input.fill(`${CANCEL_PROMPT_MARKER}${title}`);
      await input.press("Enter");
      await expect.poll(() => stillRunning(pids), { timeout: 60_000 }).toEqual([]);
    } finally {
      await launched.close();
    }
  });

  await test.step("the Devices line run by the home's own Windows account is refused, its yes typed in a PowerShell console", async () => {
    const me = await thisDeviceUser({ platform: "win32" });
    if (!me || !("sid" in me)) throw new Error("Windows did not say which user this is");
    // A home whose own account is this one.
    const home = await standInHome({ ownSid: me.sid });
    let consolePid = 0;
    try {
      const { link } = home.pairing.invite({ kind: "work", at: `127.0.0.1:${home.port}` });
      consolePid = openConsole(
        joinCommand({
          for: "another-user",
          link,
          homeName: "MacBook Pro",
          launcher: { executable, args: [] },
          version: "",
          windows: { localAppData },
        }),
      );
      await expect
        .poll(() => consoleText(consolePid), { timeout: 120_000, intervals: [1_000] })
        .toContain(helperWords.prompt.trim());
      expect(typeInConsole(consolePid, "yes")).toBe(true);
      // A long line wraps on the console's screen: compare without the spaces and breaks.
      const flat = (text: string) => text.replace(/\s+/g, "");
      await expect
        .poll(() => flat(consoleText(consolePid)), { timeout: 120_000 })
        .toContain(flat(helperWords.sameUser[0] ?? ""));
      keep("same-user-console.txt", consoleText(consolePid));
      if (evidence) screenshot(join(evidence, "same-user-console.png"));
      expect(home.pairing.list()).toEqual([]);
      expect(new JoinedHome(join(appData, "infinitary", "work")).read()).toBeNull();
    } finally {
      if (consolePid) closeProcessTree(consolePid);
      await home.close();
    }
  });

  await test.step("it joins a home with the Devices line for another Windows user, its yes typed in a PowerShell console, runs the home's work through this person's Task Scheduler in an owner-only folder, keeps a copy of the home's record and puts a newer one in place, starts it again after it crashed with its copy as it was, and leaves it when the home removes it", async () => {
    const workDir = join(appData, "infinitary", "work");
    const label = serviceLabel("release");
    const me = await thisDeviceUser({ platform: "win32" });
    if (!me || !("sid" in me)) throw new Error("Windows did not say which user this is");
    const home = await standInHome();
    let consolePid = 0;
    try {
      const { link } = home.pairing.invite({ kind: "work", at: `127.0.0.1:${home.port}` });
      // The line Devices on a Windows home shows for another user on that PC,
      // naming Infinitary in the folder of whoever runs it.
      const line = joinCommand({
        for: "another-user",
        link,
        homeName: "MacBook Pro",
        launcher: { executable, args: [] },
        version: "",
        windows: { localAppData },
      });
      keep("work-join-line.txt", line);
      expect(line).toContain("$env:LOCALAPPDATA");
      // Pasted into a PowerShell window, which asks its question there; the
      // yes is typed into that console's input as a keyboard types it.
      consolePid = openConsole(line);
      const question = helperWords.prompt.trim();
      await expect
        .poll(() => consoleText(consolePid), { timeout: 120_000, intervals: [1_000] })
        .toContain(question);
      if (evidence) screenshot(join(evidence, "work-join-question.png"));
      expect(typeInConsole(consolePid, "yes")).toBe(true);
      // The join keeps the home's name and where this PC runs, both from the
      // one welcome its dial heard, on the grant here (`keepHeard`).
      await expect
        .poll(() => new JoinedHome(workDir).read(), { timeout: 120_000 })
        .toMatchObject({ name: "MacBook Pro", grant: { onHomeMac: true } });
      const [device] = home.pairing.list();
      expect(device).toMatchObject({ kind: "work", onThisMac: true });
      // The line ends once it joined, and the console takes the next line.
      await expect
        .poll(() => consoleText(consolePid).trimEnd().split(/\r?\n/).at(-1), {
          timeout: 120_000,
        })
        .toMatch(/^PS .*>$/);
      keep("work-join-console.txt", consoleText(consolePid));
      if (evidence) screenshot(join(evidence, "work-join-console.png"));

      // Task Scheduler runs `work run` as this person in their session, again each minute after it ends.
      await expect.poll(() => runTask(label)?.state, { timeout: 120_000 }).toBe("Running");
      const task = runTask(label);
      keep("work-task.json", JSON.stringify(task, null, 2));
      expect(task?.execute.toLowerCase()).toBe(executable.toLowerCase());
      expect(task?.arguments).toBe("work run");
      expect(task?.logonType).toBe("Interactive");
      const again = ps<string>(
        "@((Get-ScheduledTask -TaskPath '\\' -TaskName $env:WORK_TASK).Triggers | ForEach-Object { $_.Repetition.Interval } | Where-Object { $_ }) -join ' '",
        { WORK_TASK: label },
      );
      expect(again).toBe(WORK_TASK_AGAIN);
      // The run reaches the home.
      await expect.poll(() => home.reached, { timeout: 120_000 }).toContain(device?.id);

      // It keeps a copy of the home's record, and puts a newer full copy in
      // place over the one there: Windows refuses that rename while any file
      // of the copy is still open (docs/windows.md, "Keeping a copy, moving
      // and taking over").
      const copyDir = join(workDir, "standby", "copy");
      const first = { "knowledge/notes.md": "first copy\n", "crewmates/T-1/report.md": "kept\n" };
      await sendFullCopy(home, device?.id ?? "", first, 1);
      expect(readFileSync(join(copyDir, "knowledge", "notes.md"), "utf8")).toBe("first copy\n");
      const newer = { "knowledge/notes.md": "newer copy\n", "crewmates/T-1/report.md": "kept\n" };
      await sendFullCopy(home, device?.id ?? "", newer, 2);
      expect(readFileSync(join(copyDir, "knowledge", "notes.md"), "utf8")).toBe("newer copy\n");
      expect(existsSync(join(workDir, "standby", "copy-old"))).toBe(false);
      keep(
        "work-copy-hello.json",
        JSON.stringify(await copyHello(home, device?.id ?? ""), null, 2),
      );

      // The work folder lets in this person alone.
      const sddl = ps<string>("(Get-Acl -LiteralPath $env:WORK_DIR).Sddl", { WORK_DIR: workDir });
      keep("work-folder-access.txt", sddl);
      expect(onlyOwnerReaches(readAccessList(sddl), me.sid)).toBe(true);

      // A run that crashed starts again on the task's next minute and reaches the home again.
      const [crashed] = workRunProcesses();
      if (!crashed) throw new Error("no work run is running");
      const contacts = home.reached.length;
      execFileSync("taskkill", ["/PID", String(crashed.pid), "/T", "/F"], { stdio: "ignore" });
      await expect
        .poll(() => workRunProcesses().filter((run) => run.pid !== crashed.pid).length, {
          timeout: 180_000,
        })
        .toBe(1);
      await expect.poll(() => home.reached.length, { timeout: 120_000 }).toBeGreaterThan(contacts);
      // The copy the killed run kept opens as it was when it started again.
      await expect
        .poll(async () => (await copyHello(home, device?.id ?? "").catch(() => null))?.seq, {
          timeout: 120_000,
        })
        .toBe(2);
      expect(readFileSync(join(copyDir, "knowledge", "notes.md"), "utf8")).toBe("newer copy\n");
      keep("work-task-after-crash.json", JSON.stringify(runTask(label), null, 2));

      // The home removes it: the run forgets the grant and takes its task away.
      home.pairing.remove(device?.id ?? "");
      await expect.poll(() => runTask(label), { timeout: 120_000 }).toBe(null);
      await expect.poll(() => new JoinedHome(workDir).read(), { timeout: 60_000 }).toBeNull();
      await expect.poll(() => workRunProcesses().length, { timeout: 60_000 }).toBe(0);
    } finally {
      if (consolePid) closeProcessTree(consolePid);
      await home.close();
    }
  });

  await test.step("the window joins a home by its pasted link and sets up the same Task Scheduler work, which leaves when the home removes it", async () => {
    const dataDir = join(appData, "infinitary");
    const workDir = join(dataDir, "work");
    const label = serviceLabel("release");
    const home = await standInHome({ anotherComputer: true });
    const launched = await launchInstalled({ ownDataDir: dataDir });
    try {
      const { link } = home.pairing.invite({ kind: "mac", at: `127.0.0.1:${home.port}` });
      await joinReady(launched.page);
      const [started] = runProcesses();
      if (!started) throw new Error("the window's command is not running");
      // Joining starts the window over, so its answer may never return to this page.
      await launched.page.evaluate((text) => {
        void window.infinitary.devices.join(text);
      }, link);
      await expect.poll(() => home.pairing.list().length, { timeout: 120_000 }).toBe(1);
      const [device] = home.pairing.list();
      keep("window-join-device.json", JSON.stringify(device, null, 2));
      expect(device?.kind).toBe("mac");
      // The window's join answers first, and the window sets this PC's work
      // up once it is a view (`setUpWork`); the work run names the home once
      // it reaches it.
      await expect
        .poll(() => new JoinedHome(workDir).read(), { timeout: 120_000 })
        .toMatchObject({ name: "MacBook Pro" });
      await expect.poll(() => runTask(label)?.state, { timeout: 120_000 }).toBe("Running");
      const task = runTask(label);
      keep("window-work-task.json", JSON.stringify(task, null, 2));
      expect(task?.execute.toLowerCase()).toBe(executable.toLowerCase());
      expect(task?.arguments).toBe("work run");
      expect(task?.logonType).toBe("Interactive");
      await expect.poll(() => home.reached, { timeout: 120_000 }).toContain(device?.id);
      // The run the window started has gone while the joined work run reaches the home, before
      // any cleanup below could stop it.
      await expect
        .poll(() => runProcesses().map((run) => run.pid), { timeout: 60_000 })
        .not.toContain(started.pid);
      // No run of this computer's own first mate is left at all, a later one included.
      expect(runProcesses()).toEqual([]);
      expect(workRunProcesses().length).toBe(1);
      // And that work run answers the home now, not only once before: a read-only ask it answers
      // over its current contact.
      await expect
        .poll(async () => (await copyHello(home, device?.id ?? "").catch(() => null)) !== null, {
          timeout: 60_000,
        })
        .toBe(true);
      if (evidence) screenshot(join(evidence, "window-joined.png"));

      home.pairing.remove(device?.id ?? "");
      await expect.poll(() => runTask(label), { timeout: 120_000 }).toBe(null);
      await expect.poll(() => new JoinedHome(workDir).read(), { timeout: 60_000 }).toBeNull();
      await expect.poll(() => workRunProcesses().length, { timeout: 60_000 }).toBe(0);
      // The window, a view of that home since the join, hears it was removed
      // and leaves as Leave does (docs/view.md, "Removed at the other Mac").
      await expect
        .poll(() => new JoinedHome(join(dataDir, "joined")).read(), { timeout: 60_000 })
        .toBeNull();
    } finally {
      await launched.close();
      await home.close();
      // The window started the command with no window as it opened: ask it to stop.
      if (runProcesses().length > 0) {
        requestRunStop(dataDir);
        await expect.poll(() => runProcesses().length, { timeout: 120_000 }).toBe(0);
      }
    }
  });

  await test.step("the window joins a throwaway home on another computer by its pasted link, runs its work over the network, and leaves when that home removes it", async () => {
    // Only a run asked with such a link (windows.yml's `home_link`); the
    // home on the other computer drives the rest and removes this PC.
    const link = process.env.INFINITARY_WINDOWS_HOME_LINK?.trim();
    if (!link) return;
    const dataDir = join(appData, "infinitary");
    const workDir = join(dataDir, "work");
    const label = serviceLabel("release");
    const launched = await launchInstalled({ ownDataDir: dataDir });
    try {
      // Whether this PC reaches that home at all, apart from the app: a
      // network that keeps the two apart reads here, not as a refused join.
      keep("network-reach.txt", await reaches(new URL(link).searchParams.get("at") ?? ""));
      // The window's own command must be known before the link is used once, as above.
      await joinReady(launched.page);
      // A refusal answers on this page; a join starts the window over, so
      // its answer never returns.
      const answer = await Promise.race([
        launched.page
          .evaluate((text) => window.infinitary.devices.join(text), link)
          .then((outcome) => JSON.stringify(outcome))
          .catch((error: unknown) => `the window started over: ${String(error)}`),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("the join had not answered in three minutes"), 180_000),
        ),
      ]);
      keep("network-join-answer.txt", answer);
      await expect
        .poll(() => new JoinedHome(workDir).read(), { timeout: 180_000, message: answer })
        .not.toBeNull();
      // What the PC joined, never its grant's own key, certificate or the home's pin.
      const joined = new JoinedHome(workDir).read();
      keep(
        "network-joined-home.json",
        JSON.stringify(
          joined && {
            name: joined.name,
            joinedAt: joined.joinedAt,
            at: joined.grant.at,
            kind: joined.grant.kind,
            deviceId: joined.grant.deviceId,
            onHomeMac: joined.grant.onHomeMac,
          },
          null,
          2,
        ),
      );
      await expect.poll(() => runTask(label)?.state, { timeout: 120_000 }).toBe("Running");
      keep("network-work-task.json", JSON.stringify(runTask(label), null, 2));
      if (evidence) screenshot(join(evidence, "network-joined.png"));
      // That home reads this PC and then removes it, which ends the work here.
      await expect.poll(() => new JoinedHome(workDir).read(), { timeout: 10 * 60_000 }).toBeNull();
      await expect.poll(() => runTask(label), { timeout: 120_000 }).toBe(null);
      await expect.poll(() => workRunProcesses().length, { timeout: 60_000 }).toBe(0);
    } finally {
      await launched.close();
      if (runProcesses().length > 0) {
        requestRunStop(dataDir);
        await expect.poll(() => runProcesses().length, { timeout: 120_000 }).toBe(0);
      }
    }
  });

  await test.step("removing it in Windows Settings' way keeps the saved work", async () => {
    const [entry] = removalEntries();
    if (!entry) throw new Error("no removal entry");
    // The removal entry's own command, silently, as Settings runs it.
    execFileSync(uninstallerOf(entry), ["/S"]);
    // NSIS's uninstaller runs on from a copy of itself: the app's files go
    // first, then its Start menu entry and removal entry.
    await expect.poll(() => existsSync(executable), { timeout: 120_000 }).toBe(false);
    await expect.poll(() => removalEntries(), { timeout: 60_000 }).toEqual([]);
    await expect.poll(() => startMenuEntry(), { timeout: 60_000 }).toBe(null);
    const kept = readdirSync(join(appData, "infinitary"));
    keep("kept-after-removal.json", JSON.stringify(kept, null, 2));
    expect(kept.some((name) => name.endsWith(".db"))).toBe(true);
  });
});

/** The job's numbers file, in the task's working copy under the project's worktrees. */
/**
 * Waits until the window accepts a pasted link (the review of INF-5409): it started the command
 * through Task Scheduler as it opened, which answers before the run begins, and Paste its link is
 * accepted only once that run has welcomed the window as its own, so the join stops that run
 * rather than leaving it beside the view. The link is then used once.
 */
async function joinReady(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.infinitary.devices.followAdded()), {
      timeout: 120_000,
    })
    .toMatchObject({ pastes: true });
}

async function jobPidsFile(git: string, repo: string): Promise<string> {
  let found = "";
  await expect
    .poll(
      () => {
        const worktrees = execFileSync(git, ["-C", repo, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        })
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length));
        found =
          worktrees.map((dir) => join(dir, JOB_PIDS_FILE)).find((file) => existsSync(file)) ?? "";
        return found;
      },
      { timeout: 60_000 },
    )
    .not.toBe("");
  return found;
}

/**
 * A home on this PC's loopback, standing in another Windows account's
 * Infinitary, as a Mac home stands in another macOS user in run-work.spec.ts:
 * its own account is never this one unless `ownSid` names it. `reached` lists each computer that
 * reached it to take its work, once per contact.
 */
async function standInHome(options: { ownSid?: string; anotherComputer?: boolean } = {}) {
  const ownSid = options.ownSid ?? "S-1-5-21-1000000000-1000000000-1000000000-1999";
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-windows-home-"), "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    port,
    ownSid: () => ownSid,
    // Reached on this PC's loopback, a window joins as a second app here,
    // which only controls; a home on another computer pairs it as one that
    // runs work (`joinedKind`, docs/devices.md, "Joining").
    ...(options.anotherComputer ? { joinsFromAnotherMac: true } : {}),
  });
  const connection = startConnection({
    dispatch: (async (channel) => {
      throw new Error(`Rejected ${channel}`);
    }) as CoreDispatch,
    events: new CoreEventBus(),
    devices: pairing,
    port,
    name: () => "MacBook Pro",
  });
  const reached: string[] = [];
  connection.onWorkDevice((contact) => {
    if (contact.contact === "in-reach") reached.push(contact.deviceId);
  });
  await connection.settled();
  return {
    port,
    pairing,
    reached,
    connection,
    close: async () => {
      await connection.close();
      pairing.dispose();
    },
  };
}

const COPY_STREAM = randomUUID();

/** A full copy of `files`, sent to `deviceId` as a home sends one: each file's blob, then the copy. */
async function sendFullCopy(
  home: Awaited<ReturnType<typeof standInHome>>,
  deviceId: string,
  files: Record<string, string>,
  seq: number,
): Promise<void> {
  const named = Object.entries(files).map(([path, text]) => {
    const data = Buffer.from(text, "utf8");
    return {
      path,
      data,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  });
  for (const file of named)
    await home.connection.ask(deviceId, STANDBY_PIECE_ORDER, [
      { sha256: file.sha256, size: file.size, offset: 0, data: file.data.toString("base64") },
    ]);
  const placed = await home.connection.ask(deviceId, STANDBY_FULL_ORDER, [
    {
      stream: COPY_STREAM,
      seq,
      at: Date.now(),
      part: 0,
      last: true,
      files: named.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    },
  ]);
  expect(placed).toEqual({ ok: true });
}

/** What the copy on `deviceId` says it holds. */
async function copyHello(home: Awaited<ReturnType<typeof standInHome>>, deviceId: string) {
  return standbyHelloSchema.parse(await home.connection.ask(deviceId, STANDBY_HELLO_ORDER, []));
}

/** Whether a plain connection to `host:port` opens within ten seconds, in words. */
function reaches(at: string): Promise<string> {
  const split = at.lastIndexOf(":");
  const host = at.slice(0, split).replace(/^\[|\]$/g, "");
  const port = Number(at.slice(split + 1));
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 10_000 });
    const done = (words: string) => {
      socket.destroy();
      resolve(`${at}: ${words}`);
    };
    socket.once("connect", () => done("opened"));
    socket.once("timeout", () => done("no answer within ten seconds"));
    socket.once("error", (error) => done(`refused: ${error.message}`));
  });
}

/** Ends a process and every program under it; it may already have ended. */
function closeProcessTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}

/** The force stop of a suspended stand-in run, through its recorded birth (see its caller). */
async function suspendedRunForce(): Promise<void> {
  const folder = scratchDir("infinitary-installed-force-");
  const heartbeat = join(folder, "heartbeat");
  const reading = join(folder, "reading");
  const startedAt = new Date().toISOString();
  // The run notes its reading's own word that it read the folder, as the run's note says it can be
  // ended by force only once that reading says so.
  const program = `
    const { Worker } = require("node:worker_threads");
    const { writeFileSync } = require("node:fs");
    new Worker(process.env.WATCH, {
      eval: true,
      workerData: { dir: process.env.DIR, startedAt: process.env.STARTED, every: 100 },
    }).on("message", (word) => { if (word === "reading") writeFileSync(process.env.READING, ""); });
    setInterval(() => writeFileSync(process.env.BEAT, String(Date.now())), 100);
  `;
  mkdirSync(join(folder, RUN_FORCE_DIR), { recursive: true });
  const run = spawn(process.execPath, ["-e", program], {
    stdio: "ignore",
    env: {
      ...process.env,
      WATCH: RUN_FORCE_WATCH_SOURCE,
      DIR: join(folder, RUN_FORCE_DIR),
      STARTED: startedAt,
      BEAT: heartbeat,
      READING: reading,
    },
  });
  const pid = run.pid ?? -1;
  try {
    await expect.poll(() => existsSync(heartbeat), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => existsSync(reading), { timeout: 30_000 }).toBe(true);
    const birth = readWindowsTable()?.find((row) => row.pid === pid)?.started;
    expect(birth).toMatch(/^win:/);
    const kernel32 = koffi.load("kernel32.dll");
    const ntdll = koffi.load("ntdll.dll");
    const openProcess = kernel32.func(
      "void * __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)",
    );
    const suspend = ntdll.func("int32_t __stdcall NtSuspendProcess(void *process)");
    const closeHandle = kernel32.func("int32_t __stdcall CloseHandle(void *handle)");
    const handle = openProcess(0x0800, 0, pid);
    expect(handle).toBeTruthy();
    try {
      expect(suspend(handle)).toBe(0);
    } finally {
      closeHandle(handle);
    }
    const beat = () => readFileSync(heartbeat, "utf8");
    const suspendedAt = beat();
    const record = (recorded: string) =>
      writeFileSync(
        join(folder, RUN_RECORD_FILE),
        `${JSON.stringify({ pid, startedAt, agent: true, recovers: true, birth: recorded })}\n`,
      );
    const context = {
      label: "infinitary-force-check",
      dataDir: folder,
      homeDir: folder,
      uid: 0,
      unitsDir: folder,
      env: {},
      // The production reading of the run, by the birth its record keeps.
      processes: { forceWaitMs: 2_000 },
    } as unknown as RunAgentContext;
    const run0 = { pid, startedAt };

    // A record that says a force stop can end the run, as the run's own does once its reading said
    // so, but whose birth is not the program under the number: no run of this stop, so nothing is
    // asked or woken, and the program stays suspended. Only the birth differs from the case below.
    record("win:1");
    expect(await stopRunAgent(context, { forget: false, force: run0 })).toBe("untouched");
    expect(stillRunning([pid])).toEqual([pid]);
    expect(beat()).toBe(suspendedAt);
    // The wake's own check of the birth, at the native handle: a program under the run's number
    // since the first look whose birth is not the one asked for is not let go on, through the
    // production wake as through its native call, and the run stays suspended. Its heartbeat would
    // move within 100 ms of going on.
    wakeRun(folder, run0, "win:1");
    expect(resumeWindowsRun(pid, "win:1")).toBe("other");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(stillRunning([pid])).toEqual([pid]);
    expect(beat()).toBe(suspendedAt);

    record(birth as string);
    expect(await stopRunAgent(context, { forget: false, force: run0 })).toBe("ended");
    expect(stillRunning([pid])).toEqual([]);
  } finally {
    if (stillRunning([pid]).length > 0) run.kill();
  }
}
