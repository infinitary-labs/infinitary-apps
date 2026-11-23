import { expect, test } from "@playwright/test";
import * as m from "../../src/shared/i18n/messages.generated";
import { SSH_SERVER_AVAILABLE, startSshServer } from "../helpers/sshServer";
import { chooseWhereFirstMateLives } from "./firstLaunch";
import { launchApp } from "./launch";
import { focusOn } from "./windowKeys";

/**
 * Set up from your first mate's computer, at first launch, from the keyboard (INF-4931's plan,
 * round 3; docs/view.md, "Joining"; docs/keyboard.md, "A new feature"): on a Mac or an x64 Linux
 * computer the chip comes first and is reached with Tab, Enter opens its aside with this
 * computer's address and the wait for its first mate's computer, and Cancel returns to the chips.
 * This computer's account, addresses and SSH server are disposable stand-ins, and its clipboard a
 * private one, so the journey reads nothing of the runner's own network identity or clipboard. It
 * proves the window's side alone, on this computer's own SSH server: no first mate's computer adds
 * this one, and the window following along after an add is the shell's own tests'
 * (`src/main/shell.test.ts`, `src/main/shell.beside.test.ts`).
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
  // The server is released however the app's launch or close ends.
  try {
    await setUpJourney(sshd.port);
  } finally {
    await sshd.stop();
  }
});

async function setUpJourney(sshPort: number): Promise<void> {
  const app = await launchApp({
    env: {
      INFINITARY_STAND_IN_ADDRESSES: `${LOCAL},${PRIVATE}`,
      INFINITARY_STAND_IN_NETWORK_NAME: "sams-mac-mini.local",
      INFINITARY_STAND_IN_USER: USER,
      INFINITARY_STAND_IN_OWN_SSH_PORT: String(sshPort),
    },
  });
  try {
    const { page } = app;
    await chooseWhereFirstMateLives(page, "running");
    const setUp = page.locator("[data-join-set-up-chip]");
    const paste = page.locator("[data-join-chip]");
    await expect(setUp).toHaveText(m.devicesJoinSetUpChip());
    // A private clipboard, so the journey neither reads nor changes the runner's own.
    await page.evaluate(() => {
      const writes: string[] = [];
      (window as unknown as { __copied: string[] }).__copied = writes;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => void writes.push(text) },
      });
    });
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
    // Focus lands on the first address's Copy, and Enter copies that address.
    const copy = aside
      .locator("[data-join-set-up-address]")
      .first()
      .getByRole("button", { name: m.devicesJoinSetUpCopy(), exact: true });
    await expect(copy).toBeFocused();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied))
      .toEqual([`${USER}@${PRIVATE}`]);
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
  }
}
