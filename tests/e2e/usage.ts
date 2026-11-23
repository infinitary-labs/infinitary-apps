/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/storage/usageStore.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { type AppDatabase, openDatabase } from "../../src/core/storage/db";
import { UsageStore } from "../../src/core/storage/usageStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { WorkKind } from "../../src/shared/routingPolicy";
import type {
  UsageQuery,
  UsageSummary,
  UsageTaskCosts,
  UsageTaskCostsQuery,
  UsageTasks,
  UsageTasksQuery,
  UsageUnit,
} from "../../src/shared/usage";
import { seedProject } from "./projectSeed";
import { starterFor } from "./starters";

/**
 * Settings → Usage (docs/usage.md) by its hooks, never its words: the unit
 * switch, the two filters, a model's row and its details, where it went
 * and the recent tasks with their See more.
 */
export function usageTab(page: Page): {
  section: Locator;
  unit: (unit: UsageUnit) => Locator;
  period: Locator;
  scope: Locator;
  models: Locator;
  model: (id: string) => Locator;
  detail: Locator;
  close: Locator;
  /** Where it went's places and projects, in the order the tab lists them. */
  where: Locator;
  project: (id: string) => Locator;
  tasks: Locator;
  more: Locator;
  tokenCoverage: (category: string) => Locator;
  categoryValue: (category: string) => Locator;
  /** Cost per task's section, its readouts, filters, line and Values table. */
  cost: Locator;
  costReadout: (readout: "now" | "start" | "change") => Locator;
  costFilter: (filter: "projects" | "kinds") => Locator;
  costLines: Locator;
  costEmpty: Locator;
  costValues: Locator;
} {
  const section = page.locator('[data-settings-section="usage"]');
  return {
    section,
    unit: (unit) => section.locator(`[data-usage-unit] [value="${unit}"]`),
    period: section.locator("[data-usage-period]"),
    scope: section.locator("[data-usage-scope]"),
    models: section.locator("[data-usage-model]"),
    model: (id) => section.locator(`[data-usage-model="${id}"]`),
    detail: section.locator("[data-usage-detail]"),
    close: section.locator("[data-usage-detail]").getByRole("button"),
    where: section.locator(
      '[data-usage-where="selection"] :is([data-usage-place], [data-usage-project])',
    ),
    project: (id) => section.locator(`[data-usage-where="selection"] [data-usage-project="${id}"]`),
    tasks: section.locator("[data-usage-task]"),
    // The recent tasks' foot holds one button, See more, while more match.
    more: section.locator("[data-usage-tasks-foot]").getByRole("button"),
    tokenCoverage: (category) => section.locator(`[data-usage-token-coverage="${category}"]`),
    categoryValue: (category) =>
      section.locator(`[data-usage-detail] [data-usage-category="${category}"] strong`),
    cost: section.locator("[data-usage-cost]"),
    costReadout: (readout) => section.locator(`[data-usage-cost-readout="${readout}"]`),
    costFilter: (filter) => section.locator(`[data-usage-cost-filter="${filter}"]`),
    costLines: section.locator("[data-usage-cost-line]"),
    costEmpty: section.locator("[data-usage-cost-empty]"),
    costValues: section.locator("[data-usage-cost-values]"),
  };
}

/** The finished tasks Cost per task reads, asked of the core the same way. */
export function usageTaskCosts(page: Page, query: UsageTaskCostsQuery): Promise<UsageTaskCosts> {
  return page.evaluate(
    (args) => window.infinitary.plugins.read("usage.taskCosts", args),
    query,
  ) as Promise<UsageTaskCosts>;
}

/** The recent tasks the tab reads, asked of the core the same way. */
export function usageTasks(page: Page, query: UsageTasksQuery): Promise<UsageTasks> {
  return page.evaluate(
    (args) => window.infinitary.plugins.read("usage.tasks", args),
    query,
  ) as Promise<UsageTasks>;
}

/** The recent task focus rests on, by its key. */
export function focusOnTask(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-usage-task") ?? null);
}

/** The usage summary the tab reads, asked of the core the same way. */
export function usageSummary(page: Page, query: UsageQuery): Promise<UsageSummary> {
  return page.evaluate(
    (args) => window.infinitary.plugins.read("usage.summary", args),
    query,
  ) as Promise<UsageSummary>;
}

export function focusOnModel(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-usage-model") ?? null);
}

/** The seeded ledger's tasks: title, project, saved kind (none for an older task), tokens, estimate. */
const SEEDED_TASKS: readonly [string, "fm" | "web", WorkKind | null, number, number | null][] = [
  ["Build command search", "fm", "implement", 6_800_000, 10.5],
  ["Repair the project picker", "fm", "fix", 5_400_000, 8.2],
  ["Refresh the homepage", "web", "implement", 2_100_000, 3.75],
  ["Improve search results", "fm", "implement", 1_600_000, 2.44],
  ["Update project dependencies", "fm", "chore", 1_200_000, null],
  ["Compare search approaches", "fm", "research", 890_000, 1.32],
  ["Improve the contact form", "web", "fix", 890_000, 1.3],
  ["Add a page index", "web", "implement", 820_000, 1.27],
  ["Earlier project work", "fm", null, 740_000, 1.18],
  ["Review keyboard changes", "fm", "review", 640_000, 0.97],
  ["Correct a date display", "fm", "fix", 470_000, 0.7],
  ["Reproduce the loading problem", "web", "reproduce", 460_000, 0.69],
  ["Reproduce delayed search", "fm", "reproduce", 360_000, 0.55],
  ["Fix the empty state", "fm", "fix", 350_000, 0.51],
  ["Refine Usage in Settings", "fm", "plan", 320_000, 0.48],
  ["Plan the pricing page", "web", "plan", 280_000, 0.42],
  ["Review the contact form", "web", "review", 230_000, 0.35],
  ["Plan command hints", "fm", "plan", 180_000, 0.27],
  ["Compare hosting options", "web", "research", 170_000, 0.26],
  ["Review the page index", "web", "review", 140_000, 0.2],
  ["Earlier website work", "web", "unclear", 120_000, null],
  ["Maintain page links", "web", "chore", 110_000, 0.17],
  ["Compare layout approaches", "web", "research", 90_000, 0.14],
];

/** How many tasks the seeded ledger lists, each with recorded usage in the last 30 days. */
export const SEEDED_USAGE_TASKS = SEEDED_TASKS.length;

function gitRepo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

/** The two projects the seeded ledgers' tasks belong to. */
/** The seeded project whose tasks grow dearer in the cost ledger, by its name. */
export const SEEDED_COST_PROJECT = "firstmate-3000";

function seedUsageProjects(db: AppDatabase, userDataDir: string, now: number): void {
  seedProject(db, {
    id: "repo-fm",
    path: gitRepo(join(userDataDir, "fm")),
    name: SEEDED_COST_PROJECT,
    setupKind: "clone",
    origin: "https://github.com/o/fm.git",
    runsOn: null,
    delivery: "direct-pr",
    addedAt: now,
    key: "FM3K",
  });
  seedProject(db, {
    id: "repo-web",
    path: gitRepo(join(userDataDir, "web")),
    name: "Website",
    setupKind: "clone",
    origin: "https://github.com/o/web.git",
    runsOn: null,
    delivery: "direct-pr",
    addedAt: now,
    key: "WEB",
  });
}

/**
 * A usage ledger a person would recognize, written through the one writers
 * before the app starts: two projects, tasks of every saved kind created a
 * few hours apart (one with no saved kind, some finished, one dropped), a
 * record of each over the last weeks - priced by category, priced whole
 * the way Claude prices, unpriced, or missing a category - the Firstmate's
 * own conversation and a model call made for no task.
 */
export function seedUsageLedger(userDataDir: string): void {
  const db = openDatabase(userDataDir);
  const now = Date.now();
  const HOUR = 3_600_000;
  seedUsageProjects(db, userDataDir, now);
  mkdirSync(join(userDataDir, "worktrees"), { recursive: true });
  // The oldest task first, five hours apart, the newest an hour ago.
  let clock = now - (SEEDED_TASKS.length * 5 + 1) * HOUR;
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const usage = new UsageStore(db);
  const codex = { provider: "openai-codex", id: starterFor("openai-codex", "medium") };
  const claudeModel = { provider: "anthropic-claude", id: starterFor("anthropic-claude", "high") };
  [...SEEDED_TASKS].reverse().forEach(([title, project, kind, tokens, usd], index) => {
    clock += 5 * HOUR;
    const id = `usage-${index}`;
    seedTask(tasks, {
      id,
      title,
      status: index % 7 === 3 ? "cancelled" : "queued",
      startPolicy: "on-request",
      repoId: project === "fm" ? "repo-fm" : "repo-web",
      ...(kind ? { shape: { kind } } : {}),
    });
    if (index % 4 === 1) tasks.close(id, { status: "done", reason: "finished", actor: "host" });
    const claude = index % 5 === 0;
    const records = index % 6 === 2 ? 2 : 1;
    for (let record = 0; record < records; record++) {
      const share = tokens / records;
      const cost = usd === null ? undefined : usd / records;
      usage.record({
        taskId: id,
        model: claude ? claudeModel : codex,
        usage: {
          input: Math.round(share * 0.1),
          output: Math.round(share * 0.025),
          cacheRead: Math.round(share * 0.825),
          // One task's second record did not report its cache writes.
          ...(index === 2 && record === 1 ? {} : { cacheWrite: Math.round(share * 0.05) }),
          ...(cost === undefined
            ? {}
            : claude
              ? { cost, costSource: "claude" as const }
              : {
                  cost,
                  costSource: "listed-prices" as const,
                  costParts: {
                    input: cost * 0.1,
                    output: cost * 0.05,
                    cacheRead: cost * 0.8,
                    cacheWrite: cost * 0.05,
                  },
                }),
        },
        at: clock + (record + 1) * 20 * 60_000,
      });
    }
  });
  usage.record({
    taskId: "firstmate",
    model: codex,
    usage: {
      input: 240_000,
      output: 60_000,
      cacheRead: 2_000_000,
      cacheWrite: 100_000,
      cost: 3.8,
      costSource: "listed-prices",
      costParts: { input: 0.6, output: 0.6, cacheRead: 2.5, cacheWrite: 0.1 },
    },
    at: now - 2 * HOUR,
  });
  usage.record({
    taskId: "routing",
    model: codex,
    usage: { input: 150_000, output: 10_000 },
    at: now - 3 * HOUR,
  });
  db.close();
}

/** Each kind's work as the seeded projects' tasks name it, used in turn. */
const COST_TITLES: Readonly<Record<"implement" | "fix" | "chore" | "plan", readonly string[]>> = {
  implement: [
    "Add saved searches",
    "Build the settings import",
    "Show a task's history",
    "Add keyboard filters",
    "Build the export page",
  ],
  fix: ["Repair the date picker", "Fix a stuck spinner", "Correct the sort order"],
  chore: ["Update dependencies", "Tidy the build scripts"],
  plan: ["Plan the onboarding flow", "Plan the search index"],
};

/**
 * What each seeded day finishes, per project: one entry a task, by its
 * kind, its estimate on the first day, and on the last. firstmate-3000's
 * implementation work grows dearer over the weeks, as a codebase gathering
 * complexity does; the website's stays level.
 */
const COST_DAY: readonly ["fm" | "web", keyof typeof COST_TITLES, first: number, last: number][] = [
  ["fm", "implement", 6, 14],
  ["fm", "fix", 3, 4],
  ["fm", "implement", 6, 14],
  ["fm", "chore", 0.9, 0.9],
  ["fm", "plan", 2.2, 2.2],
  ["web", "implement", 3.5, 3.5],
  ["web", "fix", 2, 2],
];

/** The days the cost ledger covers, today included. */
export const COST_LEDGER_DAYS = 35;

/**
 * Five weeks of finished work for Cost per task (docs/usage.md), written
 * through the one writers before the app starts: seven tasks a day across
 * two projects, each implementation or fix checked by a review under it
 * that costs about a third of it, every task priced but one in 23, its
 * tokens about 2.3M a dollar, and each estimate varied around its kind's
 * level by a fixed sequence so the median is stable from run to run.
 */
export function seedCostPerTaskLedger(userDataDir: string): void {
  const db = openDatabase(userDataDir);
  const now = Date.now();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  seedUsageProjects(db, userDataDir, now);
  let clock = 0;
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const usage = new UsageStore(db);
  const model = { provider: "openai-codex", id: starterFor("openai-codex", "medium") };
  // A fixed sequence of factors between 0.6 and 1.5, never random.
  const VARY = [1, 0.7, 1.3, 0.85, 1.5, 0.6, 1.15, 0.95, 1.25, 0.8, 1.05];
  const record = (taskId: string, usd: number | null) =>
    usage.record({
      taskId,
      model,
      usage: {
        input: Math.round((usd ?? 1) * 230_000),
        output: Math.round((usd ?? 1) * 60_000),
        cacheRead: Math.round((usd ?? 1) * 1_900_000),
        cacheWrite: Math.round((usd ?? 1) * 110_000),
        ...(usd === null ? {} : { cost: usd, costSource: "listed-prices" as const }),
      },
      at: clock - HOUR,
    });
  const finish = (id: string) =>
    tasks.close(id, { status: "done", reason: "finished", actor: "host" });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let count = 0;
  for (let day = COST_LEDGER_DAYS - 1; day >= 0; day--) {
    const progress = (COST_LEDGER_DAYS - 1 - day) / (COST_LEDGER_DAYS - 1);
    COST_DAY.forEach(([project, kind, first, last], slot) => {
      // Spread over the working day, never past the moment the app starts.
      clock = Math.min(
        today.getTime() - day * DAY + (9 + slot * 1.5) * HOUR,
        now - (7 - slot) * 60_000,
      );
      const id = `cost-${count}`;
      const titles = COST_TITLES[kind];
      const usd =
        count % 23 === 22
          ? null
          : Math.round(
              (first + (last - first) * progress) * (VARY[count % VARY.length] ?? 1) * 100,
            ) / 100;
      count++;
      seedTask(tasks, {
        id,
        title: titles[count % titles.length] ?? kind,
        status: "completed",
        repoId: project === "fm" ? "repo-fm" : "repo-web",
        shape: { kind },
      });
      record(id, usd);
      if (kind === "implement" || kind === "fix") {
        seedTask(tasks, {
          id: `${id}-review`,
          title: "Review the change",
          status: "completed",
          parentId: id,
          repoId: project === "fm" ? "repo-fm" : "repo-web",
          shape: { kind: "review" },
        });
        record(`${id}-review`, usd === null ? null : Math.round(usd * 35) / 100);
        finish(`${id}-review`);
      }
      finish(id);
    });
  }
  db.close();
}

/** Partial, wholly missing, and explicitly zero token categories through the real ledger writer. */
export function seedTokenCoverageLedger(userDataDir: string): void {
  const db = openDatabase(userDataDir);
  const store = new UsageStore(db);
  const at = Date.now();
  const record = (
    provider: string,
    tier: "low" | "medium" | "high",
    usage: Parameters<UsageStore["record"]>[0]["usage"],
  ) =>
    store.record({
      taskId: "firstmate",
      model: { provider, id: starterFor(provider, tier) },
      usage,
      at,
    });
  record("openai-codex", "medium", { input: 42, output: 0, cost: 1 });
  record("openai-codex", "medium", { input: 8, cost: 1 });
  record("xai", "medium", { cost: 1 });
  record("anthropic-claude", "high", {
    input: 10,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 1,
  });
  db.close();
}
