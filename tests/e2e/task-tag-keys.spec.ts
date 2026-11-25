import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { BOARD_TAGS_COMMAND, GROUP_ASK, TAG_FILTER_ASK } from "../../src/panels/now/words";
import { panelCommandId } from "../../src/shared/keyboard";
import { scratchDir } from "../helpers/scratchDirs";
import { seedRepo } from "./githubStub";
import { launchApp } from "./launch";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { expandDock, nowFrame, openGroup } from "./rails";
import { boardCard, boardPage } from "./taskBoard";
import { focusedRegion, regionAfter, runFromSearch } from "./windowKeys";

/**
 * Finding and grouping work by tag from the keyboard (INF-6632's plan,
 * piece 4, the captain's "Approve and build" with an All tags chip): Filter
 * tasks by tag puts the keyboard on the Tasks search's tag row, the arrows
 * move along it and Enter presses a tag, which lists only its tasks, and
 * closing the search lets go of it. Group tasks opens its menu on the
 * current choice, and ↓ and Enter pick By tag, which a restart keeps. In a
 * tag group, → opens it, ↓ reaches its rows, and ← from a task with parts
 * goes back to the group's header, folding nothing in By status. Show tasks
 * by tag opens the board's By tag table with the keyboard on its first row,
 * and ↓ and Enter open the Board on that row's tag.
 *
 * Data: one project with the tags bug and ios. A plan tagged bug has two
 * untagged parts, a photo task carries bug and ios, and a settings task
 * carries none; every task is queued on request, so all list under Backlog.
 * Completion: the pressed chip and the listed rows, the list's grouping and
 * the focused stop after each key, the parts still listed by status, and
 * the board's view, pressed chip and tiles.
 * Platforms: any; no Mac-only part. Shared resources: none beyond the app.
 */

function seeded(): string {
  const userDataDir = scratchDir("infinitary-task-tag-keys-");
  const { repoDir } = seedRepo(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, { id: "repo-harbour", path: repoDir, name: "harbour", key: "HAR", runsOn: null });
  let clock = Date.now() - 60_000;
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const seed = (id: string, title: string, tags: string[], parentId?: string) => {
    clock += 1_000;
    seedTask(tasks, {
      id,
      repoId: "repo-harbour",
      title,
      intent: { goal: `${title}.`, userWords: `${title}.` },
      startPolicy: "on-request",
      status: "queued",
      createdAt: clock,
      ...(parentId ? { parentId } : {}),
    });
    if (tags.length > 0) tasks.replaceTags(id, { names: tags }, "captain");
  };
  seed("tg-plan", "Make sign-in survive a restart", []);
  const projectId = tasks.get("tg-plan")?.projectId ?? "";
  for (const name of ["bug", "ios"])
    tasks.changeProjectTags({ op: "add", projectId, name, description: `Tasks about ${name}.` });
  tasks.replaceTags("tg-plan", { names: ["bug"] }, "captain");
  seed("tg-keep", "Keep the session token", [], "tg-plan");
  seed("tg-test", "Test a restart mid-sign-in", [], "tg-plan");
  seed("tg-photo", "Crash when a photo is too large", ["bug", "ios"]);
  seed("tg-tidy", "Tidy the settings page", []);
  db.close();
  return userDataDir;
}

/** Puts the keyboard in the Tasks list with F6, as a person does. */
async function intoTasks(app: Parameters<typeof regionAfter>[0], page: Page): Promise<void> {
  await promptInput(page).click();
  let region = await focusedRegion(page);
  while (region !== "panel:now") region = await regionAfter(app, page, region, "F6");
}

test("tags filter and group Tasks and the board by keys", async () => {
  test.setTimeout(240_000);
  const options = { userDataDir: seeded(), withMockProvider: true };
  let launched = await launchApp(options);
  try {
    let { app, page } = launched;
    const list = () => nowFrame(page);
    const row = (id: string) => list().locator(`[data-now-row="${id}"]`);
    const chip = (name: string) =>
      list()
        .locator("[data-now-tags] [data-now-tag]")
        .filter({ hasText: new RegExp(`^${name}`) });
    const tagIdOf = async (name: string) => (await chip(name).getAttribute("data-now-tag")) ?? "";
    const grouping = () => list().locator("[data-now-grouping]");
    const focusedStop = (key: string) => list().locator(`[data-now-nav="${key}"]:focus`);

    await expandDock(page, "now");
    await openGroup(page, "backlog");
    await expect(row("tg-tidy")).toBeVisible();

    let bug = "";
    await test.step("Filter tasks by tag: the arrows move along the tag row and Enter presses one", async () => {
      await runFromSearch(app, page, panelCommandId("now", TAG_FILTER_ASK));
      await expect(list().locator('[data-now-tags] [data-now-tag="all"]:focus')).toHaveCount(1);
      await expect(list().locator('[data-now-tags] [tabindex="0"]')).toHaveCount(1);
      bug = await tagIdOf("bug");
      await page.keyboard.press("ArrowRight");
      await expect(list().locator(`[data-now-tag="${bug}"]:focus`)).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(chip("bug")).toHaveAttribute("aria-pressed", "true");
      await expect(row("tg-plan")).toBeVisible();
      await expect(row("tg-photo")).toBeVisible();
      await expect(row("tg-tidy")).toHaveCount(0);
    });

    await test.step("closing the search lets go of the tag", async () => {
      await page.keyboard.press("Escape");
      await expect(list().locator("[data-now-filters]")).toBeHidden();
      await expect(row("tg-tidy")).toBeVisible();
    });

    await test.step("Group tasks: the menu opens on By status, and ↓ and Enter pick By tag", async () => {
      await runFromSearch(app, page, panelCommandId("now", GROUP_ASK));
      const menu = list().locator('[role="menu"]');
      await expect(menu).toBeVisible();
      await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]:focus')).toHaveCount(
        1,
      );
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      await expect(grouping()).toHaveAttribute("data-now-grouping", "tag");
    });

    await test.step("a tag group opens by →, and ← from a task with parts goes back to its header", async () => {
      const header = `group:tag:${bug}`;
      await expect(list().locator(`[data-now-group-header="tag:${bug}"]`)).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await intoTasks(app, page);
      await page.keyboard.press("Home");
      await expect(focusedStop(header)).toHaveCount(1);
      await page.keyboard.press("ArrowRight");
      await expect(list().locator(`[data-now-group-header="tag:${bug}"]`)).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await page.keyboard.press("ArrowDown");
      await expect(focusedStop(`row:tg-plan@tag:${bug}`)).toHaveCount(1);
      await page.keyboard.press("ArrowLeft");
      await expect(focusedStop(header)).toHaveCount(1);
      await page.keyboard.press("ArrowLeft");
      await expect(list().locator(`[data-now-group-header="tag:${bug}"]`)).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    await test.step("a restart keeps By tag, and By status still lists the plan's parts", async () => {
      await launched.close();
      launched = await launchApp(options);
      ({ app, page } = launched);
      await expandDock(page, "now");
      await expect(grouping()).toHaveAttribute("data-now-grouping", "tag");
      await runFromSearch(app, page, panelCommandId("now", GROUP_ASK));
      const menu = list().locator('[role="menu"]');
      await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]:focus')).toHaveCount(
        1,
      );
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      await expect(grouping()).toHaveAttribute("data-now-grouping", "status");
      const backlog = list().locator('[data-now-group-header="backlog"]');
      if ((await backlog.getAttribute("aria-expanded")) === "false")
        await openGroup(page, "backlog");
      await expect(row("tg-keep")).toBeVisible();
      await expect(row("tg-test")).toBeVisible();
    });

    await test.step("Show tasks by tag: ↓ and Enter on a row open the Board on its tag", async () => {
      await runFromSearch(app, page, panelCommandId("now", BOARD_TAGS_COMMAND));
      await expect(boardCard(page)).toBeVisible();
      const board = boardPage(page);
      await expect(board.locator("[data-board-view]")).toHaveAttribute("data-board-view", "tags");
      const rows = board.locator("[data-board-tag-row]");
      await expect(rows.first()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(rows.nth(1)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(board.locator("[data-board-view]")).toHaveAttribute("data-board-view", "board");
      const ios = board.locator('[data-board-tag][aria-pressed="true"]');
      await expect(ios).toHaveCount(1);
      await expect(ios).not.toHaveAttribute("data-board-tag", "all");
      await expect(board.locator('[data-board-tile="tg-photo"]')).toBeVisible();
      await expect(board.locator('[data-board-tile="tg-plan"]')).toHaveCount(0);
      await expect(board.locator('[data-board-tile="tg-tidy"]')).toHaveCount(0);
    });
  } finally {
    await launched.close();
  }
});
