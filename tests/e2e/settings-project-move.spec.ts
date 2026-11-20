import { expect, type Locator, test } from "@playwright/test";
import { ACTIONS } from "../../src/shared/actions";
import { feedLineFrom } from "../../src/shared/feed";
import * as m from "../../src/shared/i18n/messages.generated";
import { launchApp } from "./launch";
import { projectSettings } from "./projects";
import { pressKey, pressWindowKey } from "./windowKeys";

/**
 * INF-5005's plan, part 2, with the captain's rule that every feature works
 * from the keyboard: a repository's page in Settings -> Projects carries a
 * Move line above Remove, and a person moves harbour-charts out of the
 * harbour project into wallet by keys alone. Shift-Tab from Remove reaches
 * the project select with its ring, a typed letter chooses wallet, Tab
 * reaches Move with its ring, and Enter asks in place with Cancel focused,
 * so the first Enter moves nothing; Tab to the question's Move and Enter
 * moves it, and the page becomes wallet's with harbour-charts chosen. The
 * data is three disposable repositories made in the launcher's private
 * home; the completion signal is the project list the core reads back and
 * the feed line. The move's own rules are `src/core/core.projects.test.ts`'s.
 */

const ringed = (target: Locator) => target.evaluate((element) => element.matches(":focus-visible"));

test("a repository moves to another project from its Move line in Settings, by keys alone", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    await page.evaluate(() =>
      window.infinitary.repos.setup({ kind: "init", name: "harbour", key: "HAR" }),
    );
    const { repo: charts } = await page.evaluate(() =>
      window.infinitary.repos.setup({ kind: "init", name: "harbour-charts", project: "HAR" }),
    );
    await page.evaluate(() =>
      window.infinitary.repos.setup({ kind: "init", name: "wallet", key: "WAL" }),
    );
    const projectOf = async (name: string) =>
      (await page.evaluate(() => window.infinitary.projects.list())).find(
        (project) => !project.archived && project.repos?.some((repo) => repo.name === name),
      )?.key;

    await pressWindowKey(app, ",", ["meta"]);
    const projectsTab = page.locator('[role="tab"][id$="-tab-projects"]');
    await pressKey(projectsTab, "Enter");
    await pressKey(page.locator('[data-project-group="HAR"]').getByRole("button"), "Enter");
    const chartsTab = page.locator(`[data-repository-tab="${charts.id}"]`);
    await pressKey(chartsTab, "Enter");
    const panel = projectSettings(page, charts.id);
    await expect(panel).toBeVisible();

    const line = panel.locator(`[data-move-repository="${charts.id}"]`);
    const select = line.getByLabel(m.settingsProjectsMoveTarget({ name: charts.name }));
    const move = line.getByRole("button", { name: m.settingsProjectsMoveConfirm(), exact: true });
    const cancel = line.getByRole("button", { name: m.settingsProjectsRemoveCancel() });
    const question = m.projectsMoveTitleInto({ repositories: charts.name, project: "wallet" });

    await test.step("Shift-Tab from Remove reaches the select, and a letter chooses wallet", async () => {
      await expect(move).toBeDisabled();
      const remove = panel.getByRole("button", {
        name: m.settingsProjectsRemoveNamed({ name: charts.name }),
      });
      await pressKey(remove, "Shift+Tab");
      await expect(select).toBeFocused();
      expect(await ringed(select)).toBe(true);
      await page.keyboard.press("w");
      await expect(select).toHaveValue("WAL");
      await expect(move).toBeEnabled();
    });

    await test.step("Tab reaches Move, and Enter asks with Cancel focused; Enter moves nothing", async () => {
      await page.keyboard.press("Tab");
      await expect(move).toBeFocused();
      expect(await ringed(move)).toBe(true);
      await page.keyboard.press("Enter");
      await expect(line).toContainText(question);
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(line).toContainText(m.settingsProjectsMoveNamed({ name: charts.name }));
      expect(await projectOf(charts.name)).toBe("HAR");
    });

    await test.step("Tab to the question's Move and Enter moves it into wallet", async () => {
      await pressKey(move, "Enter");
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Tab");
      const confirm = line.getByRole("button", {
        name: m.settingsProjectsMoveConfirm(),
        exact: true,
      });
      await expect(confirm).toBeFocused();
      expect(await ringed(confirm)).toBe(true);
      await page.keyboard.press("Enter");
      await expect(page.locator('[data-project-page="WAL"]')).toBeVisible();
      await expect(chartsTab).toHaveAttribute("aria-selected", "true");
      await expect(projectSettings(page, charts.id).locator("[data-repository-notice]")).toHaveText(
        m.settingsProjectsMoved({ name: charts.name, project: "wallet" }),
      );
      expect(await projectOf(charts.name)).toBe("WAL");
      expect(await projectOf("harbour")).toBe("HAR");
      const feed = await page.evaluate(() => window.infinitary.feed.recent());
      expect(feed.map((entry) => entry.text)).toContain(
        feedLineFrom({
          type: "personalized",
          actor: "captain",
          text: ACTIONS["project-move"].done({
            repos: [{ id: charts.id, name: charts.name }],
            project: { name: "wallet" },
          }),
        })?.text,
      );
    });
  } finally {
    await launched.close();
  }
});
