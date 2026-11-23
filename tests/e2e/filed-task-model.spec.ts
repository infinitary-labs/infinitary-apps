import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { TaskDetail, TaskView } from "../../src/shared/tasks";
import { crewSummary, pointAtCrewmate } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockModels";
import { promptInput } from "./prompt";
import { expandDock, pressRow, recordCard, taskFact } from "./rails";
import { readSavedData } from "./savedData";
import {
  FILED_MODEL_FILE_ASK,
  FILED_MODEL_PARENT,
  FILED_MODEL_START_ASK,
  FILED_MODEL_TITLE,
  filedTaskModel,
} from "./scenarios/filedTaskModel";

/**
 * A task filed earlier starts on the model the captain names (FI3-436). Before
 * update_task could carry a model, the only way to choose one was a new
 * spawn, so the filed row was dropped and replaced under a new key. The mock
 * Firstmate follows the served tool contract by script; the record, the
 * routing ledger and the crew summary are the real app's. The hermetic app
 * has no allowance catalog, so the router records the captain's model as the
 * rule (R0) and the session binds the one mock model; why-this-model wording
 * over a served choice is `src/core/routing/modelReason.test.ts`'s.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [filedTaskModel] });
});

test.afterAll(async () => {
  await launched.close();
});

async function ask(page: Page, words: string): Promise<void> {
  const input = promptInput(page);
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.click();
  await input.fill(words);
  await input.press("Enter");
}

async function board(page: Page): Promise<TaskView[]> {
  return (await page.evaluate(() => window.infinitary.tasks.board())).tasks;
}

function detail(page: Page, id: string): Promise<TaskDetail> {
  return page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
}

/** The slice of a chat-completions request this spec reads. */
type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: { function: { name: string; arguments: string } }[];
};

function routingRules(userDataDir: string, taskId: string): string[] {
  return readSavedData(userDataDir, (db) =>
    (
      db
        .prepare("SELECT rule FROM routing_decisions WHERE task_id = ? ORDER BY id")
        .all(taskId) as {
        rule: string;
      }[]
    ).map((row) => row.rule),
  );
}

test("a filed task starts on the model the captain names, keeping its key and parent", async () => {
  const { page } = launched;
  const named = `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`;

  let filed: TaskView | undefined;
  let parent: TaskView | undefined;
  await test.step("the captain files the work for later", async () => {
    await ask(page, FILED_MODEL_FILE_ASK);
    await expect
      .poll(
        async () => {
          const tasks = await board(page);
          filed = tasks.find((task) => task.title === FILED_MODEL_TITLE);
          parent = tasks.find((task) => task.title === FILED_MODEL_PARENT);
          return filed?.status ?? null;
        },
        { timeout: 30_000 },
      )
      .toBe("open");
    expect(filed?.parentId).toBe(parent?.id);
  });
  if (!filed || !parent) throw new Error("The filed task is missing");
  const { id, key } = filed;
  const filedCount = (await board(page)).length;

  await test.step("the captain asks for it on a model by name, and the same task starts on it", async () => {
    mkdirSync(test.info().outputPath("filed-task-model"), { recursive: true });
    await ask(page, FILED_MODEL_START_ASK);
    // The record names the model once the crewmate really runs on it.
    await expect.poll(async () => (await detail(page, id)).model, { timeout: 30_000 }).toBe(named);
    expect(await detail(page, id)).toMatchObject({ key, status: "active", parentId: parent?.id });
    // It routed by the captain's named model (R0), and only so.
    expect(routingRules(launched.userDataDir, id)).toEqual(["R0"]);
    // The Firstmate's one call named the model and started the row; its
    // answer returns while the start runs (INF-3060). The start took the
    // model named, so no wake follows to say so (INF-5123): the crew list
    // names the model instead.
    // As it rides the next request: a string inside the JSON body.
    const answered = JSON.stringify(`${key} "${FILED_MODEL_TITLE}" is starting.`).slice(1, -1);
    const carrying = () =>
      (launched.mockProvider?.requestBodies() ?? []).find((body) => body.includes(answered));
    await expect.poll(() => carrying() ?? null, { timeout: 30_000 }).not.toBeNull();
    const messages = (JSON.parse(carrying() as string) as { messages: ChatMessage[] }).messages;
    writeFileSync(
      test.info().outputPath("filed-task-model/firstmate-call.json"),
      JSON.stringify(
        {
          call: messages.flatMap((message) => message.tool_calls ?? []).at(-1)?.function,
          answer: messages.filter((message) => message.role === "tool").at(-1)?.content,
        },
        null,
        2,
      ),
    );
    const after = await board(page);
    expect(after).toHaveLength(filedCount);
    expect(after.filter((task) => task.status === "dropped")).toEqual([]);
  });

  await test.step("pointing at its crewmate names the model it runs on", async () => {
    const { modelLabel } = await detail(page, id);
    await pointAtCrewmate(page, id);
    await expect(crewSummary(page)).toHaveAttribute("data-crew-summary", id);
    await expect(taskFact(crewSummary(page), "model")).toHaveText(modelLabel ?? "");
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("filed-task-model/summary.png"),
    });
    await page.mouse.move(12, 12);
    await expandDock(page, "now");
    await pressRow(page, key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", id);
    // The record names it through the same lookup (FI3-565 piece 2).
    await expect(taskFact(recordCard(page), "model")).toHaveText(modelLabel ?? "");
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("filed-task-model/record.png"),
    });
  });
});
