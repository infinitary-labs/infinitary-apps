import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { joinHome } from "../../src/core/helper/join";
import { listRecord } from "../../src/core/homeMove/record";
import { STANDBY_COPY, STANDBY_DIR } from "../../src/core/standby/keeper";
import * as m from "../../src/shared/i18n/messages.generated";
import { claimedPort } from "../helpers/claimedPort";
import { databaseDigest, recordDigest } from "../helpers/recordDigest";
import { scratchDir } from "../helpers/scratchDirs";
import { BUILDER, openDevices, selectDevice } from "./deviceFixtures";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import { type LaunchedApp, launchApp } from "./launch";
import { heroShot, regionShot } from "./pictures";
import { pressKey } from "./windowKeys";

/**
 * Keeping a live copy of the first mate on other computers (INF-4207 piece
 * 7; docs/devices.md, "Keeping a copy on another computer"). The home is the
 * built app on a scratch data folder; Mac mini and Mac Studio are two work
 * modes in this process, each joined to it as another Mac. The captain
 * presses Keep a copy here on each row in Settings, Devices, by keys. Both
 * take a full copy and follow each change; Mac Studio stops while the first
 * mate keeps saving, starts again and catches up. After a quiet moment the
 * home's record and both copies compare equal, neither computer can act on
 * its copy, and a home killed in the middle of a change leaves two copies
 * that open whole. The home starts again, both follow it, and Stop keeping a
 * copy deletes Mac Studio's. The two computers are stopped while the home
 * starts again and started once its window is up.
 *
 * Promised result: both rows read in sync, Mac Studio reads its copy's time
 * while it is stopped and in sync again once back, the three records compare
 * equal, both copies pass SQLite's integrity check after the home is killed,
 * the restarted home reads each copy's time while both computers are stopped,
 * and Mac Studio's copy is gone once stopped while Mac mini's stays.
 * Data: a scratch home whose saved settings the window changes, the
 * first mate's own saves as they come.
 * Completion signal: each row's copy line, and the record comparison.
 * Platform prerequisites: none; it runs on Linux and the Mac.
 * Shared resources: none beyond the loopback connection each work mode opens,
 * and the loopback listener each opens for the other copy on a claimed port.
 */

const MACBOOK = { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" };

const apps: LaunchedApp[] = [];
const runs: HelperRun[] = [];
test.afterEach(async () => {
  for (const run of runs.splice(0)) await run.stop();
  for (const app of apps.splice(0).reverse()) await app.close().catch(() => {});
});

type Computer = { name: string; dataDir: string; deviceId: string; run: HelperRun };

/** A computer that runs work for the home, joined as another Mac and running. */
async function computer(home: LaunchedApp, name: string): Promise<Computer> {
  const dataDir = join(scratchDir("infinitary-standby-computer-"), "work");
  const invite = await home.page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name, user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const run = await running(dataDir);
  return { name, dataDir, deviceId: joined.grant.deviceId, run };
}

/**
 * Starts a joined computer's work mode and waits until the home has it in
 * reach. It listens for the other copies on loopback alone, never on this
 * computer's network (docs/devices.md, "Copies that reach each other").
 */
async function running(dataDir: string): Promise<HelperRun> {
  const copies = { hosts: () => ["127.0.0.1"], port: await claimedPort() };
  const started = startHelper({ dataDir, say: () => {}, retryMs: [50], log: () => {}, copies });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect
    .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
    .toBe("in-reach");
  return started.run;
}

/** The first mate saves: the captain turns notifications on and off, each a change of the record. */
async function saves(page: Page, count: number): Promise<void> {
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index++)
      await window.infinitary.settings.setNotifications(index % 2 === 0);
  }, count);
}

const copyOf = (there: Computer) => join(there.dataDir, STANDBY_DIR, STANDBY_COPY);

/** The home's live record by its content, or null when it was read in the middle of a write. */
function homeDigest(userData: string): Record<string, string> | null {
  try {
    return recordDigest(userData);
  } catch {
    return null;
  }
}

test("two computers keep a live copy: one follows, one stops and catches up, all three records compare equal, and a killed home leaves copies that open", async () => {
  test.setTimeout(300_000);
  const proDir = scratchDir("infinitary-standby-pro-");
  // One address for the home across its restart, so both computers find it again.
  const env = { ...MACBOOK, INFINITARY_CONNECTION_LOOPBACK_PORT: String(await claimedPort()) };
  const pro = await launchApp({ userDataDir: proDir, env });
  apps.push(pro);
  const mini = await computer(pro, "Mac mini");
  const studio = await computer(pro, "Mac Studio");
  const rowOf = (there: Computer) => selectDevice(pro.page, there.deviceId);
  const lineOf = async (there: Computer) => (await rowOf(there)).locator("[data-standby]");

  await test.step("Keep a copy here on each row, by keys: both take a full copy and read in sync", async () => {
    await openDevices(pro.page);
    for (const there of [mini, studio]) {
      const keep = (await rowOf(there)).getByRole("button", {
        name: m.settingsDevicesStandbyKeepNamed({ device: there.name }),
      });
      await expect(keep).toBeVisible();
      await pressKey(keep, "Enter");
    }
    for (const there of [mini, studio])
      await expect(await lineOf(there)).toHaveAttribute("data-standby", "in-sync", {
        timeout: 60_000,
      });
    await expect(await lineOf(mini)).toHaveText(m.settingsDevicesStandbyInSync());
    // Capture the selected standby at rest, not the entire Devices panel.
    const selected = await rowOf(mini);
    await pro.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (test.info().repeatEachIndex === 0 && process.env.INFINITARY_TASK_EVIDENCE_DIR)
      await heroShot(pro.app, pro.page, {
        region: selected,
        name: "standby-copies",
      });
    await regionShot(selected, test.info().outputPath("standby-row-in-sync.png"));
  });

  await test.step("Ready to take over lists the copy first, in sync, then what a move there would show", async () => {
    const ask = (await rowOf(mini)).getByRole("button", {
      name: m.settingsDevicesStandbyReadyNamed({ device: mini.name }),
    });
    await pressKey(ask, "Enter");
    const ready = pro.page.locator(`[data-standby-ready="${mini.deviceId}"]`);
    const copy = ready.locator('[data-gap="copy"]');
    await expect(copy).toHaveAttribute("data-level", "notes");
    await regionShot(ready, test.info().outputPath("standby-ready.png"));
    await pressKey(ready.getByRole("button", { name: m.settingsDevicesStandbyClose() }), "Enter");
    await expect(ready).toHaveCount(0);
  });

  await test.step("the first mate saves: both copies follow each change", async () => {
    await saves(pro.page, 20);
    for (const there of [mini, studio])
      await expect(await lineOf(there)).toHaveAttribute("data-standby", "in-sync", {
        timeout: 30_000,
      });
  });

  await test.step("Mac Studio stops: its row reads its copy's time while the first mate keeps saving", async () => {
    await studio.run.stop();
    runs.splice(runs.indexOf(studio.run), 1);
    await expect(await lineOf(studio)).toHaveAttribute("data-standby", "away", { timeout: 60_000 });
    await saves(pro.page, 30);
    await expect(await lineOf(mini)).toHaveAttribute("data-standby", "in-sync", {
      timeout: 30_000,
    });
    await expect(await lineOf(studio)).toHaveAttribute("data-standby", "away");
    await expect(await lineOf(studio)).not.toHaveText(m.settingsDevicesStandbyAwayNone());
    await regionShot(await rowOf(studio), test.info().outputPath("standby-row-away.png"));
  });

  await test.step("Mac Studio starts again and catches up", async () => {
    studio.run = await running(studio.dataDir);
    await expect(await lineOf(studio)).toHaveAttribute("data-standby", "in-sync", {
      timeout: 60_000,
    });
  });

  await test.step("after a quiet moment the home's record and both copies compare equal", async () => {
    await expect
      .poll(
        () => {
          const home = homeDigest(proDir);
          if (!home) return "the home's record was being written";
          for (const there of [mini, studio]) {
            const copy = recordDigest(copyOf(there));
            const differ = [...new Set([...Object.keys(home), ...Object.keys(copy)])].filter(
              (path) => home[path] !== copy[path],
            );
            if (differ.length) return `${there.name} differs at ${differ.join(", ")}`;
          }
          return "equal";
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe("equal");
  });

  await test.step("neither computer can act on its copy: it sits in the work folder alone, where no first mate opens it", async () => {
    for (const there of [mini, studio]) {
      expect(existsSync(join(copyOf(there), "firstmate.db"))).toBe(true);
      expect(existsSync(join(there.dataDir, "firstmate.db"))).toBe(false);
    }
    // The home is still the only first mate: both rows offer a copy's list, never a home of their own.
    for (const there of [mini, studio])
      await expect((await rowOf(there)).locator("[data-standby-ask]")).toBeVisible();
  });

  await test.step("the home is killed in the middle of saving: both copies open whole", async () => {
    // Saves that never end, cut by the kill.
    void pro.page
      .evaluate(async () => {
        for (let index = 0; ; index++)
          await window.infinitary.settings.setNotifications(index % 2 === 0);
      })
      .catch(() => {});
    await saves(pro.page, 5).catch(() => {});
    const killed = pro.app.process();
    const ended = new Promise<void>((resolve) => {
      if (killed.exitCode !== null || killed.signalCode !== null) resolve();
      else killed.once("exit", () => resolve());
    });
    killed.kill("SIGKILL");
    await ended;
    for (const there of [mini, studio]) {
      const databases = listRecord(copyOf(there), null, { kinds: false }).filter((entry) =>
        /\.(db|sqlite|sqlite3)$/.test(entry.path),
      );
      expect(databases.map((entry) => entry.path)).toContain("firstmate.db");
      // Each opens and passes SQLite's own integrity check, or this throws.
      for (const entry of databases) expect(databaseDigest(entry.abs)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  await test.step("the home starts again knowing each copy's time, both copies follow it, and Stop keeping a copy deletes Mac Studio's", async () => {
    // Both computers are stopped while the home starts, and start again once its window is up.
    for (const there of [mini, studio]) {
      await there.run.stop();
      runs.splice(runs.indexOf(there.run), 1);
    }
    const again = await launchApp({
      userDataDir: proDir,
      homeDir: pro.homeDir,
      ...(pro.mockProvider ? { reuseMockProvider: pro.mockProvider } : {}),
      env,
    });
    apps.push(again);
    const rowAgain = (there: Computer) => selectDevice(again.page, there.deviceId);
    await openDevices(again.page);
    // The home stopped without closing, and still says when each copy is from.
    for (const there of [mini, studio]) {
      await expect((await rowAgain(there)).locator("[data-standby]")).toHaveAttribute(
        "data-standby",
        "away",
      );
      await expect((await rowAgain(there)).locator("[data-standby]")).not.toHaveText(
        m.settingsDevicesStandbyAwayNone(),
      );
    }
    for (const there of [mini, studio]) there.run = await running(there.dataDir);
    for (const there of [mini, studio])
      await expect((await rowAgain(there)).locator("[data-standby]")).toHaveAttribute(
        "data-standby",
        "in-sync",
        { timeout: 60_000 },
      );
    await pressKey(
      (await rowAgain(studio)).getByRole("button", {
        name: m.settingsDevicesStandbyReadyNamed({ device: studio.name }),
      }),
      "Enter",
    );
    const ready = again.page.locator(`[data-standby-ready="${studio.deviceId}"]`);
    await pressKey(ready.getByRole("button", { name: m.settingsDevicesStandbyStop() }), "Enter");
    await expect((await rowAgain(studio)).locator("[data-standby]")).toHaveCount(0);
    await expect.poll(() => existsSync(copyOf(studio)), { timeout: 30_000 }).toBe(false);
    // Mac mini keeps its copy.
    await expect((await rowAgain(mini)).locator("[data-standby]")).toHaveAttribute(
      "data-standby",
      "in-sync",
    );
    expect(existsSync(copyOf(mini))).toBe(true);
  });
});
