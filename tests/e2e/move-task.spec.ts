import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { reportSummary } from "@shared/feed";
import { moveLabel, PROVIDER_SIGN_IN_TITLE } from "../../src/core/orchestrator/hostCards";
import { TaskStore } from "../../src/core/storage/taskStore";
import { modelNames } from "../../src/shared/modelDisplayName";
import { catalogEntry } from "../../src/shared/providers";
import { FIRSTMATE_MODEL_KEY, launchClaudeCrew } from "./claudeCrew";
import type { LaunchedApp } from "./launch";
import { CLAUDE_CREWMATE_MARKER, MOCK_KEY_PROVIDER_ID, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { reportLine, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import { MOVE_TASK_PROMPT_MARKER, MOVED_TASK_REPORT, moveTask } from "./scenarios/moveTask";
import { shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

/**
 * A started task moves off a provider that signed it out (INF-849, the
 * captain's words: "it should offer an option to swap the crewmate to a
 * different provider"). The task's Claude crewmate meets a 401; its sign-in
 * card names the task and offers Move to the app's pick, by its model's
 * name, on OpenRouter, the other signed-in provider. The captain reaches
 * Move by keys, and the same task - its key, branch and working copy -
 * goes on there in a new conversation and reports.
 */

const TITLE = `${MOVE_TASK_PROMPT_MARKER} ${CLAUDE_CREWMATE_MARKER}`;
const TO_MODEL = FIRSTMATE_MODEL_KEY.slice(MOCK_KEY_PROVIDER_ID.length + 1);
const TO = catalogEntry(MOCK_KEY_PROVIDER_ID)?.name ?? MOCK_KEY_PROVIDER_ID;

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test("a signed-out crewmate's task moves to another provider by keys and goes on under its key", async () => {
  // The client meets the 401 once, as it does a lapsed login, rather than retrying it.
  launched = await launchClaudeCrew({
    scenarios: [moveTask(TO)],
    claudeTurns: { maxRetries: 0 },
    // OpenRouter's model, by the name OpenRouter lists, is one routing may pick:
    // the other provider a move can go to.
    catalog: [
      {
        provider: MOCK_KEY_PROVIDER_ID,
        id: TO_MODEL,
        label: "OpenAI: GPT Luna Latest",
        effectivePercentRemaining: 80,
      },
    ],
  });
  const { app, page, userDataDir } = launched;
  const input = page.getByRole("textbox", { name: "Task prompt" });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
  await input.press("Enter");
  const key = await taskKey(page, TITLE);
  const taskId = (await page.evaluate(
    async (wanted) =>
      (await window.infinitary.tasks.board()).tasks.find((task) => task.title === wanted)?.id,
    TITLE,
  )) as string;

  // The sign-in card names the task, and its default moves it.
  const card = shownCard(page, PROVIDER_SIGN_IN_TITLE);
  await expect(card).toBeVisible({ timeout: 30_000 });
  const before = readSavedData(userDataDir, (db) => new TaskStore(db).get(taskId));
  expect(before?.model).toMatch(/^anthropic-claude\//);
  // The captain's words: the button names the model the task would run on.
  const view = await page.evaluate(() => window.infinitary.models.slots());
  const toName = modelNames([...view.models, ...view.byName])(FIRSTMATE_MODEL_KEY);
  const move = card.getByRole("button", { name: moveLabel(toName), exact: true });
  await expect(move).toBeVisible();
  await expect(card.getByRole("button", { name: "Open settings", exact: true })).toBeVisible();
  const evidence = process.env.FM_TASK_EVIDENCE;
  if (evidence) await regionShot(card, join(evidence, "move-card-after.png"));
  if (process.env.MOVE_TASK_HERO === "1")
    await heroShot(app, page, { region: card, name: "move-task-to-another-provider" });

  await focusOn(move);
  await pressKey(move, "Enter");

  // The same task goes on: its crewmate reports under its key, on the new provider.
  await expect(
    reportLine(page, key).filter({ hasText: reportSummary(MOVED_TASK_REPORT) }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(card).toHaveCount(0);
  const after = readSavedData(userDataDir, (db) => new TaskStore(db).get(taskId));
  expect(after?.model).toBe(FIRSTMATE_MODEL_KEY);
  expect(after?.key).toBe(key);
  expect(after?.branch).toBe(before?.branch);
  expect(after?.worktreeDir).toBe(before?.worktreeDir);
});
