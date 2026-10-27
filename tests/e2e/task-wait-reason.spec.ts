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
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
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
  recordFrame,
  rowSummary,
} from "./rails";
import { boardEntry, boardsOnStage, hideBoard, openBoardButton } from "./taskBoard";
import { focusOn } from "./windowKeys";

const BLOCKER =
  "The crewmate cannot open a pull request because its session lacks the required tool.";
const CHECKS = "The pull request checks are still running.";

/**
 * The stage as painted: the ember crewmate's ink, and how much accent ink
 * lies in a band round it where the checks ring is drawn (INF-676). The
 * first mate's own accent wires sit far inside the orbit, outside the band.
 */
async function emberRing(page: Page): Promise<{ ember: number; ring: number }> {
  return page.evaluate(() => {
    const pixels: { x: number; y: number; ember: boolean }[] = [];
    let scale = 1;
    for (const layer of ["far", "near"]) {
      const canvas = document.querySelector<HTMLCanvasElement>(
        `canvas[data-crew-layer="${layer}"]`,
      );
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) throw new Error(`crew ${layer} layer missing`);
      scale = canvas.width / Math.max(1, canvas.clientWidth);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) {
        const [r = 0, g = 0, b = 0, a = 0] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a < 40) continue;
        const ember = r - b > 90 && r > g;
        const accent = b - r > 60;
        if (!ember && !accent) continue;
        const p = i / 4;
        pixels.push({ x: p % canvas.width, y: Math.floor(p / canvas.width), ember });
      }
    }
    const embers = pixels.filter((p) => p.ember);
    if (embers.length === 0) return { ember: 0, ring: 0 };
    const cx = embers.reduce((sum, p) => sum + p.x, 0) / embers.length;
    const cy = embers.reduce((sum, p) => sum + p.y, 0) / embers.length;
    const ring = pixels.filter((p) => {
      const d = Math.hypot(p.x - cx, p.y - cy) / scale;
      return !p.ember && d > 12 && d < 34;
    }).length;
    return { ember: embers.length, ring };
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
    // INF-676, the captain's direction A: the crewmate waiting on its checks
    // keeps Working and its group, banked ember inside a cyan checks ring on
    // the stage, an ember dot in the accent ring and the dim word "checks"
    // in its row; a decision's row keeps its own mark.
    await expect.poll(async () => (await emberRing(page)).ember).toBeGreaterThan(0);
    await expect.poll(async () => (await emberRing(page)).ring).toBeGreaterThan(20);
    const checksMark = nowRow(page, key("checks")).locator("[data-task-mark]");
    await expect(checksMark).toHaveAttribute("data-task-mark", "working");
    await expect(checksMark).toHaveAttribute("data-task-wait", "checks");
    await expect(checksMark).toHaveAttribute("aria-label", "Working · Waiting for checks");
    await expect(nowRow(page, key("checks")).locator("[data-now-word]")).toHaveText(" · checks");
    await expect(nowRow(page, key("choice")).locator("[data-task-mark]")).not.toHaveAttribute(
      "data-task-wait",
      /.*/,
    );
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
    if (dir) await regionShot(recordCard(page), join(dir, "checks-record.png"));
    expect(board.tasks.find((task) => task.id === "checks")?.workPosture).toEqual({
      state: "active",
      reason: "checks",
    });
    await expect(recordFrame(page).locator("[data-record-attention]")).toBeHidden();
    expect(await nowRowGroup(page, key("blocked"))).toBe("working");
    expect(await nowRowGroup(page, key("checks"))).toBe("working");
    expect(await nowRowGroup(page, key("choice"))).toBe("waiting");
    expect(board.projects[0]?.counts.waitingOnYou).toBe(1);
    await pressRow(page, key("blocked"));
    await expect(recordFrame(page).locator("[data-record-attention-guidance]")).toHaveText(BLOCKER);
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
    const frame = recordFrame(page);
    await expect(frame.locator("[data-record-attention-title]")).toHaveText(words.title);
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
