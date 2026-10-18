import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { RECORD_NEXT_LABELS } from "../../src/shared/recordBar";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import {
  expandDock,
  expectRecordBody,
  nowFrame,
  pressRow,
  recordBarButton,
  recordCard,
  recordFrame,
} from "./rails";

/** Current blockers are live work, not the closed edges retained in the task's history. */
function seeded(): string {
  const userDataDir = scratchDir("infinitary-closed-blockers-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const seed = (id: string, title: string, active = false) => {
    const worktreeDir = active ? join(userDataDir, "fixture-work", id) : "";
    if (worktreeDir) mkdirSync(worktreeDir, { recursive: true });
    return seedTask(tasks, {
      id,
      title,
      status: active ? "idle" : "queued",
      startPolicy: "on-request",
      worktreeDir,
      ...(active ? { outcome: "The work is ready for its next move." } : {}),
    });
  };
  seed("merged", "A blocker already put in");
  seed("dropped", "A blocker already dropped");
  seed("discarded", "A blocker already discarded");
  tasks.close("merged", { status: "done", reason: "merged", actor: "captain" });
  tasks.close("dropped", { status: "dropped", reason: "cancelled", actor: "captain" });
  tasks.close("discarded", { status: "dropped", reason: "discarded", actor: "captain" });
  seed("live-open", "A blocker still planned");
  seed("live-active", "A blocker still working", true);
  seed("mixed", "Wait only for unfinished work", true);
  seed("clear", "All dependencies are closed", true);
  seed("dead-start", "A stopped dependency needs a decision before starting");
  for (const blocker of ["merged", "dropped", "discarded"]) {
    tasks.link(blocker, "mixed", "blocks", "host");
    tasks.link(blocker, "clear", "blocks", "host");
    tasks.link(blocker, "dead-start", "blocks", "host");
  }
  for (const blocker of ["live-open", "live-active"]) {
    tasks.link(blocker, "mixed", "blocks", "host");
  }
  db.close();
  return userDataDir;
}

let launched: LaunchedApp;

// Keep before/after evidence outside the runner's cleaned output directory.
const evidenceDir = process.env.INFINITARY_BLOCKER_EVIDENCE_DIR;
async function evidence(name: string): Promise<void> {
  const path = evidenceDir
    ? join(evidenceDir, `${name}.png`)
    : test.info().outputPath(`${name}.png`);
  await launched.page.screenshot({ path });
}

test.beforeAll(async () => {
  launched = await launchApp({ userDataDir: seeded(), withMockProvider: true });
  await expandDock(launched.page, "now");
});

test.afterAll(async () => {
  await launched.close();
});

async function openRecord(id: string): Promise<void> {
  const { page } = launched;
  const detail = await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
  // Every open row here waits for the captain's word: the backlog.
  const backlog = nowFrame(page).locator('[data-now-group-header="backlog"]');
  if (detail.status === "open" && (await backlog.getAttribute("aria-expanded")) === "false") {
    await backlog.evaluate((el) => (el as HTMLElement).click());
  }
  await pressRow(page, detail.key);
  await expect(recordCard(page)).toHaveAttribute("data-task-record", id);
  await expect(recordCard(page)).toHaveCSS("opacity", "1");
  await expectRecordBody(page);
}

test("an active task names only its open and active blockers", async () => {
  const { page } = launched;
  await openRecord("mixed");
  await evidence("mixed-blockers");
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  const key = (id: string) => board.tasks.find((task) => task.id === id)?.key;
  const current = board.tasks.find((task) => task.id === "mixed");
  expect(current?.blockedBy).toHaveLength(2);
  expect(current?.blockedBy).toEqual(
    expect.arrayContaining([key("live-open"), key("live-active")]),
  );
  // A recorded wait names the live blockers and draws the arrow. It does
  // not mark the active row blocked: only a promised hold does (INF-416 piece E).
  expect(current?.flags.blocked).toBe(false);
  const detail = await page.evaluate(() => window.infinitary.tasks.detail("mixed"));
  expect(detail.blockedBy).toEqual(current?.blockedBy);
  await expect(recordFrame(page).locator("[data-record-attention]")).toBeVisible();
  for (const id of ["live-open", "live-active"]) {
    await expect(recordFrame(page).locator("[data-record-attention]")).toContainText(
      key(id) as string,
    );
  }
  for (const id of ["merged", "dropped", "discarded"]) {
    await expect(recordFrame(page).locator("[data-record-attention]")).not.toContainText(
      key(id) as string,
    );
  }
});

test("a dropped edge still prevents starting without naming closed work as a live blocker", async () => {
  const { page } = launched;
  await openRecord("dead-start");
  const detail = await page.evaluate(() => window.infinitary.tasks.detail("dead-start"));
  expect(detail).toMatchObject({
    blockedBy: [],
    flags: { blocked: true, ready: false, needsYou: true },
  });
  await expect(recordBarButton(page, "next")).toHaveAccessibleName(RECORD_NEXT_LABELS.start);
  await expect(recordBarButton(page, "next")).toBeDisabled();
  // The body's attention box says why it cannot start yet.
  await expect(recordFrame(page).locator("[data-record-attention]")).toBeVisible();
  for (const id of ["merged", "dropped", "discarded"]) {
    const closed = await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
    await expect(recordFrame(page).locator("[data-record-attention]")).not.toContainText(
      closed.key,
    );
  }
});

test("an active task with only closed dependencies has no blocker banner", async () => {
  const { page } = launched;
  await openRecord("clear");
  await evidence("closed-blockers");
  const detail = await page.evaluate(() => window.infinitary.tasks.detail("clear"));
  expect(detail).toMatchObject({ blockedBy: [], flags: { blocked: false } });
  await expect(recordFrame(page).locator("[data-record-attention]")).toBeHidden();
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "task-detail.json"), JSON.stringify(detail, null, 2));
  }
});
