import { userInfo } from "node:os";
import { expect, type Page, test } from "@playwright/test";
import { JOIN_RUNS_WORK } from "../../src/renderer/src/devices/viewWords";
import { COMPUTER } from "../../src/shared/deviceNames";
import { computerOf } from "../../src/shared/joinByAddress";
import { addressParts, remoteLoginWords } from "../../src/shared/remoteLogin";
import { scratchDir } from "../helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE, startSshServer } from "../helpers/sshServer";
import { type LaunchedApp, launchApp } from "./launch";
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

test("a fresh app joins another computer's first mate by its address and port, from the keyboard", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the system's own SSH server and client");
  test.setTimeout(120_000);
  // The computer where the first mate lives takes every app that joins it
  // for another computer, as two computers would be.
  const pro = await launchApp({
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" },
  });
  const sshd = await startSshServer();
  // The first time this computer reaches it, it asks the key line.
  sshd.knownHosts("unknown");
  // A home of its own there, so no other Infinitary of this account answers.
  const there = scratchDir("infinitary-e2e-join-there-");
  const ssh = sshd.ssh({
    remote: { HOME: there, CFFIXED_USER_HOME: there, INFINITARY_USER_DATA_DIR: pro.userDataDir },
  });
  let air: LaunchedApp | undefined;
  try {
    air = await launchApp({
      env: { INFINITARY_DEVICE_NAME: "MacBook Air", INFINITARY_SSH: ssh.program },
    });
    const { page } = air;

    // Both chips are reached with Tab; Enter opens the address.
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

    // The paste path's question, naming the computer the address names, then the join.
    const confirm = page.locator('[data-join-another-mac="confirm"]');
    await expect(confirm).toContainText(computerOf(addressParts(typed).address));
    await expect(confirm).toContainText(JOIN_RUNS_WORK);
    await pressKey(confirm.getByRole("button", { name: "Control it from here" }), "Enter");
    await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
    await expect
      .poll(async () =>
        (await pro.page.evaluate(() => window.infinitary.devices.list())).find(
          (device) => device.name === "MacBook Air",
        ),
      )
      .toMatchObject({ kind: "mac", controlling: true, user: userInfo().username });
  } finally {
    await air?.close();
    await sshd.stop();
    await pro.close();
  }
});
