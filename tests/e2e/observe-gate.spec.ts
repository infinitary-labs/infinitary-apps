import { expect, type Page, test } from "@playwright/test";
import { OBSERVE_DISABLED_MESSAGE } from "../../src/core/observe/gate";
import { observeBody, observeElement } from "./frames";
import { launchApp } from "./launch";

/**
 * Observe's gate (docs/dev-observe.md, "Hard gate") through installed
 * builds: an alpha offers the Settings tab and answers its reads with no
 * environment flag, and a stable build offers no tab and refuses a read
 * asked directly. The emulated installed build reports the version the
 * launcher stamps (`launchApp` `version`), the fact the gate reads.
 */

const STABLE = "0.1.30";
const ALPHA = "0.1.31-alpha.4";

/** The session list read asked directly, past every surface: the ids it lists, or the refusal's words. */
function readSessions(page: Page) {
  return page.evaluate(() =>
    window.infinitary.plugins.read("observe.sessions", {}).then(
      (sessions) => ({ listed: sessions.map((session) => session.id) }),
      (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
    ),
  );
}

function settingsTabs(page: Page) {
  return page.getByRole("tablist", { name: "Settings sections" });
}

test("an installed alpha offers Observe in Settings with the Firstmate's session", async () => {
  const launched = await launchApp({ withMockProvider: true, packaged: true, version: ALPHA });
  const { page } = launched;
  try {
    expect(await page.evaluate(() => window.infinitary.observe.enabled())).toEqual({
      enabled: true,
    });
    expect(await readSessions(page)).toEqual({ listed: expect.arrayContaining(["firstmate"]) });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const tab = settingsTabs(page).getByRole("tab", { name: "Observe", exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(observeElement(page)).toBeVisible();
    const frame = observeBody(page);
    await expect(frame.locator('[data-observe-session="firstmate"]')).toBeVisible();
    await expect(frame.locator("[data-observe-detail]")).toContainText("First mate");
  } finally {
    await launched.close();
  }
});

test("an installed stable build offers no Observe tab and refuses its reads", async () => {
  const launched = await launchApp({ withMockProvider: true, packaged: true, version: STABLE });
  const { page } = launched;
  try {
    expect(await page.evaluate(() => window.infinitary.observe.enabled())).toEqual({
      enabled: false,
    });
    expect(await readSessions(page)).toEqual({
      refused: expect.stringContaining(OBSERVE_DISABLED_MESSAGE),
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const tabs = settingsTabs(page);
    // Devices is gated by an answer from the core too; once it shows, Observe's has come back.
    await expect(tabs.getByRole("tab", { name: "Devices", exact: true })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Observe", exact: true })).toHaveCount(0);
    await expect(observeElement(page)).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
