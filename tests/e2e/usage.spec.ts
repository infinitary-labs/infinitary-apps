import { expect, test } from "@playwright/test";
import {
  type CostSelection,
  costDayEnds,
  costSeries,
  USAGE_TASK_PAGE,
  usageCategoryValue,
} from "../../src/shared/usage";
import { scratchDir } from "../helpers/scratchDirs";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import {
  focusOnModel,
  focusOnTask,
  SEEDED_COST_PROJECT,
  SEEDED_USAGE_TASKS,
  seedCostPerTaskLedger,
  seedTokenCoverageLedger,
  seedUsageLedger,
  usageSummary,
  usageTab,
  usageTaskCosts,
  usageTasks,
} from "./usage";
import { pressKey, runFromSearch, typeInto, untilWindowCommands } from "./windowKeys";

/**
 * Settings → Usage, end to end and by keys alone (docs/usage.md): a real
 * Firstmate turn through the mock provider writes the usage ledger, and the
 * captain opens Usage from command search in estimated dollars, switches
 * to tokens, narrows the period and the work, opens the model's details and
 * leaves them with Escape, and finds the unit they chose after a reload.
 */
test("Usage shows the recorded model usage and keeps the chosen unit, all from the keyboard", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    const usage = usageTab(page);

    await test.step("a Firstmate turn lands in the usage ledger", async () => {
      // The turn's answer, never the character looking idle, which it does before the turn starts.
      await askFirstmate(page, "how much have we used");
      await expect
        .poll(
          async () =>
            (await usageSummary(page, { period: "all", scope: "firstmate" })).total.records,
        )
        .toBeGreaterThan(0);
    });

    await test.step("Open Usage from command search lands on the unit switch, in estimated dollars", async () => {
      await runFromSearch(app, page, "settings.usage");
      await expect(usage.unit("usd")).toBeChecked();
      await expect(usage.unit("usd")).toBeFocused();
      const { models } = await usageSummary(page, { period: "30d", scope: "all" });
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) await expect(usage.model(model.id)).toBeVisible();
    });

    await test.step("the arrows switch every amount to tokens, and the core keeps it", async () => {
      await page.keyboard.press("ArrowLeft");
      await expect(usage.unit("tokens")).toBeChecked();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
              .usageUnit,
        )
        .toBe("tokens");
    });

    await test.step("Tab reaches the period and the work, and typing picks one", async () => {
      await page.keyboard.press("Tab");
      await typeInto(usage.period, "All");
      await expect(usage.period).toHaveValue("all");
      await page.keyboard.press("Tab");
      await typeInto(usage.scope, "First mate");
      await expect(usage.scope).toHaveValue("firstmate");
      const { models } = await usageSummary(page, { period: "all", scope: "firstmate" });
      await expect(usage.models).toHaveCount(models.length);
    });

    await test.step("a model's details open with Enter and Escape takes focus back to it", async () => {
      for (let step = 0; step < 8 && (await focusOnModel(page)) === null; step++) {
        await page.keyboard.press("Tab");
      }
      const model = await focusOnModel(page);
      expect(model).not.toBeNull();
      await page.keyboard.press("Enter");
      await expect(usage.detail).toHaveAttribute("data-usage-detail", model ?? "");
      await expect(usage.close).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(usage.detail).toHaveCount(0);
      await expect.poll(() => focusOnModel(page)).toBe(model);
      // Escape closed the details alone; Settings is still open.
      await expect(usage.section).toBeVisible();
    });

    await test.step("Usage opens again in the unit chosen, with the period and work started over", async () => {
      await page.reload();
      await untilWindowCommands(page);
      await runFromSearch(app, page, "settings.usage");
      await expect(usage.unit("tokens")).toBeChecked();
      await expect(usage.period).toHaveValue("30d");
      await expect(usage.scope).toHaveValue("all");
    });

    await test.step("Switch Usage units goes back to estimated dollars from command search", async () => {
      await runFromSearch(app, page, "usage.unit");
      await expect(usage.unit("usd")).toBeChecked();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
              .usageUnit,
        )
        .toBe("usd");
    });
  } finally {
    await launched.close();
  }
});

/**
 * Where it went and the recent tasks over a seeded ledger (FI3-993): the
 * Firstmate first, each project with its kinds of work, other work last,
 * and the newest tasks ten at a time, all by keys - See more adds the next
 * ten and takes focus to the first of them, the unit keeps the list as it
 * is, and a new period starts it over at ten.
 */
test("Usage groups where it went by project and lists recent tasks ten at a time, from the keyboard", async () => {
  const userDataDir = scratchDir("infinitary-usage-recent-");
  seedUsageLedger(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    const usage = usageTab(page);
    const listed = () =>
      usage.tasks.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-usage-task")));
    const newest = async (limit: number) =>
      (await usageTasks(page, { period: "30d", scope: "all", limit })).tasks.map(
        (each) => each.task.key,
      );
    /** Tab on until See more holds focus: every task's key before it is a stop. */
    const tabToMore = async () => {
      for (
        let step = 0;
        step < 40 && !(await usage.more.evaluate((more) => more === document.activeElement));
        step++
      ) {
        await page.keyboard.press("Tab");
      }
      await expect(usage.more).toBeFocused();
    };

    await test.step("Where it went lists the Firstmate, each project with its kinds of work, then other work", async () => {
      await expect(promptInput(page)).toBeVisible();
      await runFromSearch(app, page, "settings.usage");
      await expect(usage.unit("usd")).toBeFocused();
      const { where } = await usageSummary(page, { period: "30d", scope: "all" });
      expect(where.projects.length).toBe(2);
      await expect(usage.where).toHaveCount(where.projects.length + 2);
      await expect(usage.where.first()).toHaveAttribute("data-usage-place", "firstmate");
      await expect(usage.where.last()).toHaveAttribute("data-usage-place", "other");
      for (const project of where.projects) {
        await expect(
          usage.project(project.project?.id ?? "").locator("[data-usage-kind]"),
        ).toHaveCount(project.kinds.length);
      }
    });

    await test.step("the newest ten tasks are listed, and See more adds ten and takes focus to the first of them", async () => {
      await expect.poll(listed).toEqual(await newest(USAGE_TASK_PAGE));
      await tabToMore();
      await page.keyboard.press("Enter");
      const twenty = await newest(2 * USAGE_TASK_PAGE);
      await expect.poll(listed).toEqual(twenty);
      await expect.poll(() => focusOnTask(page)).toBe(twenty[USAGE_TASK_PAGE]);
    });

    await test.step("the rest comes with the next See more, and See more goes", async () => {
      // Each listed task's key is a Tab stop of its own on the way (FI3-1271).
      await tabToMore();
      await page.keyboard.press(" ");
      await expect(usage.tasks).toHaveCount(SEEDED_USAGE_TASKS);
      expect(new Set(await listed()).size).toBe(SEEDED_USAGE_TASKS);
      await expect(usage.more).toHaveCount(0);
    });

    await test.step("switching the unit keeps every task listed, in the same order", async () => {
      const before = await listed();
      await runFromSearch(app, page, "usage.unit");
      await expect(usage.unit("tokens")).toBeChecked();
      await expect.poll(listed).toEqual(before);
    });

    await test.step("a new period starts the list over at ten", async () => {
      await runFromSearch(app, page, "settings.usage");
      await expect(usage.unit("tokens")).toBeFocused();
      await page.keyboard.press("Tab");
      await typeInto(usage.period, "All");
      await expect(usage.period).toHaveValue("all");
      await expect(usage.tasks).toHaveCount(USAGE_TASK_PAGE);
      await expect(usage.more).toBeVisible();
    });
  } finally {
    await launched.close();
  }
});

test("Usage preserves category coverage through the ledger, filters and model details", async () => {
  const userDataDir = scratchDir("infinitary-token-coverage-");
  seedTokenCoverageLedger(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    const usage = usageTab(page);
    await expect(promptInput(page)).toBeVisible();
    await runFromSearch(app, page, "settings.usage");
    // Usage opens in dollars; category coverage is a token reading.
    await runFromSearch(app, page, "usage.unit");
    await expect(usage.unit("tokens")).toBeChecked();
    const summary = await usageSummary(page, { period: "30d", scope: "all" });
    expect(summary.total.tokenReported).toEqual({
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 1,
    });
    // Each model includes genuinely missing categories, explicit zeros, or complete coverage.
    for (const model of summary.models) {
      await pressKey(usage.model(model.id), "Enter");
      await expect(usage.detail).toHaveAttribute("data-usage-detail", model.id);
      for (const category of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        await expect(usage.categoryValue(category)).toHaveAttribute(
          "data-usage-value",
          String(usageCategoryValue(model.amount, category, "tokens") ?? ""),
        );
        await expect(usage.tokenCoverage(category)).toHaveAttribute(
          "data-usage-reported",
          String(model.amount.tokenReported?.[category] ?? ""),
        );
        await expect(usage.tokenCoverage(category)).toHaveAttribute(
          "data-usage-records",
          String(model.amount.records),
        );
      }
      await page.keyboard.press("Escape");
    }
    await runFromSearch(app, page, "usage.unit");
    await expect(usage.unit("usd")).toBeChecked();
    const first = summary.models[0];
    if (!first) throw new Error("Missing seeded models");
    await usage.model(first.id).click();
    await expect(usage.tokenCoverage("input")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await runFromSearch(app, page, "usage.unit");
    await expect(usage.unit("tokens")).toBeChecked();
    await usage.scope.selectOption("firstmate");
    expect(
      (await usageSummary(page, { period: "30d", scope: "firstmate" })).total.tokenReported,
    ).toEqual(summary.total.tokenReported);
    await usage.scope.selectOption("other");
    await expect(usage.models).toHaveCount(0);
  } finally {
    await launched.close();
  }
});

/**
 * Cost per task over five seeded weeks of finished work (docs/usage.md):
 * the median line of each finished task with its reviews, in dollars, its
 * readouts checked against the core's own read, a project and a kind
 * picked from the filters by keys alone, Escape closing a filter onto its
 * row, the Values table giving every day's window, and the filters back at
 * All when Usage opens again.
 */
test("Cost per task draws the median finished task and filters by project and kind, from the keyboard", async () => {
  const userDataDir = scratchDir("infinitary-usage-cost-");
  seedCostPerTaskLedger(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    const usage = usageTab(page);
    /** The readout's figure matches the core's read, worked by the same shared math. */
    const readsAs = async (selection: CostSelection) => {
      await expect
        .poll(async () => {
          const costs = await usageTaskCosts(page, { period: "30d" });
          const expected = costSeries(costs, selection, "usd").now.median;
          const shown = await usage.costReadout("now").getAttribute("data-usage-value");
          return expected !== null && shown === String(expected);
        })
        .toBe(true);
    };
    /** Tab on until the element holds focus. */
    const tabTo = async (target: ReturnType<typeof usage.costFilter>) => {
      for (
        let step = 0;
        step < 60 && !(await target.evaluate((element) => element === document.activeElement));
        step++
      ) {
        await page.keyboard.press("Tab");
      }
      await expect(target).toBeFocused();
    };
    const projects = usage.costFilter("projects");
    const kinds = usage.costFilter("kinds");

    await test.step("Usage opens in dollars and draws the median of every finished task", async () => {
      await expect(promptInput(page)).toBeVisible();
      await runFromSearch(app, page, "settings.usage");
      await expect(usage.unit("usd")).toBeFocused();
      await expect(usage.cost).toBeVisible();
      await expect(usage.costLines.first()).toBeVisible();
      await expect(usage.costEmpty).toHaveCount(0);
      await readsAs({ projects: null, kinds: null });
    });

    await test.step("a project picked from the Projects filter by keys redraws the median for it alone", async () => {
      await tabTo(projects.locator("summary"));
      await page.keyboard.press("Enter");
      await expect(projects).toHaveAttribute("open", "");
      await page.keyboard.press("Tab");
      await expect(projects.locator("[data-usage-cost-all]")).toBeFocused();
      await expect(projects.locator("[data-usage-cost-all]")).toBeChecked();
      // The project's id on the record, as the read names it.
      const { tasks } = await usageTaskCosts(page, { period: "30d" });
      const fm = tasks.find((task) => task.project?.name === SEEDED_COST_PROJECT)?.project?.id;
      if (!fm) throw new Error("The seeded project has no finished task");
      const firstmate = projects.locator(`input[value="${fm}"]`);
      await tabTo(firstmate);
      await page.keyboard.press(" ");
      await expect(firstmate).toBeChecked();
      await expect(projects.locator("[data-usage-cost-all]")).not.toBeChecked();
      await readsAs({ projects: new Set([fm]), kinds: null });
    });

    await test.step("Escape closes the filter onto its row and leaves Settings open", async () => {
      await page.keyboard.press("Escape");
      await expect(projects).not.toHaveAttribute("open", "");
      await expect(projects.locator("summary")).toBeFocused();
      await expect(usage.section).toBeVisible();
    });

    await test.step("a kind picked too narrows the line to that project's implementation work", async () => {
      await tabTo(kinds.locator("summary"));
      await page.keyboard.press(" ");
      const implement = kinds.locator('input[value="implement"]');
      await expect(kinds.locator('input[value="review"]')).toHaveCount(0);
      await tabTo(implement);
      await page.keyboard.press(" ");
      await expect(implement).toBeChecked();
      const { tasks } = await usageTaskCosts(page, { period: "30d" });
      const fm = tasks.find((task) => task.project?.name === SEEDED_COST_PROJECT)?.project?.id;
      await readsAs({ projects: new Set([fm ?? ""]), kinds: new Set(["implement"]) });
      await page.keyboard.press("Escape");
      await expect(kinds.locator("summary")).toBeFocused();
    });

    await test.step("Values gives every day's window, today last", async () => {
      const summary = usage.costValues.locator("summary");
      await tabTo(summary);
      await page.keyboard.press("Enter");
      const costs = await usageTaskCosts(page, { period: "30d" });
      await expect(usage.costValues.locator("tbody tr")).toHaveCount(costDayEnds(costs).length);
    });

    await test.step("the filters are back at All when Usage opens again", async () => {
      await page.reload();
      await untilWindowCommands(page);
      await runFromSearch(app, page, "settings.usage");
      await expect(projects.locator("[data-usage-cost-all]")).toBeChecked();
      await expect(kinds.locator("[data-usage-cost-all]")).toBeChecked();
      await readsAs({ projects: null, kinds: null });
    });
  } finally {
    await launched.close();
  }
});
