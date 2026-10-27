import { JoinedHome } from "@core/devices/joinedHome";
import { joinHome } from "@core/helper/join";
import { expect, test } from "@playwright/test";
import { automaticStartupWords } from "@shared/devices";
import { sshConnectionWords } from "@shared/sshConnection";
import { scratchDir } from "../helpers/scratchDirs";
import { type HelperRun, startHelper } from "./helperRun";
import { launchApp } from "./launch";

// INF-1617, approved INF-1575: a command join without supported startup keeps
// its grant, reports the fact before exiting, and explicit work can start/stop.
// Fixture: the recorded Ubuntu container outcome, real pairing/connection/UI,
// isolated HOME/data and a mock provider. No real startup configuration or shared
// account is touched. Completion: retained device/identity, capability unchanged,
// reachability follows the worker; the row never promises a next login.
test("unsupported startup keeps the join while explicit work starts and stops independently", async () => {
  const app = await launchApp({ withMockProvider: true });
  let worker: HelperRun | undefined;
  try {
    const { page } = app;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Devices", exact: true }).click();
    await page.locator('[data-device-add="mac"]').click();
    await page
      .getByRole("button", { name: "Paste a link into Infinitary there", exact: true })
      .click();
    const link = await page.locator('[data-panel-state="open"] [data-device-link]').textContent();
    const dataDir = scratchDir("infinitary-unsupported-startup-");
    const said: string[] = [];
    const outcome = await joinHome({
      text: link ?? "",
      dataDir,
      timeoutMs: 2_000,
      device: { name: "ubuntu-box", user: { name: "sam", uid: 1000 } },
      io: { ask: async () => "yes", say: (lines) => said.push(...lines) },
      background: async () => "unavailable",
    });
    expect(outcome).toMatchObject({ ok: true, background: "unavailable" });
    const joined = new JoinedHome(dataDir, () => {}).read()!;
    const row = page.locator(`[data-device-row="${joined.grant.deviceId}"]`);
    await expect(row).toContainText(automaticStartupWords.unavailable);
    await expect(row).toContainText(automaticStartupWords.guidance);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.devices.list())).find(
            (device) => device.name === "ubuntu-box",
          )?.inReach,
      )
      .toBe(false);
    expect(said.join(" ")).toContain("The join remains.");
    const started = startHelper({ dataDir, say: () => {} });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("Explicit worker did not start");
    worker = started.run;
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.devices.list())).find(
            (device) => device.id === joined.grant.deviceId,
          )?.inReach,
      )
      .toBe(true);
    await expect(row).toContainText(automaticStartupWords.unavailable);
    await worker.stop();
    worker = undefined;
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.devices.list())).find(
            (device) => device.id === joined.grant.deviceId,
          )?.inReach,
      )
      .toBe(false);
    await expect(row).toContainText(automaticStartupWords.unavailable);
    expect(new JoinedHome(dataDir, () => {}).read()?.grant.deviceId).toBe(joined.grant.deviceId);
    await expect(row).not.toContainText(
      sshConnectionWords.detail(
        { state: "at-login" },
        {
          name: "ubuntu-box",
          user: "sam",
          onThisMac: false,
        },
      ),
    );
  } finally {
    await worker?.stop();
    await app.close();
  }
});
