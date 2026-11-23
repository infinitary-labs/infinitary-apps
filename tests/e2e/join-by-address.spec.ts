import { cpSync } from "node:fs";
import { userInfo } from "node:os";
import { expect, type Page, test } from "@playwright/test";
import { JOIN_RUNS_WORK } from "../../src/renderer/src/devices/viewWords";
import { runLabelOf } from "../../src/shared/codeNames";
import { COMPUTER } from "../../src/shared/deviceNames";
import { computerOf } from "../../src/shared/joinByAddress";
import { addressParts, remoteLoginWords } from "../../src/shared/remoteLogin";
import { scratchDir } from "../helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE, type SshServer, startSshServer } from "../helpers/sshServer";
import { type LaunchedApp, launchApp } from "./launch";
import { type ServiceManagerStandIn, serviceManagerStandIn } from "./serviceManagerStandIn";
import { focusOn, pressKey, typeInto } from "./windowKeys";

/**
 * Joining by its address at first launch (INF-1827; docs/view.md, "Joining
 * by its address"): a fresh app signs in to the computer its first mate is
 * on with the person's own SSH, asks the Infinitary open there for a link,
 * and joins as a pasted link does, every step from the keyboard. Both apps
 * run on this computer; a throwaway SSH server on loopback stands in for
 * that computer's Remote Login, and every session it runs reads the first
 * app's data folder, as that account's own login would find its app.
 */

const topLine = (page: Page) => page.locator("[data-remote-control]");

async function joinByItsAddress(page: Page, sshd: SshServer): Promise<void> {
  const paste = page.locator("[data-join-chip]");
  const byAddress = page.locator("[data-join-address-chip]");
  await focusOn(paste);
  await page.keyboard.press("Tab");
  await expect(byAddress).toBeFocused();
  await page.keyboard.press("Enter");
  const aside = page.locator('[data-join-another-mac="address"]');
  await typeInto(aside.locator("#join-address"), sshd.address);
  await page.keyboard.press("Tab");
  await typeInto(aside.locator("#join-port"), String(sshd.port));
  await page.keyboard.press("Enter");

  // The key line, with Cancel holding the caret; the yes is one Shift+Tab away.
  const typed = `ssh://${sshd.address}:${sshd.port}`;
  const key = page.locator("[data-join-key]");
  await expect(key).toContainText(remoteLoginWords.confirmQuestion(typed)[0]);
  await expect(key.locator("[data-join-key-line]")).toContainText("ED25519 SHA256:");
  await expect(key.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await pressKey(
    key.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true }),
    "Enter",
  );

  const confirm = page.locator('[data-join-another-mac="confirm"]');
  await expect(confirm).toContainText(computerOf(addressParts(typed).address));
  await expect(confirm).toContainText(JOIN_RUNS_WORK);
  await pressKey(confirm.getByRole("button", { name: "Control it from here" }), "Enter");
  await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
}

async function listsJoined(pro: LaunchedApp, name: string): Promise<void> {
  await expect
    .poll(async () =>
      (await pro.page.evaluate(() => window.infinitary.devices.list())).find(
        (device) => device.name === name,
      ),
    )
    .toMatchObject({ kind: "mac", controlling: true, user: userInfo().username });
}

/**
 * A throwaway SSH server standing in for the first mate's computer, whose
 * sessions read that app's data folder, and the ssh this computer starts.
 */
async function sshToward(pro: LaunchedApp): Promise<{ sshd: SshServer; program: string }> {
  const sshd = await startSshServer();
  // The first time this computer reaches it, it asks the key line.
  sshd.knownHosts("unknown");
  // A home of its own there, so no other Infinitary of this account answers.
  const there = scratchDir("infinitary-e2e-join-there-");
  const ssh = sshd.ssh({
    remote: { HOME: there, CFFIXED_USER_HOME: there, INFINITARY_USER_DATA_DIR: pro.userDataDir },
  });
  return { sshd, program: ssh.program };
}

test("a fresh app joins another computer's first mate by its address and port, from the keyboard", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the system's own SSH server and client");
  test.setTimeout(120_000);
  // The computer where the first mate lives takes every app that joins it
  // for another computer, as two computers would be.
  const pro = await launchApp({
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" },
  });
  const { sshd, program } = await sshToward(pro);
  let air: LaunchedApp | undefined;
  try {
    air = await launchApp({
      env: { INFINITARY_DEVICE_NAME: "MacBook Air", INFINITARY_SSH: program },
    });
    await joinByItsAddress(air.page, sshd);
    await listsJoined(pro, "MacBook Air");
  } finally {
    await air?.close();
    await sshd.stop();
    await pro.close();
  }
});

let standIn: ServiceManagerStandIn | null = null;
test.afterEach(() => {
  const testInfo = test.info();
  standIn?.stopAll();
  // A failed run keeps the service manager's records and the command's output with its results.
  if (standIn && testInfo.status !== testInfo.expectedStatus)
    cpSync(standIn.dir, testInfo.outputPath("service-manager"), { recursive: true });
  standIn = null;
});

/**
 * An installed app's first launch (INF-4935; docs/run.md, "The window starts
 * it" and "Joining another computer"): its window starts the first mate in
 * a command of its own and opens beside it, so the command's first mate,
 * which keeps this computer's SSH trust, asks the other computer for the
 * link. Data: two throwaway data folders, the SSH server above, and a
 * stand-in for this account's service manager that really runs the command
 * (tests/e2e/serviceManagerStandIn.ts). Completion: the window controls the
 * first mate there, that computer lists it, and the service manager no
 * longer runs the command, which nothing starts again.
 */
test("a first launch beside the command its window started joins another computer by its address", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the system's own SSH server and client");
  test.setTimeout(180_000);
  const pro = await launchApp({
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" },
  });
  const { sshd, program } = await sshToward(pro);
  const homeDir = scratchDir("infinitary-e2e-join-beside-home-");
  const manager = serviceManagerStandIn(homeDir);
  standIn = manager;
  const label = runLabelOf("dev");
  let air: LaunchedApp | undefined;
  try {
    air = await launchApp({
      homeDir,
      env: {
        ...manager.env,
        INFINITARY_WINDOW_STARTS_RUN: "1",
        INFINITARY_DEVICE_NAME: "MacBook Air",
        INFINITARY_SSH: program,
      },
    });
    const { page } = air;
    // The window stands beside the command it started, which welcomes it, which on a busy
    // runner takes seconds, before the person asks anything of it.
    expect(await page.evaluate(() => window.infinitary.devices.thisMac())).toMatchObject({
      role: "home",
      byCommand: true,
    });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.infinitary.devices.list().then(
              () => true,
              () => false,
            ),
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(manager.runs(label)).toHaveLength(1);

    await joinByItsAddress(page, sshd);
    await listsJoined(pro, "MacBook Air");
    // Joining stopped this computer's own first mate and let its agent go, so nothing starts it again.
    await expect.poll(() => manager.running(label)).toBe(false);
    expect(manager.runs(label)).toHaveLength(1);
  } finally {
    await air?.close();
    await sshd.stop();
    await pro.close();
  }
});
