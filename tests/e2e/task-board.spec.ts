import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { expectClearOf } from "./layout";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { expandDock, openRowSummary, POINT_SUMMARY, recordCard, rowSummary } from "./rails";
import { clickInBody, SHOWN_ENTRY, stagePrepared } from "./stack";
import {
  BOARD_PANEL,
  boardEntry,
  boardEntryId,
  boardFocusOn,
  boardsOnStage,
  boardTile,
  boardView,
  boardViewTab,
  focusedTileKey,
  hideBoard,
  laneKeys,
  openBoardButton,
  pressInBoard,
} from "./taskBoard";
import {
  commandSearch,
  focusOn,
  pressKey,
  pressWindowKey,
  runFromSearch,
  typeInto,
  windowComesForward,
} from "./windowKeys";

/**
 * The task board (docs/task-board.md; FI3-979 piece 2, FI3-1065's focused
 * board), driven the way a person with a keyboard drives it: Open task
 * board in the Tasks header in both states and on ⌘B, one board however
 * often it is asked for, its keys kept when the window comes forward while
 * a decision waits behind it, the arrows through Waiting on you and the Board's
 * columns, the Backlog list by its button and by name, Enter to a task's
 * record, the board keeping its chip, view and selected tile while it
 * pages, the selected tile as the turn's hint, Find and its earlier
 * matches, the dropped list by name, Esc in its order, and a fresh board
 * after Hide that keeps the window's project focus (INF-1091: the chip is the
 * top bar's focus, so Hide does not let it go). The board is the Tasks panel's card, drawn in a page of its
 * own; its helpers read inside it.
 */

function repo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

/** Two projects and a task in every lane, written through the one writer. */
function seedBoard(userDataDir: string): void {
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
  const cards = new CardStore(db);
  const worktree = (id: string) => {
    const dir = join(userDataDir, "worktrees", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const seed = (seedValue: Parameters<typeof seedTask>[1]) => {
    clock += 60_000;
    seedTask(tasks, { repoId: "repo-fm", ...seedValue });
  };
  // FM3K-1: its crewmate finished and declared it waits on the captain, and
  // its decision card is up.
  seed({
    id: "waits",
    title: "Review the planned work",
    status: "completed",
    worktreeDir: worktree("waits"),
  });
  tasks.turns.recordReport("waits", {
    text: "Ready for your review.",
    declared: { wait: { reason: "review the plan" } },
  });
  cards.upsert({
    id: "review-choice",
    taskId: "waits",
    author: "firstmate",
    priority: 0,
    title: "Review the planned work",
    meta: "firstmate",
    body: "<p>Review the plan.</p>",
    actions: [
      { id: "accept", label: "Accept" },
      { id: "leave", label: "Leave it" },
    ],
    status: "ready",
    createdAt: clock,
  });
  // FM3K-2 and FM3K-3: backlog, the first at the top priority.
  seed({ id: "alpha", title: "Ship the alpha", status: "queued", startPolicy: "on-request" });
  tasks.updateFields("alpha", { priority: 0 }, "host");
  seed({
    id: "history",
    title: "Search task history",
    status: "queued",
    startPolicy: "on-request",
  });
  // FM3K-4: queued, held until next month so nothing starts it.
  seed({
    id: "cards",
    title: "Make cards easier to read",
    status: "queued",
    gate: { kind: "at-time", until: now + 30 * 24 * 60 * 60_000 },
  });
  // FM3K-5: working, its crewmate idle with its work kept.
  seed({
    id: "setup",
    title: "Simplify project setup",
    status: "completed",
    worktreeDir: worktree("setup"),
  });
  // FM3K-6: done this week; FM3K-7: dropped this week.
  seed({
    id: "steady",
    title: "Keep search results steady",
    status: "queued",
    startPolicy: "on-request",
  });
  tasks.close("steady", { status: "done", reason: "finished", actor: "host" });
  seed({ id: "toolbar", title: "Add another toolbar", status: "cancelled" });
  // WEB-1: backlog in the second project.
  seed({
    id: "site",
    title: "Refresh the website",
    status: "queued",
    startPolicy: "on-request",
    repoId: "repo-web",
  });
  clock = now;
  db.close();
}

test("the task board opens from the Tasks header and ⌘B, and the keyboard drives it", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-task-board-");
  seedBoard(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  const { app, page } = launched;
  const detail = (id: string) =>
    page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
  const press = async (key: string, expected: string) => {
    await page.keyboard.press(key);
    await expect.poll(() => focusedTileKey(page)).toBe(expected);
    await expect(boardTile(page, expected)).toHaveAttribute("data-board-selected", "");
  };
  try {
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length)
      .toBe(8);

    await test.step("Open task board sits in the Tasks header collapsed and expanded, and opens one board", async () => {
      const panel = page.locator('[data-side-panel="now"]');
      await expect(panel).toHaveAttribute("data-side-panel-collapsed", "");
      await expect(openBoardButton(page)).toBeVisible();
      await focusOn(promptInput(page));
      await openBoardButton(page).click();
      await expect(boardEntry(page)).toBeVisible();
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute(
        "data-stage-entry-id",
        boardEntryId(),
      );
      // Each task once, under its own state's lane: the Board's columns are
      // the work not yet done, Backlog first, and Done · 7d is a list of its own.
      expect(await boardView(page)).toBe("board");
      expect(await laneKeys(page, "waiting")).toEqual(["FM3K-1"]);
      expect(await laneKeys(page, "backlog")).toEqual(["FM3K-2", "FM3K-3", "WEB-1"]);
      expect(await laneKeys(page, "queued")).toEqual(["FM3K-4"]);
      expect(await laneKeys(page, "working")).toEqual(["FM3K-5"]);
      expect(await laneKeys(page, "landed")).toEqual([]);
      await pressInBoard(boardViewTab(page, "landed"));
      await expect(boardViewTab(page, "landed")).toHaveAttribute("aria-pressed", "true");
      expect(await laneKeys(page, "landed")).toEqual(["FM3K-6"]);
      // Waiting on you stays above every view.
      expect(await laneKeys(page, "waiting")).toEqual(["FM3K-1"]);
      expect(await laneKeys(page, "dropped")).toEqual([]);
      await expandDock(page, "now");
      await openBoardButton(page).click();
      await expect(boardsOnStage(page)).toHaveCount(1);
      await hideBoard(page).click();
      await expect(boardsOnStage(page)).toHaveCount(0);
    });

    await test.step("⌘B opens the board with focus on its tiles, the window coming forward keeps it there, and a repeat finds the same board", async () => {
      await pressWindowKey(app, "b", ["meta"]);
      await expect(boardEntry(page)).toBeVisible();
      // Hide let go of the Done · 7d view: a new board opens on the Board.
      expect(await boardView(page)).toBe("board");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-1");
      // The decision behind the board is prepared in a page of its own while
      // the board has the keyboard; when the window comes forward, that page
      // hands focus to the window's own page, which gives it back to the tile.
      await stagePrepared(page);
      await windowComesForward(app, page);
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-1");
      await press("ArrowDown", "FM3K-2");
      await press("ArrowUp", "FM3K-1");
      await pressWindowKey(app, "b", ["meta"]);
      await expect(boardsOnStage(page)).toHaveCount(1);
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-1");
    });

    await test.step("the arrows reach Waiting on you and every column, and a tile the keyboard rests on opens its summary", async () => {
      await press("ArrowDown", "FM3K-2");
      await press("ArrowRight", "FM3K-4");
      await press("ArrowRight", "FM3K-5");
      await press("ArrowLeft", "FM3K-4");
      await press("ArrowUp", "FM3K-1");
      await press("ArrowDown", "FM3K-2");
      await press("ArrowRight", "FM3K-4");
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, "cards");
      // The tile lights as its own rest does, as the lit task reaches it (INF-237); no other does.
      await expect(boardTile(page, "FM3K-4")).toHaveAttribute("data-board-lit", "");
      await expect(boardTile(page, "FM3K-1")).not.toHaveAttribute("data-board-lit", "");
      // The summary leaves the tile and input usable.
      await expectClearOf(
        page,
        page.locator("[data-point-summary] > div").last(),
        boardTile(page, "FM3K-4"),
        page.locator("[data-prompt-dock]"),
      );
      // The tiles are one stop: Tab leaves them for the foot.
      await page.keyboard.press("Tab");
      await expect.poll(() => focusedTileKey(page)).toBeNull();
      await expect
        .poll(() => boardFocusOn(page, boardEntry(page).locator("[data-board-dropped-toggle]")))
        .toBe(true);
    });

    await test.step("Show the backlog by name lands on its rows, and the arrows walk them", async () => {
      await runFromSearch(app, page, `panel:${BOARD_PANEL}/board-backlog`);
      await expect(boardViewTab(page, "backlog")).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-2");
      await press("ArrowDown", "FM3K-3");
      await press("End", "WEB-1");
      await press("Home", "FM3K-2");
      await press("ArrowUp", "FM3K-1");
      await press("ArrowDown", "FM3K-2");
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, "alpha");
      await expectClearOf(
        page,
        page.locator("[data-point-summary] > div").last(),
        boardTile(page, "FM3K-2"),
        page.locator("[data-prompt-dock]"),
      );
    });

    await test.step("Enter opens a row's record, and the board keeps its chip, view and selection while it pages", async () => {
      await clickInBody(boardEntry(page).locator('[data-board-chip="FM3K"]'));
      await expect(boardTile(page, "WEB-1")).toHaveCount(0);
      await pressKey(boardTile(page, "FM3K-3"), "Enter");
      await expect(recordCard(page)).toBeVisible();
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute(
        "data-stage-entry-id",
        "record:history",
      );
      await pressWindowKey(app, "]", ["meta", "shift"]);
      await expect(boardEntry(page)).toBeVisible();
      await expect(boardEntry(page).locator('[data-board-chip="FM3K"]')).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(boardViewTab(page, "backlog")).toHaveAttribute("aria-pressed", "true");
      await expect(boardTile(page, "WEB-1")).toHaveCount(0);
      await expect(boardTile(page, "FM3K-3")).toHaveAttribute("data-board-selected", "");
    });

    await test.step("the selected tile is the turn's hint", async () => {
      await pressWindowKey(app, "l", ["meta"]);
      await expect(promptInput(page)).toBeFocused();
      await promptInput(page).fill("is this one still needed?");
      await promptInput(page).press("Enter");
      await expect
        .poll(async () => (await detail("history")).asks.map((ask) => ask.text), {
          timeout: 20_000,
        })
        .toContain("is this one still needed?");
    });

    await test.step("Find on task board by name, with earlier matches only while it has words; Esc closes the summary, then clears Find, then hides", async () => {
      await stagePrepared(page);
      await runFromSearch(app, page, `panel:${BOARD_PANEL}/board-find`);
      const find = boardEntry(page).locator("[data-board-find]");
      await expect.poll(() => boardFocusOn(page, find)).toBe(true);
      await expect(boardViewTab(page, "earlier")).toHaveCount(0);
      await typeInto(find, "history");
      await expect(boardEntry(page).locator("[data-board-tile]")).toHaveCount(1);
      await expect(boardViewTab(page, "earlier")).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-3");
      // This rest's own summary, not the last rest's on the same task as it fades out (INF-595).
      await expect(openRowSummary(page)).toHaveAttribute(POINT_SUMMARY, "history");
      // A list's scroll can be heard a frame after the summary read where its
      // tile is; one that left the tile there keeps the summary (INF-595).
      await boardTile(page, "FM3K-3").evaluate((tile) => {
        const rows = tile.closest("[data-board-list-rows]");
        if (!rows) throw new Error("FM3K-3 is not a list's row");
        rows.dispatchEvent(new Event("scroll"));
      });
      await page.keyboard.press("Escape");
      await expect(rowSummary(page)).toHaveCount(0);
      await expect(find).toHaveValue("history");
      await page.keyboard.press("Escape");
      await expect(find).toHaveValue("");
      await expect(boardViewTab(page, "earlier")).toHaveCount(0);
      await expect(boardEntry(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(boardsOnStage(page)).toHaveCount(0);
    });

    await test.step("after Hide the board starts fresh on the focused project, and Show dropped tasks opens its list", async () => {
      await expect(commandSearch(page).dialog).toHaveCount(0);
      await pressWindowKey(app, "b", ["meta"]);
      await expect(boardEntry(page).locator('[data-board-chip="FM3K"]')).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(boardEntry(page).locator("[data-board-find]")).toHaveValue("");
      await expect(boardViewTab(page, "board")).toHaveAttribute("aria-pressed", "true");
      await expect(boardEntry(page).locator('[data-board-list="dropped"]')).toHaveCount(0);
      await stagePrepared(page);
      await runFromSearch(app, page, `panel:${BOARD_PANEL}/board-dropped`);
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-7");
      expect(await laneKeys(page, "dropped")).toEqual(["FM3K-7"]);
      await expect(boardEntry(page).locator("[data-board-dropped-toggle]")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.keyboard.press("ArrowUp");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-1");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-7");
      await page.keyboard.press("Enter");
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute(
        "data-stage-entry-id",
        "record:toolbar",
      );
    });
  } finally {
    await launched.close();
  }
});
