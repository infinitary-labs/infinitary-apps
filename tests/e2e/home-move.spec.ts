import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { readHomeNumber } from "../../src/core/devices/homeNumber";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { joinHome } from "../../src/core/helper/join";
import { SESSION_AGENT_FILE } from "../../src/core/helper/runAgent";
import { HOME_MOVE_WORDS } from "../../src/core/homeMove/words";
import {
  RUN_LAST_STOP,
  RUN_UPDATED_EXIT,
  RUN_WORDS,
  RunStopSchema,
} from "../../src/main/runCommand";
import { COMMAND_NOTICE_WORDS } from "../../src/shared/commandNotice";
import * as m from "../../src/shared/i18n/messages.generated";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { endCommands, run, runEnv } from "./commandRun";
import { BUILDER, openDevices } from "./deviceFixtures";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import { builtAppDir, type LaunchedApp, launchApp } from "./launch";
import { regionShot } from "./pictures";
import { pressKey } from "./windowKeys";
import { writeWorkServiceManager } from "./workFixtures";

/**
 * Moving the first mate to another computer while it runs (INF-4207 piece 5,
 * the captain's "let me move my home from macbook to mac mini";
 * docs/devices.md, "Moving the first mate"). The home is the built app on
 * a scratch data folder; the computer that runs work is the work mode in
 * this process, joined to it as another Mac, whose data folder's parent is
 * that computer's app's own. The captain presses Move your first mate here
 * on its row in Settings, Devices, reads the Ready list and presses Move
 * now, by keys. The old home stops and its process ends; the work mode puts
 * the record in place and starts the first mate there, which this journey
 * does by launching the built app on that folder at the address the work
 * mode gave. The old home's window then opens as a window of the new home
 * with no new link, the computer that runs work follows the new home, and
 * the new home keeps the project the old one kept, cloned with its branches.
 *
 * Promised result: the move ends with the new home at number 2 holding the
 * old record, the old home's process ended and its window controlling the
 * new home, and the work computer in reach of the new home.
 * Data: a scratch home with one project repository with a second branch.
 * Completion signal: the window's Remote control reads in reach, and the
 * work mode reads in reach, both of the new home.
 * Platform prerequisites: none beyond git; it runs on Linux and the Mac.
 * Shared resources: two loopback ports this journey claims.
 */

/**
 * The MacBook Pro the first mate moves from. Every computer that joins it
 * stands in for another Mac, so Mac mini reads as a computer of its own, as
 * in the captain's MacBook to Mac mini move, never as another user here.
 */
const MACBOOK = { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" };

const apps: LaunchedApp[] = [];
const runs: HelperRun[] = [];
test.afterEach(async () => {
  for (const run of runs.splice(0)) await run.stop();
  for (const app of apps.splice(0).reverse()) await app.close().catch(() => {});
  endCommands();
});

/** The built app's own version, which the home and the work mode must share for a move. */
function appVersion(): string {
  return JSON.parse(readFileSync(join(builtAppDir(), "package.json"), "utf8")).version;
}

/** A project repository with a second branch, as a home adopts one. */
function projectRepository(): string {
  const path = join(scratchDir("infinitary-home-move-code-"), "website");
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(path, "README.md"), "website\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  git("branch", "footer");
  return path;
}

test("the captain moves the live first mate to a computer that runs work: the old home stops and opens as a window of the new one, and the work computer follows", async () => {
  test.setTimeout(300_000);
  const proDir = scratchDir("infinitary-home-move-pro-");
  const pro = await launchApp({
    userDataDir: proDir,
    env: MACBOOK,
  });
  apps.push(pro);
  const project = projectRepository();
  await pro.page.evaluate(
    (path) => window.infinitary.repos.setup({ kind: "adopt", path, name: "website" }),
    project,
  );

  // The computer that runs work: its app's data folder, with the work folder inside it.
  const miniRoot = scratchDir("infinitary-home-move-mini-");
  const dataDir = join(miniRoot, "work");
  const miniPort = await claimedPort();
  const invite = await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  let mini: Promise<LaunchedApp> | null = null;
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [50],
    log: () => {},
    appVersion: appVersion(),
    homeAddresses: () => [`127.0.0.1:${miniPort}`],
    homeFolder: join(miniRoot, "home"),
    // The first mate starts there as the app on that folder, at the address the work mode gave.
    startHome: async () => {
      mini = launchApp({
        userDataDir: dirname(dataDir),
        env: {
          INFINITARY_DEVICE_NAME: "Mac mini",
          INFINITARY_CONNECTION_LOOPBACK_PORT: String(miniPort),
        },
      });
      void mini.then((app) => apps.push(app));
      return true;
    },
  });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect
    .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
    .toBe("in-reach");

  const row = pro.page.locator(`[data-device-row="${joined.grant.deviceId}"]`);
  const ready = pro.page.locator(`[data-home-move="${joined.grant.deviceId}"]`);
  await test.step("the Ready list names what differs on the computer before the click", async () => {
    await openDevices(pro.page);
    const ask = row.locator(`[data-home-move-ask="${joined.grant.deviceId}"]`);
    await expect(ask).toBeVisible();
    await pressKey(ask, "Enter");
    await expect(ready).toBeVisible();
    await expect(ready.getByRole("button", { name: m.settingsDevicesMoveNow() })).toBeEnabled();
    // Nothing blocks: every line is a note.
    await expect(ready.locator('[data-level="blocks"]')).toHaveCount(0);
    // The Ready list as the captain sees it, kept with the run's evidence.
    await regionShot(ready, test.info().outputPath("home-move-ready.png"));
  });

  const exited = new Promise<void>((resolve) => pro.app.process().once("exit", () => resolve()));
  await test.step("Move now: the old home stops and its process ends", async () => {
    await pressKey(ready.getByRole("button", { name: m.settingsDevicesMoveNow() }), "Enter");
    await expect(ready.locator('[role="status"]')).toBeVisible();
    await exited;
    expect(readHomeNumber(join(miniRoot, "devices"))).toBe(2);
    // The old home kept a window's grant to the new home, at its next number.
    const kept = new JoinedHome(join(proDir, "joined"), () => {});
    expect(kept.read()?.grant).toMatchObject({ at: `127.0.0.1:${miniPort}`, kind: "mac" });
    expect(kept.homeNumber()).toBe(2);
    // Its own record went aside, deleted nowhere.
    expect(existsSync(join(proDir, "firstmate.db"))).toBe(false);
    expect(existsSync(join(proDir, "moved-away"))).toBe(true);
  });

  await test.step("the new home keeps the record: the project, cloned with its branches", async () => {
    if (!mini) throw new Error("The work mode never started the first mate.");
    const home = await mini;
    const repos = await home.page.evaluate(() => window.infinitary.repos.list());
    const website = repos.find((repo) => repo.name === "website");
    expect(website?.path).toBe(join(miniRoot, "fleet", "website"));
    const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: website?.path,
      encoding: "utf8",
    });
    expect(branches.split("\n")).toContain("footer");
  });

  await test.step("the old home opens as a window of the new home, and the work computer follows it", async () => {
    const window = await launchApp({
      userDataDir: proDir,
      env: MACBOOK,
    });
    apps.push(window);
    await expect(window.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
      { timeout: 90_000 },
    );
    await expect.poll(() => started.run.state().contact, { timeout: 90_000 }).toBe("in-reach");
    await openDevices(window.page);
    await expect(window.page.locator('[data-device-row="this-mac"]')).toContainText(
      m.settingsDevicesLivesThere(),
    );
  });
});

/**
 * The first mate started by a command, with its window beside it, as a Mac
 * runs it by default (docs/run.md, "The window opened beside it"), and a
 * computer that runs work joined to it, in reach. The command's service
 * manager is a stand-in that writes down what it was asked, and its data
 * folder holds the agent file Start at login keeps while it is off, so a
 * journey reads what the move does to the command's background.
 */
async function commandHome(options: {
  commandEnv?: Record<string, string>;
  windowEnv?: Record<string, string>;
  startHome: (miniRoot: string, dataDir: string, miniPort: number) => Promise<boolean>;
}) {
  const proDir = scratchDir("infinitary-home-move-run-");
  writeFileSync(
    join(proDir, SESSION_AGENT_FILE),
    "the agent Start at login keeps while it is off\n",
  );
  const env = await runEnv(proDir, {
    ...MACBOOK,
    ...options.commandEnv,
  });
  const systemd = process.platform === "linux";
  const manager = writeWorkServiceManager(env.HOME as string, systemd);
  env[systemd ? "INFINITARY_SYSTEMCTL" : "INFINITARY_LAUNCHCTL"] = manager.manager;
  const command = run(env);
  await command.started();
  const beside = await launchApp({
    userDataDir: proDir,
    env: { ...MACBOOK, ...options.windowEnv },
  });
  apps.push(beside);

  const miniRoot = scratchDir("infinitary-home-move-mini-");
  const dataDir = join(miniRoot, "work");
  const miniPort = await claimedPort();
  const invite = await beside.page.evaluate(() =>
    window.infinitary.devices.invite({ kind: "work" }),
  );
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [50],
    log: () => {},
    appVersion: appVersion(),
    homeAddresses: () => [`127.0.0.1:${miniPort}`],
    homeFolder: join(miniRoot, "home"),
    startHome: () => options.startHome(miniRoot, dataDir, miniPort),
  });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect
    .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
    .toBe("in-reach");
  const managerAsked = () =>
    existsSync(manager.asked) ? readFileSync(manager.asked, "utf8").trim().split("\n") : [];
  return { proDir, command, beside, joined, run: started.run, miniRoot, miniPort, managerAsked };
}

/** Opens the Ready list on the computer's row in Settings, Devices and presses Move now, by keys. */
async function moveNow(page: Page, deviceId: string) {
  await openDevices(page);
  const ask = page.locator(`[data-home-move-ask="${deviceId}"]`);
  await expect(ask).toBeVisible();
  await pressKey(ask, "Enter");
  const ready = page.locator(`[data-home-move="${deviceId}"]`);
  const now = ready.getByRole("button", { name: m.settingsDevicesMoveNow() });
  await expect(now).toBeEnabled({ timeout: 30_000 });
  await pressKey(now, "Enter");
  await expect(ready.locator('[role="status"]')).toBeVisible();
  return ready;
}

/** Resolves once the window's own program ends. */
const windowEnded = (opened: LaunchedApp) =>
  new Promise<void>((resolve) => opened.app.process().once("exit", () => resolve()));

/**
 * The captain's "let me move my home from macbook to mac mini", where the
 * MacBook's first mate is started by a command with its window beside it,
 * as a Mac runs it by default (docs/devices.md, "Every device follows";
 * docs/run.md). Promised result: Move now pressed in that window ends the
 * command for good, forgetting its background so nothing starts it again;
 * the command leaves the window a grant of a Mac of the new home at its
 * next number and starts this computer's work for it; the window starts
 * over and opens as a window of the new home, and the computer that runs
 * work follows. Data: a scratch home with the agent file Start at login
 * keeps while it is off. Completion signal: the window's Remote control
 * reads in reach of the new home, and the work mode reads in reach of it.
 * Platform prerequisites: none beyond the command's own (Xvfb on Linux).
 * Shared resources: a loopback port for each launch and the work mode, each claimed.
 */
test("a first mate started by a command moves from the window beside it: the command ends for good, and the window follows as a Mac of the new home", async () => {
  test.setTimeout(300_000);
  let mini: Promise<LaunchedApp> | null = null;
  const home = await commandHome({
    startHome: async (miniRoot, dataDir, miniPort) => {
      mini = launchApp({
        userDataDir: dirname(dataDir),
        env: {
          INFINITARY_DEVICE_NAME: "Mac mini",
          INFINITARY_CONNECTION_LOOPBACK_PORT: String(miniPort),
        },
      });
      void mini.then((app) => apps.push(app));
      return Boolean(miniRoot);
    },
  });
  const { proDir, command, beside } = home;

  await test.step("Move now in the window: the command ends for good and forgets its background", async () => {
    const ended = windowEnded(beside);
    await moveNow(beside.page, home.joined.grant.deviceId);
    expect(await command.exited, command.error()).toBe(0);
    expect(command.lines()).toEqual([RUN_WORDS.started, RUN_WORDS.movedAway, RUN_WORDS.stopped]);
    expect(existsSync(join(proDir, SESSION_AGENT_FILE))).toBe(false);
    // The window beside it starts over once the command has ended.
    await ended;
  });

  await test.step("the command left a Mac of the new home: its grant, its number and its work", async () => {
    expect(readHomeNumber(join(home.miniRoot, "devices"))).toBe(2);
    const kept = new JoinedHome(join(proDir, "joined"), () => {});
    expect(kept.read()?.grant).toMatchObject({ at: `127.0.0.1:${home.miniPort}`, kind: "mac" });
    expect(kept.homeNumber()).toBe(2);
    // This computer's work keeps the same grant and starts in the background.
    const work = new JoinedHome(join(proDir, "work"), () => {});
    expect(work.read()?.grant.deviceId).toBe(kept.read()?.grant.deviceId);
    expect(work.homeNumber()).toBe(2);
    expect(home.managerAsked().join("\n")).toMatch(
      process.platform === "linux" ? /--user .*start/ : /bootstrap/,
    );
    expect(existsSync(join(proDir, "moved-away"))).toBe(true);
  });

  await test.step("the window opens as a window of the new home, and the work computer follows it", async () => {
    if (!mini) throw new Error("The work mode never started the first mate.");
    await mini;
    const again = await launchApp({
      userDataDir: proDir,
      env: MACBOOK,
    });
    apps.push(again);
    await expect(again.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
      { timeout: 90_000 },
    );
    await expect.poll(() => home.run.state().contact, { timeout: 90_000 }).toBe("in-reach");
    await openDevices(again.page);
    await expect(again.page.locator('[data-device-row="this-mac"]')).toContainText(
      m.settingsDevicesLivesThere(),
    );
  });
});

/**
 * The captain's answer on a destination that never answers: after a long
 * wait, a confirmed Start my first mate here again (docs/devices.md, "A
 * destination that never answers"), here from the window beside a command,
 * whose words pass the move's hold over the local door. Promised result:
 * while the move holds, the window's other changes are refused with the
 * holding words; once the destination has stayed out of reach through the
 * offer's wait, the confirmed start ends the command for its starter to
 * start again, in words of its own and never an update's, and the command
 * started again runs the first mate on its own record at the home number
 * above the move's. Data: the offer's wait shortened to three seconds, as a
 * development run may, a destination that stops as it is told to start the
 * first mate, and a stand-in start entry, which this journey plays by
 * starting the command again. Completion signal: the command started again
 * runs with home number 3 and the window's notice goes.
 * Platform prerequisites: none beyond the command's own (Xvfb on Linux).
 * Shared resources: a loopback port for each launch and the work mode, each claimed.
 */
test("a destination that never answers: Start my first mate here again from the window beside a command starts it here at the next number", async () => {
  test.setTimeout(300_000);
  const startEntry = join(scratchDir("infinitary-home-move-entry-"), "start-entry");
  writeFileSync(startEntry, "a stand-in start entry\n");
  const commandEnv = { INFINITARY_HOME_MOVE_OFFER_MS: "3000" };
  let stopping: HelperRun | null = null;
  const home = await commandHome({
    commandEnv,
    windowEnv: { INFINITARY_RUN_START_ENTRY: startEntry },
    // The destination stops as it is told to start the first mate, and never answers.
    startHome: () => {
      if (stopping) void stopping.stop();
      return new Promise<boolean>(() => {});
    },
  });
  stopping = home.run;
  const { proDir, command, beside } = home;
  const page = beside.page;
  const ready = await moveNow(page, home.joined.grant.deviceId);

  await test.step("while the move holds, the window's other changes are refused with the holding words", async () => {
    await expect(ready.locator('[role="status"]')).toHaveText(
      HOME_MOVE_WORDS.waitingFor("Mac mini"),
      {
        timeout: 120_000,
      },
    );
    const refused = await page.evaluate(() =>
      window.infinitary.devices.invite({ kind: "work" }).then(
        () => "",
        (error: Error) => error.message,
      ),
    );
    expect(refused).toContain(HOME_MOVE_WORDS.holding("Mac mini"));
  });

  await test.step("after the wait, the confirmed Start my first mate here again ends the command in words of its own", async () => {
    const offer = ready.getByRole("button", { name: m.settingsDevicesMoveStartHere() });
    await expect(offer).toBeVisible({ timeout: 60_000 });
    await pressKey(offer, "Enter");
    const keep = ready.getByRole("button", { name: m.settingsDevicesMoveKeepWaiting() });
    await expect(keep).toBeFocused();
    await expect(ready.locator("[data-home-move-sure]")).toBeVisible();
    await regionShot(ready, test.info().outputPath("home-move-start-here.png"));
    await pressKey(keep, "Shift+Tab");
    const confirm = ready.getByRole("button", { name: m.settingsDevicesMoveStartHereConfirm() });
    await expect(confirm).toBeFocused();
    await pressKey(confirm, "Enter");
    expect(await command.exited, command.error()).toBe(RUN_UPDATED_EXIT);
    expect(command.lines()).toEqual([RUN_WORDS.started, ...RUN_WORDS.restart, RUN_WORDS.stopped]);
    expect(
      RunStopSchema.parse(JSON.parse(readFileSync(join(proDir, RUN_LAST_STOP), "utf8"))).reason,
    ).toBe("restart");
    // The window waits for the start entry, saying the command stopped: never that it updates.
    const notice = page.locator("[data-command-stopped]");
    await expect(notice).toHaveAttribute("data-command-stopped", "waiting", { timeout: 60_000 });
    await expect(notice.getByRole("alertdialog")).toHaveAccessibleName(
      COMMAND_NOTICE_WORDS.title({ state: "waiting", ending: "restart" }),
    );
  });

  await test.step("the command started again runs the first mate here, above the move's number", async () => {
    expect(readHomeNumber(join(proDir, "devices"))).toBe(3);
    expect(existsSync(join(proDir, "firstmate.db"))).toBe(true);
    const ended = windowEnded(beside);
    const again = run(await runEnv(proDir, { ...MACBOOK, ...commandEnv }));
    await again.started();
    // The window joins the command started again, or starts over to join it.
    await Promise.race([
      expect(page.locator("[data-command-stopped]")).toHaveCount(0, { timeout: 60_000 }),
      ended,
    ]);
    expect(again.child.exitCode).toBeNull();
    expect(readHomeNumber(join(proDir, "devices"))).toBe(3);
  });
});
