import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { dropConfirmLead, dropPartsLine, dropWaitingLine } from "../../src/shared/recordDrop";
import { STARTED_BACKLOG_REASON } from "../../src/shared/taskPresentation";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { measured } from "./perf";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { SHOWN_ENTRY, stagePrepared } from "./stack";
import {
  BOARD_PANEL,
  boardConfirm,
  boardDrop,
  boardEntry,
  boardFocusOn,
  boardLive,
  boardMenu,
  boardTile,
  boardViewTab,
  dragTile,
  focusedTileKey,
  laneKeys,
  pressInBoard,
} from "./taskBoard";
import { pressKey, pressWindowKey, runFromSearch, windowComesForward } from "./windowKeys";

/**
 * The task board's moves (docs/task-board.md, "Moves"; FI3-979 piece 3,
 * FI3-1065's focused board), the way a person makes them: dragging a tile
 * on the Board onto a column or the Drop task tray, and the same moves
 * from a tile's or a Backlog row's ⋯ menu by keys - a list's rows move by
 * their menus alone. A move that asks once asks on the tile where it
 * landed, or on its row, and writes nothing until its confirm; a refusal
 * says why on the live line and writes nothing; Show the card brings the
 * task's completion card forward and merges nothing; a live change under
 * a confirmation cancels it. Every write is read back from the task's own
 * record, where it lands as the captain's, from the task card.
 */

const COMPLETION_CARD = "card-moves-merge";

function repo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

/** One project and a task for every move, written through the one writer. */
function seedMoves(userDataDir: string): void {
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
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const worktree = (id: string) => {
    const dir = join(userDataDir, "worktrees", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const seed = (seedValue: Parameters<typeof seedTask>[1]) => {
    clock += 60_000;
    seedTask(tasks, { repoId: "repo-fm", startPolicy: "on-request", ...seedValue });
  };
  // FM3K-1: its crewmate is idle and its completion card is up.
  seed({ id: "ready", title: "Ready to merge", status: "idle", worktreeDir: worktree("ready") });
  // FM3K-2 .. FM3K-4: backlog that could start at once; a blocker and the work it holds.
  seed({ id: "queue-me", title: "Queue me", status: "queued" });
  seed({ id: "blocker", title: "Blocker", status: "queued" });
  seed({ id: "blocked", title: "Blocked", status: "queued" });
  tasks.graph.link("blocker", "blocked", "blocks", "host");
  // FM3K-5: queued, held until next month.
  seed({
    id: "held",
    title: "Held",
    status: "queued",
    startPolicy: "when-ready",
    gate: { kind: "at-time", until: now + 30 * 24 * 60 * 60_000 },
  });
  // FM3K-6 and its part FM3K-7.
  seed({ id: "parent", title: "Parent", status: "queued" });
  seed({ id: "part", title: "Part", status: "queued", parentId: "parent" });
  // FM3K-8: started; its crewmate is idle with its work kept.
  seed({ id: "started", title: "Started", status: "idle", worktreeDir: worktree("started") });
  // FM3K-9 .. FM3K-13: started from the Backlog by menu twice, dropped by
  // the tray (queued, so it is on the Board) and by menu, and changed while
  // it asks.
  seed({ id: "start-drag", title: "Start from the list", status: "queued" });
  seed({ id: "start-menu", title: "Start by menu", status: "queued" });
  seed({
    id: "drop-tray",
    title: "Drop by tray",
    status: "queued",
    startPolicy: "when-ready",
    gate: { kind: "at-time", until: now + 30 * 24 * 60 * 60_000 },
  });
  seed({ id: "drop-menu", title: "Drop by menu", status: "queued" });
  seed({ id: "changes", title: "Changes underneath", status: "queued" });
  // FM3K-14 waits on FM3K-11, so dropping it names what still waits.
  seed({ id: "waiter", title: "Waiter", status: "queued", startPolicy: "when-ready" });
  tasks.graph.link("drop-tray", "waiter", "blocks", "host");
  new CardStore(db).upsert({
    id: COMPLETION_CARD,
    taskId: "ready",
    author: "crewmate",
    priority: 30,
    title: "Ready to merge is ready",
    meta: "",
    body: "<p>The checks passed.</p>",
    actions: [
      {
        id: "merge",
        label: "Merge the pull request",
        variant: "primary",
        default: true,
        effect: { kind: "merge", after: "close" },
      },
    ],
    status: "ready",
    createdAt: clock,
  });
  clock = now;
  db.close();
}

/**
 * From the app writing a move to the board's page having painted it, and
 * one paint of the board: a stall ceiling and a paint ceiling, graded only
 * on a perf run (./perf.ts), as the Tasks panel's own are.
 */
const BOARD_LAG_BUDGET_MS = 1_000;
const BOARD_RENDER_BUDGET_MS = 50;

/** The two User Timing measures the board records in its page (`board:lag`, `board:render`). */
function boardMeasures(page: Page): Promise<{ lag: number[]; render: number[] }> {
  return boardEntry(page).evaluate(() => ({
    lag: performance.getEntriesByName("board:lag").map((entry) => entry.duration),
    render: performance.getEntriesByName("board:render").map((entry) => entry.duration),
  }));
}

const detail = (page: Page, id: string): Promise<TaskDetail> =>
  page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);

/**
 * The captain's moves on the task's history, from the task card as the
 * record's own buttons write them: the app's own Tasks panel names no
 * panel. None before a confirm.
 */
async function captainMoves(page: Page, id: string): Promise<string[]> {
  const { events } = await detail(page, id);
  return events
    .filter(
      (event) =>
        event.actor === "captain" &&
        event.data?.via === "task-card" &&
        event.data?.panel === undefined,
    )
    .map((event) => event.kind);
}

test("the task board moves tasks by drag and by menu, asking on the tile and writing only what was confirmed", async () => {
  test.setTimeout(240_000);
  const userDataDir = scratchDir("infinitary-task-board-moves-");
  seedMoves(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  const { app, page } = launched;
  try {
    // Wide enough for the board's columns side by side.
    await resizeWindow(app, page, { width: 1440, height: 900 });
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length)
      .toBe(14);
    await pressWindowKey(app, "b", ["meta"]);
    await expect(boardEntry(page)).toBeVisible();
    await expect.poll(() => laneKeys(page, "waiting")).toEqual(["FM3K-1"]);
    await test.step("the prepared card hands focus back before the board's first key", async () => {
      // INF-1125: the waiting card is prepared in a new process behind the
      // focused board. The next injected key focuses the window, and that
      // page hands focus to the shell: Space can reach the board's BODY
      // before the shell restores its tile. Complete that focus handoff
      // without a key first, as task-board.spec does; never retry the press.
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-1");
      await stagePrepared(page);
      await windowComesForward(app, page);
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-1");
    });

    const backlogMenu = async (key: string, entry: string) => {
      await pressInBoard(boardViewTab(page, "backlog"));
      await expect(boardViewTab(page, "backlog")).toHaveAttribute("aria-pressed", "true");
      await pressKey(boardTile(page, key), "Space");
      const menu = boardMenu(page, key);
      await expect(menu.menu).toBeVisible();
      await pressInBoard(menu.entry(entry));
    };
    const toBoard = async () => {
      await pressInBoard(boardViewTab(page, "board"));
      await expect(boardViewTab(page, "board")).toHaveAttribute("aria-pressed", "true");
    };

    await test.step("a Backlog row's Queue it asks on the row; Cancel writes nothing, and a row is never dragged", async () => {
      await backlogMenu("FM3K-2", "queue");
      const confirm = boardConfirm(page, "FM3K-2");
      await expect(confirm.card).toHaveAttribute("data-board-confirm", "queue-task");
      // The list draws no Queued column: it asks on the row, its status unchanged, Cancel focused.
      await expect(boardTile(page, "FM3K-2")).toHaveAttribute("data-board-lane", "backlog");
      await expect.poll(() => boardFocusOn(page, confirm.cancel)).toBe(true);
      expect((await detail(page, "queue-me")).startPolicy).toBe("on-request");
      await pressInBoard(confirm.cancel);
      await expect(confirm.card).toHaveCount(0);
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-2");
      expect(await captainMoves(page, "queue-me")).toEqual([]);
      // No cross-view drag: a list's rows move by their menus alone.
      await expect(boardTile(page, "FM3K-2")).not.toHaveAttribute("data-board-movable", "");
      await expect(boardDrop(page, "queued")).toHaveCount(0);
    });

    await test.step("a blocked row queues at once and keeps its blocker, and goes back to Backlog at once", async () => {
      await backlogMenu("FM3K-4", "queue");
      await expect.poll(async () => (await detail(page, "blocked")).startPolicy).toBe("when-ready");
      expect((await detail(page, "blocked")).blockedBy).toEqual(["FM3K-3"]);
      // It left the list: focus lands on the row now nearest where it was.
      await expect.poll(() => laneKeys(page, "backlog")).not.toContain("FM3K-4");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-6");
      await expect(boardLive(page)).toHaveAttribute("data-board-live", "said");
      await toBoard();
      await expect(boardTile(page, "FM3K-4")).toHaveAttribute("data-board-lane", "queued");
      await dragTile(page, "FM3K-4", "backlog");
      await expect.poll(async () => (await detail(page, "blocked")).startPolicy).toBe("on-request");
      await expect(boardTile(page, "FM3K-4")).toHaveAttribute("data-board-lane", "backlog");
      await dragTile(page, "FM3K-4", "queued");
      await expect.poll(async () => (await detail(page, "blocked")).startPolicy).toBe("when-ready");
      await expect(boardTile(page, "FM3K-4")).toHaveAttribute("data-board-lane", "queued");
      await pressKey(boardTile(page, "FM3K-4"), "Space");
      await pressInBoard(boardMenu(page, "FM3K-4").entry("unqueue"));
      await expect.poll(async () => (await detail(page, "blocked")).startPolicy).toBe("on-request");
      await expect(boardTile(page, "FM3K-4")).toHaveAttribute("data-board-lane", "backlog");
      expect(await captainMoves(page, "blocked")).toEqual(["note", "note", "note", "note"]);
      // Every write landed on a board whose page was alive before it, so
      // each paint is measured from the app's write.
      const { lag, render } = await boardMeasures(page);
      expect(lag.length).toBeGreaterThanOrEqual(2);
      measured("board:lag", lag, BOARD_LAG_BUDGET_MS);
      measured("board:render", render, BOARD_RENDER_BUDGET_MS);
    });

    await test.step("the Board's columns refuse held, waiting and started tiles, and the menu lists Start now dim on blocked and parent rows", async () => {
      const refuses = async (key: string, id: string, target: string) => {
        const before = await detail(page, id);
        await dragTile(page, key, target, {
          whileOver: () =>
            expect(boardDrop(page, target)).toHaveAttribute("data-board-accepts", "no"),
        });
        await expect(boardLive(page)).toHaveAttribute("data-board-live", "refused");
        await expect(boardLive(page)).not.toBeEmpty();
        await expect.poll(() => focusedTileKey(page)).toBe(key);
        const after = await detail(page, id);
        expect([after.status, after.startPolicy, after.events.length]).toEqual([
          before.status,
          before.startPolicy,
          before.events.length,
        ]);
      };
      await refuses("FM3K-5", "held", "working");
      await refuses("FM3K-14", "waiter", "working");
      await refuses("FM3K-8", "started", "queued");
      await refuses("FM3K-1", "ready", "working");
      for (const key of ["FM3K-4", "FM3K-6"]) {
        await backlogMenu(key, "start");
        await expect(boardMenu(page, key).entry("start")).toHaveAttribute("aria-disabled", "true");
        await page.keyboard.press("Escape");
        await expect(boardMenu(page, key).menu).toHaveCount(0);
        await expect.poll(() => focusedTileKey(page)).toBe(key);
      }
      expect((await detail(page, "blocked")).status).toBe("open");
      expect((await detail(page, "parent")).status).toBe("open");
      await toBoard();
    });

    // INF-2062: the captain approved letting a started task go back to the backlog with its work kept.
    await test.step("a started tile goes back to the Backlog by its menu at once, keeps its work, and Start brings it back after asking once", async () => {
      const before = await detail(page, "started");
      await pressKey(boardTile(page, "FM3K-8"), "Space");
      const menu = boardMenu(page, "FM3K-8");
      await expect(menu.menu).toBeVisible();
      await pressInBoard(menu.entry("unqueue"));
      await expect.poll(async () => (await detail(page, "started")).backlogSince).toBeDefined();
      const parked = await detail(page, "started");
      expect([parked.status, parked.startedAt]).toEqual(["active", before.startedAt]);
      await expect(boardLive(page)).toHaveAttribute("data-board-live", "said");
      await pressInBoard(boardViewTab(page, "backlog"));
      await expect.poll(() => laneKeys(page, "backlog")).toContain("FM3K-8");
      await expect(boardTile(page, "FM3K-8")).toContainText(STARTED_BACKLOG_REASON);
      await expect(boardTile(page, "FM3K-8").locator("[data-board-wait-since]")).toBeVisible();
      await pressKey(boardTile(page, "FM3K-8"), "Space");
      await expect(boardMenu(page, "FM3K-8").entry("queue")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await pressInBoard(boardMenu(page, "FM3K-8").entry("start"));
      const asking = boardConfirm(page, "FM3K-8");
      await expect(asking.card).toHaveAttribute("data-board-confirm", "start-task");
      expect((await detail(page, "started")).backlogSince).toBeDefined();
      await pressInBoard(asking.go);
      await expect.poll(async () => (await detail(page, "started")).backlogSince).toBeUndefined();
      expect((await detail(page, "started")).status).toBe("active");
      await expect.poll(() => laneKeys(page, "backlog")).not.toContain("FM3K-8");
      await toBoard();
      await expect(boardTile(page, "FM3K-8")).toHaveAttribute("data-board-lane", "working");
    });

    await test.step("Start now from a Backlog row's menu runs the record's Start after asking once", async () => {
      await backlogMenu("FM3K-9", "start");
      const first = boardConfirm(page, "FM3K-9");
      await expect(first.card).toHaveAttribute("data-board-confirm", "start-task");
      expect((await detail(page, "start-drag")).status).toBe("open");
      await pressInBoard(first.go);
      await expect
        .poll(async () => (await detail(page, "start-drag")).status, { timeout: 30_000 })
        .toBe("active");
      await toBoard();
      await expect(boardTile(page, "FM3K-9")).toHaveAttribute("data-board-lane", "working");

      await pressInBoard(boardViewTab(page, "backlog"));
      await pressKey(boardTile(page, "FM3K-10"), "Space");
      const menu = boardMenu(page, "FM3K-10");
      await expect(menu.menu).toBeVisible();
      await expect.poll(() => boardFocusOn(page, menu.entry("open"))).toBe(true);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => boardFocusOn(page, menu.entry("start"))).toBe(true);
      await page.keyboard.press("Enter");
      const byMenu = boardConfirm(page, "FM3K-10");
      await expect.poll(() => boardFocusOn(page, byMenu.cancel)).toBe(true);
      // Esc lets go of the confirmation before anything else, and writes nothing.
      await page.keyboard.press("Escape");
      await expect(byMenu.card).toHaveCount(0);
      await expect(boardEntry(page)).toBeVisible();
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-10");
      expect((await detail(page, "start-menu")).status).toBe("open");
      // Move the selected task, by name, opens the same menu.
      await runFromSearch(app, page, `panel:${BOARD_PANEL}/board-move`);
      await expect(menu.menu).toBeVisible();
      await pressInBoard(menu.entry("start"));
      await pressInBoard(byMenu.go);
      await expect
        .poll(async () => (await detail(page, "start-menu")).status, { timeout: 30_000 })
        .toBe("active");
      expect(await captainMoves(page, "start-menu")).toContain("status");
      // The board draws it gone from the list, and focus lands on the row now
      // nearest where it was, before the next move.
      await expect.poll(() => laneKeys(page, "backlog")).not.toContain("FM3K-10");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-12");
    });

    await test.step("Drop task by tray and by menu asks in the record's words, and keeps open parts planned", async () => {
      await toBoard();
      await dragTile(page, "FM3K-11", "drop");
      const byTray = boardConfirm(page, "FM3K-11");
      await expect(byTray.card).toHaveAttribute("data-board-confirm", "drop-task");
      await expect(byTray.card.locator("p")).toHaveText(
        `${dropConfirmLead("FM3K-11")} ${dropWaitingLine([{ key: "FM3K-14" }])}`,
      );
      await pressInBoard(byTray.go);
      await expect.poll(async () => (await detail(page, "drop-tray")).status).toBe("dropped");
      expect((await detail(page, "waiter")).status).toBe("open");
      // The board draws it gone, and focus lands on the tile now nearest
      // where it was, before the next move: a later one would take focus
      // from wherever the next move had put it.
      await expect(boardTile(page, "FM3K-11")).toHaveCount(0);
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-14");

      await backlogMenu("FM3K-12", "drop");
      const byMenu = boardConfirm(page, "FM3K-12");
      await expect(byMenu.card.locator("p")).toHaveText(dropConfirmLead("FM3K-12"));
      await pressInBoard(byMenu.go);
      await expect.poll(async () => (await detail(page, "drop-menu")).status).toBe("dropped");
      await expect.poll(() => laneKeys(page, "backlog")).not.toContain("FM3K-12");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-13");

      // A parent with an open part: the one drop (INF-3169's piece 4, the
      // captain's "fold the three into one drop") drops it and keeps the
      // part planned, and the ask says so before anything is written.
      await backlogMenu("FM3K-6", "open");
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute(
        "data-stage-entry-id",
        "record:parent",
      );
      await pressWindowKey(app, "]", ["meta", "shift"]);
      await expect(boardEntry(page)).toBeVisible();
      // The keyboard goes back into the board once the stage has prepared
      // the card behind it again, as in task-board-pages.
      await stagePrepared(page);
      await pressKey(boardTile(page, "FM3K-6"), "Space");
      const parentDrop = boardMenu(page, "FM3K-6").entry("drop");
      await expect(parentDrop).not.toHaveAttribute("aria-disabled", "true");
      await pressInBoard(parentDrop);
      const byParent = boardConfirm(page, "FM3K-6");
      await expect(byParent.card).toHaveAttribute("data-board-confirm", "drop-task");
      await expect(byParent.card.locator("p")).toHaveText(
        `${dropConfirmLead("FM3K-6")} ${dropPartsLine([{ key: "FM3K-7", title: "Part" }])}`,
      );
      expect((await detail(page, "parent")).status).toBe("open");
      expect(await captainMoves(page, "parent")).toEqual([]);
      await pressInBoard(byParent.go);
      await expect
        .poll(async () => {
          const parent = await detail(page, "parent");
          return { status: parent.status, closedReason: parent.closedReason };
        })
        .toEqual({ status: "dropped", closedReason: "cancelled" });
      expect(await captainMoves(page, "parent")).toContain("status");
      // Its part stays planned on the Backlog, and focus lands on it, the
      // row now nearest where the parent was.
      expect((await detail(page, "part")).status).toBe("open");
      await expect.poll(() => laneKeys(page, "backlog")).not.toContain("FM3K-6");
      expect(await laneKeys(page, "backlog")).toContain("FM3K-7");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-7");
    });

    await test.step("a live change under a confirmation cancels it and the live line says so", async () => {
      await backlogMenu("FM3K-13", "start");
      const asking = boardConfirm(page, "FM3K-13");
      await expect(asking.card).toBeVisible();
      // Firstmate, or another surface, changes the task underneath.
      await page.evaluate(() => window.infinitary.task.run("changes", "queue-task"));
      await expect(asking.card).toHaveCount(0);
      await expect(boardLive(page)).toHaveAttribute("data-board-live", "refused");
      await expect(boardLive(page)).toContainText("FM3K-13");
      // It left the list, so focus lands on the row now nearest where it
      // stood, at once: never later, onto its tile in a view drawn next.
      await expect.poll(() => laneKeys(page, "backlog")).not.toContain("FM3K-13");
      await expect.poll(() => focusedTileKey(page)).toBe("FM3K-7");
    });

    await test.step("Show the card brings the completion card forward and merges nothing", async () => {
      await toBoard();
      await pressKey(boardTile(page, "FM3K-1"), "Space");
      await pressInBoard(boardMenu(page, "FM3K-1").entry("card"));
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute(
        "data-stage-entry-id",
        COMPLETION_CARD,
      );
      const ready = await detail(page, "ready");
      expect(ready.status).toBe("active");
      expect(ready.cards.find((card) => card.id === COMPLETION_CARD)?.state).toBe("open");
    });
  } finally {
    await launched.close();
  }
});
