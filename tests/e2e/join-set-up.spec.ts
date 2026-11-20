import { expect, test } from "@playwright/test";
import * as m from "../../src/shared/i18n/messages.generated";
import { SSH_SERVER_AVAILABLE, startSshServer } from "../helpers/sshServer";
import { launchApp } from "./launch";
import { focusOn } from "./windowKeys";

/**
 * Set up from your first mate's computer, at first launch, from the keyboard (INF-4931's plan,
 * round 3; docs/view.md, "Joining"; docs/keyboard.md, "A new feature"): on a Mac or an x64 Linux
 * computer the chip comes first and is reached with Tab, Enter opens its aside with this
 * computer's address and the wait for its first mate's computer, and Cancel returns to the chips.
 * This computer's account, addresses and SSH server are disposable stand-ins, so the journey reads
 * nothing of the runner's own network identity.
 */

/** This computer as the journey stands it in: a local network address and a private one. */
const LOCAL = "192.168.1.20";
const PRIVATE = "100.86.12.40";
const USER = "sam";

test("set up from the first mate's computer is reached with Tab and opens this computer's address", async () => {
  test.skip(
    process.platform === "win32" || (process.platform === "linux" && process.arch !== "x64"),
    "only a Mac or an x64 Linux computer can be added by its address",
  );
  test.skip(!SSH_SERVER_AVAILABLE, "needs the system's own SSH server to stand this computer's in");
  // This computer's SSH server: a throwaway one on loopback that answers for each of its addresses.
  const sshd = await startSshServer();
  const app = await launchApp({
    env: {
      INFINITARY_STAND_IN_ADDRESSES: `${LOCAL},${PRIVATE}`,
      INFINITARY_STAND_IN_NETWORK_NAME: "sams-mac-mini.local",
      INFINITARY_STAND_IN_USER: USER,
      INFINITARY_STAND_IN_OWN_SSH_PORT: String(sshd.port),
    },
  });
  try {
    const { page } = app;
    const setUp = page.locator("[data-join-set-up-chip]");
    const paste = page.locator("[data-join-chip]");
    await expect(setUp).toHaveText(m.devicesJoinSetUpChip());
    // The new chip sits before Paste its link: one Shift+Tab back from it.
    await focusOn(paste);
    await page.keyboard.press("Shift+Tab");
    await expect(setUp).toBeFocused();
    await page.keyboard.press("Enter");

    const aside = page.locator('[data-join-another-mac="set-up"]');
    await expect(aside).toContainText(m.devicesJoinSetUpHead());
    await expect(aside.locator("[role=status]")).toHaveText(m.devicesJoinSetUpWaiting());
    // The private network address comes first, to type on the other computer, with its Copy.
    await expect(aside.locator("[data-join-set-up-address] code").first()).toHaveText(
      `${USER}@${PRIVATE}`,
    );
    // The stand-in server answered on loopback, so Remote Login reads on, and its key is the line
    // to compare, for the address it answered at.
    await expect(aside.locator('[data-join-remote-login="on"]')).toBeVisible();
    await expect(aside.locator("[data-join-set-up-line]")).toHaveText(/^ED25519 SHA256:/);
    await expect(aside).toContainText(m.devicesJoinSetUpCompare({ address: `${USER}@${PRIVATE}` }));
    // Cancel is reached with Tab, and returns to the chips with the new one first.
    const cancel = aside.getByRole("button", { name: m.devicesJoinCancel(), exact: true });
    for (let press = 0; press < 8; press += 1) {
      if (await cancel.evaluate((button) => button === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(setUp).toBeVisible();
  } finally {
    await app.close();
    await sshd.stop();
  }
});
