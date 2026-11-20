import { cpSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import {
  DEVICE_SETUP_ACTIONS,
  deviceSetupActions,
  deviceSetupTitle,
} from "../../src/shared/deviceSetup";
import * as m from "../../src/shared/i18n/messages.generated";
import { signInPlace } from "../../src/shared/signIns";
import { workSetupWords } from "../../src/shared/workSetupWords";
import { scratchDir } from "../helpers/scratchDirs";
import { openDevices, selectDevice } from "./deviceFixtures";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import type { Scenario } from "./mockProvider";
import { promptInput } from "./prompt";
import { DEVICE_SETUP_FACTS_ASK, deviceSetupFacts } from "./scenarios/deviceSetupFacts";
import { type ServiceManagerStandIn, serviceManagerStandIn } from "./serviceManagerStandIn";
import { shownCard } from "./stack";
import { pressKey, typeInto } from "./windowKeys";

/**
 * A Mac that joins with its window sets its work up by itself, and says why
 * when it cannot (docs/view.md, "A Mac that runs work"; docs/devices.md, "A
 * Mac that has not finished setting up"). The captain's ask (INF-4835): "Set
 * it up again by itself, and say why when it still cannot".
 *
 * Promised result: the system refuses the background once; the joining
 * window's notice names that reason, the home's Devices row names it with
 * Fix it, and Try again on the window, pressed from the keyboard, brings the
 * work into reach. Data: two hermetic launches on this computer, the home
 * taking the other as another Mac's, and a stand-in for the joining
 * account's service manager that refuses one start and then really runs
 * the work it is given (tests/e2e/serviceManagerStandIn.ts), so no test
 * loads a real agent. Completion: the home lists that Mac's work in reach.
 * Platform: any system the stand-in plays (launchd or systemd). Shared
 * resources: none beyond the two launches' own folders.
 */

let standIn: ServiceManagerStandIn | null = null;
const opened: LaunchedApp[] = [];
test.afterEach(async () => {
  const testInfo = test.info();
  for (const app of opened.splice(0).reverse()) await app.close();
  standIn?.stopAll();
  // A failed run keeps the service manager's records and each command's output with its results.
  if (standIn && testInfo.status !== testInfo.expectedStatus)
    cpSync(standIn.dir, testInfo.outputPath("service-manager"), { recursive: true });
  standIn = null;
});

async function joinWithWorkRefused(scenarios?: Scenario[]) {
  const pro = await launchApp({
    ...(scenarios ? { withMockProvider: true, scenarios } : {}),
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" },
  });
  opened.push(pro);
  const airHome = scratchDir("infinitary-e2e-work-setup-home-");
  standIn = serviceManagerStandIn(airHome);
  // The system refuses the first start, as macOS does while Login Items keeps Infinitary out.
  standIn.refuseStarts(1);
  const air = await launchApp({
    homeDir: airHome,
    env: {
      ...standIn.env,
      INFINITARY_DEVICE_NAME: "MacBook Air",
      INFINITARY_HELPER_DATA_DIR: join(scratchDir("infinitary-e2e-work-setup-work-"), "work"),
    },
  });
  opened.push(air);

  const { link } = await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
  await air.page.evaluate((text) => {
    // The window starts over as the other Mac's, so the answer may never come back.
    void window.infinitary.devices.join(text);
  }, link);
  await expect(air.page.locator("[data-remote-control]")).toHaveAttribute(
    "data-remote-control",
    "in-reach",
  );
  const deviceId = new JoinedHome(join(air.userDataDir, "joined"), () => {}).read()?.grant.deviceId;
  if (!deviceId) throw new Error("The joining window kept no grant.");

  return { pro, air, deviceId };
}

test("a Mac whose background was refused says why on both computers, and Try again brings its work into reach", async () => {
  test.setTimeout(180_000);
  const { pro, air, deviceId } = await joinWithWorkRefused();

  // The joining window says why, with Not now and one way to check again.
  const notice = air.page.locator('[data-work-setup-notice="background-off"]');
  await expect(notice).toBeVisible();
  const tryAgain = notice.getByRole("button", { name: m.viewWorkTryAgain(), exact: true });
  await expect(notice.getByRole("button")).toHaveCount(2);
  await expect(tryAgain).toBeVisible();

  // The home's row says the same reason instead of a bare out of reach, with Fix it.
  await openDevices(pro.page);
  const row = await selectDevice(pro.page, deviceId);
  await expect(row.locator('[data-device-work-setup="background-off"]')).toBeVisible();
  await expect(row.locator(`[data-device-fix-work="${deviceId}"]`)).toBeVisible();

  // Try again, from the keyboard: the second start runs, and the work reaches the home.
  await pressKey(tryAgain, "Enter");
  await expect(air.page.locator("[data-work-setup-notice]")).toHaveCount(0);
  await expect(row.locator("[data-device-work-setup]")).toHaveCount(0);
  await expect
    .poll(async () =>
      pro.page.evaluate(
        async (id) =>
          (await window.infinitary.devices.list()).find((device) => device.id === id)?.inReach,
        deviceId,
      ),
    )
    .toBe(true);
});

// INF-4835 piece 2: watch the same blocked work transition through all three setup surfaces.
test("setup names the work wait, and sign-in choices return after Fix it in Intelligence", async () => {
  test.setTimeout(180_000);
  let read: string | undefined;
  const { pro, deviceId } = await joinWithWorkRefused([
    deviceSetupFacts((value) => {
      read = value;
    }),
  ]);
  const { page } = pro;
  const place = signInPlace({ name: "MacBook Air", onThisMac: false });
  const title = deviceSetupTitle(place);
  const card = shownCard(page, title);
  const body = cardBody(card, title);
  const reason = workSetupWords(place.label, { state: "blocked", reason: "background-off" });
  if (!reason) throw new Error("The background-off reason has no words");
  const waitingActions = deviceSetupActions({
    deviceId,
    place,
    reach: "out-of-reach",
    waitReason: reason,
    signIns: null,
    runs: [],
  });
  const footer = card.locator("[data-card-actions]");
  await expect(card).toBeVisible();
  await expect(body.locator('[data-setup-wait="work"]')).toHaveText(reason);
  await expect(footer.getByRole("button")).toHaveCount(waitingActions.length);
  for (const { label } of waitingActions)
    await expect(footer.getByRole("button", { name: label, exact: true })).toBeVisible();

  const input = promptInput(page);
  await typeInto(input, DEVICE_SETUP_FACTS_ASK);
  await pressKey(input, "Enter");
  await expect.poll(() => read).toBeDefined();
  const facts = JSON.parse(read ?? "[]");
  expect(
    facts.find((line: { action: string }) => line.action === "device-sign-in")?.current.computers,
  ).toContainEqual(
    expect.objectContaining({
      deviceId,
      windowConnected: true,
      reach: "out-of-reach",
      reportedSignIns: false,
      workSetup: { state: "blocked", reason: "background-off" },
      workWait: reason,
    }),
  );

  await openDevices(page);
  await page.getByRole("tab", { name: m.panelSettingsIntegrations(), exact: true }).click();
  const forge = page.locator(`[data-device-forge-wait="${deviceId}"]`);
  await expect(forge).toContainText(reason);
  await expect(forge.getByRole("button")).toHaveCount(0);

  await page.getByRole("tab", { name: m.panelSettingsIntelligence(), exact: true }).click();
  const wait = page.locator(`[data-device-sign-in-wait="${deviceId}"]`);
  await expect(wait).toContainText(reason);
  await pressKey(wait.getByRole("button"), "Enter");
  await expect(wait).toHaveCount(0);
  const group = page.locator(`[data-device-sign-ins="${deviceId}"]`);
  await expect(group.locator("[data-subscriptions-list]")).toBeVisible();

  await page.getByRole("tab", { name: m.panelSettingsIntegrations(), exact: true }).click();
  await expect(forge).toHaveCount(0);
  await expect(page.locator(`[data-device-forge-row="${deviceId}"]`).first()).toBeVisible();
  await pressKey(
    page.getByRole("tab", { name: m.panelSettingsIntegrations(), exact: true }),
    "Escape",
  );
  await expect(body.locator('[data-setup-row="github"]')).toBeVisible();
  const report = (await page.evaluate(() => window.infinitary.devices.signIns())).find(
    (device) => device.deviceId === deviceId,
  );
  const github = deviceSetupActions({
    deviceId,
    place,
    reach: "in-reach",
    waitReason: null,
    signIns: report?.signIns ?? null,
    runs: [],
  }).find(({ id }) => id === DEVICE_SETUP_ACTIONS.github);
  if (!github) throw new Error("The connected computer did not offer a GitHub sign-in");
  await expect(footer.getByRole("button", { name: github.label, exact: true })).toBeVisible();
});
