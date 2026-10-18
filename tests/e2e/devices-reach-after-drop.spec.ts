import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { shellWord } from "@core/devices/joinCommand";
import { type HelperRun, startHelper } from "@core/helper/run";
import { catalogRefreshesSettled } from "@core/pi/modelRuntime";
import { expect, type Page, test } from "@playwright/test";
import { type DeviceView, deviceLabel } from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import { sshConnectionWords } from "@shared/sshConnection";
import electronPath from "electron";
import { COMPUTER } from "../../src/shared/deviceNames";
import { scratchDir } from "../helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE, startSshServer } from "../helpers/sshServer";
import { standInFirstmate } from "../helpers/standInFirstmate";
import { builtAppDir, type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { pressKey, typeInto } from "./windowKeys";

/**
 * Captain, INF-318: "my wifi went down for a bit, but now this screen shows a
 * conflicting state". An update refused while a computer did not answer must
 * not stay above that computer's row once the row says it is connected again.
 * The other computer is a throwaway SSH server on loopback; the drop is its
 * processes frozen (SIGSTOP), so nothing answers and nothing is refused on
 * the wire, then thawed (SIGCONT).
 */

const BUILDER = { name: "builder", uid: (process.getuid?.() ?? userInfo().uid) + 1000 };

async function openDevices(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Devices", exact: true }).click();
  await expect(page.locator("[data-devices]")).toBeVisible();
}

async function addByAddress(page: Page, address: string): Promise<DeviceView> {
  await pressKey(page.locator('[data-device-add="mac"]'), "Enter");
  await pressKey(page.getByRole("button", { name: "By its address", exact: true }), "Enter");
  await typeInto(page.locator("[data-device-address-question]").getByRole("textbox"), address);
  await page.keyboard.press("Enter");
  const check = page.locator("[data-device-confirm-question]");
  await expect(check).toBeVisible({ timeout: 30_000 });
  await pressKey(
    check.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true }),
    "Enter",
  );
  await expect
    .poll(async () => (await page.evaluate(() => window.infinitary.devices.list())).length)
    .toBe(1);
  await expect(page.locator("[data-device-adding]")).toHaveCount(0);
  const [device] = await page.evaluate(() => window.infinitary.devices.list());
  if (!device) throw new Error("Nothing joined.");
  return device;
}

test("an update refused while a computer did not answer is not still said once its row says connected", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  test.setTimeout(6 * 60_000);
  process.env.PI_OFFLINE = "1";

  const sshd = await startSshServer();
  const record = join(scratchDir("infinitary-e2e-remote-record-"), "started");
  const them = scratchDir("infinitary-e2e-remote-user-");
  const work = join(them, "work");
  const ssh = sshd.ssh({
    remote: {
      HOME: them,
      CFFIXED_USER_HOME: them,
      INFINITARY_HELPER_DATA_DIR: work,
      INFINITARY_DEVICE_NAME: "Mac mini",
      ELECTRON_RENDERER_URL: "",
      PI_OFFLINE: "1",
    },
  });
  const builtApp = join(scratchDir("infinitary-e2e-remote-app-"), "firstmate");
  writeFileSync(
    builtApp,
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
    { mode: 0o755 },
  );
  const bundle = standInFirstmate(record, BUILDER.uid, {
    joined: "running",
    updated: "running",
    connect: builtApp,
  });
  const app: LaunchedApp = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_SSH: ssh.program, INFINITARY_APP_BUNDLE: bundle },
  });
  const runs: HelperRun[] = [];
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1280, height: 900 });
    await openDevices(page);
    const device = await addByAddress(page, sshd.address);
    const label = deviceLabel(device);

    // Its run there is on an older Infinitary, as the Mac mini's 0.4.2-alpha.2 is, so Update shows.
    const started = startHelper({
      dataDir: work,
      say: () => {},
      retryMs: [50],
      log: () => {},
      appVersion: "0.0.1",
    });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    await expect.poll(() => started.run.state().contact, { timeout: 60_000 }).toBe("in-reach");

    const row = page.locator(`[data-device-row="${device.id}"]`);
    const sshState = async () =>
      (await page.evaluate(() => window.infinitary.devices.list()))[0]?.ssh;
    const connected = sshConnectionWords.detail({ state: "connected" }, device);
    await expect.poll(sshState, { timeout: 60_000 }).toEqual({ state: "connected" });
    await expect(row).toContainText(connected);
    const update = row.getByRole("button", { name: `Update ${label}`, exact: true });
    await expect(update).toBeVisible();
    const problem = page.locator('[data-settings-error="devices"]');
    await expect(problem).toHaveCount(0);

    // The Wi-Fi drops: the other computer stops answering, with no refusal on the wire.
    sshd.freeze();

    // Update, clicked while it does not answer.
    await update.click();
    const [reachLine, reachTodo] = remoteLoginWords.refused("unreachable", {
      address: sshd.address,
      doing: "update",
    });
    await expect(problem).toContainText(reachLine, { timeout: 90_000 });
    await expect(problem).toContainText(reachTodo);

    // The Wi-Fi is back: the same computer answers again.
    sshd.thaw();
    await expect.poll(sshState, { timeout: 180_000, intervals: [1000] }).toEqual({
      state: "connected",
    });
    await expect(row).toContainText(connected, { timeout: 30_000 });

    // The failing check: once the row says it is connected, the tab no longer says it could not be reached.
    await expect(
      problem,
      "the tab still says it could not reach a computer whose row says connected",
    ).toHaveCount(0, {
      timeout: 5_000,
    });
  } finally {
    sshd.thaw();
    await Promise.all(runs.map((each) => each.stop()));
    await catalogRefreshesSettled();
    await app.close();
    await app.mockProvider?.close();
    await sshd.stop();
  }
});
