import { expect, test } from "@playwright/test";
import * as m from "../../src/shared/i18n/messages.generated";
import { launchApp } from "./launch";
import { projectSettings } from "./projects";
import { focusOn, pressKey, pressWindowKey } from "./windowKeys";

/**
 * The captain's ask: a project's settings open on a page of their own, not
 * inline in an open row, and every feature works from the keyboard. A person
 * opens a project of two repositories from its line, moves between the
 * repositories' tabs with the arrows, chooses one with Enter, and goes back
 * to the list and out of Settings with Escape. Its data is two disposable
 * repositories made in the launcher's private home; completion is focus and
 * which repository's settings the page shows.
 */
test("a project's page opens, moves between its repositories and goes back by keys alone", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    const { repo: wallet } = await page.evaluate(() =>
      window.infinitary.repos.setup({ kind: "init", name: "wallet", key: "WAL" }),
    );
    const { repo: api } = await page.evaluate(() =>
      window.infinitary.repos.setup({ kind: "init", name: "wallet-api", project: "WAL" }),
    );

    await pressWindowKey(app, ",", ["meta"]);
    const projectsTab = page.locator('[role="tab"][id$="-tab-projects"]');
    await focusOn(projectsTab);
    await pressKey(projectsTab, "Enter");

    // Enter on the project's line opens its page, with focus on Back.
    const line = page.locator('[data-project-group="WAL"]').getByRole("button");
    await pressKey(line, "Enter");
    const back = page.locator("[data-project-back]");
    await expect(back).toBeFocused();
    await expect(back).toHaveText(m.settingsProjectsLabel());
    await expect(projectSettings(page, wallet.id)).toBeVisible();

    // The strip of tabs is one Tab stop after the project's Name, on the chosen tab.
    const walletTab = page.locator(`[data-repository-tab="${wallet.id}"]`);
    const apiTab = page.locator(`[data-repository-tab="${api.id}"]`);
    const name = page
      .locator("[data-project-box]")
      .getByLabel(m.settingsProjectsNameLabel(), { exact: true });
    await pressKey(name, "Tab");
    await expect(walletTab).toBeFocused();
    await expect(walletTab).toHaveAttribute("aria-selected", "true");

    // The arrows move between tabs without choosing; Enter chooses.
    await pressKey(walletTab, "ArrowRight");
    await expect(apiTab).toBeFocused();
    await expect(walletTab).toHaveAttribute("aria-selected", "true");
    await pressKey(apiTab, "Enter");
    await expect(apiTab).toHaveAttribute("aria-selected", "true");
    await expect(projectSettings(page, api.id)).toBeVisible();
    await expect(projectSettings(page, wallet.id)).toHaveCount(0);

    // Tab leaves the strip for Add a repository; Shift+Tab comes back to the chosen tab.
    const addTab = page.locator("[data-add-repository-tab]");
    await pressKey(apiTab, "Tab");
    await expect(addTab).toBeFocused();
    await pressKey(addTab, "Shift+Tab");
    await expect(apiTab).toBeFocused();

    // Add a repository opens its form in the panel; Cancel brings the
    // settings back and puts focus on Add a repository again.
    await pressKey(addTab, "Enter");
    await expect(addTab).toHaveAttribute("aria-expanded", "true");
    const cancel = page.locator("[data-add-repository-cancel]");
    await pressKey(cancel, "Enter");
    await expect(addTab).toBeFocused();
    await expect(projectSettings(page, api.id)).toBeVisible();
    await pressKey(addTab, "Shift+Tab");
    await expect(apiTab).toBeFocused();

    // Escape goes back to the list with focus on the project's line.
    await pressKey(apiTab, "Escape");
    await expect(line).toBeFocused();
    await expect(back).toHaveCount(0);

    // Space on the line opens the page too.
    await pressKey(line, " ");
    await expect(back).toBeFocused();
    await pressKey(back, "Escape");
    await expect(line).toBeFocused();

    // Escape on the list closes Settings.
    await pressKey(line, "Escape");
    await expect(projectsTab).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
