import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { openDevices, selectDevice } from "./deviceFixtures";
import { type LaunchedApp, launchApp } from "./launch";
import { startMockProvider } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { showCard, shownCard } from "./stack";

/**
 * An app open on another computer follows the version of the computer it
 * controls (docs/view.md, "Following the home's version"; docs/devices.md,
 * "Updating the app open there"). The captain asked that it update "by
 * itself" to "the home's version" while nobody uses it, and that "a manual
 * update flow in the devices view" stays. Data: two throwaway data folders;
 * the app's older version stood in (`INFINITARY_UPDATE_CURRENT_VERSION`) and
 * its update stood in (`INFINITARY_MAC_UPDATE_STAND_IN`,
 * src/main/host/macUpdateStandIn.ts), so nothing is downloaded or replaced
 * and its install never answers, as a release quitting to start again would
 * not. The first mate's computer runs this build's version. A window here
 * is never in front, so only words not yet sent keep the app in use.
 */

const HOME = "Mac mini";
const VIEW = "MacBook Air";
const OLDER = "0.0.1";

/** The app open on the other computer: older, and its update stood in unless it cannot follow. */
function viewEnv(follows: boolean): Record<string, string> {
  return {
    INFINITARY_DEVICE_NAME: VIEW,
    INFINITARY_UPDATE_CURRENT_VERSION: OLDER,
    ...(follows ? { INFINITARY_MAC_UPDATE_STAND_IN: OLDER } : {}),
  };
}

/** The app on the other computer, joined as a view of the computer whose window makes the link. */
async function viewJoining(home: LaunchedApp, follows: boolean): Promise<LaunchedApp> {
  const invite = await home.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
  const view = await launchApp({
    userDataDir: scratchDir("infinitary-app-follows-view-"),
    env: viewEnv(follows),
  });
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

/** The home's Settings -> Devices row of the computer the app is open on. */
async function viewRow(home: LaunchedApp): Promise<Locator> {
  const id = await home.page.evaluate(
    async (name) =>
      (await window.infinitary.devices.list()).find((device) => device.name === name)?.id,
    VIEW,
  );
  expect(id).toBeTruthy();
  await openDevices(home.page);
  return selectDevice(home.page, id as string);
}

/** The row's line under the app's version says the step it is at. */
async function step(row: Locator, said: string, words: string): Promise<void> {
  const line = row.locator("[data-device-app-follow]");
  await expect(line).toHaveAttribute("data-device-app-follow", said, { timeout: 60_000 });
  await expect(line).toHaveText(words);
}

/**
 * The app's own installer got the first mate's computer's exact version:
 * the stand-in install, which never answers, holds it installing.
 */
async function installing(view: LaunchedApp, version: string): Promise<void> {
  await expect
    .poll(() => view.page.evaluate(() => window.infinitary.update.status()), { timeout: 60_000 })
    .toMatchObject({ phase: "installing", latestVersion: version });
}

/** Moves the focus by Tab alone until it rests on `target`, as a person reaches it. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < 40; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab never reached the control");
}

/** Words typed here and not sent, while the first mate's computer is away. */
async function wordsLeft(page: Page): Promise<void> {
  const input = promptInput(page);
  await input.fill("check the harbour lights");
  await expect(input).toHaveValue("check the harbour lights");
}

const evidence = () =>
  test.info().repeatEachIndex === 0 ? process.env.INFINITARY_TASK_EVIDENCE_DIR : undefined;

test("an app on another computer gets the first mate's computer's version by itself while nobody uses it, and Update app on its row starts it at once", async () => {
  test.setTimeout(300_000);
  const opened: LaunchedApp[] = [];
  const provider = await startMockProvider();
  try {
    const homeDir = scratchDir("infinitary-app-follows-home-");
    // A first mate signed in, so the words typed there can be cleared.
    const homeAgain = () =>
      launchApp({
        userDataDir: homeDir,
        reuseMockProvider: provider,
        env: { INFINITARY_DEVICE_NAME: HOME },
      });
    let home = await homeAgain();
    opened.push(home);
    const version = await home.page.evaluate(
      async () => (await window.infinitary.update.status()).currentVersion,
    );
    let view = await viewJoining(home, true);
    opened.push(view);

    // Nobody uses the app: it gets the version and starts again on it by itself.
    let row = await viewRow(home);
    await step(row, "restarting", m.devicesAppRestarting({ version }));
    await installing(view, version);
    await regionShot(row, test.info().outputPath("by-itself.png"));

    // Someone left words unsent there: it waits, and starts again once they are gone.
    const viewDir = view.userDataDir;
    await view.close();
    await home.close();
    view = await launchApp({ userDataDir: viewDir, env: viewEnv(true) });
    opened.push(view);
    await wordsLeft(view.page);
    home = await homeAgain();
    opened.push(home);
    row = await viewRow(home);
    await step(row, "waiting", m.devicesAppWaiting({ version }));
    // Ready, and nothing installs while the words wait there.
    expect((await view.page.evaluate(() => window.infinitary.update.status())).phase).not.toBe(
      "installing",
    );
    const update = row.getByRole("button", { name: m.devicesUpdateAppNamed({ device: VIEW }) });
    await expect(update).toHaveText(m.devicesUpdateApp());
    await regionShot(row, test.info().outputPath("waiting.png"));
    const kept = evidence();
    if (kept) {
      await regionShot(row, join(kept, "app-waiting-row.png"));
      await heroShot(home.app, home.page, { region: row, name: "app-follows-home" });
    }
    await promptInput(view.page).fill("");
    await step(row, "restarting", m.devicesAppRestarting({ version }));
    await installing(view, version);

    // Words unsent again: Update app on the row, by keys, starts it at once.
    await view.close();
    await home.close();
    view = await launchApp({ userDataDir: viewDir, env: viewEnv(true) });
    opened.push(view);
    await wordsLeft(view.page);
    home = await homeAgain();
    opened.push(home);
    row = await viewRow(home);
    await step(row, "waiting", m.devicesAppWaiting({ version }));
    await tabTo(
      home.page,
      row.getByRole("button", { name: m.devicesUpdateAppNamed({ device: VIEW }) }),
    );
    await home.page.keyboard.press("Enter");
    await step(row, "restarting", m.devicesAppRestarting({ version }));
    await installing(view, version);
    if (kept) await regionShot(row, join(kept, "app-update-pressed-row.png"));
    // The words there were never sent anywhere: they wait in its composer.
    await expect(promptInput(view.page)).toHaveValue("check the harbour lights");
  } finally {
    for (const app of opened.reverse()) await app.close().catch(() => {});
    await provider.close();
  }
});

test("an app on another computer that cannot update by itself says why on its row and on a card", async () => {
  test.setTimeout(180_000);
  const opened: LaunchedApp[] = [];
  try {
    const home = await launchApp({
      userDataDir: scratchDir("infinitary-app-follows-cannot-"),
      env: { INFINITARY_DEVICE_NAME: HOME },
    });
    opened.push(home);
    const version = await home.page.evaluate(
      async () => (await window.infinitary.update.status()).currentVersion,
    );
    const view = await viewJoining(home, false);
    opened.push(view);

    const row = await viewRow(home);
    const line = row.locator("[data-device-app-follow]");
    await expect(line).toHaveAttribute("data-device-app-follow", "cannot", { timeout: 60_000 });
    await expect(line).toHaveText(
      `${m.devicesAppCannot({ version })} ${m.devicesAppWhyInstallation({ version })}`,
    );
    await expect(line).toHaveAttribute("data-tone", "warn");
    const kept = evidence();
    if (kept) await regionShot(row, join(kept, "app-cannot-row.png"));

    // The first mate's computer raises the card that says it is updated there.
    await home.page.getByRole("button", { name: "Back", exact: true }).click();
    const title = m.devicesAppCardTitle({ device: VIEW });
    await showCard(home.page, title);
    const card = shownCard(home.page, title);
    await expect(card.getByRole("button", { name: m.devicesAppCardGotIt() })).toBeVisible();
    if (kept) await regionShot(card, join(kept, "app-cannot-card.png"));
  } finally {
    for (const app of opened.reverse()) await app.close().catch(() => {});
  }
});
