import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { renderWake } from "../../src/core/orchestrator/wakes";
import { placementNamedModelWait } from "../../src/shared/placement";
import { ruleIdSchema } from "../../src/shared/routingPolicy";
import type { TaskDetail, TaskView } from "../../src/shared/tasks";
import { type LaunchedApp, launchApp, SHORT_TICK } from "./launch";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockModels";
import { promptInput } from "./prompt";
import { latestContext, providerMessages } from "./providerRequest";
import { feedLineOf } from "./rails";
import { readSavedData } from "./savedData";
import {
  NAMED_SPAWN_ASK,
  NAMED_SPAWN_FOLLOW_UP_ASK,
  NAMED_SPAWN_MISSING_ASK,
  NAMED_SPAWN_MISSING_MODEL_ID,
  NAMED_SPAWN_MISSING_TITLE,
  NAMED_SPAWN_TITLE,
  namedSpawn,
} from "./scenarios/namedSpawn";

/**
 * New work on a model the captain names starts on it (FI3-444). The spawn
 * answers once the task is recorded, before any model takes it (INF-3060);
 * a start on the model named is no news, so no wake follows it, and the
 * crew list the Firstmate reads names the model instead (INF-5123). A named model that no computer serves never
 * starts on another model: the task waits and the Firstmate is told once to
 * ask the captain (INF-1429, the captain's "every start waits and asks").
 * The mock Firstmate follows the served tool contract by script; the record,
 * the routing ledger and the answer it reads back are the real app's. The
 * hermetic app serves one model, so a model it does not define is the one
 * that cannot serve; the answer's wording is `namedModel.test.ts`'s.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  // A short tick, so the ready sweep tries a waiting task again within the test.
  launched = await launchApp({ withMockProvider: true, scenarios: [namedSpawn], env: SHORT_TICK });
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

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? (part.text as string) : ""))
    .join("\n");
}

/** The wake that told the Firstmate a task it started is running, off its requests. */
function startedWake(taskId: string): string | undefined {
  for (const body of launched.mockProvider?.requestBodies() ?? []) {
    if (!body.trimStart().startsWith("{")) continue;
    const messages = (JSON.parse(body) as { messages?: ChatMessage[] }).messages ?? [];
    for (const message of messages) {
      if (message.role !== "user") continue;
      const line = textOf(message.content)
        .split("\n")
        .find(
          (entry) =>
            entry.includes(`[fm-op] task ${taskId} `) &&
            entry.includes("which you started, is running now"),
        );
      if (line) return line;
    }
  }
  return undefined;
}

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
    if (at < 0 || typeof answer !== "string" || !answer.includes(`Recorded task ${taskId}`))
      continue;
    const call = messages[at]?.tool_calls?.find(
      (entry) => entry.function.name === "spawn_crewmate",
    );
    return { call: JSON.parse(call?.function.arguments ?? "{}"), answer };
  }
  return undefined;
}

function routingRules(userDataDir: string, taskId: string): string[] {
  return readSavedData(userDataDir, (db) =>
    (
      db
        .prepare("SELECT rule FROM routing_decisions WHERE task_id = ? ORDER BY id")
        .all(taskId) as { rule: string }[]
    ).map((row) => row.rule),
  );
}

/** The model the Firstmate's crew list names for a task, off its newest request that lists it. */
function crewModel(taskId: string): string | undefined {
  let model: string | undefined;
  for (const body of launched.mockProvider?.requestBodies() ?? []) {
    const row = latestContext(body)?.crew?.find((entry) => entry.task_id === taskId);
    if (row?.model) model = row.model;
  }
  return model;
}

/**
 * The captain asks for new work on a named model; the task starts on it, and
 * the Firstmate reads the model its record says took it.
 */
async function spawnOnNamedModel(
  page: Page,
  words: string,
  title: string,
  named: string,
): Promise<{ id: string; model: string; listed: string }> {
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
  // The captain's next words reach the Firstmate with its crew list, which
  // names the model; no wake came before them to say the task started.
  await ask(page, NAMED_SPAWN_FOLLOW_UP_ASK);
  await expect.poll(() => crewModel(taskId) ?? null, { timeout: 30_000 }).not.toBeNull();
  const listed = crewModel(taskId) ?? "";
  expect(startedWake(taskId)).toBeUndefined();
  mkdirSync(test.info().outputPath("spawn-model"), { recursive: true });
  writeFileSync(
    test.info().outputPath(`spawn-model/${taskId}.json`),
    JSON.stringify({ ...exchange, listed, record: { id: taskId, model } }, null, 2),
  );
  return { id: taskId, model, listed };
}

test("new work on a model the app serves starts on it, and the crew list names it", async () => {
  const named = `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`;
  const { model, listed } = await spawnOnNamedModel(
    launched.page,
    NAMED_SPAWN_ASK,
    NAMED_SPAWN_TITLE,
    named,
  );
  expect(model).toBe(named);
  expect(listed).toBe(model);
});

test("new work on a model the app cannot serve waits, says so once, and Firstmate is told once to ask", async () => {
  const { page } = launched;
  const named = `${MOCK_PROVIDER_ID}/${NAMED_SPAWN_MISSING_MODEL_ID}`;
  await ask(page, NAMED_SPAWN_MISSING_ASK);
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = (await board(page)).find((task) => task.title === NAMED_SPAWN_MISSING_TITLE)?.id;
        // The list's wait line: the wait's words, then since when it waits.
        return id ? ((await detail(page, id)).queueWait?.line.split(" · ")[0] ?? null) : null;
      },
      { timeout: 30_000 },
    )
    .toBe(placementNamedModelWait(named));
  if (!id) throw new Error(`${NAMED_SPAWN_MISSING_TITLE} was never recorded`);
  const taskId = id;
  const key = (await board(page)).find((task) => task.id === taskId)?.key ?? taskId;
  // It routed by the captain's named model (R0), and started on none.
  expect(routingRules(launched.userDataDir, taskId)[0]).toBe(ruleIdSchema.enum.R0);

  const told = renderWake({
    facts: {
      kind: "named-model-wait",
      task: { id: taskId, key, title: NAMED_SPAWN_MISSING_TITLE },
      model: named,
    },
  });
  const heard = () =>
    (launched.mockProvider?.requestBodies() ?? [])
      .map(
        (body) =>
          providerMessages(body).filter(
            (message) => message.role === "user" && message.text.includes(told),
          ).length,
      )
      .filter((count) => count > 0);
  await expect.poll(heard, { timeout: 30_000 }).not.toHaveLength(0);

  // The ready sweep tries it again on later ticks; it still waits, Activity
  // keeps one line for the wait, and Firstmate is not told again.
  const line = feedLineOf(page, {
    type: "firstmate_note",
    taskId,
    text: `"${NAMED_SPAWN_MISSING_TITLE}": ${placementNamedModelWait(named)}`,
  });
  await expect(line).toHaveCount(1);
  const triesBefore = routingRules(launched.userDataDir, taskId).length;
  await expect
    .poll(() => routingRules(launched.userDataDir, taskId).length, { timeout: 30_000 })
    .toBeGreaterThan(triesBefore);
  const waiting = await detail(page, taskId);
  expect(waiting).toMatchObject({ status: "open", startedAt: null });
  expect(waiting.model ?? null).toBeNull();
  await expect(line).toHaveCount(1);
  expect(heard().every((count) => count === 1)).toBe(true);
  await line.scrollIntoViewIfNeeded();
  await test.info().attach("named-model-wait.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await test.info().attach("task.json", {
    body: JSON.stringify(waiting, null, 2),
    contentType: "application/json",
  });
});
