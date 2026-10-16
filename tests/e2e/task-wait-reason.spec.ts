import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { hostEnv } from "../../src/core/hostEnv";
import { armWatch } from "../../src/core/orchestrator/checkWatch";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { taskHoldWords } from "../../src/shared/taskHold";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import {
  dockFrameElement,
  expandDock,
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
  tasks.recordDelivery("checks", {
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
    if (dir) await regionShot(recordCard(page), join(dir, "record.png"));
    if (process.env.FM_WAIT_HERO)
      await heroShot(page, { region: recordCard(page), name: "task-wait-reason" });
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
      await heroShot(page, { region: recordCard(page), name: "held-task-says-why" });
  } finally {
    await app.close();
  }
});
