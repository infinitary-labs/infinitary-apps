import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { RESTART_REPLAY_NOTE } from "../../src/core/orchestrator/wakes";
import { type LaunchedApp, launchApp, SHORT_TICK } from "./launch";
import { resizeWindow } from "./layout";
import {
  FM_SYSTEM_MARKER,
  MOCK_RESTART_REPLAY_REPORT,
  RESTART_REPLAY_PROMPT_MARKER,
  RESTART_REPLAY_QUITS,
  SPAWN_PROMPT_MARKER,
  startMockProvider,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { providerMessages, requestToolNames } from "./providerRequest";
import { expandDock } from "./rails";

/**
 * The captain closes the app while a crewmate is in the middle of one long
 * turn, opens it again, and does that three times (docs/inbox.md, "A turn a
 * quit or crash cut"). Each launch delivers the crewmate's message again,
 * saying it is a replay after a restart, and none of those replays spends
 * one of the message's three tries: the fourth launch picks the work up
 * again, in the task it began in, instead of setting the message aside.
 */

const TITLE = `${RESTART_REPLAY_PROMPT_MARKER} on the release checklist`;

test("a crewmate's turn the app closes under three times picks up again at the next launch, told it is a replay", async () => {
  // Its own app, since it quits and starts it again; one mock provider across every launch.
  test.setTimeout(360_000);
  const mockProvider = await startMockProvider();
  // A short grace between delivery attempts, so the work a quit left in
  // flight is due again by the time the next launch sweeps its inbox, and a
  // short tick, so that sweep comes seconds after the launch, not a minute.
  const env = { ...SHORT_TICK, INFINITARY_INBOX_GRACE_MS: "2000" };
  let app: LaunchedApp = await launchApp({ reuseMockProvider: mockProvider, env });
  /**
   * Each time the crewmate was handed its message, oldest first: its model
   * calls that open on words for it, not on the answer to a tool it called.
   */
  const deliveries = () =>
    mockProvider
      .requestBodies()
      .filter(
        (body) =>
          body.includes(RESTART_REPLAY_PROMPT_MARKER) &&
          !body.includes(FM_SYSTEM_MARKER) &&
          requestToolNames(body).includes("report") &&
          providerMessages(body).at(-1)?.role === "user",
      );
  /** The words the crewmate was handed last. */
  const latestWords = () => providerMessages(deliveries().at(-1) ?? "").at(-1)?.text ?? "";
  /** The tasks on the board, by title: the work never starts over as another task. */
  const boardTitles = () =>
    app.page.evaluate(async () =>
      (await window.infinitary.tasks.board()).tasks.map((task) => task.title),
    );
  try {
    await resizeWindow(app.app, app.page, { width: 1280, height: 900 });

    const taskId =
      await test.step("the captain asks for the work and its crewmate's turn runs", async () => {
        const input = promptInput(app.page);
        await expect(input).toBeEnabled({ timeout: 30_000 });
        await input.fill(`${SPAWN_PROMPT_MARKER} ${TITLE}`);
        await input.press("Enter");
        await expect.poll(() => deliveries().length, { timeout: 60_000 }).toBe(1);
        await expect.poll(() => mockProvider.heldRequests()).toBe(1);
        expect(latestWords()).not.toContain(RESTART_REPLAY_NOTE);
        return app.page.evaluate(async (title) => {
          const board = await window.infinitary.tasks.board();
          return board.tasks.find((task) => task.title === title)?.id ?? "";
        }, TITLE);
      });
    expect(taskId).not.toBe("");

    for (let quit = 1; quit <= RESTART_REPLAY_QUITS; quit += 1) {
      await test.step(`the app closes mid-turn (${quit} of ${RESTART_REPLAY_QUITS}) and the next launch delivers the message again, saying so`, async () => {
        const { userDataDir, homeDir } = app;
        await app.close();
        app = await launchApp({ reuseMockProvider: mockProvider, userDataDir, homeDir, env });
        await resizeWindow(app.app, app.page, { width: 1280, height: 900 });
        await expect.poll(() => deliveries().length, { timeout: 120_000 }).toBe(quit + 1);
        // The same message, opened by the replay note, in the conversation it was cut from.
        expect(latestWords()).toContain(RESTART_REPLAY_NOTE);
        expect(latestWords()).toContain(TITLE);
        expect(await boardTitles()).toEqual([TITLE]);
      });
    }

    await test.step("after the third restart the crewmate finishes the work", async () => {
      const outcome = async () =>
        (
          (await app.page.evaluate(
            (id) => window.infinitary.tasks.detail(id),
            taskId,
          )) as TaskDetail | null
        )?.outcome ?? "";
      await expect.poll(outcome, { timeout: 60_000 }).toContain(MOCK_RESTART_REPLAY_REPORT);
      expect(await boardTitles()).toEqual([TITLE]);
    });
  } finally {
    // What the crewmate was handed at each launch, for the run's record.
    writeFileSync(
      test.info().outputPath("deliveries.txt"),
      deliveries()
        .map(
          (body, index) => `--- launch ${index + 1}\n${providerMessages(body).at(-1)?.text ?? ""}`,
        )
        .join("\n\n"),
    );
    // The fourth launch as the captain sees it, with Activity and Tasks open.
    await Promise.all([expandDock(app.page, "activity"), expandDock(app.page, "now")]).catch(
      () => {},
    );
    await app.page.screenshot({ path: test.info().outputPath("last-launch.png") }).catch(() => {});
    await app.close();
    await mockProvider.close();
  }
});
