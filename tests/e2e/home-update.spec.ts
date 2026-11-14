import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import * as m from "../../src/shared/i18n/messages.generated";
import { PROTOCOL_VERSION } from "../../src/shared/ipc";
import { scratchDir } from "../helpers/scratchDirs";
import { endCommands, run, runEnv } from "./commandRun";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { HELD_CALL_MARKER, heldCall, heldCallPipe } from "./scenarios/heldCall";
import { pressKey, runFromSearch, untilFocused } from "./windowKeys";

/**
 * Updating the first mate's computer from a paired Mac (docs/view.md,
 * "Updating the first mate's computer"; INF-4012's direction 1, which the
 * captain chose with "1 and 2 together"). The Mac where Firstmate lives speaks
 * a newer major past this build's floor, so the view reads only; from
 * Settings, General it still starts that Mac's own update by keys, which runs
 * the real update controller and the crew's save there, and that Mac's update
 * notice opens and names the view that asked. Data: two throwaway data
 * folders; the newer contract and floor stood in on the home
 * (`INFINITARY_CONTRACT_VERSION`, `INFINITARY_VIEW_FLOOR`) and its release
 * feed and copy replacement stood in (`INFINITARY_MAC_UPDATE_STAND_IN`,
 * src/main/host/macUpdateStandIn.ts), so nothing is downloaded or replaced.
 * In the first journey a crewmate there makes a call that waits for the
 * journey's word (scenarios/heldCall.ts), so the update saves running
 * work and the view's Update later lets it go. The other journeys' first
 * mate is started by a command (docs/run.md), so the window opened beside it
 * installs, as a release's would; when that window is closed, the first mate
 * asks for it, and the journey opens it as macOS would
 * (`INFINITARY_OPEN_WINDOW_STAND_IN`, src/main/host/openWindowStandIn.ts).
 */

test.afterEach(endCommands);

const MAJOR = Number(PROTOCOL_VERSION.split(".")[0]);
const HOME = "Mac mini";
const VIEW = "MacBook Air";
const OFFERED = "99.0.0";

/** A Mac on this build, joined as a view of the computer whose window makes the link. */
async function viewJoining(home: LaunchedApp): Promise<LaunchedApp> {
  const invite = await home.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
  const view = await launchApp({ env: { INFINITARY_DEVICE_NAME: VIEW } });
  // Joining starts the window over, so its answer may never return to this page.
  await view.page.evaluate((link) => {
    void window.infinitary.devices.join(link);
  }, invite.link);
  await expect(view.page.locator("[data-remote-control]")).toHaveAttribute(
    "data-remote-control",
    "in-reach",
  );
  return view;
}

/** The view opens the row by command search and presses Update by keys, which asks first. */
async function armFromView(view: LaunchedApp, shots: string): Promise<Locator> {
  await runFromSearch(view.app, view.page, "updates.home");
  const row = view.page.locator("[data-home-update]");
  await expect(row).toHaveAttribute("data-home-update", "offered");
  await expect(row).toContainText(m.viewHomeUpdateOffered({ name: HOME, version: OFFERED }));
  await regionShot(row, test.info().outputPath(`${shots}-offered.png`));
  await pressKey(
    row.getByRole("button", { name: m.viewHomeUpdateButton({ name: HOME }) }),
    "Enter",
  );
  await untilFocused(row.locator("[data-home-update-confirm]"));
  await expect(row).toContainText(m.viewHomeUpdateConfirmNoUndo({ name: HOME }));
  return row;
}

/** The home's controller downloads, saves the crew's work and installs; the row says it restarts. */
async function restarting(row: Locator, shots: string): Promise<void> {
  // The stand-in replaces nothing and never answers, as a release quitting to restart would not.
  await expect(row).toHaveAttribute("data-home-update", "restarting", { timeout: 60_000 });
  await expect(row).toContainText(m.viewHomeUpdateRestarting({ name: HOME }));
  await regionShot(row, test.info().outputPath(`${shots}-restarting.png`));
}

/** The view starts the update by keys, Update then Enter, and the home restarts. */
async function updateFromView(view: LaunchedApp, shots: string): Promise<void> {
  const row = await armFromView(view, shots);
  await regionShot(row, test.info().outputPath(`${shots}-confirm.png`));
  await view.page.keyboard.press("Enter");
  await restarting(row, shots);
}

/** The home's own window: its update notice opens by itself and names the view that asked. */
async function homeSaysWhoAsked(home: LaunchedApp, shot: string): Promise<void> {
  await expect(home.page.locator("[data-update-asked-from]")).toHaveText(
    m.viewHomeUpdateAskedFrom({ name: VIEW }),
  );
  const status = await home.page.evaluate(() => window.infinitary.update.status());
  expect(status).toMatchObject({ phase: "installing", askedFrom: VIEW, latestVersion: OFFERED });
  await regionShot(home.page.locator("[data-update-channel]"), test.info().outputPath(shot));
}

test("a Mac reading only starts the first mate's computer's own update, puts it off while work runs there, and that computer says who asked", async () => {
  test.setTimeout(240_000);
  const opened: LaunchedApp[] = [];
  const pipe = heldCallPipe(scratchDir("infinitary-home-update-held-"));
  try {
    const home = await launchApp({
      userDataDir: scratchDir("infinitary-home-update-"),
      withMockProvider: true,
      scenarios: [heldCall(pipe)],
      env: {
        INFINITARY_DEVICE_NAME: HOME,
        INFINITARY_CONTRACT_VERSION: `${MAJOR + 1}.0.0`,
        INFINITARY_VIEW_FLOOR: `${MAJOR + 1}`,
        INFINITARY_MAC_UPDATE_STAND_IN: OFFERED,
      },
    });
    opened.push(home);
    // A crewmate on the first mate's computer makes a call that has not finished.
    await promptInput(home.page).fill(`${SPAWN_PROMPT_MARKER} ${HELD_CALL_MARKER}`);
    await promptInput(home.page).press("Enter");
    const view = await viewJoining(home);
    opened.push(view);
    await expect
      .poll(
        async () =>
          (await view.page.evaluate(() => window.infinitary.update.home.status())).stops.tasks,
        { timeout: 60_000 },
      )
      .toEqual([HELD_CALL_MARKER]);
    // Past the floor: the view reads only, and its pill names the side to update.
    await expect(view.page.locator("[data-view-pill]")).toHaveCount(1);

    // Update names the running work, and the home saves it first: Update later lets it go.
    const row = await armFromView(view, "view");
    await expect(row.locator("[data-home-update-stops]")).toContainText(HELD_CALL_MARKER);
    await regionShot(row, test.info().outputPath("view-confirm.png"));
    await view.page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("data-home-update", "saving");
    await expect(row).toContainText(m.viewHomeUpdateSaving({ name: HOME }));
    await expect(row).toContainText(HELD_CALL_MARKER);
    await regionShot(row, test.info().outputPath("view-saving.png"));
    await pressKey(row.getByRole("button", { name: m.viewHomeUpdateLater() }), "Enter");
    await expect(row).toHaveAttribute("data-home-update", "offered");
    await regionShot(row, test.info().outputPath("view-later.png"));
    // Nothing was installed, and the crewmate's call was never cut off.
    expect(await home.page.evaluate(() => window.infinitary.update.status())).toMatchObject({
      updateAvailable: true,
      latestVersion: OFFERED,
    });
    expect((await home.page.evaluate(() => window.infinitary.update.status())).phase).not.toBe(
      "installing",
    );

    // Once the call ends, Update goes through.
    writeFileSync(pipe, "released");
    await expect
      .poll(
        async () =>
          (await view.page.evaluate(() => window.infinitary.update.home.status())).stops.tasks,
        { timeout: 60_000 },
      )
      .toEqual([]);
    await updateFromView(view, "view-again");
    await homeSaysWhoAsked(home, "home-notice.png");
  } finally {
    for (const app of opened.reverse()) await app.close().catch(() => {});
  }
});

test("a first mate a command started installs a view's update through the window beside it", async () => {
  test.setTimeout(180_000);
  const opened: LaunchedApp[] = [];
  try {
    const userDataDir = scratchDir("infinitary-home-update-command-");
    const standIn = { INFINITARY_DEVICE_NAME: HOME, INFINITARY_MAC_UPDATE_STAND_IN: OFFERED };
    const ran = run(await runEnv(userDataDir, standIn));
    await ran.started();
    // The window beside the command installs this computer's copy (docs/run.md).
    const beside = await launchApp({ userDataDir, env: standIn });
    opened.push(beside);
    expect(await beside.page.evaluate(() => window.infinitary.devices.thisMac())).toMatchObject({
      role: "home",
      byCommand: true,
    });
    const view = await viewJoining(beside);
    opened.push(view);
    await updateFromView(view, "command-view");
    await homeSaysWhoAsked(beside, "command-beside-notice.png");
    // The command is still the first mate: the window's install never replaced it.
    expect(ran.child.exitCode).toBeNull();
  } finally {
    for (const app of opened.reverse()) await app.close().catch(() => {});
  }
});

test("a first mate a command started opens its closed window to install a view's update", async () => {
  test.setTimeout(240_000);
  const opened: LaunchedApp[] = [];
  try {
    const userDataDir = scratchDir("infinitary-home-update-closed-");
    const asks = join(scratchDir("infinitary-home-update-opens-"), "opened");
    const standIn = { INFINITARY_DEVICE_NAME: HOME, INFINITARY_MAC_UPDATE_STAND_IN: OFFERED };
    // Where a Mac's run asks macOS to open the app, the stand-in notes the ask (openWindowStandIn.ts).
    const ran = run(
      await runEnv(userDataDir, { ...standIn, INFINITARY_OPEN_WINDOW_STAND_IN: asks }),
    );
    await ran.started();
    const first = await launchApp({ userDataDir, env: standIn });
    opened.push(first);
    const view = await viewJoining(first);
    opened.push(view);
    // The window closes; the view still reaches the first mate the command runs.
    await first.close();
    const row = await armFromView(view, "closed-view");
    await view.page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("data-home-update", "starting");
    await expect(row).toContainText(m.viewHomeUpdateStarting({ name: HOME }));
    await regionShot(row, test.info().outputPath("closed-view-starting.png"));
    // The first mate asked once for its window; the journey opens it as macOS would.
    await expect.poll(() => existsSync(asks), { timeout: 30_000 }).toBe(true);
    expect(readFileSync(asks, "utf8")).toBe("open\n");
    const reopened = await launchApp({ userDataDir, env: standIn });
    opened.push(reopened);
    await restarting(row, "closed-view");
    await homeSaysWhoAsked(reopened, "closed-reopened-notice.png");
    expect(ran.child.exitCode).toBeNull();
  } finally {
    for (const app of opened.reverse()) await app.close().catch(() => {});
  }
});
