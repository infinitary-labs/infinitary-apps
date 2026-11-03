import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { UsageStore } from "../../src/core/storage/usageStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { observeBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { seedTranscript } from "./transcriptFixtures";

const PLAN_TITLE = "Plan the faster release process";
const UNKNOWN_TITLE = "Unreported usage";
const PARTIAL_TITLE = "Partly reported usage";

// A classifier plus two served models from ONE Claude completion.
// No timestamp-based turn reconstruction: timestamps are not request IDs.
test("reads mixed-model task usage independently from the transcript model", async () => {
  const userDataDir = scratchDir("infinitary-observe-accounting-");
  const file = join(userDataDir, "main.jsonl");
  seedTranscript(file, [
    {
      type: "message",
      id: "reply",
      timestamp: "2026-10-05T12:00:00Z",
      message: {
        role: "assistant",
        model: "opus",
        provider: "anthropic-claude",
        content: [{ type: "text", text: "The plan is ready." }],
      },
    },
  ]);
  const db = openDatabase(userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: "plan",
    title: PLAN_TITLE,
    createdAt: Date.parse("2026-10-06T07:02:41Z"),
    status: "cancelled",
    sessionFile: file,
  });
  const store = new UsageStore(db);
  store.record({
    taskId: "plan",
    model: { provider: "openai-codex", id: "luna" },
    usage: { input: 65, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.0000675 },
    at: 1000,
  });
  store.record({
    taskId: "plan",
    model: { provider: "anthropic-claude", id: "opus" },
    usage: {
      models: [
        { model: "haiku", input: 20, output: 2, cacheRead: 0, cost: 0.00204 },
        { model: "opus", input: 100, output: 30, cacheRead: 400, cacheWrite: 0, cost: 8.3256488 },
      ],
    },
    at: 2000,
  });
  seedTask(new TaskService({ db, strict: true }), {
    id: "unknown",
    title: UNKNOWN_TITLE,
    createdAt: Date.parse("2026-10-06T07:02:41Z") + 1,
    status: "cancelled",
  });
  store.record({ taskId: "unknown", usage: { cost: 0 }, at: 3000 });
  seedTask(new TaskService({ db, strict: true }), {
    id: "partial",
    title: PARTIAL_TITLE,
    createdAt: Date.parse("2026-10-06T07:02:41Z") + 2,
    status: "cancelled",
  });
  store.record({
    taskId: "partial",
    usage: { input: 42, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
    at: 4000,
  });
  store.record({ taskId: "partial", usage: { input: 5, cost: 0 }, at: 4000 });
  store.record({ taskId: "partial", usage: {}, at: 4000 });
  db.close();
  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await resizeWindow(launched.app, page, { width: 1280, height: 900 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Observe" }).click();
    const frame = observeBody(page);
    await frame.locator('[data-observe-session="plan"]').dispatchEvent("click");
    const header = frame.locator("[data-observe-detail-header]");
    await expect(header).toContainText(PLAN_TITLE);
    await frame.locator("[data-observe-session-list]").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const mixed = await page.evaluate(() => window.infinitary.observe.detail("plan"));
    expect(mixed.model).toBe("anthropic-claude/opus");
    expect(mixed.usage?.records).toBe(3);
    expect(mixed.usage?.models?.map((model) => model.model)).toEqual(["haiku", "opus", "luna"]);
    await expect(header.locator("[data-model-chip]")).toContainText(mixed.model ?? "");
    await expect(header.locator("[data-observe-model-usage] > div")).toHaveCount(3);

    await frame.locator('[data-observe-session="unknown"]').dispatchEvent("click");
    await expect(header).toContainText(UNKNOWN_TITLE);
    const unknown = await page.evaluate(() => window.infinitary.observe.detail("unknown"));
    expect(unknown.usage?.priced).toBe(0);
    expect(unknown.usage?.reported?.input).toBe(0);
    expect(unknown.usage?.cost).toBeUndefined();
    await expect(header.locator("[data-model-chip]")).toHaveCount(0);

    await frame.locator('[data-observe-session="partial"]').dispatchEvent("click");
    await expect(header).toContainText(PARTIAL_TITLE);
    const partial = await page.evaluate(() => window.infinitary.observe.detail("partial"));
    expect(partial.usage).toMatchObject({
      input: 47,
      output: 0,
      cost: 0.5,
      records: 3,
      priced: 1,
      reported: { input: 2, output: 1, cacheRead: 1, cacheWrite: 1 },
    });
    await expect(header.locator("[data-observe-model-usage] > div")).toHaveCount(1);
  } finally {
    await launched.close();
  }
});
