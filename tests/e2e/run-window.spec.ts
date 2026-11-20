import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { HOST_CARD_PRIORITY } from "../../src/core/orchestrator/hostCards";
import { appPathsFor } from "../../src/core/paths";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { START_HERE_ARG } from "../../src/main/besideRun";
import {
  RUN_LAST_STOP,
  RUN_MARKER,
  RUN_UPDATED_EXIT,
  RUN_WORDS,
  RunStopSchema,
  WINDOW_PROFILE_FOLDER,
} from "../../src/main/runCommand";
import { LocalWindow } from "../../src/main/view/localWindow";
import { COMMAND_NOTICE_WORDS, type CommandNotice } from "../../src/shared/commandNotice";
import { scratchDir } from "../helpers/scratchDirs";
import { seedMockModelCatalog } from "./accountFixtures";
import { endCommands, run, runEnv } from "./commandRun";
import { type LaunchedApp, launchApp } from "./launch";
import { mockModelsJson } from "./mockModels";
import { type MockProviderServer, startMockProvider } from "./mockProvider";
import { showCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * The window opened beside Infinitary started by a command (docs/run.md,
 * "The window opened beside it" and "When the command stops"): one rule
 * splits the work, the captain's answers on the plan for it. The first mate
 * keeps the settings, the records and the crew, and only this computer's
 * window touches the desktop; once the command no longer runs the window
 * says so over itself and never starts a first mate by itself. Data: a
 * throwaway data folder with one card in the command's record, the mock
 * provider's model list, and, where a journey needs a start entry, a
 * stand-in file for it, so no test reads or writes a real one. Each
 * command is the built app started as `<app> run` (tests/e2e/commandRun.ts);
 * each window is the built app launched as every journey launches it.
 */

test.afterEach(endCommands);

/** The card the command's record holds before it starts, which the window beside it shows. */
const RUN_CARD_TITLE = "A card the command's first mate shows";

/** A data folder holding the command's card, with the mock provider's models. */
function seededDataDir(provider: MockProviderServer): string {
  const userDataDir = scratchDir("infinitary-run-window-");
  seedMockModelCatalog(userDataDir, mockModelsJson(provider.port));
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: "run-card",
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: RUN_CARD_TITLE,
      meta: "Infinitary",
      body: "<p>Shown by the first mate a command started.</p>",
      actions: [],
      status: "ready",
      createdAt: Date.now(),
    });
  } finally {
    db.close();
  }
  return userDataDir;
}

/** A stand-in for the start entry the app wrote, in place: a file the window is told to read instead. */
function startEntryInPlace(): string {
  const entry = join(scratchDir("infinitary-run-window-entry-"), "start-entry");
  writeFileSync(entry, "a stand-in start entry\n");
  return entry;
}

/** The notice over the whole window once its command no longer runs. */
const noticeOver = (page: Page) => page.locator("[data-command-stopped]");

/** The notice shows this state, in its own words, and offers Start it here only once it is stopped. */
async function expectNotice(page: Page, notice: CommandNotice): Promise<void> {
  const over = noticeOver(page);
  await expect(over).toHaveAttribute("data-command-stopped", notice.state, { timeout: 60_000 });
  await expect(over.getByRole("alertdialog")).toHaveAccessibleName(
    COMMAND_NOTICE_WORDS.title(notice),
  );
  await expect(over.getByRole("alertdialog")).toContainText(COMMAND_NOTICE_WORDS.line(notice));
  await expect(over.getByRole("button", { name: COMMAND_NOTICE_WORDS.quit })).toBeVisible();
  await expect(over.getByRole("button", { name: COMMAND_NOTICE_WORDS.startHere })).toHaveCount(
    notice.state === "stopped" ? 1 : 0,
  );
}

/** Resolves once the window's own program ends. */
const ended = (opened: LaunchedApp) =>
  new Promise<void>((resolve) => opened.app.process().once("exit", () => resolve()));

/**
 * Presses Enter on a button whose press ends the window's own program, and
 * returns once that program ended. The press's own answer can be lost with
 * the window it closes, so only a press that failed for another reason
 * fails the journey.
 */
async function pressToEnd(opened: LaunchedApp, button: Locator): Promise<void> {
  const windowEnded = ended(opened);
  const failed = new Promise<never>((_resolve, reject) => {
    pressKey(button, "Enter").catch((error: Error) => {
      if (!error.message.includes("has been closed")) reject(error);
    });
  });
  await Promise.race([windowEnded, failed]);
}

/**
 * INF-1352's plan, piece 6, the captain's answer window_joins=join ("it
 * joins the run as a view"), and INF-3660's plan, restart=wait-for-entry:
 * "offer it at once when none will restart the run". Promised result: the
 * window opened beside a command shows the command's own card, as this
 * computer's own window with nothing to leave; once the command is stopped
 * the window starts no first mate by itself, says so over the whole window
 * and offers Start it here beside Quit at once, by keys, with Escape
 * closing nothing. Completion: the card, the notice in its own words, and
 * the window's process ending when Start it here starts the app again,
 * which an isolated launch leaves to whoever started it.
 */
test("Infinitary's window opened while a command runs joins it, and offers Start it here once the command is stopped", async () => {
  // A command and a window of it, each a launch of the built app.
  test.setTimeout(120_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider);
    const ran = run(await runEnv(userDataDir));
    await ran.started();
    const opened = await launchApp({ userDataDir });
    try {
      const { page } = opened;
      await showCard(page, RUN_CARD_TITLE);
      await expect(shownCard(page, RUN_CARD_TITLE)).toBeVisible();
      // This computer's own window, not a device of the first mate's: it has nothing to leave.
      expect(await page.evaluate(() => window.infinitary.devices.thisMac())).toEqual({
        role: "home",
        left: null,
        byCommand: true,
      });
      await expect(page.locator("[data-remote-control]")).toHaveCount(0);
      await expect(noticeOver(page)).toHaveCount(0);
      // The command keeps its folder; the window's browser profile is its own.
      expect(existsSync(join(userDataDir, RUN_MARKER))).toBe(true);
      expect(existsSync(join(userDataDir, WINDOW_PROFILE_FOLDER))).toBe(true);

      // The person stops the command: no start entry is in place to start it again.
      ran.child.kill("SIGTERM");
      expect(await ran.exited, ran.error()).toBe(0);
      // Electron can take the signal through its own quit before Node hears it, so the
      // command records a quit or a signal (docs/run.md): the window tells the one on record.
      const { reason } = RunStopSchema.parse(
        JSON.parse(readFileSync(join(userDataDir, RUN_LAST_STOP), "utf8")),
      );
      expect(["quit", "signal"]).toContain(reason);
      const stopped: CommandNotice = { state: "stopped", ending: reason };
      await expectNotice(page, stopped);
      expect(await page.evaluate(() => window.infinitary.devices.thisMac())).toMatchObject({
        role: "home",
        command: stopped,
      });

      // By keys: focus starts on Quit, Escape closes nothing, and Tab reaches Start it here.
      const quit = noticeOver(page).getByRole("button", { name: COMMAND_NOTICE_WORDS.quit });
      const startHere = noticeOver(page).getByRole("button", {
        name: COMMAND_NOTICE_WORDS.startHere,
      });
      await expect(quit).toBeFocused();
      await pressKey(quit, "Escape");
      await expectNotice(page, stopped);
      await pressKey(quit, "Tab");
      await expect(startHere).toBeFocused();
      await pressToEnd(opened, startHere);
    } finally {
      await opened.close();
    }
  } finally {
    await provider.close();
  }
});

/**
 * INF-3660's plan: "The run records why it stopped only on a clean stop. So
 * the window checks the record belongs to the run it joined; if not, the
 * run crashed." Promised result: a command killed under its window, with an
 * earlier command's clean stop still on record, is told as stopped without
 * saying why, and Quit, reached by key, closes the window's program. Data:
 * a first command stopped cleanly, then a second one killed. Completion:
 * the notice's words and the window's process ending.
 */
test("a command killed under its window is told as stopped without saying why, whatever an earlier stop recorded", async () => {
  // A command and a window of it, each a launch of the built app.
  test.setTimeout(120_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider);
    const earlier = run(await runEnv(userDataDir));
    await earlier.started();
    earlier.child.kill("SIGTERM");
    expect(await earlier.exited, earlier.error()).toBe(0);

    const ran = run(await runEnv(userDataDir));
    await ran.started();
    const opened = await launchApp({ userDataDir });
    try {
      const { page } = opened;
      await showCard(page, RUN_CARD_TITLE);
      ran.child.kill("SIGKILL");
      await ran.exited;
      await expectNotice(page, { state: "stopped", ending: "crashed" });
      const quit = noticeOver(page).getByRole("button", { name: COMMAND_NOTICE_WORDS.quit });
      await pressToEnd(opened, quit);
    } finally {
      await opened.close();
    }
  } finally {
    await provider.close();
  }
});

/**
 * INF-3660's plan, the captain's answers restart=wait-for-entry ("Wait for
 * the start entry when one is in place") and update=window-installs (the
 * command replaces the program and exits 75, and the window follows the new
 * program). Promised result: under a start entry, a command that ends for
 * its update leaves the window waiting, with no way to start a first mate
 * here; when the command is back on the new program the window starts again
 * on it, and the window opened again shows the command's card with no
 * notice. Data: a stand-in file for the installed program, which both
 * programs read, replaced as an update replaces the app's, and a stand-in
 * start entry. Completion: the waiting notice, the window's process ending
 * once the command welcomes it again, and the card in the reopened window.
 */
test("under a start entry, the window waits for a command that ended for its update and follows the new program", async () => {
  // Two commands and one or two windows, each a launch of the built app.
  test.setTimeout(180_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider);
    const program = join(scratchDir("infinitary-run-window-program-"), "Infinitary");
    writeFileSync(program, "this version\n");
    const commandEnv = {
      INFINITARY_RUN_PROGRAM: program,
      INFINITARY_RUN_PROGRAM_EVERY_MS: "200",
    };
    const windowEnv = {
      INFINITARY_RUN_PROGRAM: program,
      INFINITARY_RUN_START_ENTRY: startEntryInPlace(),
    };
    const ran = run(await runEnv(userDataDir, commandEnv));
    await ran.started();
    const opened = await launchApp({ userDataDir, env: windowEnv });
    try {
      const { page } = opened;
      await showCard(page, RUN_CARD_TITLE);
      writeFileSync(`${program}.new`, "the new version\n");
      renameSync(`${program}.new`, program);
      expect(await ran.exited, ran.error()).toBe(RUN_UPDATED_EXIT);
      expect(ran.lines()).toEqual([RUN_WORDS.started, ...RUN_WORDS.updated, RUN_WORDS.stopped]);
      await expectNotice(page, { state: "waiting", ending: "updated" });

      // The start entry starts the command again, on the new program: the window follows it.
      const windowEnded = ended(opened);
      const again = run(await runEnv(userDataDir, commandEnv));
      await again.started();
      await windowEnded;
    } finally {
      await opened.close();
    }
    const reopened = await launchApp({ userDataDir, env: windowEnv });
    try {
      await showCard(reopened.page, RUN_CARD_TITLE);
      await expect(noticeOver(reopened.page)).toHaveCount(0);
    } finally {
      await reopened.close();
    }
  } finally {
    await provider.close();
  }
});

/**
 * INF-3660's plan: Start it here "appears after the entry's own 10-second
 * restart wait, plus the time a window already allows to join", and the
 * window "never starts again while the run it joined is still alive".
 * Promised result: under a start entry that does not start a killed command
 * again in its time, the window first waits and then offers Start it here;
 * a command that comes back late takes the notice down, and the window
 * shows its card again. Data: a stand-in start entry with a one-second
 * restart wait. Completion: the two notices in order, then the card with no
 * notice over it.
 */
test("a start entry that does not start the command again in its time ends in Start it here, and a late command takes the notice down", async () => {
  // Two commands and one or two windows, each a launch of the built app.
  test.setTimeout(180_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider);
    const ran = run(await runEnv(userDataDir));
    await ran.started();
    const opened = await launchApp({
      userDataDir,
      env: {
        INFINITARY_RUN_START_ENTRY: startEntryInPlace(),
        INFINITARY_RUN_RESTART_WAIT_MS: "1000",
      },
    });
    try {
      const { page } = opened;
      await showCard(page, RUN_CARD_TITLE);
      ran.child.kill("SIGKILL");
      await ran.exited;
      await expectNotice(page, { state: "waiting", ending: "crashed" });
      await expectNotice(page, { state: "stopped", ending: "crashed" });

      const late = run(await runEnv(userDataDir));
      await late.started();
      await expect(noticeOver(page)).toHaveCount(0, { timeout: 60_000 });
      await showCard(page, RUN_CARD_TITLE);
      // This computer's own window again, with no notice left to show.
      const here = await page.evaluate(() => window.infinitary.devices.thisMac());
      expect(here.role).toBe("home");
      expect(here).not.toHaveProperty("command");
    } finally {
      await opened.close();
    }
  } finally {
    await provider.close();
  }
});

/**
 * INF-4622: after an update from an old version, a person's window never
 * opened beside a command that ran and did not answer. Promised result: a
 * window opened beside a command that is alive and does not answer still
 * draws, says over itself that the first mate is not answering, and offers
 * Start it here; once the command answers, the notice goes and the window
 * shows its card. Data: a command frozen with SIGSTOP, the stand-in for one
 * stuck on its way to opening its door, and a one-second answer wait.
 * Completion: the notice in its own words, then the card with no notice.
 */
test("a window opened beside a command that does not answer draws under a notice, which goes once it answers", async () => {
  // A command and a window of it, each a launch of the built app.
  test.setTimeout(120_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider);
    const ran = run(await runEnv(userDataDir));
    await ran.started();
    ran.child.kill("SIGSTOP");
    const opened = await launchApp({
      userDataDir,
      env: { INFINITARY_RUN_ANSWER_WAIT_MS: "1000" },
    });
    try {
      const { page } = opened;
      await expectNotice(page, { state: "stopped", ending: "not-answering" });
      ran.child.kill("SIGCONT");
      await expect(noticeOver(page)).toHaveCount(0, { timeout: 60_000 });
      await showCard(page, RUN_CARD_TITLE);
      const here = await page.evaluate(() => window.infinitary.devices.thisMac());
      expect(here).not.toHaveProperty("command");
    } finally {
      await opened.close();
    }
  } finally {
    await provider.close();
  }
});

/**
 * INF-3660's plan: "The same rule applies when you open the window while
 * the run is between stops", and Start it here "takes the same data-folder
 * lock the run takes". Promised result: with a start entry in place and a
 * killed command on record, the app started as Start it here starts it
 * opens as this computer's own first mate, and no later launch waits for
 * that same end again; after another command is killed, a window opened
 * then opens under the waiting notice with no first mate of its own, and
 * joins the command the entry starts. Data: a stand-in start entry.
 * Completion: what each window says it is, and the card in the last one.
 */
test("a window opened between two starts of a command waits for the next one, unless Start it here answered that end", async () => {
  // Four commands and three windows, each a launch of the built app.
  test.setTimeout(240_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider);
    const env = { INFINITARY_RUN_START_ENTRY: startEntryInPlace() };
    const first = run(await runEnv(userDataDir));
    await first.started();
    first.child.kill("SIGKILL");
    await first.exited;

    // Start it here: this computer's own first mate, whatever entry is in place.
    const own = await launchApp({ userDataDir, env, args: [START_HERE_ARG] });
    try {
      await showCard(own.page, RUN_CARD_TITLE);
      await expect(noticeOver(own.page)).toHaveCount(0);
    } finally {
      await own.close();
    }
    // That end is answered: the app opens as itself again, with no wait.
    const ownAgain = await launchApp({ userDataDir, env });
    try {
      await showCard(ownAgain.page, RUN_CARD_TITLE);
      await expect(noticeOver(ownAgain.page)).toHaveCount(0);
      expect(existsSync(join(userDataDir, WINDOW_PROFILE_FOLDER))).toBe(false);
    } finally {
      await ownAgain.close();
    }

    // Another command, killed in turn: the entry in place starts the next one.
    const second = run(await runEnv(userDataDir));
    await second.started();
    second.child.kill("SIGKILL");
    await second.exited;
    const opened = await launchApp({ userDataDir, env });
    try {
      const { page } = opened;
      await expectNotice(page, { state: "waiting", ending: "crashed" });
      // No first mate of its own holds the folder: the command the entry starts takes it.
      const next = run(await runEnv(userDataDir));
      await next.started();
      await expect(noticeOver(page)).toHaveCount(0, { timeout: 60_000 });
      await showCard(page, RUN_CARD_TITLE);
    } finally {
      await opened.close();
    }
  } finally {
    await provider.close();
  }
});

/**
 * INF-3660's plan, the captain's answers look_here=follow and
 * extras=same-piece (a change the first mate makes reaches this window).
 * Promised result: a theme changed at the first mate by another program
 * than the window, as the first mate's own change of it is, shows in the
 * window at once, and a theme changed in the window is the first mate's.
 * Data: a second client of the command's local door in this test's own
 * process. Completion: the theme the window draws, and the one the first
 * mate answers.
 */
test("a look changed at the first mate reaches the window opened beside it, and one changed in the window is the first mate's", async () => {
  // A command and a window of it, each a launch of the built app.
  test.setTimeout(120_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = seededDataDir(provider);
    const ran = run(await runEnv(userDataDir));
    await ran.started();
    const opened = await launchApp({ userDataDir });
    const other = new LocalWindow({
      door: appPathsFor(userDataDir).localDoorDir,
      broadcast: () => {},
    });
    try {
      const { page } = opened;
      await showCard(page, RUN_CARD_TITLE);
      const drawn = page.locator("body");
      await expect(drawn).toHaveAttribute("data-theme", "dark");
      await other.ready();
      const theirs = await other.dispatch("inf:settings:appearance:get", []);
      await other.dispatch("inf:settings:appearance:set", [{ ...theirs, theme: "light" }]);
      await expect(drawn).toHaveAttribute("data-theme", "light");

      await page.evaluate(async () => {
        const appearance = await window.infinitary.settings.getAppearance();
        await window.infinitary.settings.setAppearance({ ...appearance, theme: "dark" });
      });
      await expect(drawn).toHaveAttribute("data-theme", "dark");
      expect((await other.dispatch("inf:settings:appearance:get", [])).theme).toBe("dark");
    } finally {
      other.close();
      await opened.close();
    }
    ran.child.kill("SIGTERM");
    expect(await ran.exited, ran.error()).toBe(0);
  } finally {
    await provider.close();
  }
});
