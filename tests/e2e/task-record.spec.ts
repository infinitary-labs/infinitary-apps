import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import {
  CANCEL_PROMPT_MARKER,
  FINISH_PROMPT_MARKER,
  MOCK_COMPLETION_TEXT,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { latestContext } from "./providerRequest";
import { putInLine, reportLine, statusLine, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import { SPAWNED_TASK_START } from "./taskTimeline";

/**
 * The task record (task-system P0): a task is a record, not a runtime
 * handle. A crewmate's report lands on its row, so after a quit and relaunch
 * the record remains idle and steerable by resume with the same report
 * (crew_status reads the record), the Firstmate's context block names
 * it, and settling it works on the durable row.
 */

let launched: LaunchedApp;

type TaskRow = {
  id: string;
  key: string;
  status: string;
  activity: string | null;
  closed_reason: string | null;
  outcome: string | null;
  outcome_summary: string | null;
  assignee: string | null;
  workspace_state: string;
  closed_at: number | null;
};

function readTasks(userDataDir: string): TaskRow[] {
  return readSavedData(
    userDataDir,
    (db) =>
      db
        .prepare(
          "SELECT id, key, status, activity, closed_reason, outcome, outcome_summary, assignee, workspace_state, closed_at FROM tasks ORDER BY created_at",
        )
        .all() as TaskRow[],
  );
}

/** The work's own timeline; decision records (R2 provenance) are asserted apart. */
function timelineKinds(userDataDir: string, taskId: string): string[] {
  return allTimelineKinds(userDataDir, taskId).filter((kind) => kind !== "decided");
}

function allTimelineKinds(userDataDir: string, taskId: string): string[] {
  return readSavedData(userDataDir, (db) =>
    (
      db.prepare("SELECT kind FROM task_events WHERE task_id = ? ORDER BY at, id").all(taskId) as {
        kind: string;
      }[]
    ).map((row) => row.kind),
  );
}

// Share only the app launch; every named case commissions its own task.
test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

async function commissionReportedTask(app: LaunchedApp, title: string): Promise<TaskRow> {
  const { page, userDataDir } = app;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");
  const key = await taskKey(page, title);
  await expect(reportLine(page, key)).toBeVisible({ timeout: 30_000 });
  await waitForFirstmateIdle(page, 20_000);
  await expect
    .poll(() => readTasks(userDataDir).find((task) => task.key === key), { timeout: 10_000 })
    .toMatchObject({ outcome: MOCK_COMPLETION_TEXT, activity: "idle" });
  const row = readTasks(userDataDir).find((task) => task.key === key);
  if (!row) throw new Error(`Commissioned task ${key} is missing from its record`);
  return row;
}

async function recordEvidence(app: LaunchedApp, taskId: string, name: string): Promise<void> {
  await test.info().attach(`${name}-state`, {
    body: JSON.stringify(
      {
        task: readTasks(app.userDataDir).find((task) => task.id === taskId),
        timeline: allTimelineKinds(app.userDataDir, taskId),
        worktreeExists: existsSync(join(app.userDataDir, "worktrees", taskId)),
        sessionsExist: existsSync(join(app.userDataDir, "crewmates", taskId, "sessions")),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await app.page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test("after a restart the record retains its report, and settling works", async () => {
  const title = "write a restart probe note";
  const row = await test.step("commission a task and wait for its report", () =>
    commissionReportedTask(launched, title));
  const { userDataDir, homeDir } = launched;
  const taskId = row.id;
  await recordEvidence(launched, taskId, "before-restart");
  await launched.close();
  launched = await launchApp({ withMockProvider: true, userDataDir, homeDir });
  const { page, mockProvider } = launched;

  // The record retains its idle state with no runtime behind it.
  expect(readTasks(userDataDir).find((task) => task.id === taskId)).toMatchObject({
    id: taskId,
    status: "active",
    activity: "idle",
    outcome: MOCK_COMPLETION_TEXT,
  });
  await recordEvidence(launched, taskId, "restored-idle-task");

  // Firstmate's context block lists it from crew_status, which is how the
  // mock finds the task id to settle; landing closes the durable row.
  const input = promptInput(page);
  await input.click();
  await input.fill(`${FINISH_PROMPT_MARKER}${title}`);
  await input.press("Enter");
  await expect(putInLine(page, row.key)).toBeVisible({
    timeout: 30_000,
  });
  const body = mockProvider?.requestBodies().at(-1) ?? "";
  expect(latestContext(body)?.crew).toEqual(
    expect.arrayContaining([expect.objectContaining({ task_id: taskId, status: "idle" })]),
  );

  // WI-11 retired `delivered`/`finish`: an idle crewmate is settled by
  // landing it. The clean branch fast-forwards, so the row closes done; its
  // worktree goes while the row, its report and its session stay (D2).
  await expect
    .poll(() => existsSync(join(userDataDir, "worktrees", taskId)), { timeout: 15_000 })
    .toBe(false);
  // The row records the removal after the directory is gone, so wait for
  // the row itself rather than racing that write (flaked on CI).
  await expect
    .poll(() => readTasks(userDataDir).find((task) => task.id === taskId), { timeout: 15_000 })
    .toMatchObject({
      id: taskId,
      status: "done",
      closed_reason: "landed",
      outcome: MOCK_COMPLETION_TEXT,
      workspace_state: "removed",
    });
  // The settle turn's ask attached to the task it landed (P1 capture).
  expect(timelineKinds(userDataDir, taskId)).toEqual([
    ...SPAWNED_TASK_START,
    "report",
    "ask",
    "landed",
    "note",
  ]);
  expect(existsSync(join(userDataDir, "crewmates", taskId, "sessions"))).toBe(true);
  await recordEvidence(launched, taskId, "settled-after-restart");
});

test("a task cancelled while idle closes as dropped with no worktree", async () => {
  const title = "write a cancel probe note";
  const row = await commissionReportedTask(launched, title);
  const { page, userDataDir } = launched;
  const input = promptInput(page);
  const taskId = row.id;
  expect(row).toMatchObject({ activity: "idle", workspace_state: "present" });
  expect(existsSync(join(userDataDir, "worktrees", taskId))).toBe(true);

  await input.click();
  await input.fill(`${CANCEL_PROMPT_MARKER}${title}`);
  await input.press("Enter");
  await expect(statusLine(page, row.key)).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => existsSync(join(userDataDir, "worktrees", taskId)), { timeout: 15_000 })
    .toBe(false);
  // The directory goes first and the row records it after: wait for the row,
  // not just the directory, or a busy machine reads the gap between the two.
  await expect
    .poll(() => readTasks(userDataDir).find((task) => task.id === taskId)?.workspace_state, {
      timeout: 15_000,
    })
    .toBe("removed");
  const closed = readTasks(userDataDir).find((task) => task.id === taskId);
  expect(closed).toMatchObject({
    status: "dropped",
    closed_reason: "cancelled",
    workspace_state: "removed",
  });
  expect(closed?.closed_at).toBeGreaterThan(0);
  expect(existsSync(join(userDataDir, "crewmates", taskId, "sessions"))).toBe(true);
  await recordEvidence(launched, taskId, "cancelled-task");
});
