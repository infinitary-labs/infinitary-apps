import { cpSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { joinHome } from "../../src/core/helper/join";
import { openDatabase } from "../../src/core/storage/db";
import { COMPUTER } from "../../src/shared/deviceNames";
import { type DeviceView, deviceFoldedLine } from "../../src/shared/devices";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { chooseWhereFirstMateLives } from "./firstLaunch";
import { seedRepo } from "./githubStub";
import { type HelperRun, startHelper } from "./helperRun";
import { type LaunchedApp, launchApp } from "./launch";
import { heroShot, regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";

/**
 * One computer, one row (docs/devices.md, "One computer, one entry"; INF-4835's
 * plan, piece 3, captain: "Fold them into one row by itself, keeping the one
 * that runs work"). A Mac whose window joined with a pasted link and whose
 * work kept no grant, joined again by its command, stays the same row. A Mac
 * already on the list twice - once for its window, once for its work - folds
 * into the row its work keeps when its window opens: the project that ran on
 * the other row follows, the feed says so once, and the window carries on
 * in reach as the row that stays, saying so in Settings -> Devices. Both
 * apps run on this computer, each with its own data; the command's join
 * stands in for the add by address, which runs the same join over SSH.
 */

const PROJECT = "ledger";
const AIR = "MacBook Air";
const user = { name: userInfo().username, uid: userInfo().uid };

const topLine = (page: Page) => page.locator("[data-remote-control]");

test("a Mac joined twice keeps one row, and a Mac on the list twice folds into the row that runs its work while its window stays", async () => {
  test.setTimeout(240_000);
  const proData = scratchDir("infinitary-one-row-pro-");
  const { repoDir } = seedRepo(proData);
  const db = openDatabase(proData);
  seedProject(db, {
    id: "repo-ledger",
    path: repoDir,
    name: PROJECT,
    setupKind: "clone",
    origin: `https://github.com/o/${PROJECT}.git`,
    delivery: "direct-pr",
    rigor: "quick",
    runsOn: null,
  });
  seedHostedOrigins(db, proData);
  db.close();
  // The Mac where Firstmate lives takes every app that joins it for another Mac.
  const pro = await launchApp({
    userDataDir: proData,
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" },
  });
  const rows = async (): Promise<DeviceView[]> =>
    (await pro.page.evaluate(() => window.infinitary.devices.list())).filter(
      (device) => device.name === AIR,
    );
  const invite = async () =>
    (await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }))).link;
  const runs: HelperRun[] = [];
  const runWork = (dataDir: string) => {
    const started = startHelper({ dataDir, say: () => {}, retryMs: [50], log: () => {} });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    return started.run;
  };
  let air: LaunchedApp | undefined;
  try {
    let windowId = "";
    let workDir = "";
    await test.step("a Mac whose window joined, joined again by its command, stays the same row", async () => {
      air = await launchApp({ env: { INFINITARY_DEVICE_NAME: AIR } });
      const { page } = air;
      await chooseWhereFirstMateLives(page, "running");
      await page.locator("[data-join-chip]").click();
      await page.getByLabel(`The link from your other ${COMPUTER.one}`).fill(await invite());
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Control it from here" }).click();
      await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
      await expect.poll(async () => (await rows()).length).toBe(1);
      windowId = (await rows())[0]?.id ?? "";
      // Its work kept no grant: the folder is gone, as on a Mac whose
      // background setup never finished.
      workDir = join(air.userDataDir, "work");
      await expect.poll(() => new JoinedHome(workDir).read()?.grant.deviceId).toBe(windowId);
      rmSync(workDir, { recursive: true, force: true });

      const joined = await joinHome({
        text: await invite(),
        dataDir: workDir,
        io: { say: () => {}, ask: async () => "yes" },
        device: { name: AIR, user },
        timeoutMs: 5_000,
      });
      expect(joined).toMatchObject({ ok: true, again: true, grant: { deviceId: windowId } });
      expect(new JoinedHome(workDir).read()?.grant.deviceId).toBe(windowId);
      runWork(workDir);
      await expect
        .poll(rows)
        .toEqual([expect.objectContaining({ id: windowId, inReach: true, controlling: true })]);
    });

    await test.step("a Mac on the list twice folds into the row its work keeps when its window opens", async () => {
      if (!air) throw new Error("no window");
      // Its work kept a row of its own: a join with a fresh link into another
      // folder, which then becomes this Mac's work folder.
      await Promise.all(runs.splice(0).map((run) => run.stop()));
      const elsewhere = join(scratchDir("infinitary-one-row-work-"), "work");
      const joined = await joinHome({
        text: await invite(),
        dataDir: elsewhere,
        io: { say: () => {}, ask: async () => "yes" },
        device: { name: AIR, user },
        timeoutMs: 5_000,
      });
      if (!joined.ok) throw new Error(joined.reason);
      const workId = joined.grant.deviceId;
      expect(workId).not.toBe(windowId);
      const airData = air.userDataDir;
      await air.close();
      air = undefined;
      rmSync(workDir, { recursive: true, force: true });
      cpSync(elsewhere, workDir, { recursive: true });
      rmSync(elsewhere, { recursive: true, force: true });
      runWork(workDir);
      await expect
        .poll(async () => (await rows()).map((row) => row.id).sort())
        .toEqual([windowId, workId].sort());
      await pro.page.evaluate(
        ([repoId, deviceId]) => window.infinitary.devices.runsOn(repoId, deviceId),
        ["repo-ledger", windowId] as const,
      );

      air = await launchApp({ userDataDir: airData, env: { INFINITARY_DEVICE_NAME: AIR } });
      const { page } = air;
      await expect.poll(rows).toEqual([expect.objectContaining({ id: workId, inReach: true })]);
      await expect
        .poll(
          async () =>
            (await pro.page.evaluate(() => window.infinitary.repos.list())).find(
              (repo) => repo.id === "repo-ledger",
            )?.runsOn,
        )
        .toBe(workId);
      const kept = (await rows())[0];
      if (!kept) throw new Error("no row");
      await expect
        .poll(
          async () =>
            (
              await pro.page.evaluate(async () =>
                (await window.infinitary.feed.recent()).map((line) => line.text),
              )
            ).filter((text) => text === deviceFoldedLine(kept)).length,
        )
        .toBe(1);

      // The window never left: it carries on in reach as the row that stays, and says so.
      await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
      await expect(page.locator('[data-first-run-gate="open"]')).toHaveCount(0);
      expect(new JoinedHome(join(air.userDataDir, "joined")).read()?.grant.deviceId).toBe(workId);
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("tab", { name: "Devices", exact: true }).click();
      const note = page.locator("[data-carried-on]");
      await expect(note).toHaveText(m.settingsControllingCarriedOn({ name: "MacBook Pro" }));
      // The note's picture, for the change's own evidence when a run names a folder for it.
      const evidence =
        test.info().repeatEachIndex === 0 ? process.env.INFINITARY_TASK_EVIDENCE_DIR : undefined;
      if (evidence) {
        await regionShot(note, join(evidence, "carried-on-note.png"));
        await heroShot(air.app, page, {
          region: note,
          anchors: [page.locator("div[data-controlling]:not([data-device-row])")],
          name: "one-computer-one-row",
        });
      }
    });
  } finally {
    await Promise.all(runs.map((run) => run.stop()));
    await air?.close();
    await pro.close();
  }
});
