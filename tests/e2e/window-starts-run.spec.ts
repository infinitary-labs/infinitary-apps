import { spawn } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import electronPath from "electron";
import { STOPPED_RUN_WAIT_MS } from "../../src/core/helper/lock";
import { HOST_CARD_PRIORITY } from "../../src/core/orchestrator/hostCards";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { SAVED_DATA_REFUSAL_TITLE } from "../../src/core/storage/savedDataCompatibility";
import { LET_GO_JOB_ARG, START_HERE_ARG } from "../../src/main/besideRun";
import { RUN_MARKER, RunMarkerSchema, windowProfileDir } from "../../src/main/runCommand";
import { TOLD_THE_PERSON } from "../../src/main/runReopen";
import { COMMAND_STOP_WORDS } from "../../src/renderer/src/settings/commandStopWords";
import { runLabelOf } from "../../src/shared/codeNames";
import { COMMAND_NOTICE_WORDS } from "../../src/shared/commandNotice";
import { setCurrentLanguage } from "../../src/shared/i18n/current";
import * as m from "../../src/shared/i18n/messages.generated";
import { claimedPort } from "../helpers/claimedPort";
import { recordNewerMigration } from "../helpers/database";
import { scratchDir } from "../helpers/scratchDirs";
import { seedMockModelCatalog } from "./accountFixtures";
import {
  builtAppDir,
  defaultClaudeStubDir,
  hermeticEnv,
  type LaunchedApp,
  launchApp,
} from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { mockModelsJson } from "./mockModels";
import { SPAWN_PROMPT_MARKER, startMockProvider } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  HELD_MOVE_TURN_MARKER,
  HELD_MOVE_TURN_REPORT,
  heldMoveTurn,
} from "./scenarios/heldMoveTurn";
import {
  afterStandIn,
  type ServiceManagerStandIn,
  serviceManagerStandIn,
} from "./serviceManagerStandIn";
import { settingRow, settingsSection } from "./settings";
import { showCard, shownCard } from "./stack";
import { MAC_ONLY_TAG } from "./tags";
import { focusOn, pressKey, runFromSearch } from "./windowKeys";

/**
 * The window starts the command itself (docs/run.md, "The window starts
 * it" and "Quit and Stop"; INF-1352's plan, piece 7, the captain's answers
 * quit=window-only and starter=login-agent). Data: a throwaway data folder
 * with one card in its record, the mock provider's model list, and a
 * stand-in for this account's service manager that really runs the job the
 * window gives it (tests/e2e/serviceManagerStandIn.ts), so no test loads a
 * real agent or starts a real service.
 */

const LABEL = runLabelOf("dev");
const CARD_TITLE = "A card the first mate in its own program shows";

let standIn: ServiceManagerStandIn | null = null;
test.afterEach(() => {
  const testInfo = test.info();
  const kept = standIn;
  standIn = null;
  // A failed run, or one whose service manager did not stop, keeps that manager's records and each
  // command's output with its results.
  afterStandIn(kept, testInfo.status !== testInfo.expectedStatus, () =>
    testInfo.outputPath("service-manager"),
  );
});

function seededDataDir(port: number): string {
  const userDataDir = scratchDir("infinitary-window-starts-run-");
  seedMockModelCatalog(userDataDir, mockModelsJson(port));
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: "run-card",
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: CARD_TITLE,
      meta: "Infinitary",
      body: "<p>Shown by the first mate the window started in a program of its own.</p>",
      actions: [],
      status: "ready",
      createdAt: Date.now(),
    });
  } finally {
    db.close();
  }
  return userDataDir;
}

/** The command that holds the data folder now, by the note it keeps there. */
function commandPid(userDataDir: string): number {
  return RunMarkerSchema.parse(JSON.parse(readFileSync(join(userDataDir, RUN_MARKER), "utf8"))).pid;
}

/**
 * Freezes the command numbered `pid` once its note says a force stop can end it (`recovers`), so
 * the window's recovery is armed before it, and confirms through the supervisor that started it
 * that the run is suspended.
 */
async function freeze(userDataDir: string, standIn: ServiceManagerStandIn, pid: number) {
  await expect
    .poll(
      () => {
        const marker = RunMarkerSchema.parse(
          JSON.parse(readFileSync(join(userDataDir, RUN_MARKER), "utf8")),
        );
        return marker.pid === pid && marker.recovers === true;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  expect(await standIn.signal(LABEL, "SIGSTOP", pid)).toBe("sent");
  await expect.poll(() => standIn.state(LABEL, pid), { timeout: 30_000 }).toBe("stopped");
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Opens Settings → General by keys. */
async function openGeneral(opened: LaunchedApp): Promise<void> {
  await runFromSearch(opened.app, opened.page, "settings.open");
  await expect(settingsSection(opened.page, "general")).toBeVisible();
}

const noticeOver = (page: Page) => page.locator("[data-command-stopped]");

/**
 * Promised result: opening Infinitary with no command running starts
 * `<app> run` through this account's service manager and opens beside it,
 * showing that first mate's card. Settings → General offers Stop and moves
 * Start at login to the command. Quit closes only the window: the command
 * keeps running, and the window opened again joins the same one. Stop ends
 * it, and the service manager does not start it again; Start it here
 * starts it again. When the program is replaced, the command ends for the
 * update, the service manager starts the new one, and the window follows
 * it. Completion: the service manager's own record of each run, the
 * command's note in the data folder, the window's card and notice.
 */
test("the window starts the command in the background, quits alone, and stops it from Settings", async () => {
  test.setTimeout(240_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider.port);
    const homeDir = scratchDir("infinitary-window-starts-run-home-");
    standIn = serviceManagerStandIn(homeDir);
    const program = join(scratchDir("infinitary-window-starts-run-program-"), "Infinitary");
    writeFileSync(program, "this version\n");
    const env = {
      ...standIn.env,
      INFINITARY_WINDOW_STARTS_RUN: "1",
      INFINITARY_RUN_PROGRAM: program,
      INFINITARY_RUN_PROGRAM_EVERY_MS: "200",
    };
    const open = () => launchApp({ userDataDir, homeDir, env });

    // Section: opening the window starts the command, and the window opens beside it.
    let opened = await open();
    let first: number;
    try {
      const { page } = opened;
      // The window draws before the command it started welcomes it (docs/run.md, "Drawn before
      // the first welcome"): the card follows once that command holds the data folder and
      // welcomes the window, which takes seconds on a busy runner.
      await expect(
        shownCard(page, CARD_TITLE)
          .or(page.getByRole("button", { name: "Next card" }))
          .first(),
      ).toBeVisible({ timeout: 60_000 });
      await showCard(page, CARD_TITLE);
      await expect(shownCard(page, CARD_TITLE)).toBeVisible();
      expect(standIn.runs(LABEL)).toHaveLength(1);
      first = commandPid(userDataDir);
      expect(standIn.runs(LABEL)).toEqual([first]);
      expect(await page.evaluate(() => window.infinitary.devices.thisMac())).toEqual({
        role: "home",
        left: null,
        byCommand: true,
      });

      // Section: Settings → General offers Stop, and Start at login is the command's.
      await openGeneral(opened);
      await expect(settingRow(page, "stop-command")).toContainText(COMMAND_STOP_WORDS.title);
      await expect(settingRow(page, "start-at-login")).toContainText(
        COMMAND_STOP_WORDS.startAtLogin,
      );
      const login = settingRow(page, "start-at-login").getByRole("switch");
      // The switch stays disabled until it has read the saved setting, which
      // beside the command is a question to the command; its off before then
      // is a placeholder, not the setting.
      await expect(login).toBeEnabled();
      await expect(login).toHaveAttribute("aria-checked", "false");
      await focusOn(login);
      await pressKey(login, "Space");
      await expect(login).toHaveAttribute("aria-checked", "true");
      const loginEntry =
        process.platform === "linux"
          ? join(homeDir, ".config", "systemd", "user", "default.target.wants", `${LABEL}.service`)
          : join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
      await expect.poll(() => existsSync(loginEntry)).toBe(true);
    } finally {
      // Section: Quit closes only the window.
      await opened.close();
    }
    expect(alive(first)).toBe(true);
    expect(standIn.running(LABEL)).toBe(true);

    // Section: the window opened again joins the same command, and Stop ends it.
    opened = await open();
    try {
      const { page } = opened;
      await showCard(page, CARD_TITLE);
      expect(standIn.runs(LABEL)).toEqual([first]);
      await openGeneral(opened);
      const stop = settingRow(page, "stop-command").getByRole("button");
      // A first press arms it, as Purge does; the second stops the command.
      await expect(stop).not.toContainText(COMMAND_STOP_WORDS.confirm);
      await pressKey(stop, "Enter");
      await expect(stop).toContainText(COMMAND_STOP_WORDS.confirm);
      await pressKey(stop, "Enter");
      await expect(noticeOver(page)).toHaveAttribute("data-command-stopped", "stopped", {
        timeout: 60_000,
      });
      // Beside the program this window started, the notice speaks of the person's first mate.
      await expect(noticeOver(page).getByRole("alertdialog")).toContainText(
        COMMAND_NOTICE_WORDS.line({ state: "stopped", ending: "quit", byWindow: true }),
      );
      await expect.poll(() => alive(first)).toBe(false);
      expect(standIn.exits(LABEL)).toEqual([0]);
      expect(standIn.running(LABEL)).toBe(false);

      // Section: Start it here starts the command again through the service manager.
      const startHere = noticeOver(page).getByRole("button", {
        name: COMMAND_NOTICE_WORDS.startHere,
      });
      await pressKey(startHere, "Enter");
      await expect(noticeOver(page)).toHaveCount(0, { timeout: 60_000 });
      // The window waits with no notice while the new command starts, which
      // takes seconds on a busy runner: the card follows once that command
      // holds the data folder and welcomes the window.
      await expect.poll(() => standIn?.runs(LABEL).length, { timeout: 60_000 }).toBe(2);
      const second = standIn.runs(LABEL)[1];
      await expect
        .poll(() => (existsSync(join(userDataDir, RUN_MARKER)) ? commandPid(userDataDir) : null), {
          timeout: 60_000,
        })
        .toBe(second);
      await expect(noticeOver(page)).toHaveCount(0);
      await expect(shownCard(page, CARD_TITLE)).toBeVisible({ timeout: 60_000 });

      // Section: an update replaces the program; the service manager starts the new
      // command and the window follows it, which an isolated window does by ending.
      const windowEnded = new Promise<void>((resolve) =>
        opened.app.process().once("exit", () => resolve()),
      );
      writeFileSync(`${program}.new`, "the new version\n");
      renameSync(`${program}.new`, program);
      await expect.poll(() => standIn?.runs(LABEL).length, { timeout: 60_000 }).toBe(3);
      expect(standIn.exits(LABEL)).toEqual([0, 75]);
      await windowEnded;
    } finally {
      await opened.close();
    }
    opened = await open();
    try {
      await showCard(opened.page, CARD_TITLE);
      await expect(noticeOver(opened.page)).toHaveCount(0);
      expect(standIn.runs(LABEL)).toHaveLength(3);
    } finally {
      await opened.close();
    }
  } finally {
    await provider.close();
  }
});

/**
 * The captain, on INF-4622's fix: "can we not give an option that's force
 * restart the background process?" Promised result: a window opened beside
 * the command it started, which runs and does not answer, offers Restart it
 * on its notice; pressing it ends that command by force (the window lets the
 * frozen command go on, and the command ends itself by its process and
 * start), the service manager starts it again, and the window joins the new
 * one and shows its card. Data: the throwaway data folder above, its command frozen with
 * SIGSTOP (the stand-in for one stuck on its way to answering), and a
 * one-second answer wait. Completion: the service manager's record of a
 * second run, the frozen run gone, and the card with no notice.
 */
test("Restart it ends a command that does not answer and the window joins the one started again", async () => {
  test.setTimeout(240_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider.port);
    const homeDir = scratchDir("infinitary-window-starts-run-home-");
    standIn = serviceManagerStandIn(homeDir);
    const env = {
      ...standIn.env,
      INFINITARY_WINDOW_STARTS_RUN: "1",
      INFINITARY_RUN_ANSWER_WAIT_MS: "1000",
    };
    const open = () => launchApp({ userDataDir, homeDir, env });

    // Section: the window starts the command, then quits; the command is frozen.
    let opened = await open();
    let first: number;
    try {
      await showCard(opened.page, CARD_TITLE);
      first = commandPid(userDataDir);
    } finally {
      await opened.close();
    }
    await freeze(userDataDir, standIn, first);

    // Section: the window opened again says its first mate is not answering, and Restart it restarts it.
    opened = await open();
    try {
      const { page } = opened;
      await expect(noticeOver(page)).toHaveAttribute("data-command-stopped", "stopped", {
        timeout: 60_000,
      });
      await expect(noticeOver(page).getByRole("alertdialog")).toContainText(
        COMMAND_NOTICE_WORDS.line({ state: "stopped", ending: "not-answering", byWindow: true }),
      );
      const restart = noticeOver(page).getByRole("button", { name: COMMAND_NOTICE_WORDS.restart });
      await pressKey(restart, "Enter");
      await expect.poll(() => standIn?.runs(LABEL).length, { timeout: 60_000 }).toBe(2);
      // The frozen run ended, by its supervisor's own record of its exit.
      expect(standIn.exits(LABEL)).toEqual([null]);
      await expect(shownCard(page, CARD_TITLE)).toBeVisible({ timeout: 60_000 });
      await expect(noticeOver(page)).toHaveCount(0);
      expect(commandPid(userDataDir)).toBe(standIn.runs(LABEL)[1]);
    } finally {
      await opened.close();
      // A frozen command acts on no polite stop: one Restart it did not end goes by force, through
      // its supervisor, only while it is still that run.
      expect(await standIn.signal(LABEL, "SIGKILL", first)).not.toBe("timeout");
    }
  } finally {
    await provider.close();
  }
});

/**
 * The review of INF-5409: Start it here over a command that does not answer ends it by force and
 * starts the app again, while the agent's job starts the command again. Promised result: the app
 * started again with Start it here opens beside the command the job started again, as its own,
 * whether that command already noted that it holds the data folder or holds its lock and has not
 * noted it yet; the card is usable, and the service manager starts and stops nothing more. Data:
 * the throwaway data folder above, its command frozen with SIGSTOP, a one-second answer wait, and
 * a file the development build's command waits on before it notes that it holds the folder. An
 * isolated window never starts itself again: the development build notes the start it asks for in
 * a file, and the journey starts that. The frozen run is signalled only through the supervisor that
 * started it, while it is still that run. Completion: the service manager's record of each run,
 * exit and start or stop asked of it, the command's note, the folder's lock, the start's own end
 * and what it said, the window's ownership of the command, and the card with no notice.
 */
test("Start it here ends a command that does not answer and opens beside the one its job started again", async () => {
  test.setTimeout(420_000);
  const provider = await startMockProvider();
  const hold = join(scratchDir("infinitary-window-starts-run-hold-"), "hold");
  const relaunchNote = join(scratchDir("infinitary-window-starts-run-relaunch-"), "relaunch.json");
  let waiting: ReturnType<typeof spawn> | null = null;
  try {
    const userDataDir = seededDataDir(provider.port);
    /**
     * The words of the start the app last asked for, which the journey starts: the built app and
     * this data folder, checked and then left for the journey's own launch to add again, and every
     * other word as asked, a mode such as `run` included. Only the switches the journey's own
     * launches add (`launchApp`) are set aside.
     */
    const askedStart = () => {
      const words = JSON.parse(readFileSync(relaunchNote, "utf8")) as string[];
      rmSync(relaunchNote, { force: true });
      const [entry, ...rest] = words.filter((arg) => !launcherSwitch(arg));
      expect(entry).toBe(builtAppDir());
      const folder = (arg: string) => arg.startsWith("--user-data-dir=");
      expect(rest.filter(folder)).toEqual([`--user-data-dir=${userDataDir}`]);
      return rest.filter((arg) => !folder(arg));
    };
    const homeDir = scratchDir("infinitary-window-starts-run-home-");
    standIn = serviceManagerStandIn(homeDir);
    const env = {
      ...standIn.env,
      INFINITARY_WINDOW_STARTS_RUN: "1",
      INFINITARY_RUN_ANSWER_WAIT_MS: "1000",
      INFINITARY_RUN_NOTE_HOLD: hold,
      INFINITARY_RELAUNCH_NOTE: relaunchNote,
    };
    const open = (args: string[] = []) => launchApp({ userDataDir, homeDir, env, args });
    const gone = join(standIn.dir, "state", `${LABEL}.gone`);
    const noted = () =>
      existsSync(join(userDataDir, RUN_MARKER)) ? commandPid(userDataDir) : null;
    /**
     * Launches the app with `args` while the run the job started holds the folder's lock and has
     * not noted it: the launch waits with no window, past a stopped run's wait, never taking that
     * run for a window, and ends once the run notes itself as `run`. Answers what it said.
     */
    const waitBeside = async (args: string[], run: number) => {
      const started = spawn(
        electronPath as unknown as string,
        [builtAppDir(), `--user-data-dir=${userDataDir}`, ...args],
        {
          env: {
            ...hermeticEnv({ userDataDir, homeDir, loopbackPort: String(await claimedPort()) }),
            INFINITARY_CLAUDE_CLI: writeMockClaudeClient(defaultClaudeStubDir(userDataDir)),
            ...env,
          },
          cwd: scratchDir("infinitary-window-starts-run-cwd-"),
        },
      );
      waiting = started;
      let said = "";
      started.stdout?.on("data", (chunk) => {
        said += String(chunk);
      });
      started.stderr?.on("data", (chunk) => {
        said += String(chunk);
      });
      const ended = new Promise<void>((resolve) => started.once("exit", () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, STOPPED_RUN_WAIT_MS + 2_000));
      expect(started.exitCode).toBeNull();
      expect(started.signalCode).toBeNull();
      rmSync(hold, { force: true });
      await expect.poll(noted, { timeout: 60_000 }).toBe(run);
      await ended;
      return said;
    };

    // Section: the window starts the command, then quits; the command is frozen.
    let opened = await open();
    let first: number;
    let managerAsks: string[] = [];
    try {
      await showCard(opened.page, CARD_TITLE);
      first = commandPid(userDataDir);
    } finally {
      await opened.close();
    }
    await freeze(userDataDir, standIn, first);

    // Section: Start it here ends the frozen command by force; the window starts again, which an
    // isolated window does by ending, and the job starts the command again.
    opened = await open();
    try {
      const { page } = opened;
      const windowEnded = new Promise<void>((resolve) =>
        opened.app.process().once("exit", () => resolve()),
      );
      await expect(noticeOver(page).getByRole("alertdialog")).toContainText(
        COMMAND_NOTICE_WORDS.line({ state: "stopped", ending: "not-answering", byWindow: true }),
        { timeout: 60_000 },
      );
      const startHere = noticeOver(page).getByRole("button", {
        name: COMMAND_NOTICE_WORDS.startHere,
      });
      // Every start or stop asked of the service manager from the press on is compared with this.
      managerAsks = standIn.asks();
      await pressKey(startHere, "Enter");
      await windowEnded;
      // The frozen run ended before any cleanup, by its supervisor's own record of its exit.
      await expect.poll(() => standIn?.exits(LABEL), { timeout: 60_000 }).toEqual([null]);
    } finally {
      await opened.close();
      expect(await standIn.signal(LABEL, "SIGKILL", first)).not.toBe("timeout");
    }
    await expect.poll(() => standIn?.runs(LABEL).length, { timeout: 60_000 }).toBe(2);
    const [, second] = standIn.runs(LABEL) as [number, number];
    // Ended by force, the run asked its service manager for nothing, and the window asked to
    // start again here, letting the job go.
    expect(standIn.asks()).toEqual(managerAsks);
    const restartedWith = askedStart();
    expect(restartedWith).toEqual([START_HERE_ARG, LET_GO_JOB_ARG]);

    // Section: started again with the command's note already there, the app opens beside it,
    // as its own.
    await expect.poll(noted, { timeout: 60_000 }).toBe(second);
    opened = await open(restartedWith);
    try {
      const { page } = opened;
      await showCard(page, CARD_TITLE);
      await expect(noticeOver(page)).toHaveCount(0);
      expect(await page.evaluate(() => window.infinitary.devices.thisMac())).toMatchObject({
        byCommand: true,
      });
      expect(await page.evaluate(() => window.infinitary.devices.followAdded())).toMatchObject({
        followed: false,
        joins: true,
        outside: false,
      });
    } finally {
      await opened.close();
    }
    expect(standIn.asks()).toEqual(managerAsks);
    expect(standIn.runs(LABEL)).toEqual([first, second]);
    expect(standIn.exits(LABEL)).toEqual([null]);
    expect(standIn.running(LABEL)).toBe(true);
    expect(existsSync(gone)).toBe(false);
    expect(noted()).toBe(second);

    // Section: started again while the command the job started holds the folder's lock and has
    // not noted it yet, the start waits with no window, past a stopped run's wait, never taking
    // that command for a window; once the command notes it, the start ends to start again.
    writeFileSync(hold, "");
    expect(await standIn.signal(LABEL, "SIGKILL", second)).toBe("sent");
    await expect.poll(() => standIn?.runs(LABEL).length, { timeout: 60_000 }).toBe(3);
    const [, , third] = standIn.runs(LABEL) as [number, number, number];
    await expect.poll(() => profileHolder(userDataDir), { timeout: 60_000 }).toBe(third);
    expect(noted()).toBe(second);
    let said = await waitBeside([START_HERE_ARG, LET_GO_JOB_ARG], third);
    expect(said).toContain("[app] Start it here found the folder held by a run");
    const startedWith = askedStart();
    expect(startedWith).toEqual([START_HERE_ARG, LET_GO_JOB_ARG]);

    // Section: the start that one asked for opens beside the command the job started again, as
    // its own.
    opened = await open(startedWith);
    try {
      const { page } = opened;
      await showCard(page, CARD_TITLE);
      await expect(noticeOver(page)).toHaveCount(0);
      expect(await page.evaluate(() => window.infinitary.devices.followAdded())).toMatchObject({
        followed: false,
        joins: true,
        outside: false,
      });
    } finally {
      await opened.close();
    }
    // The run the journey ended was started again by its job alone: nothing asked the service
    // manager to start or stop anything.
    expect(standIn.asks()).toEqual(managerAsks);
    expect(standIn.runs(LABEL)).toEqual([first, second, third]);
    expect(standIn.exits(LABEL)).toEqual([null, null]);
    expect(standIn.running(LABEL)).toBe(true);
    expect(existsSync(gone)).toBe(false);
    expect(noted()).toBe(third);

    // Section: an ordinary launch, with no Start it here, while the command the job started again
    // holds the folder's lock and has not noted it yet, waits the same way, never quitting with no
    // window, and starts again once the command notes it.
    writeFileSync(hold, "");
    expect(await standIn.signal(LABEL, "SIGKILL", third)).toBe("sent");
    await expect.poll(() => standIn?.runs(LABEL).length, { timeout: 60_000 }).toBe(4);
    const [, , , fourth] = standIn.runs(LABEL) as [number, number, number, number];
    await expect.poll(() => profileHolder(userDataDir), { timeout: 60_000 }).toBe(fourth);
    expect(noted()).toBe(third);
    said = await waitBeside([], fourth);
    expect(said).toContain("[app] the launch found the folder held by a run");
    const ordinaryWith = askedStart();
    expect(ordinaryWith).toEqual([]);

    // Section: the start that ordinary launch asked for opens a usable window beside the command.
    opened = await open(ordinaryWith);
    try {
      const { page } = opened;
      await showCard(page, CARD_TITLE);
      await expect(noticeOver(page)).toHaveCount(0);
      expect(await page.evaluate(() => window.infinitary.devices.followAdded())).toMatchObject({
        followed: false,
        joins: true,
        outside: false,
      });
    } finally {
      await opened.close();
    }
    // Nothing asked the service manager to start or stop anything for that launch either.
    expect(standIn.asks()).toEqual(managerAsks);
    expect(standIn.runs(LABEL)).toEqual([first, second, third, fourth]);
    expect(standIn.exits(LABEL)).toEqual([null, null, null]);
    expect(standIn.running(LABEL)).toBe(true);
    expect(existsSync(gone)).toBe(false);
    expect(noted()).toBe(fourth);
  } finally {
    rmSync(hold, { force: true });
    // Set only inside `waitBeside`, which the compiler does not follow.
    const left = waiting as ReturnType<typeof spawn> | null;
    if (left && left.exitCode === null && left.signalCode === null) left.kill("SIGKILL");
    await provider.close();
  }
});

/**
 * Whether `arg` is a switch the journey's own launches add (`launchApp`, and Playwright's own
 * debugging switches), which a start the app asks for carries along from its own launch.
 */
function launcherSwitch(arg: string): boolean {
  return (
    [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--enable-gpu-benchmarking",
      "--disable-lcd-text",
      "--disable-gpu",
    ].includes(arg) || /^--(inspect|remote-debugging-port|force-device-scale-factor)=/.test(arg)
  );
}

/** The process holding a browser profile folder, by the lock Chromium keeps there (`<host>-<pid>`). */
function profileHolder(dir: string): number {
  return Number(readlinkSync(join(dir, "SingletonLock")).split("-").at(-1));
}

/**
 * Promised result (INF-1352's plan, piece 7's checked-by item: a journey
 * that closes the window while a task runs, opens it again and finds the
 * task still running): a crewmate's turn the command runs keeps going while
 * the window quits, and the window opened again finds the same task on the
 * same command. The window keeps its own browser profile folder, so the two
 * programs never contend for one. Data: the throwaway data folder above, a
 * crewmate whose first step the mock provider holds open (heldMoveTurn).
 * Completion: the held step still open after Quit and after the reopen, the
 * task's state, and the report once the step is let go.
 */
// The review of INF-5409: Start it here lets go of the agent's job only once its window opens its own
// first mate on the folder. On saved data from a newer version it opens nothing there, so the job
// its window registered is asked nothing and stays as it was.
test("Start it here on saved data from a newer version asks the background job nothing", async () => {
  test.setTimeout(240_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider.port);
    const homeDir = scratchDir("infinitary-window-starts-run-home-");
    standIn = serviceManagerStandIn(homeDir);
    const env = { ...standIn.env, INFINITARY_WINDOW_STARTS_RUN: "1" };

    // Section: the window registers the job, which starts the command; the window quits and the
    // command is stopped through its supervisor, leaving the job registered.
    let opened = await launchApp({ userDataDir, homeDir, env });
    let first: number;
    try {
      await showCard(opened.page, CARD_TITLE);
      first = commandPid(userDataDir);
    } finally {
      await opened.close();
    }
    expect(await standIn.signal(LABEL, "SIGTERM", first)).toBe("sent");
    await expect.poll(() => standIn?.running(LABEL), { timeout: 60_000 }).toBe(false);
    await expect.poll(() => existsSync(join(userDataDir, RUN_MARKER))).toBe(false);

    // Section: Start it here, letting go of the job, on saved data a newer version wrote.
    const db = openDatabase(userDataDir);
    recordNewerMigration(db);
    db.close();
    const managerAsks = standIn.asks();
    opened = await launchApp({
      userDataDir,
      homeDir,
      env,
      args: [START_HERE_ARG, LET_GO_JOB_ARG],
      shell: false,
    });
    try {
      await expect(
        opened.page.getByRole("heading", { name: SAVED_DATA_REFUSAL_TITLE }),
      ).toBeVisible();
    } finally {
      await opened.close();
    }
    expect(standIn.asks()).toEqual(managerAsks);
    expect(standIn.runs(LABEL)).toEqual([first]);
  } finally {
    await provider.close();
  }
});

// The review of INF-5409: a launch refused the folder's lock by a window from before windows
// answered a launch tells it by what it runs as and ends, starting nothing. On a Mac it asks that
// window once to reopen and, with no window's answer to confirm it, tells the person in their
// language to click Infinitary in the Dock; a check's hidden launch says those words in its output
// instead of showing them. The older window keeps the folder and its first mate. Only a Mac has a
// Dock to name; elsewhere the launch quits at once, as for any window.
test("a launch refused by a window that answers no launch ends, telling the person where it is", {
  tag: MAC_ONLY_TAG,
}, async () => {
  test.skip(process.platform !== "darwin", "only a Mac has a Dock to name");
  test.setTimeout(180_000);
  const provider = await startMockProvider();
  let launch: ReturnType<typeof spawn> | null = null;
  try {
    const userDataDir = seededDataDir(provider.port);
    const homeDir = scratchDir("infinitary-window-starts-run-home-");
    const older = await launchApp({
      userDataDir,
      homeDir,
      env: { INFINITARY_ANSWERS_NO_LAUNCH: "1" },
    });
    try {
      await showCard(older.page, CARD_TITLE);
      launch = spawn(
        electronPath as unknown as string,
        [builtAppDir(), `--user-data-dir=${userDataDir}`],
        {
          env: {
            ...hermeticEnv({ userDataDir, homeDir, loopbackPort: String(await claimedPort()) }),
            INFINITARY_CLAUDE_CLI: writeMockClaudeClient(defaultClaudeStubDir(userDataDir)),
            INFINITARY_LANGUAGE: "de",
          },
          cwd: scratchDir("infinitary-window-starts-run-cwd-"),
        },
      );
      let said = "";
      launch.stdout?.on("data", (chunk) => {
        said += String(chunk);
      });
      launch.stderr?.on("data", (chunk) => {
        said += String(chunk);
      });
      const started = launch;
      const code = await new Promise<number | null>((resolve) =>
        started.once("exit", (exitCode) => resolve(exitCode)),
      );
      expect(code, said).toBe(0);
      expect(said).toContain("[app] the launch found the folder held by a window");
      setCurrentLanguage("de");
      const dock = `${TOLD_THE_PERSON} ${m.dialogOpenInDock()} ${m.dialogOpenInDockDetail()}`;
      setCurrentLanguage("en");
      expect(said).toContain(dock);
      expect(older.app.process().exitCode).toBeNull();
      expect(profileHolder(userDataDir)).toBe(older.app.process().pid);
      await showCard(older.page, CARD_TITLE);
    } finally {
      await older.close();
    }
  } finally {
    if (launch && launch.exitCode === null && launch.signalCode === null) launch.kill("SIGKILL");
    await provider.close();
  }
});

test("a task keeps running while the window quits, and the window opened again finds it", async () => {
  test.setTimeout(240_000);
  const provider = await startMockProvider({ scenarios: [heldMoveTurn] });
  try {
    const userDataDir = seededDataDir(provider.port);
    const homeDir = scratchDir("infinitary-window-starts-run-home-");
    standIn = serviceManagerStandIn(homeDir);
    const env = { ...standIn.env, INFINITARY_WINDOW_STARTS_RUN: "1" };
    const open = () => launchApp({ userDataDir, homeDir, env });
    const title = `${HELD_MOVE_TURN_MARKER} on the release checklist`;
    const taskOn = (page: Page) =>
      page.evaluate(async (wanted) => {
        const task = (await window.infinitary.tasks.board()).tasks.find((t) => t.title === wanted);
        return task ? { id: task.id, status: task.status } : null;
      }, title);

    // Section: beside the command, the window keeps its own profile, and a crewmate starts working.
    let opened = await open();
    let command: number;
    let task: { id: string; status: string } | null;
    try {
      const { page } = opened;
      await showCard(page, CARD_TITLE);
      command = commandPid(userDataDir);
      const profile = await opened.app.evaluate(({ app }) => app.getPath("userData"));
      expect(profile).toBe(windowProfileDir(userDataDir));
      expect(profileHolder(userDataDir)).toBe(command);
      expect(profileHolder(profile)).toBe(opened.app.process().pid);
      const input = promptInput(page);
      await expect(input).toBeEnabled();
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      await expect.poll(() => provider.heldRequests(), { timeout: 60_000 }).toBe(1);
      task = await taskOn(page);
      expect(task?.status).toBe("active");
    } finally {
      // Section: Quit closes only the window, while the crewmate's step is still open.
      await opened.close();
    }
    expect(alive(command)).toBe(true);
    expect(provider.heldRequests()).toBe(1);

    // Section: the window opened again finds the same task still running on the same command.
    opened = await open();
    try {
      const { page } = opened;
      await showCard(page, CARD_TITLE);
      expect(await taskOn(page)).toEqual(task);
      expect(standIn.runs(LABEL)).toEqual([command]);
      expect(provider.heldRequests()).toBe(1);
      provider.releaseHeldCrew();
      const id = task?.id ?? "";
      const outcome = async () =>
        (
          (await page.evaluate(
            (each) => window.infinitary.tasks.detail(each),
            id,
          )) as TaskDetail | null
        )?.outcome ?? "";
      await expect.poll(outcome, { timeout: 60_000 }).toContain(HELD_MOVE_TURN_REPORT);
    } finally {
      await opened.close();
    }
  } finally {
    await provider.close();
  }
});
