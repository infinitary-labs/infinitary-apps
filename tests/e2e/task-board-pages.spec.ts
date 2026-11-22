import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { minimumWindowSize, resizeWindow } from "./layout";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { recordCard } from "./rails";
import { clickInBody, SHOWN_ENTRY, stagePrepared } from "./stack";
import {
  BOARD_PANEL,
  boardConfirm,
  boardEntry,
  boardLive,
  boardMenu,
  boardPager,
  boardTile,
  boardViewCount,
  boardViewTab,
  focusedTileKey,
  laneCount,
  laneKeys,
  pressInBoard,
} from "./taskBoard";
import { focusOn, pressWindowKey, runFromSearch, windowComesForward } from "./windowKeys";

/**
 * The task board with hundreds of tasks (docs/task-board.md; FI3-1065, the
 * focused board): 60 in the backlog and 300 done this week. The board
 * draws a page of each lane, never the whole of it, and every count is the
 * whole lane's; the keys reach a task on another page, open its record and
 * come back to the same place; a child whose parent is on another page
 * stands alone as part of it, and no task is drawn twice; the project chip
 * and Find narrow before the pages, and Find's earlier matches stay apart
 * from Done · 7d, say when the search's answer may have been cut, and say
 * when it cannot be read rather than that nothing matched; a live move under the focused row puts focus on the
 * nearest one and says where the task went; a move confirmed by keys runs
 * from an off-page row; and at the narrowest window the arrows still reach
 * every column, each brought into view.
 */

function repo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

const BACKLOG = 60;
const DONE = 300;
/** More older done work than one search answers (50), so its answer is cut. */
const OLDER = 52;

/**
 * Two projects and a busy week, written through the one writer: older done
 * work Find reaches, 300 done this week, 3 dropped, 60 in the backlog - its
 * 20th a parent whose two parts land at the top of the second page - 7
 * queued and held, 4 working and 4 waiting on the captain.
 */
function seedBusyBoard(userDataDir: string): void {
  const db = openDatabase(userDataDir);
  const now = Date.now();
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
  let clock = now - 30 * 24 * 60 * 60_000;
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const cards = new CardStore(db);
  const seed = (seedValue: Parameters<typeof seedTask>[1]) => {
    clock += 60_000;
    seedTask(tasks, { repoId: "repo-fm", startPolicy: "on-request", ...seedValue });
  };
  const worktree = (id: string) => {
    const dir = join(userDataDir, "worktrees", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  for (let i = 0; i < OLDER; i += 1) {
    seed({ id: `older-${i}`, title: `Older search work ${i + 1}`, status: "queued" });
    tasks.close(`older-${i}`, { status: "done", reason: "finished", actor: "host" });
  }
  clock = now - 6 * 24 * 60 * 60_000;
  for (let i = 0; i < DONE; i += 1) {
    seed({ id: `done-${i}`, title: `Finished work ${i + 1}`, status: "queued" });
    tasks.close(`done-${i}`, { status: "done", reason: "finished", actor: "host" });
  }
  for (let i = 0; i < 3; i += 1) {
    seed({ id: `dropped-${i}`, title: `Dropped work ${i + 1}`, status: "cancelled" });
  }
  for (let i = 0; i < 19; i += 1)
    seed({ id: `b-${i}`, title: `Planned ${i + 1}`, status: "queued" });
  seed({ id: "parent", title: "Planned parent", status: "queued" });
  for (let i = 19; i < 55; i += 1)
    seed({ id: `b-${i}`, title: `Planned ${i + 1}`, status: "queued" });
  seed({ id: "part-1", title: "First part", status: "queued", parentId: "parent" });
  seed({ id: "part-2", title: "Second part", status: "queued", parentId: "parent" });
  seed({ id: "web-1", title: "Refresh the site", status: "queued", repoId: "repo-web" });
  seed({ id: "web-2", title: "Rewrite the site's footer", status: "queued", repoId: "repo-web" });
  for (let i = 0; i < 7; i += 1) {
    seed({
      id: `q-${i}`,
      title: `Queued ${i + 1}`,
      status: "queued",
      startPolicy: "when-ready",
      gate: { kind: "at-time", until: now + 30 * 24 * 60 * 60_000 },
    });
  }
  for (let i = 0; i < 4; i += 1) {
    seed({
      id: `w-${i}`,
      title: `Working ${i + 1}`,
      status: "completed",
      worktreeDir: worktree(`w-${i}`),
    });
  }
  for (let i = 0; i < 4; i += 1) {
    seed({
      id: `y-${i}`,
      title: `Review ${i + 1}`,
      status: "completed",
      worktreeDir: worktree(`y-${i}`),
    });
    tasks.turns.recordReport(`y-${i}`, {
      text: "Ready for your review.",
      declared: { wait: { reason: "review it" } },
    });
    cards.upsert({
      id: `choice-${i}`,
      taskId: `y-${i}`,
      author: "firstmate",
      priority: 0,
      title: `Review ${i + 1}`,
      meta: "firstmate",
      body: "<p>Review the work.</p>",
      actions: [
        { id: "accept", label: "Accept" },
        { id: "leave", label: "Leave it" },
      ],
      status: "ready",
      createdAt: clock,
    });
  }
  clock = now;
  db.close();
}

const detail = (page: Page, id: string): Promise<TaskDetail> =>
  page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
const keyOf = async (page: Page, id: string) => (await detail(page, id)).key;

test("with 60 in the backlog and 300 done this week, the board pages every lane and the keys reach every task", async () => {
  test.setTimeout(240_000);
  const userDataDir = scratchDir("infinitary-task-board-pages-");
  seedBusyBoard(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  const { app, page } = launched;
  const press = async (key: string, expected: string) => {
    await page.keyboard.press(key);
    await expect.poll(() => focusedTileKey(page)).toBe(expected);
  };
  try {
    await resizeWindow(app, page, { width: 1600, height: 900 });
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length, {
        timeout: 30_000,
      })
      .toBe(DONE + 3 + BACKLOG + 7 + 4 + 4);
    const first = await keyOf(page, "b-0");
    const parent = await keyOf(page, "parent");
    const [part1, part2] = [await keyOf(page, "part-1"), await keyOf(page, "part-2")];
    const last = await keyOf(page, "web-2");

    await test.step("the Board draws a page of each lane, and every count is the whole lane's", async () => {
      await pressWindowKey(app, "b", ["meta"]);
      await expect(boardEntry(page)).toBeVisible();
      // Three of Waiting on you, the first five of the backlog, five queued, four working.
      await expect(boardEntry(page).locator("[data-board-tile]")).toHaveCount(3 + 5 + 5 + 4);
      await test.step("the prepared card hands focus back before the board's first key", async () => {
        // INF-1152, as INF-1125 in task-board-moves.spec: a waiting card is
        // prepared in a new process behind the focused board. The next
        // injected key focuses the window, and that page hands focus to the
        // shell: ↓ can reach the board's body before the shell gives the
        // tile focus back. Complete that handoff without a key first, as
        // task-board.spec does; never retry the press. The board put focus
        // on its tiles' stop, the first of Waiting on you.
        const stop = (await laneKeys(page, "waiting"))[0];
        await expect.poll(() => focusedTileKey(page)).toBe(stop);
        await stagePrepared(page);
        await windowComesForward(app, page);
        await expect.poll(() => focusedTileKey(page)).toBe(stop);
      });
      expect(await laneCount(page, "waiting")).toBe(4);
      expect(await laneCount(page, "backlog")).toBe(BACKLOG);
      expect(await laneCount(page, "queued")).toBe(7);
      await expect(boardViewCount(page, "backlog")).toHaveText(String(BACKLOG));
      await expect(boardViewCount(page, "landed")).toHaveText(String(DONE));
      await expect(boardPager(page, "waiting").browse).toBeVisible();
      // Backlog pages five at a time as Queued and Working do (the captain's
      // ask: "the backlog column in our kanban board should have pagination
      // just like the other columns"), and the arrows walk on past its page.
      const backlogFrom = (from: number) =>
        Promise.all([0, 1, 2, 3, 4].map((i) => keyOf(page, `b-${from + i}`)));
      expect(await laneKeys(page, "backlog")).toEqual(await backlogFrom(0));
      await pressInBoard(boardPager(page, "backlog").next);
      await expect.poll(() => laneKeys(page, "backlog")).toEqual(await backlogFrom(5));
      await pressInBoard(boardPager(page, "backlog").previous);
      await expect.poll(() => laneKeys(page, "backlog")).toEqual(await backlogFrom(0));
      await focusOn(boardTile(page, await keyOf(page, "b-4")));
      await press("ArrowDown", await keyOf(page, "b-5"));
      expect(await laneKeys(page, "backlog")).toEqual(await backlogFrom(5));
      await press("End", last);
      expect(await laneKeys(page, "backlog")).toContain(last);
      // Queued turns to its second page; the Backlog view opens the backlog
      // as a list on its own first page, twenty a page.
      await pressInBoard(boardPager(page, "queued").next);
      expect(await laneKeys(page, "queued")).toHaveLength(2);
      await pressInBoard(boardViewTab(page, "backlog"));
      await expect(boardViewTab(page, "backlog")).toHaveAttribute("aria-pressed", "true");
      expect(await laneKeys(page, "backlog")).toHaveLength(20);
      expect((await laneKeys(page, "backlog"))[0]).toBe(first);
      // Done · 7d is a list of its own, a page at a time.
      await pressInBoard(boardViewTab(page, "landed"));
      await expect(boardViewTab(page, "landed")).toHaveAttribute("aria-pressed", "true");
      expect(await laneCount(page, "landed")).toBe(DONE);
      expect(await laneKeys(page, "landed")).toHaveLength(20);
      const firstPage = await laneKeys(page, "landed");
      await pressInBoard(boardPager(page, "landed").next);
      await expect.poll(() => laneKeys(page, "landed")).not.toEqual(firstPage);
      expect(await laneKeys(page, "landed")).toHaveLength(20);
      await pressInBoard(boardPager(page, "waiting").browse);
      expect(await laneKeys(page, "waiting")).toHaveLength(4);
    });

    await test.step("the keys reach a task on another page, open its record, and come back to the same place", async () => {
      await stagePrepared(page);
      await runFromSearch(app, page, `panel:${BOARD_PANEL}/board-backlog`);
      await expect.poll(() => focusedTileKey(page)).toBe(first);
      await press("End", last);
      expect(await laneKeys(page, "backlog")).toHaveLength(20);
      await page.keyboard.press("Enter");
      await expect(recordCard(page)).toBeVisible();
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute(
        "data-stage-entry-id",
        "record:web-2",
      );
      await pressWindowKey(app, "]", ["meta", "shift"]);
      await expect(boardEntry(page)).toBeVisible();
      await expect(boardViewTab(page, "backlog")).toHaveAttribute("aria-pressed", "true");
      await expect(boardTile(page, last)).toHaveAttribute("data-board-selected", "");
      // The keyboard comes back to the selected row once the stage has
      // prepared the decision behind the board again.
      await stagePrepared(page);
      await runFromSearch(app, page, `panel:${BOARD_PANEL}/board-backlog`);
      await expect.poll(() => focusedTileKey(page)).toBe(last);
      await press("Home", first);
      await expect(boardTile(page, last)).toHaveCount(0);
    });

    await test.step("a part whose parent is on another page stands alone as part of it, and no task is drawn twice", async () => {
      await press("End", last);
      await press("Home", first);
      // The parent closes the first page; ↓ turns to the second, where its parts start.
      for (let n = 0; n < 19; n += 1) await page.keyboard.press("ArrowDown");
      await expect.poll(() => focusedTileKey(page)).toBe(parent);
      await press("ArrowDown", part1);
      await expect(boardTile(page, parent)).toHaveCount(0);
      for (const part of [part1, part2]) {
        await expect(boardTile(page, part).locator("[data-board-word]")).toHaveAttribute(
          "data-board-word",
          "part",
        );
      }
      await press("ArrowUp", parent);
      const seen: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        if (n > 0) await pressInBoard(boardPager(page, "backlog").next);
        await expect
          .poll(async () => (await laneKeys(page, "backlog")).includes(seen.at(-1) ?? ""))
          .toBe(false);
        seen.push(...(await laneKeys(page, "backlog")));
      }
      expect(seen).toHaveLength(BACKLOG);
      expect(new Set(seen).size).toBe(BACKLOG);
      expect(seen.filter((key) => key === part1 || key === part2)).toEqual([part1, part2]);
    });

    await test.step("the project chip and Find narrow before the pages, and Find's earlier matches stay apart from Done · 7d", async () => {
      await clickInBody(boardEntry(page).locator('[data-board-chip="WEB"]'));
      await expect(boardViewCount(page, "backlog")).toHaveText("2");
      expect(await laneKeys(page, "backlog")).toEqual([await keyOf(page, "web-1"), last]);
      await expect(boardPager(page, "backlog").next).toHaveCount(0);
      await clickInBody(boardEntry(page).locator('[data-board-chip="all"]'));
      const find = boardEntry(page).locator("[data-board-find]");
      await find.fill("older search");
      // The search answers its 50 newest: partial results, never a total.
      await expect(boardViewCount(page, "earlier")).toHaveText("50+");
      // Older results never count toward this week's Done.
      await expect(boardViewCount(page, "landed")).toHaveText("0");
      await pressInBoard(boardViewTab(page, "earlier"));
      await expect(boardEntry(page).locator('[data-board-earlier-note="capped"]')).toBeVisible();
      expect(await laneCount(page, "earlier")).toBe(50);
      expect(await laneKeys(page, "earlier")).toHaveLength(20);
      await find.fill("nothing has these words");
      await expect(boardViewCount(page, "backlog")).toHaveText("0");
      await expect(boardEntry(page).locator('[data-board-empty="earlier"]')).toBeVisible();
      // Words the app's search refuses: the list says earlier results are
      // unavailable, never that nothing matched.
      await find.fill("x".repeat(201));
      await expect(boardEntry(page).locator('[data-board-earlier-note="unavailable"]')).toBeVisible(
        { timeout: 20_000 },
      );
      await expect(boardEntry(page).locator('[data-board-empty="earlier"]')).toHaveCount(0);
      await find.fill("");
      await expect(boardViewTab(page, "earlier")).toHaveCount(0);
      await pressInBoard(boardViewTab(page, "backlog"));
      expect(await laneKeys(page, "backlog")).toHaveLength(20);
    });

    await test.step("a live move takes the focused row away: focus goes to the nearest row, and the live line says where it went", async () => {
      const second = await keyOf(page, "b-1");
      const third = await keyOf(page, "b-2");
      await focusOn(boardTile(page, second));
      await expect.poll(() => focusedTileKey(page)).toBe(second);
      // Another surface queues it underneath.
      await page.evaluate(() => window.infinitary.task.run("b-1", "queue-task"));
      await expect.poll(() => focusedTileKey(page)).toBe(third);
      await expect(boardLive(page)).toContainText(second);
      await expect(boardViewCount(page, "backlog")).toHaveText(String(BACKLOG - 1));
    });

    await test.step("a move confirmed by keys runs from a row on the last page", async () => {
      await press("End", last);
      await page.keyboard.press("Space");
      const menu = boardMenu(page, last);
      await expect(menu.menu).toBeVisible();
      await pressInBoard(menu.entry("queue"));
      const confirm = boardConfirm(page, last);
      await expect(confirm.card).toHaveAttribute("data-board-confirm", "queue-task");
      expect((await detail(page, "web-2")).startPolicy).toBe("on-request");
      await pressInBoard(confirm.go);
      await expect.poll(async () => (await detail(page, "web-2")).startPolicy).toBe("when-ready");
      // Focus follows the move to the row now nearest where it stood.
      await expect.poll(() => focusedTileKey(page)).toBe(await keyOf(page, "web-1"));
    });

    await test.step("at the narrowest window the arrows still reach every column, each brought into view", async () => {
      await resizeWindow(app, page, await minimumWindowSize(app));
      await pressInBoard(boardViewTab(page, "board"));
      // The two tasks queued above have started, so the lanes hold still under the arrows.
      for (const id of ["b-1", "web-2"]) {
        await expect(boardTile(page, await keyOf(page, id))).toHaveAttribute(
          "data-board-lane",
          "working",
        );
      }
      const backlog = (await laneKeys(page, "backlog"))[0] as string;
      const queued = (await laneKeys(page, "queued"))[0] as string;
      const working = (await laneKeys(page, "working"))[0] as string;
      await focusOn(boardTile(page, backlog));
      await press("ArrowRight", queued);
      await press("ArrowRight", working);
      await expect(boardTile(page, working)).toBeInViewport();
    });
  } finally {
    await launched.close();
  }
});
