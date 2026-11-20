import { expect, test } from "@playwright/test";
import { CostLimitStore } from "../../src/core/storage/costLimitStore";
import { openDatabase } from "../../src/core/storage/db";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  COST_LIMIT_WORDS,
  costLimitDescription,
} from "../../src/renderer/src/settings/costLimitWords";
import { PROJECT_COST_WORDS } from "../../src/renderer/src/settings/projectCostWords";
import {
  COST_LIMIT_DEFAULT_USD,
  DEFAULT_COST_LIMIT,
  RECENT_COST_DAYS,
  taskCostWords,
} from "../../src/shared/costLimit";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { seedHostedOrigins } from "./projectSeed";
import { projectLine, projectSettings } from "./projects";
import { recordCard } from "./rails";
import { readSavedData } from "./savedData";
import { settingRow } from "./settings";
import { SEEDED_USAGE_TASKS, seedUsageLedger } from "./usage";
import { focusOn, pressKey, pressWindowKey, typeInto } from "./windowKeys";

/**
 * The app's own cost limit in Settings → Intelligence (INF-3112's plan,
 * built by INF-3131; docs/usage.md, "The cost limit"): over a seeded
 * ledger whose dearest task spent $10.50, the row shows the $50 default and
 * that none of the recent tasks would have asked; the captain lowers it to
 * $8 by keys, the row then counts the two tasks that spent that much, and
 * the switch turns the asking off. Each answer is read back from the saved
 * settings.
 */
test("the captain sets the app's cost limit by keys and sees which recent tasks it would ask about", async () => {
  const userDataDir = scratchDir("infinitary-cost-limit-");
  seedUsageLedger(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    const saved = () =>
      readSavedData(userDataDir, (db) => new SettingsStore(db).getTaskCostLimit());
    const recent = (asked: number) => ({
      asked,
      tasks: SEEDED_USAGE_TASKS,
      days: RECENT_COST_DAYS,
    });
    await pressWindowKey(app, ",", ["meta"]);
    const intelligence = page.locator('[role="tab"][id$="-tab-subscriptions"]');
    await focusOn(intelligence);
    await pressKey(intelligence, "Enter");
    const row = settingRow(page, "cost-limit");
    const toggle = row.getByRole("switch", { name: COST_LIMIT_WORDS.switchLabel });
    const amount = row.getByRole("spinbutton", { name: COST_LIMIT_WORDS.amountLabel });
    await expect(toggle).toBeChecked();
    await expect(amount).toHaveValue(String(COST_LIMIT_DEFAULT_USD));
    await expect(row).toContainText(
      costLimitDescription({ limit: DEFAULT_COST_LIMIT, recent: recent(0) }),
    );

    await focusOn(amount);
    await pressKey(amount, "ControlOrMeta+a");
    await typeInto(amount, "8");
    await pressKey(amount, "Enter");
    await expect(row).toContainText(costLimitDescription({ limit: { usd: 8 }, recent: recent(2) }));
    expect(saved()).toEqual({ usd: 8 });

    await focusOn(toggle);
    await pressKey(toggle, "Space");
    await expect(toggle).not.toBeChecked();
    await expect(amount).toHaveCount(0);
    expect(saved()).toEqual({ none: true });
  } finally {
    await launched.close();
  }
});

/**
 * INF-3112's approved second piece: a project's choice applies to its
 * task records, includes the work under each task, and persists by keys.
 * Uses the same reported-usage ledger as Usage, with its review under the
 * implementation it reviews; no provider, account or external service.
 */
test("the captain sets a project's cost limit by keys and reads family spend in its task record", async () => {
  const userDataDir = scratchDir("infinitary-project-cost-");
  seedUsageLedger(userDataDir);
  const db = openDatabase(userDataDir);
  seedHostedOrigins(db, userDataDir);
  const tasks = new TaskService({ db });
  const parent = tasks.list().find((task) => task.title === "Build command search");
  const review = tasks.list().find((task) => task.title === "Review keyboard changes");
  if (!parent || !review) throw new Error("Usage fixture is missing its implementation or review");
  tasks.setParent(review.id, parent.id, "host");
  const spent = new CostLimitStore(db).familySpend(parent.id);
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    const saved = () =>
      readSavedData(userDataDir, (db) => new CostLimitStore(db).limitOf("project", "repo-fm"));
    await pressWindowKey(app, ",", ["meta"]);
    const projects = page.locator('[role="tab"][id$="-tab-projects"]');
    await focusOn(projects);
    await pressKey(projects, "Enter");
    const expand = projectLine(page, "repo-fm").getByRole("button");
    await focusOn(expand);
    await pressKey(expand, "Enter");
    const project = projectSettings(page, "repo-fm");
    const control = project.locator("[data-project-cost-limit]");
    const follow = control.getByRole("radio", {
      name: PROJECT_COST_WORDS.choices[0].label,
      exact: true,
    });
    const own = control.getByRole("radio", {
      name: PROJECT_COST_WORDS.choices[1].label,
      exact: true,
    });
    const none = control.getByRole("radio", {
      name: PROJECT_COST_WORDS.choices[2].label,
      exact: true,
    });
    await expect(follow).toBeChecked();
    await focusOn(own);
    await pressKey(own, "Space");
    const amount = control.getByRole("spinbutton", { name: PROJECT_COST_WORDS.amount });
    await focusOn(amount);
    await pressKey(amount, "ControlOrMeta+a");
    await typeInto(amount, "75");
    await pressKey(amount, "Enter");
    await expect.poll(saved).toEqual({ usd: 75 });
    await focusOn(none);
    await pressKey(none, "Space");
    await expect.poll(saved).toEqual({ none: true });
    await focusOn(follow);
    await pressKey(follow, "Space");
    await expect.poll(saved).toBeNull();
    // A fresh read supplies the same persisted choice after the tab remounts.
    const usage = page.locator('[role="tab"][id$="-tab-usage"]');
    await focusOn(usage);
    await pressKey(usage, "Enter");
    const taskKey = page.locator(`[data-usage-task="${parent.key}"]`).getByRole("link");
    await focusOn(taskKey);
    await pressKey(taskKey, "Enter");
    const cost = recordCard(page).locator("[data-record-cost]");
    await expect(cost).toContainText(
      taskCostWords({ ...spent, limit: DEFAULT_COST_LIMIT, source: "app" }).amount,
    );
    // The compact strip preserves room for the record's frame. Its complete
    // family/source explanation remains readable from the keyboard (the
    // task-record-height and prepared-card regressions in the cost display).
    await focusOn(cost, { focusVisible: true });
    await expect(page.locator("[data-icon-label]")).toBeVisible();
    await expect(page.locator("[data-icon-label]")).toContainText(
      taskCostWords({ ...spent, limit: DEFAULT_COST_LIMIT, source: "app" }).detail,
    );
    await page.evaluate(() => window.infinitary.settings.setCostLimit({ usd: 100 }));
    await expect(cost).toContainText(
      taskCostWords({ ...spent, limit: { usd: 100 }, source: "app" }).amount,
    );
  } finally {
    await launched.close();
  }
});
