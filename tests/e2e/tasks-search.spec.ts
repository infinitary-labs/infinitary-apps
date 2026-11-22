import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { dockBody, expandDock, nowFrame, nowRow, nowRowGroup } from "./rails";
import { focusOn, pressWindowKey } from "./windowKeys";

/**
 * Closing the Tasks panel's search (FI3-1068, the captain's choice on
 * FI3-1067): Close search beside the field, Esc in the search, and the
 * header's Search tasks each close it, and closing lets go of the words, so
 * every task is listed again. A project chip is the window's project focus
 * (INF-1091: one focus with the top bar's pill), so closing keeps it: the
 * list goes back to every task of that project, and All projects lets it go.
 * Esc first empties the words, and a second Esc closes; closed from the
 * keyboard, focus goes to the list.
 *
 * A panel whose only tasks are answered questions, as a new profile's
 * welcome is, lists no row, so its page draws nothing: Search tasks still
 * opens the search there, and the words find those answers (FI3-1547).
 */

/** One word of an answered question's title, which the search finds it by. */
const ANSWER_WORD = "screenshots";
const ANSWER_TITLE = `Which model reads my ${ANSWER_WORD}`;

function repo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

/** Two projects, so the search has project chips, and five working tasks. */
function seedTasks(userDataDir: string): void {
  const db = openDatabase(userDataDir);
  const now = Date.now();
  let clock = now - 60 * 60_000;
  seedProject(db, {
    id: "repo-fm",
    path: repo(join(userDataDir, "fm")),
    name: "firstmate",
    setupKind: "clone",
    origin: "https://github.com/o/fm.git",
    runsOn: null,
    delivery: "direct-pr",
    addedAt: now,
    key: "FM3K",
  });
  seedHostedOrigins(db, userDataDir);
  seedProject(db, {
    id: "repo-web",
    path: repo(join(userDataDir, "web")),
    name: "website",
    setupKind: "clone",
    origin: "https://github.com/o/web.git",
    runsOn: null,
    delivery: "direct-pr",
    addedAt: now,
    key: "WEB",
  });
  seedHostedOrigins(db, userDataDir);
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const seeds: [string, string, string][] = [
    ["release", "Tidy the release checklist", "repo-fm"],
    ["voice", "Fix the voice hint under the input", "repo-fm"],
    ["icon", "Round the legacy app icon", "repo-fm"],
    ["care", "Read a task's care from its record", "repo-fm"],
    ["site", "Refresh the website's front page", "repo-web"],
  ];
  for (const [id, title, repoId] of seeds) {
    clock += 60_000;
    const worktreeDir = join(userDataDir, "worktrees", id);
    mkdirSync(worktreeDir, { recursive: true });
    // A crewmate that finished and went idle: a Working row that stays put.
    seedTask(tasks, { id, title, repoId, status: "completed", worktreeDir });
  }
  clock = now;
  db.close();
}

function listedKeys(page: Page): Promise<(string | null)[]> {
  return nowFrame(page)
    .locator("[data-now-row]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-now-key")));
}

test("the Tasks search closes by its close, by Esc and by Search tasks, and every task is listed again", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-tasks-search-");
  seedTasks(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  const { app, page } = launched;
  try {
    const board = () => page.evaluate(() => window.infinitary.tasks.board());
    await expect.poll(async () => (await board()).tasks.length).toBe(5);
    const keys = (await board()).tasks.map((task) => task.key);
    const iconKey = (await board()).tasks.find((task) => task.id === "icon")?.key;

    await expandDock(page, "now");
    const frame = nowFrame(page);
    const panel = page.locator('[data-side-panel="now"]');
    const searchTasks = panel.locator("header").getByRole("button", { name: "Search tasks" });
    const filters = frame.locator("[data-now-filters]");
    const query = frame.locator("[data-now-query]");
    const close = frame.locator("[data-now-close]");
    const allChip = frame.locator('[data-now-project="all"]');
    const fmChip = frame.getByRole("button", { name: "FM3K", exact: true });
    const everyTaskListed = () => expect.poll(() => listedKeys(page)).toEqual(keys);
    const fmKeys = keys.filter((key) => key?.startsWith("FM3K-"));
    const everyFmTaskListed = () => expect.poll(() => listedKeys(page)).toEqual(fmKeys);
    const listHasFocus = () =>
      dockBody(page, "now")
        .locator("body")
        .evaluate((body) => body.ownerDocument.activeElement?.closest("[data-now-groups]") != null);
    await everyTaskListed();

    await test.step("Close search sits after the field, and from the keyboard it closes, clears and goes to the list", async () => {
      await searchTasks.click();
      await expect(query).toBeFocused();
      await expect(close).toBeVisible();
      await fmChip.evaluate((chip) => (chip as HTMLElement).click());
      await focusOn(query);
      await query.pressSequentially("icon");
      await expect.poll(() => listedKeys(page)).toEqual([iconKey]);
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(filters).toBeHidden();
      await everyFmTaskListed();
      await expect.poll(listHasFocus).toBe(true);
      // Open again, the search starts empty, still on the focused project.
      // The press reaches the panel's own page after the click returns, so
      // the caret in the field is what says the search is open to type in.
      await searchTasks.click();
      await expect(query).toBeFocused();
      await expect(query).toHaveValue("");
      await expect(fmChip).toHaveAttribute("aria-pressed", "true");
      await allChip.evaluate((chip) => (chip as HTMLElement).click());
      await expect(allChip).toHaveAttribute("aria-pressed", "true");
      await everyTaskListed();
    });

    await test.step("Esc empties the words, and a second Esc closes the search", async () => {
      await query.pressSequentially("icon");
      await expect.poll(() => listedKeys(page)).toEqual([iconKey]);
      await page.keyboard.press("Escape");
      await expect(query).toHaveValue("");
      await expect(filters).toBeVisible();
      await expect(query).toBeFocused();
      await everyTaskListed();
      await page.keyboard.press("Escape");
      await expect(filters).toBeHidden();
      await expect.poll(listHasFocus).toBe(true);
    });

    await test.step("Find a task opens it again, and Search tasks closes it and clears it too", async () => {
      await pressWindowKey(app, "f", ["meta", "shift"]);
      await expect(filters).toBeVisible();
      await expect(query).toBeFocused();
      await fmChip.evaluate((chip) => (chip as HTMLElement).click());
      await query.fill("icon");
      await expect.poll(() => listedKeys(page)).toEqual([iconKey]);
      await searchTasks.click();
      await expect(filters).toBeHidden();
      await everyFmTaskListed();
      await searchTasks.click();
      await expect(query).toBeFocused();
      await expect(query).toHaveValue("");
      await expect(fmChip).toHaveAttribute("aria-pressed", "true");
      await allChip.evaluate((chip) => (chip as HTMLElement).click());
      await everyTaskListed();
    });

    await test.step("a press on Close search closes it and clears it", async () => {
      await query.fill("icon");
      await expect.poll(() => listedKeys(page)).toEqual([iconKey]);
      // In the frame itself: Chromium hands a hidden window's native click to a sandboxed frame unreliably.
      await close.evaluate((button) =>
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })),
      );
      await expect(filters).toBeHidden();
      await everyTaskListed();
    });
  } finally {
    await launched.close();
  }
});

test("Search tasks opens the search in a panel that lists no row, and its words find an answered question", async () => {
  const userDataDir = scratchDir("infinitary-tasks-search-answers-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  tasks.capture.fileQuestion({
    id: "answer",
    title: ANSWER_TITLE,
    outcome: "<p>The one you pick.</p>",
  });
  db.close();
  const launched = await launchApp({ userDataDir });
  const { page } = launched;
  try {
    const board = () => page.evaluate(() => window.infinitary.tasks.board());
    await expect
      .poll(async () => (await board()).tasks.map((task) => task.id))
      .toEqual(expect.arrayContaining(["answer"]));
    const key = (await board()).tasks.find((task) => task.id === "answer")?.key ?? "";

    await expandDock(page, "now");
    const panel = page.locator('[data-side-panel="now"]');
    await panel.locator("header").getByRole("button", { name: "Search tasks" }).click();
    const query = nowFrame(page).locator("[data-now-query]");
    await expect(query).toBeFocused();
    await query.fill(ANSWER_WORD);
    await expect(nowRow(page, key)).toHaveCount(1);
    expect(await nowRowGroup(page, key)).toBe("earlier");
  } finally {
    await launched.close();
  }
});
