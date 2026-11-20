import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import electronPath from "electron";
import { readHomeNumber } from "../../src/core/devices/homeNumber";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { joinHome } from "../../src/core/helper/join";
import { readStandbyHome, readStandbyState } from "../../src/core/standby/keeper";
import { readTakeOver, readTakeOverAnswer } from "../../src/core/standby/takeOver";
import { TAKE_OVER_WORDS } from "../../src/core/standby/words";
import * as m from "../../src/shared/i18n/messages.generated";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { BUILDER, openDevices, selectDevice } from "./deviceFixtures";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import {
  builtAppDir,
  defaultClaudeStubDir,
  hermeticEnv,
  type LaunchedApp,
  launchApp,
} from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { heroShot, regionShot } from "./pictures";
import { launchSecrets } from "./secretsHarness";
import { pressKey } from "./windowKeys";

/**
 * Taking over from a copy, and the old home's return (INF-4207 piece 8;
 * docs/devices.md, "Taking over", "Bringing in a newer copy" and "An old
 * home that returns"). The home is the built app on a scratch data folder;
 * Mac Studio and Mac mini are work modes in this process, each joined to it
 * as another Mac and listening for the other copy on loopback. Mac Studio's
 * data folder's parent is that computer's app's own. The captain presses
 * Keep a copy here on both rows by keys, and both copies read in sync. Mac
 * Studio's work stops while the home saves more, so only Mac mini's copy
 * holds the newest changes. Mac Studio's app then opens as a window of the
 * home, and the home's process ends, as when that computer dies. Mac
 * Studio's work starts again, and its window offers Take over, listing Mac
 * mini's copy; the captain presses Take over by keys and confirms, with a
 * stand-in for Touch ID. Mac Studio brings in Mac mini's newer copy first,
 * starts the first mate as the app on its own folder at the address it
 * said, with the next number, and its own work follows it there. Mac mini
 * runs on this same computer and dials the home at loopback, where a
 * computer never follows another address (`src/core/helper/homePlace.ts`),
 * so a separate computer following the copy's address is
 * `src/core/devices/homeRoutes.test.ts`'s. The old home then starts again
 * on its own record: it hears the home on Mac Studio with a higher number,
 * steps down by itself, and starts again as a window of the new home,
 * which shows that it stepped down and what never reached Mac Studio.
 *
 * Promised result: the window's own Take over, confirmed, makes Mac Studio
 * home number 2 holding Mac mini's newer copy, which its own work follows;
 * the old home, started again, ends its own process with no click, keeps a
 * window's grant to Mac Studio at number 2 with its record set aside, and
 * its window controls the new home in reach and reads Stepped down under
 * Controlling.
 * Data: a scratch home whose saved settings the window changes.
 * Completion signal: the take-over answer, the new home's take-over record,
 * Mac Studio's work's contact, the old home's process exit, and the window's Remote
 * control reading in reach.
 * Platform prerequisites: none; it runs on Linux and the Mac.
 * Shared resources: the loopback ports this journey claims.
 */

const MACBOOK = { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" };
const STUDIO = { INFINITARY_DEVICE_NAME: "Mac Studio" };

const apps: LaunchedApp[] = [];
const runs: HelperRun[] = [];
const stops: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const run of runs.splice(0)) await run.stop();
  for (const app of apps.splice(0).reverse()) await app.close().catch(() => {});
});

/** The built app's own version, which the home and the work mode share. */
function appVersion(): string {
  return JSON.parse(readFileSync(join(builtAppDir(), "package.json"), "utf8")).version;
}

/** The first mate saves: the captain turns notifications on and off, each a change of the record. */
async function saves(page: Page, count: number): Promise<void> {
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index++)
      await window.infinitary.settings.setNotifications(index % 2 === 0);
  }, count);
}

/** Resolves once the app's own program ends. */
const ended = (opened: LaunchedApp) =>
  new Promise<void>((resolve) => {
    const process = opened.app.process();
    if (process.exitCode !== null || process.signalCode !== null) resolve();
    else process.once("exit", () => resolve());
  });

/**
 * Starts the built app on a data folder as the person would, for an app that
 * ends by itself, and resolves once it ended: an old home that hears a
 * higher number steps down as it starts, often before it draws a window,
 * which `launchApp` waits for.
 */
async function startsAndEnds(userDataDir: string, env: Record<string, string>): Promise<void> {
  const child = spawn(
    electronPath as unknown as string,
    [builtAppDir(), `--user-data-dir=${userDataDir}`],
    {
      env: {
        ...hermeticEnv({
          userDataDir,
          homeDir: scratchDir("standby-old-home-"),
          loopbackPort: String(await claimedPort()),
        }),
        // Never this computer's own Claude client.
        INFINITARY_CLAUDE_CLI: writeMockClaudeClient(defaultClaudeStubDir(userDataDir)),
        ...env,
      },
      cwd: scratchDir("standby-old-home-cwd-"),
      stdio: "ignore",
    },
  );
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  stops.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await exited;
}

/**
 * Joins a work folder to the home: as a Mac, whose app there opens as a
 * window of the home and whose work keeps the same grant, or as a computer
 * that only runs work.
 */
async function joinHomeAs(home: LaunchedApp, dataDir: string, name: string, kind: "mac" | "work") {
  const invite = await home.page.evaluate(
    (kind) => window.infinitary.devices.invite({ kind }),
    kind,
  );
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name, user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  return joined.grant.deviceId;
}

test("a copy's window takes over once the home is gone, bringing in the newer copy first, and the old home that returns steps down to it by itself", async () => {
  test.setTimeout(420_000);
  const proDir = scratchDir("infinitary-take-over-pro-");
  const pro = await launchApp({ userDataDir: proDir, env: MACBOOK });
  apps.push(pro);

  // Mac Studio: its app's data folder, with the work folder inside it.
  const studioRoot = scratchDir("infinitary-take-over-studio-");
  const dataDir = join(studioRoot, "work");
  const studioPort = await claimedPort();
  const studioCopies = await claimedPort();
  const deviceId = await joinHomeAs(pro, dataDir, "Mac Studio", "mac");
  let studio: Promise<LaunchedApp> | null = null;
  const startStudio = () => {
    const started = startHelper({
      dataDir,
      say: () => {},
      retryMs: [50],
      log: () => {},
      appVersion: appVersion(),
      // It listens for other copies on loopback alone, and says where its first mate would answer.
      copies: { hosts: () => ["127.0.0.1"], port: studioCopies },
      homeAddresses: () => [`127.0.0.1:${studioPort}`],
      homeFolder: join(studioRoot, "home"),
      // The first mate starts there as the app on that folder, at the address the work mode gave.
      startHome: async () => {
        studio = launchApp({
          userDataDir: studioRoot,
          env: { ...STUDIO, INFINITARY_CONNECTION_LOOPBACK_PORT: String(studioPort) },
        });
        void studio.then((app) => apps.push(app));
        return true;
      },
    });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    return started.run;
  };
  let studioRun = startStudio();

  // Mac mini: another computer that keeps a copy.
  const miniDir = join(scratchDir("infinitary-take-over-mini-"), "work");
  const miniId = await joinHomeAs(pro, miniDir, "Mac mini", "work");
  const mini = startHelper({
    dataDir: miniDir,
    say: () => {},
    retryMs: [50],
    log: () => {},
    appVersion: appVersion(),
    copies: { hosts: () => ["127.0.0.1"], port: await claimedPort() },
  });
  if (!mini.ok) throw new Error(mini.reason);
  runs.push(mini.run);
  for (const run of [studioRun, mini.run])
    await expect
      .poll(() => run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
      .toBe("in-reach");
  const rowOf = (id: string) => selectDevice(pro.page, id);

  await test.step("Keep a copy here on both rows, by keys: each copy reads in sync", async () => {
    await openDevices(pro.page);
    for (const [id, name] of [
      [deviceId, "Mac Studio"],
      [miniId, "Mac mini"],
    ] as const)
      await pressKey(
        (await rowOf(id)).getByRole("button", {
          name: m.settingsDevicesStandbyKeepNamed({ device: name }),
        }),
        "Enter",
      );
    await saves(pro.page, 6);
    for (const id of [deviceId, miniId])
      await expect((await rowOf(id)).locator("[data-standby]")).toHaveAttribute(
        "data-standby",
        "in-sync",
        {
          timeout: 60_000,
        },
      );
    // The home told each copy what taking over needs, and where the other copy answers.
    for (const dir of [dataDir, miniDir])
      await expect
        .poll(() => readStandbyHome(dir)?.copies.length ?? 0, { timeout: 30_000 })
        .toBe(2);
  });

  await test.step("Mac Studio's work stops while the home saves more: only Mac mini's copy holds it", async () => {
    await studioRun.stop();
    runs.splice(runs.indexOf(studioRun), 1);
    const stopped = readStandbyState(dataDir).seq;
    await saves(pro.page, 6);
    await expect
      .poll(() => readStandbyState(miniDir).seq, { timeout: 60_000 })
      .toBeGreaterThan(stopped);
  });

  // Mac Studio's app opens as a window of the home its work runs for, with Touch ID stood in.
  const studioWindow = await launchSecrets({ userDataDir: studioRoot, env: STUDIO });
  apps.push(studioWindow);

  await test.step("the home dies; Mac Studio's window offers Take over, and the captain takes over by keys", async () => {
    await expect(studioWindow.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
      { timeout: 90_000 },
    );
    const gone = ended(pro);
    await pro.app.process().kill("SIGKILL");
    await gone;
    apps.splice(apps.indexOf(pro), 1);
    studioRun = startStudio();
    await expect.poll(() => mini.run.state().contact, { timeout: 60_000 }).not.toBe("in-reach");
    await openDevices(studioWindow.page);
    const offer = studioWindow.page.locator("[data-take-over]");
    await expect(offer).toBeVisible({ timeout: 90_000 });
    // It lists Mac mini's copy as the first mate's computer last said it.
    await expect(offer.locator('[data-take-over-copy="Mac mini"]')).toBeVisible();
    await regionShot(offer, test.info().outputPath("take-over-offer.png"));
    const takeOver = offer.getByRole("button", { name: m.settingsTakeOverButton(), exact: true });
    await pressKey(takeOver, "Enter");
    await expect(offer).toContainText(m.settingsTakeOverAsk());
    await regionShot(offer, test.info().outputPath("take-over-ask.png"));
    const closed = ended(studioWindow);
    await pressKey(takeOver, "Enter");
    // Confirmed, the work there answers, and the window starts over as its own first mate.
    await expect
      .poll(() => readTakeOverAnswer(dataDir)?.state, { timeout: 120_000 })
      .toBe("started");
    expect(readTakeOverAnswer(dataDir)?.text).toBe(
      TAKE_OVER_WORDS.startedNewer("MacBook Pro", "Mac mini"),
    );
    await closed;
    apps.splice(apps.indexOf(studioWindow), 1);
  });

  await test.step("Mac Studio is home 2, holding Mac mini's newer copy, and its own work follows it", async () => {
    expect(readHomeNumber(join(studioRoot, "devices"))).toBe(2);
    const record = readTakeOver(studioRoot);
    expect(record).toMatchObject({
      homeNumber: 2,
      stream: readStandbyState(miniDir).stream,
      seq: readStandbyState(miniDir).seq,
    });
    if (!studio) throw new Error("The work mode never started the first mate.");
    const home = await studio;
    // Its own work follows the first mate there.
    await expect.poll(() => studioRun.state().contact, { timeout: 90_000 }).toBe("in-reach");
    // The first mate there knows Mac Studio as itself, never as a copy of its own.
    const list = await home.page.evaluate(() => window.infinitary.devices.standby.list());
    expect(list.standbys.map((each) => each.deviceId)).not.toContain(deviceId);
  });

  await test.step("the old home starts again on its own record, hears home 2 and steps down by itself", async () => {
    await startsAndEnds(proDir, MACBOOK);
    const kept = new JoinedHome(join(proDir, "joined"), () => {});
    expect(kept.read()?.grant).toMatchObject({ at: `127.0.0.1:${studioPort}`, kind: "mac" });
    expect(kept.homeNumber()).toBe(2);
    expect(kept.steppedDown()?.from).toBe("Mac Studio");
    // Its own record went aside, deleted nowhere.
    expect(existsSync(join(proDir, "firstmate.db"))).toBe(false);
    // Its way back's key went with it: the grant it keeps holds its own.
    expect(existsSync(join(proDir, "devices", "returning-key.json"))).toBe(false);
    expect(existsSync(join(proDir, "moved-away"))).toBe(true);
  });

  await test.step("it opens as a window of the home on Mac Studio, and says it stepped down", async () => {
    const window = await launchApp({ userDataDir: proDir, env: MACBOOK });
    apps.push(window);
    await expect(window.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
      { timeout: 90_000 },
    );
    await openDevices(window.page);
    const note = window.page.locator("[data-stepped-down]");
    await expect(note).toBeVisible();
    await expect(note).toContainText(m.settingsSteppedDownLabel());
    await expect(note).toContainText("Mac Studio");
    if (test.info().repeatEachIndex === 0 && process.env.INFINITARY_TASK_EVIDENCE_DIR)
      await heroShot(window.app, window.page, { region: note, name: "standby-take-over" });
    await regionShot(note, test.info().outputPath("stepped-down.png"));
  });
});
