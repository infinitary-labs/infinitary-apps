import { join } from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { type LaunchedApp, launchApp } from "./launch";
import {
  BLOCKED_REPORT_PROMPT_MARKER,
  ESCALATE_PROMPT_MARKER,
  ESCALATION_REFUSAL_PHRASE,
  MOCK_BLOCKED_REPORT,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { feedLine, reportLine, startedLine, taskKey, taskLine } from "./rails";

/**
 * Escalation on the regular spawn (intelligence-bucket routing S4,
 * captain-approved 2026-09-18, report section 4). The captain rejecting a
 * result in words is the ONLY trigger: it produces a fresh crewmate one
 * tier up, briefed with the failed attempt's report, linked
 * discovered-from it, with the rejected row closed superseded and one feed
 * line. A crewmate's own "I am blocked" arriving as an [fm-op] is refused
 * at the tool boundary, and nothing is created by that refusal.
 */

let launched: LaunchedApp;

type TaskRow = {
  id: string;
  key: string;
  title: string;
  status: string;
  closed_reason: string | null;
  difficulty: string | null;
  shape_json: string | null;
  prompt: string;
};

function withDb<T>(userDataDir: string, read: (db: Database.Database) => T): T {
  const db = new Database(join(userDataDir, "firstmate.db"), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function readTasks(userDataDir: string): TaskRow[] {
  return withDb(
    userDataDir,
    (db) =>
      db
        .prepare(
          "SELECT id, key, title, status, closed_reason, difficulty, shape_json, prompt FROM tasks ORDER BY created_at, seq",
        )
        .all() as TaskRow[],
  );
}

function readEvents(userDataDir: string, taskId: string) {
  return withDb(
    userDataDir,
    (db) =>
      db
        .prepare(
          "SELECT kind, actor, text, data_json, feed FROM task_events WHERE task_id = ? ORDER BY at, id",
        )
        .all(taskId) as {
        kind: string;
        actor: string;
        text: string;
        data_json: string | null;
        feed: number;
      }[],
  );
}

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

test("the captain's rejection escalates a task one tier up as a fresh crewmate", async () => {
  const { page, userDataDir } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} Meter fix`);
  await input.press("Enter");

  const key = await taskKey(page, "Meter fix");
  await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
  await expect(reportLine(page, key)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => readTasks(userDataDir).length, { timeout: 15_000 }).toBe(1);
  const attempt = readTasks(userDataDir)[0] as TaskRow;
  // Every unoverridden spawn routes high until the classifier lands (S2),
  // so the rung above this attempt is premium.
  expect(attempt.difficulty).toBe("high");

  // The captain rejects the result in his own words. No new tool: the same
  // spawn_crewmate, carrying escalate_from.
  await input.click();
  await input.fill(`${ESCALATE_PROMPT_MARKER}Meter fix`);
  await input.press("Enter");

  await expect.poll(() => readTasks(userDataDir).length, { timeout: 30_000 }).toBe(2);
  const [rejected, fresh] = readTasks(userDataDir) as [TaskRow, TaskRow];

  // One tier up, with the lineage stamped on the shape the row routed from.
  expect(fresh.difficulty).toBe("premium");
  expect(JSON.parse(fresh.shape_json ?? "{}")).toMatchObject({
    escalate_from: rejected.key,
    escalation: { from: rejected.key, attempt: 1, floor: "premium" },
  });

  // A FRESH crewmate (Q4 B), briefed with the failed attempt's report and
  // the captain's words - never a resume of the rejected session.
  expect(fresh.prompt).toContain(rejected.key);
  expect(fresh.prompt).toContain(`${ESCALATE_PROMPT_MARKER}Meter fix`);

  // The rejected attempt is closed superseded (O1), not deleted.
  await expect
    .poll(() => readTasks(userDataDir)[0]?.closed_reason, { timeout: 20_000 })
    .toBe("superseded");
  expect(readTasks(userDataDir)[0]?.status).toBe("dropped");

  // The lineage edge the captain chose.
  const links = withDb(
    userDataDir,
    (db) =>
      db.prepare("SELECT from_id, to_id, type, actor FROM task_links").all() as {
        from_id: string;
        to_id: string;
        type: string;
        actor: string;
      }[],
  );
  expect(links).toContainEqual({
    from_id: fresh.id,
    to_id: rejected.id,
    type: "discovered-from",
    actor: "captain",
  });

  // The two `escalated` rows, and exactly one of them on the feed.
  const rejectedEscalated = readEvents(userDataDir, rejected.id).filter(
    (event) => event.kind === "escalated",
  );
  expect(rejectedEscalated).toHaveLength(1);
  expect(rejectedEscalated[0]?.feed).toBe(1);
  expect(JSON.parse(rejectedEscalated[0]?.data_json ?? "{}")).toMatchObject({
    escalated_to: fresh.key,
    attempt: 1,
    tier: "premium",
  });
  const freshEscalated = readEvents(userDataDir, fresh.id).filter(
    (event) => event.kind === "escalated",
  );
  expect(freshEscalated).toHaveLength(1);
  expect(freshEscalated[0]?.feed).toBe(0);
  // The close that retired the rejected row says so on the record and stays
  // off the feed, so the escalation is one line, not two.
  const superseded = readEvents(userDataDir, rejected.id).find(
    (event) => event.kind === "status" && event.text === "superseded",
  );
  expect(superseded?.feed).toBe(0);

  // The rejected row's one line names the stored tier it moved to and the
  // row the work goes on as.
  const escalated = taskLine(page, rejected.key, "escalated");
  await expect(escalated).toContainText(fresh.key, { timeout: 20_000 });
  await expect(escalated).toContainText("premium");
});

test("an escalate_from on an [fm-op] wake is refused and creates nothing", async () => {
  const { page, userDataDir, mockProvider } = launched;
  const before = new Set(readTasks(userDataDir).map((task) => task.id));
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${BLOCKED_REPORT_PROMPT_MARKER}`);
  await input.press("Enter");

  // The crewmate says it is blocked; supervision hands that to the Firstmate,
  // which tries to escalate from the report alone.
  await expect(feedLine(page, new RegExp(MOCK_BLOCKED_REPORT.slice(0, 40)))).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(
      () =>
        (mockProvider?.requestBodies() ?? []).some((body) =>
          body.includes(ESCALATION_REFUSAL_PHRASE),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);

  // Nothing climbed: no new row, and the crewmate's own task is untouched.
  const tasks = readTasks(userDataDir);
  const created = tasks.filter((task) => !before.has(task.id));
  const blocked = created.find((task) => task.title.includes(BLOCKED_REPORT_PROMPT_MARKER));
  expect(blocked).toBeDefined();
  // A decision row settling the preceding captain turn may land here after
  // this test starts. It is not an escalation; only another routed work row
  // would violate this boundary.
  expect(created.filter((task) => task.difficulty !== null)).toEqual([blocked]);
  if (!blocked) throw new Error("blocked crewmate row did not land");
  expect(blocked.title).toContain(BLOCKED_REPORT_PROMPT_MARKER);
  expect(blocked.status).toBe("active");
  expect(blocked.closed_reason).toBeNull();
  expect(
    tasks.some((task) => JSON.parse(task.shape_json ?? "{}").escalate_from === blocked.key),
  ).toBe(false);
  expect(readEvents(userDataDir, blocked.id).some((event) => event.kind === "escalated")).toBe(
    false,
  );
});
