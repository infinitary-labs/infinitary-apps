import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { hostEnv } from "../../src/core/hostEnv";
import { armWatch } from "../../src/core/orchestrator/checkWatch";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { taskHoldWords } from "../../src/shared/taskHold";
import { taskStatusLabel, taskStatusOf } from "../../src/shared/taskPresentation";
import { taskWaitText } from "../../src/shared/taskWaits";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { emberRing } from "./crew";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import {
  dockFrameElement,
  expandDock,
  expectRecordBody,
  hideRecord,
  nowRow,
  nowRowGroup,
  openGroup,
  pressRow,
  recordCard,
  rowSummary,
} from "./rails";
import {
  boardConfirm,
  boardEntry,
  boardMenu,
  boardsOnStage,
  boardTile,
  boardViewTab,
  hideBoard,
  openBoardButton,
  pressInBoard,
} from "./taskBoard";
import { focusOn, pressKey } from "./windowKeys";

const BLOCKER =
  "The crewmate cannot open a pull request because its session lacks the required tool.";
const CHECKS = "The pull request checks are still running.";

/**
 * The stage's cyan crewmates as painted, each as how far its accent ink
 * spreads from its centre in css px (the 90th percentile distance), any
 * ember crewmate left out. A plain solid's wires stay close; the beacon's
 * ring (INF-1543) and the wait ring (INF-676, INF-1777) carry the ink out
 * to most of the glyph's size.
 */
async function cyanSpreads(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const groups: {
      seed: { x: number; y: number };
      points: { x: number; y: number }[];
      ember: boolean;
    }[] = [];
    for (const layer of ["far", "near"]) {
      const canvas = document.querySelector<HTMLCanvasElement>(
        `canvas[data-crew-layer="${layer}"]`,
      );
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) throw new Error(`crew ${layer} layer missing`);
      const scale = canvas.width / Math.max(1, canvas.clientWidth);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) {
        const [r = 0, g = 0, b = 0, a = 0] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a < 40) continue;
        const ember = r - b > 90 && r > g;
        if (!ember && b - r <= 60) continue;
        const p = i / 4;
        const point = { x: (p % canvas.width) / scale, y: Math.floor(p / canvas.width) / scale };
        // Crewmates sit far further apart than one glyph and its ring are wide.
        let group = groups.find((g) => Math.hypot(g.seed.x - point.x, g.seed.y - point.y) < 70);
        if (!group) {
          group = { seed: point, points: [], ember: false };
          groups.push(group);
        }
        group.ember ||= ember;
        if (!ember) group.points.push(point);
      }
    }
    return groups
      .filter((g) => !g.ember && g.points.length > 0)
      .map(({ points }) => {
        const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
        const d = points.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((m, n) => m - n);
        return d[Math.floor(d.length * 0.9)] ?? 0;
      });
  });
}

function fixture(): string {
  const userDataDir = scratchDir("infinitary-wait-reason-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const cards = new CardStore(db);
  for (const [id, title, text] of [
    ["blocked", "Open the harbour map pull request", BLOCKER],
    ["checks", "Check the harbour map", CHECKS],
    ["choice", "Choose the harbour map", "The map is ready for your review."],
  ] as const) {
    const worktreeDir = join(userDataDir, "worktrees", id);
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, { id, title, status: "idle", worktreeDir });
    tasks.recordReport(id, { text, summary: text, declared: { wait: { reason: text } } });
    tasks.setGate(id, { kind: "captain" });
  }
  // The durable watch reads a real head; no forge request is due during this journey.
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: join(userDataDir, "worktrees", "checks"),
      env: hostEnv({ HOME: userDataDir, GIT_CONFIG_GLOBAL: "/dev/null" }),
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git("init", "--initial-branch=main");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "chore: seed checks",
  );
  const head = git("rev-parse", "HEAD");
  seedDelivery(tasks, "checks", {
    mode: "direct-pr",
    prNumber: 57,
    headSha: head,
    ci: "pending",
    ciWatch: armWatch(undefined, head, Date.now()),
  });
  const note = {
    id: "past-note",
    taskId: "blocked",
    author: "firstmate" as const,
    title: "The work is paused",
    meta: "firstmate",
    body: "<p>The crewmate stopped.</p>",
    actions: [],
    priority: 0,
    status: "ready" as const,
    createdAt: Date.now(),
  };
  cards.upsert(note);
  cards.resolve(note.id, "dismissed");
  tasks.recordCardResolved("blocked", { cardId: note.id, title: note.title, action: "dismissed" });
  cards.upsert({
    id: "real-choice",
    taskId: "choice",
    author: "firstmate",
    title: "Which map should we use?",
    meta: "firstmate",
    body: "<p>Choose the map.</p>",
    priority: 0,
    actions: [
      { id: "harbour", label: "Harbour map" },
      { id: "bay", label: "Bay map" },
    ],
    status: "ready",
    createdAt: Date.now(),
  });
  db.close();
  return userDataDir;
}

test("a cardless wait opens its record with the reported reason, while a real choice opens its card", async () => {
  const app = await launchApp({ userDataDir: fixture(), withMockProvider: true });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1440, height: 1000 });
    await expandDock(page, "now");
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const key = (id: string) => {
      const row = board.tasks.find((task) => task.id === id);
      if (!row) throw new Error(`Missing fixture task ${id}`);
      return row.key;
    };
    // INF-676, the captain's direction A, and INF-1777, the captain's plan:
    // the crewmate waiting on its checks keeps Working and its group, banked
    // ice cyan - never ember - inside the wait ring on the stage, an accent
    // dot in the dashed accent ring and the dim word "checks" in its row; a
    // decision's row keeps its own mark.
    const checksMark = nowRow(page, key("checks")).locator("[data-task-mark]");
    await expect(checksMark).toHaveAttribute("data-task-mark", "working");
    await expect(checksMark).toHaveAttribute("data-task-wait", "checks");
    await expect(checksMark).toHaveAttribute("aria-label", "Working · Waiting for checks");
    await expect(nowRow(page, key("checks")).locator("[data-now-word]")).toHaveText(" · checks");
    await expect(nowRow(page, key("choice")).locator("[data-task-mark]")).not.toHaveAttribute(
      "data-task-wait",
      /.*/,
    );
    // INF-1543, the captain's direction A: the crewmate under Waiting on you
    // wears the beacon, the row's ring round its solid, as the checks crewmate
    // wears the wait ring; the idle crewmate whose wait is only reported keeps
    // its plain solid.
    await expect(nowRow(page, key("choice")).locator("[data-task-mark]")).toHaveAttribute(
      "data-task-mark",
      "waiting",
    );
    await expect
      .poll(async () => {
        const spreads = (await cyanSpreads(page)).sort((m, n) => m - n);
        return spreads.length === 3 ? (spreads[1] ?? 0) / (spreads[0] ?? 1) : 0;
      })
      .toBeGreaterThan(1.5);
    expect((await emberRing(page)).ember).toBe(0);
    const dir = process.env.FM_WAIT_PICTURES;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await regionShot(dockFrameElement(page, "now"), join(dir, "panel.png"));
      await focusOn(nowRow(page, key("blocked")));
      await expect(rowSummary(page)).toBeVisible();
      await regionShot(rowSummary(page).locator("[data-crew-summary]"), join(dir, "summary.png"));
    }
    await pressRow(page, key("blocked"));
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "blocked");
    await expectRecordBody(page);
    if (dir) await regionShot(recordCard(page), join(dir, "record.png"));
    if (process.env.FM_WAIT_HERO)
      await heroShot(app.app, page, { region: recordCard(page), name: "task-wait-reason" });
    await hideRecord(page).click();
    await openBoardButton(page).click();
    if (dir) {
      await regionShot(boardEntry(page), join(dir, "board.png"));
      writeFileSync(join(dir, "tasks.json"), JSON.stringify(board, null, 2));
    }
    await hideBoard(page).click();
    await expect(boardsOnStage(page)).toHaveCount(0);
    await pressRow(page, key("checks"));
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "checks");
    await expect(recordCard(page).locator("[data-task-mark]")).toHaveAttribute(
      "data-task-wait",
      "checks",
    );
    const watch = board.tasks
      .find((task) => task.id === "checks")
      ?.waits?.find((wait) => wait.kind === "checks");
    if (!watch) throw new Error("Missing current check watch");
    await expect(recordCard(page).locator("[data-task-watch]")).toHaveText(
      taskWaitText(watch, Date.now()),
    );
    await expect(recordCard(page).locator("[data-record-status-reason]")).toHaveCount(0);
    if (dir) await regionShot(recordCard(page), join(dir, "checks-record.png"));
    expect(board.tasks.find((task) => task.id === "checks")?.workPosture).toEqual({
      state: "active",
      reason: "checks",
    });
    await expect(recordCard(page).locator("[data-record-attention]")).toBeHidden();
    expect(await nowRowGroup(page, key("blocked"))).toBe("working");
    expect(await nowRowGroup(page, key("checks"))).toBe("working");
    expect(await nowRowGroup(page, key("choice"))).toBe("waiting");
    expect(board.projects[0]?.counts.waitingOnYou).toBe(1);
    await pressRow(page, key("blocked"));
    await expect(recordCard(page).locator("[data-record-attention-guidance]")).toHaveText(BLOCKER);
    await pressRow(page, key("choice"));
    await expect(page.getByRole("button", { name: "Harbour map", exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a queued premium ask held for premium allowance says in its record why it waits and what ends the wait", async () => {
  // A premium ask that no premium model with allowance can serve waits on
  // the premium reset instead of starting lower (P7 + R1). Its record named
  // no reason for that wait, since the work never started and so never
  // reported one (FI3-1749).
  const userDataDir = scratchDir("infinitary-held-ask-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "premium",
    title: "Redraw the harbour map",
    status: "queued",
    shape: { kind: "implement", premium_ask: true },
    gate: { kind: "quota-reset", ref: "bucket:premium" },
  });
  db.close();
  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1440, height: 1000 });
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const held = board.tasks.find((task) => task.id === "premium");
    if (!held) throw new Error("Missing the held premium ask");
    expect(held.flags.held).toBe(true);
    await expandDock(page, "now");
    await openGroup(page, "queued");
    await pressRow(page, held.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "premium");
    const words = taskHoldWords({ kind: "premium" });
    const frame = recordCard(page);
    // INF-1605: the queued title is the home's dated wait; the hold still owns its guidance.
    const wait = held.queueWait;
    if (!wait) throw new Error("The held premium ask has no dated queue wait");
    // INF-2215 replaces the repeated queue reason with the full typed wait and its unknown reset.
    if (!held.waits?.length) throw new Error("Missing the allowance wait projection");
    await expect(frame.locator("[data-record-attention-title]")).toHaveText(
      held.waits.map((wait) => taskWaitText(wait, Date.now())).join("; "),
    );
    await expect(nowRow(page, held.key)).toContainText(wait.line);
    await expect(frame.locator("[data-record-attention-guidance]")).toHaveText(words.text);
    const dir = process.env.FM_WAIT_PICTURES;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await regionShot(recordCard(page), join(dir, "held-record.png"));
    }
    if (process.env.FM_WAIT_HERO)
      await heroShot(app.app, page, { region: recordCard(page), name: "held-task-says-why" });
  } finally {
    await app.close();
  }
});

/** INF-2197 item 3 / approved INF-2215: permitted views agree; lists stay unchanged.
 * Real task/gate/link writers, private HOME, no provider or forge requests.
 * Completion is DOM text on the three views and a live cleared dependency after a confirmed drop.
 * Uses only this isolated app, its keyboard and disposable saved tasks.
 */
test("grouped waits reconcile into kanban and task card, the hover stays short, and lists add nothing", async () => {
  const dir = scratchDir("infinitary-wait-views-");
  const db = openDatabase(dir);
  const now = Date.now();
  const tasks = new TaskService({ db, strict: true, now: () => now });
  seedTask(tasks, {
    id: "owner",
    title: "Prepare website update",
    status: "queued",
    startPolicy: "on-request",
  });
  const worktreeDir = join(dir, "worktree");
  mkdirSync(worktreeDir, { recursive: true });
  seedTask(tasks, {
    id: "waiter",
    title: "Publish website update",
    status: "completed",
    worktreeDir,
  });
  tasks.recordReport("waiter", { text: "The website update is ready after its prerequisite." });
  tasks.link("owner", "waiter", "blocks", "crewmate", true);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tasks.setGate("waiter", { kind: "at-time", until: tomorrow.getTime() });
  db.close();
  const launched = await launchApp({ userDataDir: dir, withMockProvider: true });
  const { app, page } = launched;
  try {
    await resizeWindow(app, page, { width: 1440, height: 1000 });
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const owner = board.tasks.find((row) => row.id === "owner");
    const waiter = board.tasks.find((row) => row.id === "waiter");
    if (!owner || !waiter) throw new Error("Missing wait fixtures");
    const dependency = waiter.waits?.find((wait) => wait.kind === "dependency");
    const start = waiter.waits?.find((wait) => wait.kind === "start");
    if (!dependency || !start) throw new Error("Missing standing wait sources");
    const startEvent = taskWaitText(start, Date.now(), false);
    await expandDock(page, "now");
    await openGroup(page, "backlog");
    const list = nowRow(page, owner.key);
    if (!owner.queueWait) throw new Error("Missing original list reason");
    await expect(list).toHaveText(`${owner.key} ${owner.title}`);
    await expect(list).toHaveAttribute(
      "aria-label",
      `${owner.key} · ${owner.title} · Scratch · ${taskStatusLabel(taskStatusOf(owner))}`,
    );
    await expect(list.locator("[data-board-wait]")).toHaveCount(0);
    await expect(nowRow(page, waiter.key)).toHaveText(`${waiter.key} ${waiter.title}`);
    await list.evaluate((element) => {
      element.setAttribute("data-wait-test-identity", "kept");
    });
    await openBoardButton(page).click();
    const tile = boardTile(page, waiter.key);
    await expect(tile.locator("[data-board-wait]")).toContainText(owner.key);
    await expect(tile.locator("[data-board-wait]")).toContainText(startEvent);
    await focusOn(tile);
    // INF-2528, the captain's direction B: the preview names the blocker by
    // its key and keeps the short status; every wait's wording and time is
    // the task card's, read below.
    await expect(rowSummary(page).locator("[data-crew-blocked-wait]")).toHaveText(owner.key);
    await expect(rowSummary(page).locator("[data-task-fact=status]")).toHaveText(
      taskStatusLabel(taskStatusOf(waiter)),
    );
    await expect(rowSummary(page).locator("[data-crew-summary]")).not.toContainText(startEvent);
    await pressKey(tile, "Enter");
    await expect(recordCard(page)).toHaveAttribute("data-task-record", waiter.id);
    await expectRecordBody(page);
    await expect(recordCard(page).locator("[data-record-attention-title]")).toContainText(
      taskWaitText(dependency, Date.now()),
    );
    await expect(recordCard(page).locator("[data-record-attention-title]")).toContainText(
      taskWaitText(start, Date.now()),
    );
    await expect(recordCard(page).locator("[data-record-status-reason]")).toHaveCount(0);
    await hideRecord(page).click();
    await expect(list).toHaveAttribute("data-wait-test-identity", "kept");
    await openBoardButton(page).click();
    await pressInBoard(boardViewTab(page, "backlog"));
    await expect(boardTile(page, owner.key)).toContainText(owner.queueWait.line);
    await expect(boardEntry(page).locator("[data-board-wait]")).toHaveCount(0);
    await pressKey(boardTile(page, owner.key), "Space");
    const menu = boardMenu(page, owner.key);
    await expect(menu.menu).toBeVisible();
    await pressInBoard(menu.entry("drop"));
    const confirm = boardConfirm(page, owner.key);
    await expect(confirm.card).toBeVisible();
    await pressKey(confirm.go, "Enter");
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.detail("owner"))).status)
      .toBe("dropped");
    await pressInBoard(boardViewTab(page, "board"));
    await expect(boardTile(page, waiter.key).locator("[data-board-wait]")).not.toContainText(
      owner.key,
    );
    await expect(boardTile(page, waiter.key).locator("[data-board-wait]")).toContainText(
      startEvent,
    );
    // The approved event survives narrow columns and large text, including its off-today date.
    await resizeWindow(app, page, { width: 960, height: 1100 });
    await page.evaluate(async () => {
      const { appearance } = await window.infinitary.settings.getPreferences();
      await window.infinitary.settings.setAppearance({ ...appearance, size: 150 });
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor(),
        ),
      )
      .toBe(1.5);
    const narrowTile = boardTile(page, waiter.key);
    await focusOn(narrowTile);
    const narrowEvent = narrowTile
      .locator("[data-board-wait]")
      .getByText(startEvent, { exact: true });
    await expect(narrowEvent).toHaveText(startEvent);
    await expect
      .poll(() => narrowEvent.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await hideBoard(page).click();
    await expect(boardsOnStage(page)).toHaveCount(0);
    await expect(nowRow(page, waiter.key)).toHaveText(`${waiter.key} ${waiter.title}`);
    const after = await page.evaluate(() => window.infinitary.tasks.detail("waiter"));
    const proof = {
      before: { waits: waiter.waits, listWords: `${owner.key} ${owner.title}` },
      after: { waits: after.waits, listWords: await nowRow(page, waiter.key).innerText() },
    };
    await test.info().attach("standing waits before and after the confirmed drop", {
      body: JSON.stringify(proof, null, 2),
      contentType: "application/json",
    });
  } finally {
    await launched.close();
  }
});
