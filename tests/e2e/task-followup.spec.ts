import { join } from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import {
  FOLLOWUP_PROVENANCE_OPENING,
  renderAnswerShapeSection,
} from "../../src/core/orchestrator/intentBrief";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { taskReadTable } from "../../src/core/storage/taskRecordFields";
import { waitForFirstmateIdle } from "./crew";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_COMPLETION_TEXT, MOCK_FOLLOWUP_TITLE, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { latestContext, providerMessages, requestToolNames } from "./providerRequest";
import {
  expectRecordBody,
  feedLine,
  nowFrame,
  pressRow,
  recordBarButton,
  recordCard,
  reportLine,
  taskKey,
} from "./rails";
import {
  FILE_FOLLOWUP_PROMPT_MARKER,
  fileFollowup,
  MOCK_FOLLOWUP_GOAL,
  MOCK_PROGRESS_TEXT,
} from "./scenarios/fileFollowup";
import { SPAWNED_TASK_START } from "./taskTimeline";

/**
 * The task graph (task-system P2) from the crewmate's side: a crewmate on
 * a real Pi session files a follow-up with its own tool, and the record
 * shows it as an on-request task of ITS OWN - discovered from the
 * crewmate's task, never a child of it, so it can never hold that task's
 * merge up - with the crewmate's progress line on the origin's timeline;
 * the feed says so in one line, and the filing rides the crewmate's report
 * wake (cards/tasks/agents P0, WI-4) - never a wake of its own, never a card.
 * Started from its record, a follow-up the classifier sorts as research is
 * served as the answer it is: no Delivery line and no tool to open a pull
 * request (FI3-598).
 */

let launched: LaunchedApp;

type TaskRow = {
  id: string;
  key: string;
  parent_id: string | null;
  kind: string;
  status: string;
  start_policy: string;
  title: string;
  goal: string | null;
  project_id: string;
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
          `SELECT id, key, parent_id, kind, status, start_policy, title, goal, project_id FROM ${taskReadTable(db)} ORDER BY created_at, seq`,
        )
        .all() as TaskRow[],
  );
}

test.beforeAll(async () => {
  launched = await launchApp({ scenarios: [fileFollowup], withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

test("a crewmate's follow-up is its own task, not a child, and the Firstmate hears about it", async () => {
  const { page, userDataDir, mockProvider } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${FILE_FOLLOWUP_PROMPT_MARKER}`);
  await input.press("Enter");

  // The feed carries the filing as one line, then the crewmate's report.
  const filed = feedLine(page, new RegExp(MOCK_FOLLOWUP_TITLE));
  await expect(filed).toBeVisible({ timeout: 30_000 });
  await expect(reportLine(page, await taskKey(page, FILE_FOLLOWUP_PROMPT_MARKER))).toBeVisible({
    timeout: 30_000,
  });
  await waitForFirstmateIdle(page, 20_000);

  await expect.poll(() => readTasks(userDataDir).length, { timeout: 10_000 }).toBe(2);
  const [origin, followup] = readTasks(userDataDir);
  // Neither task acquired a card just because the follow-up was filed.
  expect(
    (await page.evaluate(() => window.infinitary.cards.list())).some(
      (card) => card.taskId === origin?.id || card.taskId === followup?.id,
    ),
  ).toBe(false);
  expect(origin).toMatchObject({ key: "SCR-1", kind: "work", parent_id: null });
  expect(followup).toMatchObject({
    key: "SCR-2",
    kind: "work",
    // Discovery is provenance, not containment: no parent edge, so the work
    // the captain asked for still lands on its own merits. The project is
    // still inherited from the origin.
    parent_id: null,
    status: "open",
    start_policy: "on-request",
    title: MOCK_FOLLOWUP_TITLE,
    goal: MOCK_FOLLOWUP_GOAL,
    project_id: origin?.project_id,
  });

  // The edge and the timelines: discovered-from points at the origin, the
  // progress line sits on the origin's timeline off the feed, and the
  // origin still carries its report.
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
  expect(links).toEqual([
    { from_id: followup?.id, to_id: origin?.id, type: "discovered-from", actor: "crewmate" },
  ]);
  const originEvents = withDb(
    userDataDir,
    (db) =>
      db
        .prepare(
          "SELECT kind, actor, text, feed FROM task_events WHERE task_id = ? ORDER BY at, id",
        )
        .all(origin?.id) as { kind: string; actor: string; text: string; feed: number }[],
  );
  // The decision records (R2 provenance) ride the same timeline; the work's
  // own story reads the same without them.
  expect(
    originEvents.some((event) => event.kind === "decided" && event.actor === "firstmate"),
  ).toBe(true);
  const workEvents = originEvents.filter((event) => event.kind !== "decided");
  expect(workEvents.map((event) => event.kind)).toEqual([
    ...SPAWNED_TASK_START,
    "linked",
    "progress",
    "report",
  ]);
  expect(originEvents.find((event) => event.kind === "progress")).toMatchObject({
    actor: "crewmate",
    text: MOCK_PROGRESS_TEXT,
    feed: 0,
  });
  expect(workEvents.at(-1)?.text).toBe(MOCK_COMPLETION_TEXT);
  const followupEvents = withDb(
    userDataDir,
    (db) =>
      db
        .prepare("SELECT kind, actor FROM task_events WHERE task_id = ? ORDER BY at, id")
        .all(followup?.id) as { kind: string; actor: string }[],
  );
  expect(followupEvents).toEqual([
    { kind: "created", actor: "crewmate" },
    { kind: "note", actor: "crewmate" },
  ]);

  // The filing rode the crewmate's report wake, which the whose-turn rule
  // hands to the Firstmate (S7c, branch 2); no wake of its own reached anyone.
  await expect
    .poll(
      () =>
        (mockProvider?.requestBodies() ?? []).some(
          (body) =>
            body.includes(FIRSTMATE_PERSONA) &&
            body.includes("reported on task") &&
            body.includes(`Filed this turn: SCR-2 \\"${MOCK_FOLLOWUP_TITLE}\\" (not blocking)`),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const requests = mockProvider?.requestBodies() ?? [];
  expect(requests.some((body) => body.includes("filed a follow-up while working on task"))).toBe(
    false,
  );
  // The Firstmate's next turn counts the follow-up in its project's
  // backlog, waiting on request; the context lists only started work, and
  // the tasks read names where it was found (INF-1712).
  await askFirstmate(page, "what is on the board?", 20_000);
  await expect
    .poll(
      () =>
        (mockProvider?.requestBodies() ?? [])
          .filter((body) => body.includes(FIRSTMATE_PERSONA))
          .at(-1)
          ?.includes("what is on the board?"),
      { timeout: 20_000 },
    )
    .toBe(true);
  const latest =
    (mockProvider?.requestBodies() ?? [])
      .filter((body) => body.includes(FIRSTMATE_PERSONA))
      .at(-1) ?? "";
  expect(latestContext(latest)?.backlog?.projects).toEqual(
    expect.arrayContaining([expect.objectContaining({ project: "SCR", on_request: 1 })]),
  );
  expect(latestContext(latest)?.crew.map((entry) => entry.task_id)).not.toContain(followup?.id);

  await test.step("started, a follow-up the classifier sorts as research is told it ships nothing, and gets no tool to ship (FI3-598)", async () => {
    // The follow-up was filed with its origin's posture, before any kind.
    const filedBrief = await page.evaluate(
      (id) => window.infinitary.tasks.detail(id).then((task) => task.brief),
      followup?.id ?? "",
    );
    expect(filedBrief).toContain("Delivery: ");

    // The captain starts it from its record in the Tasks panel.
    const backlog = nowFrame(page).locator('[data-now-group-header="backlog"]');
    if ((await backlog.getAttribute("aria-expanded")) === "false") {
      await backlog.evaluate((el) => (el as HTMLElement).click());
    }
    await pressRow(page, "SCR-2");
    await expect(recordCard(page)).toHaveAttribute("data-task-record", followup?.id ?? "");
    await expectRecordBody(page);
    await recordBarButton(page, "next").click();

    // The mock classifier sorts it as research, so the record says it
    // delivers an answer and takes no rigor.
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), followup?.id ?? ""), {
        timeout: 30_000,
      })
      .toMatchObject({ status: "active", deliverable: "answer", rigor: null });

    // What its crewmate was served: the brief and the tools on its first
    // request. Its brief names the origin, so the origin's own request is
    // the one without the filing's provenance line.
    const crewRequests = () =>
      (mockProvider?.requestBodies() ?? []).filter((body) => body.includes("You are a crewmate"));
    const filedAs = FOLLOWUP_PROVENANCE_OPENING;
    await expect
      .poll(() => crewRequests().find((body) => body.includes(filedAs)) ?? null, {
        timeout: 30_000,
      })
      .not.toBeNull();
    const served = crewRequests().find((body) => body.includes(filedAs)) as string;
    const brief = providerMessages(served).find((message) => message.role === "user")?.text ?? "";
    await test.info().attach("follow-up served brief", { body: brief, contentType: "text/plain" });
    expect(brief).toContain(MOCK_FOLLOWUP_GOAL);
    expect(brief).not.toContain("Delivery: ");
    // The focused brief tests own the wording; this proves the answer guidance reached the model.
    expect(brief).toContain(renderAnswerShapeSection());

    // The tools agree with the brief: the change that filed it could open a
    // pull request, the answer cannot, and both can still read checks.
    const originTools = requestToolNames(
      crewRequests().find(
        (body) => body.includes(FILE_FOLLOWUP_PROMPT_MARKER) && !body.includes(filedAs),
      ) ?? "",
    );
    const followupTools = requestToolNames(served);
    await test.info().attach("crewmate tools", {
      body: JSON.stringify({ origin: originTools, followup: followupTools }, null, 2),
      contentType: "application/json",
    });
    expect(originTools).toEqual(expect.arrayContaining(["open_change", "check_change"]));
    expect(followupTools).toContain("read_workflow");
    expect(followupTools).not.toContain("open_change");
    expect(followupTools).not.toContain("check_change");
  });
});
