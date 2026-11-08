import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { namedModelWords } from "../../src/core/orchestrator/namedModel";
import { ruleIdSchema } from "../../src/shared/routingPolicy";
import type { TaskDetail, TaskView } from "../../src/shared/tasks";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockModels";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  NAMED_SPAWN_ASK,
  NAMED_SPAWN_MISSING_ASK,
  NAMED_SPAWN_MISSING_MODEL_ID,
  NAMED_SPAWN_MISSING_TITLE,
  NAMED_SPAWN_TITLE,
  namedSpawn,
} from "./scenarios/namedSpawn";

/**
 * New work on a model the captain names answers with the model that took it
 * (FI3-444). A named model routes only when it can serve and otherwise falls
 * back without a word, so before this the Firstmate read only "Commissioned
 * crewmate N on task X" and could tell the captain the named model ran it.
 * The mock Firstmate follows the served tool contract by script; the record,
 * the routing ledger and the answer it reads back are the real app's. The
 * hermetic app serves one model, so a model it does not define is the one
 * that cannot serve; the answer's wording is `namedModel.test.ts`'s.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [namedSpawn] });
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

/** The spawn_crewmate call for a task and the answer the Firstmate read back, off its requests. */
function spawnExchange(
  title: string,
  taskId: string,
): { call: Record<string, unknown>; answer: string } | undefined {
  for (const body of launched.mockProvider?.requestBodies() ?? []) {
    if (!body.trimStart().startsWith("{")) continue;
    const messages = (JSON.parse(body) as { messages?: ChatMessage[] }).messages ?? [];
    const at = messages.findIndex((message) =>
      message.tool_calls?.some(
        (call) =>
          call.function.name === "spawn_crewmate" &&
          (JSON.parse(call.function.arguments) as { title?: string }).title === title,
      ),
    );
    const answer = messages.slice(at + 1).find((message) => message.role === "tool")?.content;
    if (at < 0 || typeof answer !== "string" || !answer.includes(`on task ${taskId}`)) continue;
    const call = messages[at]?.tool_calls?.find(
      (entry) => entry.function.name === "spawn_crewmate",
    );
    return { call: JSON.parse(call?.function.arguments ?? "{}"), answer };
  }
  return undefined;
}

/** The rule of every routing decision recorded for a task, from the app's own ledger. */
function routingRules(userDataDir: string, taskId: string): string[] {
  return readSavedData(userDataDir, (db) =>
    (
      db
        .prepare("SELECT rule FROM routing_decisions WHERE task_id = ? ORDER BY id")
        .all(taskId) as { rule: string }[]
    ).map((row) => row.rule),
  );
}

/**
 * The captain asks for new work on a named model; the task starts, and the
 * Firstmate's spawn answer names the model the record says took it.
 */
async function spawnOnNamedModel(
  page: Page,
  words: string,
  title: string,
  named: string,
): Promise<{ id: string; model: string; answer: string }> {
  await ask(page, words);
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = (await board(page)).find((task) => task.title === title)?.id;
        return id ? (await detail(page, id)).model : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  if (!id) throw new Error(`${title} never started`);
  const taskId = id;
  const { model, status } = await detail(page, taskId);
  expect(status).not.toBe("open");
  // It routed by the captain's named model (R0), whether or not it could serve.
  expect(routingRules(launched.userDataDir, taskId)).toEqual([ruleIdSchema.enum.R0]);
  await expect.poll(() => spawnExchange(title, taskId) ?? null, { timeout: 30_000 }).not.toBeNull();
  const exchange = spawnExchange(title, taskId);
  if (!exchange || !model) throw new Error(`${title} has no spawn answer or model`);
  expect(exchange.call).toMatchObject({ shape: { override_model_id: named } });
  mkdirSync(test.info().outputPath("spawn-model"), { recursive: true });
  writeFileSync(
    test.info().outputPath(`spawn-model/${taskId}.json`),
    JSON.stringify({ ...exchange, record: { id: taskId, model } }, null, 2),
  );
  return { id: taskId, model, answer: exchange.answer };
}

test("new work on a model the app serves answers with that model", async () => {
  const named = `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`;
  const { model, answer } = await spawnOnNamedModel(
    launched.page,
    NAMED_SPAWN_ASK,
    NAMED_SPAWN_TITLE,
    named,
  );
  expect(model).toBe(named);
  expect(answer).toContain(namedModelWords({ named, took: model }));
});

test("new work on a model the app cannot serve answers with the model that took it instead", async () => {
  const named = `${MOCK_PROVIDER_ID}/${NAMED_SPAWN_MISSING_MODEL_ID}`;
  const { model, answer } = await spawnOnNamedModel(
    launched.page,
    NAMED_SPAWN_MISSING_ASK,
    NAMED_SPAWN_MISSING_TITLE,
    named,
  );
  // Routing fell back to the one model the app serves.
  expect(model).toBe(`${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`);
  expect(answer).toContain(namedModelWords({ named, took: model }));
});
