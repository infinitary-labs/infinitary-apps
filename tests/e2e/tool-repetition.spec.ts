import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { POSSIBLE_REPETITION_OPENING } from "../../src/core/orchestrator/turnWakes";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { providerMessages } from "./providerRequest";
import { readSavedData } from "./savedData";
import { REPETITION_MARKER, REPETITION_TITLE, toolRepetition } from "./scenarios/toolRepetition";

/**
 * Intent: accepted INF-1996 piece 2, with INF-6123's successful-repeat threshold.
 * Prescribed picture rereads use the real read tool and durable session/task/inbox
 * owners. The first mate gets one notice at ten, and the task keeps reading.
 * Platform: desktop on Mac or Linux. Resources: isolated HOME/userData/provider.
 */
test("the first mate wakes at the tenth successful read without stopping prescribed rereads", async () => {
  const app = await launchApp({ withMockProvider: true, scenarios: [toolRepetition] });
  try {
    await askFirstmate(app.page, REPETITION_MARKER);
    const state = () =>
      readSavedData(app.userDataDir, (db) => ({
        task: db.prepare("SELECT id, status FROM tasks WHERE title = ?").get(REPETITION_TITLE) as
          | { id: string; status: string }
          | undefined,
        operation: db
          .prepare(
            "SELECT count, notice, first_call, latest_call FROM task_repetitions WHERE tool = ?",
          )
          .get("read") as
          | { count: number; notice: string | null; first_call: string; latest_call: string }
          | undefined,
        notices: db
          .prepare("SELECT COUNT(*) AS n FROM inbox_once WHERE once_key LIKE 'repetition:%'")
          .get() as { n: number },
      }));
    const notices = () =>
      app.mockProvider
        ?.requestBodies()
        .flatMap(providerMessages)
        .filter(
          (message) =>
            message.role === "user" && message.text.includes(POSSIBLE_REPETITION_OPENING),
        ) ?? [];
    // The scenario withholds read ten and then read eleven while we inspect their boundaries.
    await expect.poll(() => app.mockProvider?.heldThreadAnswers()).toBe(1);
    await expect.poll(() => state().operation?.count).toBe(9);
    const beforeThreshold = state();
    expect(beforeThreshold.operation?.notice).toBeNull();
    expect(beforeThreshold.notices.n).toBe(0);
    expect(notices()).toHaveLength(0);
    app.mockProvider?.releaseThreadAnswer();

    await expect.poll(() => app.mockProvider?.heldThreadAnswers()).toBe(1);
    await expect.poll(() => state().operation?.count).toBe(10);
    await expect.poll(() => notices().length).toBeGreaterThan(0);
    const atThreshold = state();
    expect(atThreshold.notices.n).toBe(1);
    const wake = notices()[0]?.text ?? "";
    expect(wake).toContain("every one of those calls worked; none failed");
    app.mockProvider?.releaseThreadAnswer();

    await expect.poll(() => state().operation?.count).toBe(11);
    await expect.poll(() => app.mockProvider?.heldRequests()).toBeGreaterThan(0);
    const observed = state();
    expect(observed.notices.n).toBe(1);
    expect(observed.operation?.notice).toBe(atThreshold.operation?.notice);
    expect(observed.task?.status).toBe("active");
    expect(observed.operation?.first_call).not.toBe(observed.operation?.latest_call);
    expect(wake).not.toContain("base64");
    const proof = JSON.stringify(
      {
        beforeThreshold,
        atThreshold,
        observed,
        wake,
        activeRequests: app.mockProvider?.heldRequests(),
      },
      null,
      2,
    );
    const evidence = process.env.INFINITARY_REPETITION_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "notice-delivery.json"), proof);
    }
    await test.info().attach("notice-delivery", {
      body: proof,
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});
