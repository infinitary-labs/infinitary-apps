import { expect, test } from "@playwright/test";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import {
  COST_LIMIT_WORDS,
  costLimitDescription,
} from "../../src/renderer/src/settings/costLimitWords";
import {
  COST_LIMIT_DEFAULT_USD,
  DEFAULT_COST_LIMIT,
  RECENT_COST_DAYS,
} from "../../src/shared/costLimit";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
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
