import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { POSSIBLE_REPETITION_OPENING } from "../../src/core/orchestrator/wakes";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { providerMessages } from "./providerRequest";
import { readSavedData } from "./savedData";
import { REPETITION_MARKER, REPETITION_TITLE, toolRepetition } from "./scenarios/toolRepetition";

/**
 * Intent: accepted INF-1996 piece 2. Four prescribed picture rereads use the
 * real read tool and durable session/task/inbox owners, without a subscription.
 * The first mate gets one third-result observation while the task stays active.
 * Platform: desktop on Mac or Linux. Resources: isolated HOME/userData/provider.
 */
test("the first mate receives one third-result notice without stopping prescribed rereads", async () => {
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
          | { count: number; notice: string; first_call: string; latest_call: string }
          | undefined,
        notices: db
          .prepare("SELECT COUNT(*) AS n FROM inbox_once WHERE once_key LIKE 'repetition:%'")
          .get() as { n: number },
      }));
    await expect.poll(() => state().operation?.count).toBe(4);
    await expect.poll(() => app.mockProvider?.heldRequests()).toBeGreaterThan(0);
    await expect
      .poll(() =>
        app.mockProvider
          ?.requestBodies()
          .flatMap(providerMessages)
          .filter((message) => message.role === "user")
          .some((message) => message.text.includes(POSSIBLE_REPETITION_OPENING)),
      )
      .toBe(true);
    const observed = state();
    expect(observed.notices.n).toBe(1);
    expect(observed.task?.status).toBe("active");
    expect(observed.operation?.first_call).not.toBe(observed.operation?.latest_call);
    const messages =
      app.mockProvider
        ?.requestBodies()
        .flatMap(providerMessages)
        .filter(
          (message) =>
            message.role === "user" && message.text.includes(POSSIBLE_REPETITION_OPENING),
        ) ?? [];
    const wake = messages[0]?.text ?? "";
    expect(wake).not.toContain("base64");
    const evidence = process.env.INFINITARY_REPETITION_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, "notice-delivery.json"),
        JSON.stringify(
          {
            observed,
            wake,
            activeRequests: app.mockProvider?.heldRequests(),
          },
          null,
          2,
        ),
      );
    }
    await test.info().attach("notice-delivery", {
      body: JSON.stringify({ observed, wake, activeRequests: app.mockProvider?.heldRequests() }),
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});
