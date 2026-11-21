import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import * as m from "../../src/shared/i18n/messages.generated";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { frameIn, panelBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";

import { panelCardChrome } from "./panelCards";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { POINT_SUMMARY, recordCard, rowSummary } from "./rails";
import { ADD_PANEL_PROMPT_MARKER, installPanel } from "./scenarios/installPanel";
import { SHOWN_ENTRY, shownCardFrame } from "./stack";
import {
  boardConfirm,
  boardEntry,
  boardEntryId,
  boardFocusOn,
  boardMenu,
  boardTile,
  boardViewTab,
  dragTile,
  focusedTileKey,
  laneKeys,
  openBoardButton,
  pressInBoard,
} from "./taskBoard";
import { pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

/**
 * The app's own Tasks panel and its task board are an ordinary panel folder
 * (docs/ui-plugins.md, "The app's own panels are ordinary folders"): no
 * code of the app's names it. So the same folder, `src/panels/now/`, added
 * from elsewhere under another id with a maker's name, does everything the
 * app's own does, walled off in pages of its own: it asks first for its
 * moves, docks on its own rail, puts its board up from its header and its
 * command, and the board's journey runs on it - by keys, by drag and by
 * menu - each move landing on the task's record as the captain's, naming
 * the panel it came from.
 */

/** The copy's id: its folder's name where it was added from, never the app's own `now`. */
const COPY = "team-desk";
const TITLE = "Team desk";
const MAKER = "Acme";

function repo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

/** One project, work in the backlog for each move, and work underway and done. */
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
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const seed = (seedValue: Parameters<typeof seedTask>[1]) => {
    clock += 60_000;
    seedTask(tasks, { repoId: "repo-fm", startPolicy: "on-request", ...seedValue });
  };
  // FM3K-1 .. FM3K-3: queued and started from the Backlog's menu, and
  // dropped by the tray from Queued, held so nothing starts it.
  seed({ id: "queue-me", title: "Queue me", status: "queued" });
  seed({ id: "start-me", title: "Start me", status: "queued" });
  seed({
    id: "drop-me",
    title: "Drop me",
    status: "queued",
    startPolicy: "when-ready",
    gate: { kind: "at-time", until: now + 30 * 24 * 60 * 60_000 },
  });
  // FM3K-4: working, its crewmate idle with its work kept.
  const worktree = join(userDataDir, "worktrees", "underway");
  mkdirSync(worktree, { recursive: true });
  seed({ id: "underway", title: "Underway", status: "idle", worktreeDir: worktree });
  // FM3K-5: done this week.
  seed({ id: "done", title: "Done already", status: "queued" });
  tasks.close("done", { status: "done", reason: "finished", actor: "host" });
  clock = now;
  db.close();
}

const detail = (page: Page, id: string): Promise<TaskDetail> =>
  page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);

/** The captain's moves on the task's history that name the copy's panel. */
async function movesFromCopy(page: Page, id: string): Promise<string[]> {
  const { events } = await detail(page, id);
  return events
    .filter((event) => event.actor === "captain" && event.data?.panel === TITLE)
    .map((event) => event.kind);
}

test("the Tasks panel's own folder, added from elsewhere under another id, runs the board's journey", async () => {
  test.setTimeout(240_000);
  const userDataDir = scratchDir("infinitary-tasks-elsewhere-");
  seedBoard(userDataDir);
  // The app's own folder, as someone else would hand it over: their name
  // and version on it, and a title of their own.
  const source = join(scratchDir("infinitary-tasks-elsewhere-source-"), COPY);
  cpSync(join(process.cwd(), "src", "panels", "now"), source, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  writeFileSync(
    join(source, "manifest.json"),
    JSON.stringify({ ...manifest, name: MAKER, version: "1.0.0", title: TITLE }),
  );
  const launched = await launchApp({
    scenarios: [installPanel],
    userDataDir,
    withMockProvider: true,
  });
  const { app, page } = launched;
  try {
    await resizeWindow(app, page, { width: 1600, height: 900 });
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length)
      .toBe(5);
    const panel = page.locator(`[data-side-panel="${COPY}"]`);

    await test.step("added from elsewhere, it asks first for its moves, then docks under its maker's name", async () => {
      const input = promptInput(page);
      await input.click();
      await input.fill(`${ADD_PANEL_PROMPT_MARKER}${source}`);
      await input.press("Enter");
      const add = page.getByRole("button", { name: "Add it", exact: true });
      await add.waitFor({ timeout: 30_000 });
      await expect(shownCardFrame(page).locator("body")).toContainText(m.cardConsentMovesValue());
      await add.click();
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel.locator("[data-side-panel-attribution]")).toHaveText(MAKER);
      // Walled off: its page is a frame at a host of its own, drawn from its pinned version.
      await expect(frameIn(panel)).toHaveAttribute("src", /^app-frame:\/\/panel-[0-9a-f-]+\/$/);
      const rows = panelBody(page, COPY).locator("[data-now-row]");
      await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    });

    await test.step("its header button puts its board up, in a page of its own under its maker's name", async () => {
      await openBoardButton(page, COPY).click();
      await expect(boardEntry(page, COPY)).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute(
        "data-stage-entry-id",
        boardEntryId(COPY),
      );
      await expect(panelCardChrome(page).attribution).toHaveText(MAKER);
      await expect(
        frameIn(page.locator(`${SHOWN_ENTRY} [data-installed-panel="${COPY}"]`)),
      ).toHaveAttribute("src", /^app-frame:\/\/panel-[0-9a-f-]+\/$/);
      expect(await laneKeys(page, "backlog", COPY)).toEqual(["FM3K-1", "FM3K-2"]);
      expect(await laneKeys(page, "queued", COPY)).toEqual(["FM3K-3"]);
      expect(await laneKeys(page, "working", COPY)).toEqual(["FM3K-4"]);
      expect(await laneKeys(page, "landed", COPY)).toEqual([]);
      await pressInBoard(boardViewTab(page, "landed", COPY));
      expect(await laneKeys(page, "landed", COPY)).toEqual(["FM3K-5"]);
      await pressInBoard(boardViewTab(page, "board", COPY));
    });

    await test.step("by keys: its commands put focus on the tiles and on the Backlog, the arrows move, Enter opens a record", async () => {
      await runFromSearch(app, page, `panel:${COPY}/board`);
      await expect.poll(() => focusedTileKey(page, COPY)).toBe("FM3K-1");
      // Across a column, the arrow lands on the tile level with this one.
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => focusedTileKey(page, COPY)).toBe("FM3K-3");
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => focusedTileKey(page, COPY)).toBe("FM3K-1");
      await runFromSearch(app, page, `panel:${COPY}/board-backlog`);
      await expect.poll(() => focusedTileKey(page, COPY)).toBe("FM3K-1");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => focusedTileKey(page, COPY)).toBe("FM3K-2");
      await expect(boardTile(page, "FM3K-2", COPY)).toHaveAttribute("data-board-selected", "");
      // The keyboard rests on the row as the pointer does: its summary opens.
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, "start-me");
      await page.keyboard.press("Enter");
      await expect(recordCard(page)).toBeVisible();
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute(
        "data-stage-entry-id",
        "record:start-me",
      );
      // Paged back, the board finds its view and selected row as it left them.
      await pressWindowKey(app, "]", ["meta", "shift"]);
      await expect(boardEntry(page, COPY)).toBeVisible();
      await expect(boardViewTab(page, "backlog", COPY)).toHaveAttribute("aria-pressed", "true");
      await expect(boardTile(page, "FM3K-2", COPY)).toHaveAttribute("data-board-selected", "");
    });

    await test.step("by menu: a Backlog row's Queue it asks on the row, and Queue it writes, naming the panel", async () => {
      await pressKey(boardTile(page, "FM3K-1", COPY), "Space");
      await pressInBoard(boardMenu(page, "FM3K-1", COPY).entry("queue"));
      const confirm = boardConfirm(page, "FM3K-1", COPY);
      await expect(confirm.card).toHaveAttribute("data-board-confirm", "queue-task");
      expect((await detail(page, "queue-me")).startPolicy).toBe("on-request");
      await pressInBoard(confirm.go);
      await expect
        .poll(async () => (await detail(page, "queue-me")).startPolicy)
        .toBe("when-ready");
      await expect.poll(() => movesFromCopy(page, "queue-me")).toContain("note");
    });

    await test.step("by menu: Space opens a row's menu, and Start now asks once and starts it", async () => {
      await pressKey(boardTile(page, "FM3K-2", COPY), "Space");
      const menu = boardMenu(page, "FM3K-2", COPY);
      await expect(menu.menu).toBeVisible();
      await expect.poll(() => boardFocusOn(page, menu.entry("open"), COPY)).toBe(true);
      await pressInBoard(menu.entry("start"));
      const confirm = boardConfirm(page, "FM3K-2", COPY);
      await expect(confirm.card).toHaveAttribute("data-board-confirm", "start-task");
      await pressInBoard(confirm.go);
      await expect
        .poll(async () => (await detail(page, "start-me")).status, { timeout: 30_000 })
        .toBe("active");
      expect(await movesFromCopy(page, "start-me")).toContain("status");
    });

    await test.step("by drag: on the Board, the tray's Drop task asks in the record's words, and drops it", async () => {
      await pressInBoard(boardViewTab(page, "board", COPY));
      // The record says active before the board settles the Start: the
      // board draws FM3K-2, and FM3K-1, which started by itself once
      // queued, as Starting in Queued above FM3K-3 until their crewmates
      // begin. Each that leaves moves FM3K-3 up the lane, and a press
      // measured before then lands on the empty lane, so the drag waits
      // until the board itself has settled.
      await expect(boardTile(page, "FM3K-2", COPY)).toHaveAttribute("data-board-lane", "working", {
        timeout: 30_000,
      });
      await expect
        .poll(() => laneKeys(page, "queued", COPY), { timeout: 30_000 })
        .toEqual(["FM3K-3"]);
      await expect(boardEntry(page, COPY).locator("[data-board-pending]")).toHaveCount(0);
      await dragTile(page, "FM3K-3", "drop", { panel: COPY });
      const confirm = boardConfirm(page, "FM3K-3", COPY);
      await expect(confirm.card).toHaveAttribute("data-board-confirm", "drop-task");
      await pressInBoard(confirm.go);
      await expect.poll(async () => (await detail(page, "drop-me")).status).toBe("dropped");
      expect(await movesFromCopy(page, "drop-me")).not.toEqual([]);
    });
  } finally {
    await launched.close();
  }
});
