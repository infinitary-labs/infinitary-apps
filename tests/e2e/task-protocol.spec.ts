import { expect, test } from "@playwright/test";
import { crewComposer, crewmateView } from "./crewmateTab";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_COMPLETION_TEXT, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { nowRow, pressRow, reportLine, startedLine, taskKey } from "./rails";
import {
  SESSION_REPEAT_MARKER,
  SESSION_REPEAT_REPORT,
  sessionObservationRepeat,
} from "./scenarios/sessionObservationRepeat";
import { showTabByKeys } from "./taskBrowser";
import { focusOn, pressKey, typeInto } from "./windowKeys";

/**
 * The task protocol end to end (task-system P3, design section 9): a task
 * made by talking to the Firstmate (design principle 5) reaches the feed,
 * the board and the Tasks panel.
 */

const TITLE = "write a short status note";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [sessionObservationRepeat] });
});

test.afterAll(async () => {
  await launched.close();
});

test("a commissioned crewmate starts, reports, and its task is on the board with its outcome", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
  await input.press("Enter");
  const key = await taskKey(page, TITLE);
  await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
  await expect(reportLine(page, key)).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(
      () =>
        page.evaluate(async (key) => {
          const board = await window.infinitary.tasks.board();
          const task = board.tasks.find((task) => task.key === key);
          return task ? { status: task.status, activity: task.activity } : null;
        }, key),
      { timeout: 20_000 },
    )
    .toEqual({ status: "active", activity: "idle" });
  const detail = await page.evaluate(async (key) => {
    const board = await window.infinitary.tasks.board();
    const id = board.tasks.find((task) => task.key === key)?.id as string;
    return window.infinitary.tasks.detail(id);
  }, key);
  expect(detail.outcome).toBe(MOCK_COMPLETION_TEXT);
  // INF-1484 E2: the real supervisor records the same session at start and turn end.
  // Re-reading its token must not add another immutable Activity observation.
  expect(
    detail.timeline?.filter(({ entry }) => entry.content.kind === "session-observation"),
  ).toHaveLength(1);
  await test.info().attach("completed-turn-history", {
    body: Buffer.from(JSON.stringify(detail.timeline, null, 2)),
    contentType: "application/json",
  });
  await expect(nowRow(page, key)).toBeVisible();
  await pressRow(page, key);
  await showTabByKeys(page, "crewmate");
  const composer = crewComposer(crewmateView(page, detail.id));
  await focusOn(composer);
  await typeInto(composer, SESSION_REPEAT_MARKER);
  await pressKey(composer, "Enter");
  const reread = () => page.evaluate((id) => window.infinitary.tasks.detail(id), detail.id);
  await expect.poll(async () => (await reread()).outcome).toBe(SESSION_REPEAT_REPORT);
  await expect.poll(async () => (await reread()).activity).toBe("idle");
  const repeated = await reread();
  expect(repeated.events.filter((event) => event.kind === "report")).toHaveLength(2);
  expect(
    repeated.timeline?.filter(({ entry }) => entry.content.kind === "session-observation"),
  ).toEqual(detail.timeline?.filter(({ entry }) => entry.content.kind === "session-observation"));
  await test.info().attach("repeated-turn-history", {
    body: Buffer.from(JSON.stringify(repeated.timeline, null, 2)),
    contentType: "application/json",
  });
});

/**
 * The delta carrier (task-system P5, design section 9.1) through the real
 * window. A packaged build switches to deltas only above the design's
 * trigger; the dev override lowers it to zero so a one-task fleet takes
 * the path a large fleet takes, and the Tasks panel still paints the row.
 */
test.describe("the delta carrier above the trigger", () => {
  let delta: LaunchedApp;

  test.beforeAll(async () => {
    delta = await launchApp({
      withMockProvider: true,
      env: { INFINITARY_TASK_DELTA_ROWS: "0" },
    });
  });

  test.afterAll(async () => {
    await delta.close();
  });

  test("above the trigger, a commissioned task still reaches the Tasks panel", async () => {
    const { page } = delta;
    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
    await input.press("Enter");
    const key = await taskKey(page, TITLE);
    await expect(reportLine(page, key)).toBeVisible({ timeout: 30_000 });
    // The now panel is fed by the executor folding the deltas. An idle
    // crewmate with a report stays working, open by default.
    await expect(nowRow(page, key)).toBeVisible({ timeout: 10_000 });
    await expect(nowRow(page, key)).toContainText(TITLE);
  });
});
