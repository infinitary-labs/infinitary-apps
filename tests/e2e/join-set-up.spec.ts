import { expect, test } from "@playwright/test";
import { COMPUTER, HERE } from "../../src/shared/deviceNames";
import * as m from "../../src/shared/i18n/messages.generated";
import { launchApp } from "./launch";
import { focusOn } from "./windowKeys";

/**
 * Set up from your first mate's computer, at first launch, from the keyboard (INF-4931's plan,
 * round 3; docs/view.md, "Joining"; docs/keyboard.md, "A new feature"): on a Mac or an x64 Linux
 * computer the chip comes first and is reached with Tab, Enter opens its aside with this
 * computer's address and the wait for its first mate's computer, and Cancel returns to the chips.
 */

test("set up from the first mate's computer is reached with Tab and opens this computer's address", async () => {
  test.skip(
    process.platform === "win32" || (process.platform === "linux" && process.arch !== "x64"),
    "only a Mac or an x64 Linux computer can be added by its address",
  );
  const app = await launchApp({});
  try {
    const { page } = app;
    const setUp = page.locator("[data-join-set-up-chip]");
    const paste = page.locator("[data-join-chip]");
    await expect(setUp).toHaveText(m.devicesJoinSetUpChip({ computer: COMPUTER.one }));
    // The new chip sits before Paste its link: one Shift+Tab back from it.
    await focusOn(paste);
    await page.keyboard.press("Shift+Tab");
    await expect(setUp).toBeFocused();
    await page.keyboard.press("Enter");

    const aside = page.locator('[data-join-another-mac="set-up"]');
    await expect(aside).toContainText(
      m.devicesJoinSetUpHead({ here: HERE.this, computer: COMPUTER.one }),
    );
    await expect(aside.locator("[role=status]")).toHaveText(
      m.devicesJoinSetUpWaiting({ computer: COMPUTER.one }),
    );
    // This computer's own address is there to type on the other computer, each with its Copy.
    await expect(aside.locator("[data-join-set-up-address]").first()).toBeVisible();
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
});
