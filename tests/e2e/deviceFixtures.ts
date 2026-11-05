import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { shellWord } from "@core/devices/joinCommand";
import { expect, type Page } from "@playwright/test";
import type { DeviceView } from "@shared/devices";
import type { WorkOutcome } from "@shared/remoteLogin";
import electronPath from "electron";
import { appPathsFor } from "../../src/core/paths";
import { COMPUTER } from "../../src/shared/deviceNames";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { startSshServer } from "../helpers/sshServer";
import { standInFirstmate } from "../helpers/standInFirstmate";
import { type HelperRun, startHelper } from "./helperRun";
import { builtAppDir, type LaunchedApp, launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { pressKey, typeInto } from "./windowKeys";

/**
 * What the Devices journeys share (docs/devices.md): Settings -> Devices and
 * the first mate's cards for it, this Mac moved to another port, a computer
 * that runs work in the background, the other Mac over Remote Login, and
 * + A Mac by its address. `devices.spec.ts`, `devices-links.spec.ts`,
 * `devices-command.spec.ts`, `devices-address.spec.ts` and
 * `devices-ssh.spec.ts` import this file, and a change to the devices core
 * selects each of them (`scripts/affected-journeys.ts`).
 */

export async function ask(page: Page, action: string, value: unknown) {
  const input = promptInput(page);
  await input.fill(APP_CATALOG_PROMPT_MARKER + JSON.stringify({ action, value }));
  await input.press("Enter");
}

export const linkInTab = (page: Page) =>
  page.locator('[data-panel-state="open"] [data-device-link]');

export const BUILDER = { name: "builder", uid: (process.getuid?.() ?? userInfo().uid) + 1000 };

/** Settings -> Devices, opened from the window's own Settings. */
export async function openDevices(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Devices", exact: true }).click();
  await expect(page.locator("[data-devices]")).toBeVisible();
}

/**
 * This Mac's address changes: the app quits and starts again on the same
 * data, answering at another port, where a link made now sends a device.
 */
export async function moveThisMac(app: LaunchedApp, env: Record<string, string> = {}) {
  const { userDataDir, homeDir, mockProvider } = app;
  await app.close();
  return launchApp({
    userDataDir,
    homeDir,
    ...(mockProvider ? { reuseMockProvider: mockProvider } : {}),
    env: { ...env, INFINITARY_CONNECTION_LOOPBACK_PORT: String(await claimedPort()) },
  });
}

/** A computer that runs work, as the work mode runs it in the background, from its data folder. */
export function workRuns(runs: HelperRun[], dataDir: string) {
  return () => {
    const started = startHelper({ dataDir, say: () => {}, retryMs: [50], log: () => {} });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    return started.run;
  };
}

/**
 * The other Mac, reached over Remote Login: a throwaway SSH server on
 * loopback, a user there with a home of its own and the work folder its
 * Firstmate keeps, and the Firstmate this Mac sends, a stand-in that joins at
 * the wire and keeps its grant, whose controller is the built app's own.
 * `env` is what this Mac's app runs with to reach it; `removed` is what
 * removing it there answers.
 */
export async function otherMacOverSsh(
  removed?: WorkOutcome,
  startGate?: { when: "update" | "join"; ready: string; resume: string },
) {
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
    ...(removed ? { removed } : {}),
    ...(startGate ? { startGate } : {}),
  });
  return {
    sshd,
    them,
    work,
    bundle,
    env: { INFINITARY_SSH: ssh.program, INFINITARY_APP_BUNDLE: bundle },
  };
}

/** + A Mac, by its address, from the keyboard, in Devices: answers it once it joined. */
export async function addByAddress(
  page: Page,
  address: string,
  timeout = 5_000,
): Promise<DeviceView> {
  await pressKey(page.locator('[data-device-add="mac"]'), "Enter");
  await pressKey(page.getByRole("button", { name: "By its address", exact: true }), "Enter");
  // The question takes the caret once it has drawn.
  await typeInto(
    page
      .locator("[data-device-address-question]")
      .getByLabel(`The other ${COMPUTER.one}'s address`),
    address,
  );
  await page.keyboard.press("Enter");
  const check = page.locator("[data-device-confirm-question]");
  await expect(check).toBeVisible();
  await pressKey(
    check.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true }),
    "Enter",
  );
  await expect
    .poll(async () => (await page.evaluate(() => window.infinitary.devices.list())).length, {
      timeout,
    })
    .toBe(1);
  await expect(page.locator("[data-device-adding]")).toHaveCount(0);
  await expect(page.locator("[data-device-address-question]")).toHaveCount(0);
  const [device] = await page.evaluate(() => window.infinitary.devices.list());
  if (!device) throw new Error("Nothing joined.");
  return device;
}

/**
 * INF-2394 measure 4: a paired Mac reached from elsewhere keeps its real pairing plus its dialed address.
 * @journey-area src/core/devices/pairing.ts
 * @journey-area src/core/devices/locality.ts
 */
export function seedRemotePairing(userDataDir: string, deviceId: string, address: string): void {
  const devicesDir = appPathsFor(userDataDir).devicesDir;
  const file = join(devicesDir, "devices.json");
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    devices: { id: string; onThisMac?: boolean }[];
  };
  for (const entry of saved.devices) if (entry.id === deviceId) entry.onThisMac = false;
  writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  writeFileSync(
    join(devicesDir, "reached.json"),
    JSON.stringify({ version: 1, reached: { [deviceId]: address } }),
    { mode: 0o600 },
  );
}
