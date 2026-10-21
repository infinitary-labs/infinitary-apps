import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { expandDock, expectRecordBody, pressRow, recordCard, recordFrame } from "./rails";
import {
  FINDING,
  FINDING_RELAY_PROMPT,
  findingRelay,
  HELD_TITLE,
  READER_CARD_TITLE,
  READER_TITLE,
  RESUMED,
} from "./scenarios/findingRelay";

/**
 * A hold on a task's finding ends when that task reports it (INF-735, from
 * INF-720's Fix 2: "file a fix so a hold on another task's finding ends
 * when that task reports it"; PR #184 sat 2,393 minutes after INF-621's
 * finding). The first mate holds a rerun on a reader's finding through a
 * recorded wait. The reader reports the finding with its own card still up,
 * which is the captain's turn, and the rerun is no longer held on a close
 * days away: the report wakes the first mate with the rerun named, the
 * first mate passes the finding on and ends the wait, and the rerun carries
 * on. The served words are the unit tests' to own.
 */

/** Chromium drops native clicks into a hidden window's sandboxed frames. */
async function openRecord(page: Page, key: string, id: string): Promise<void> {
  await pressRow(page, key);
  await expect(recordCard(page)).toHaveAttribute("data-task-record", id);
  await expect(recordCard(page)).toHaveCSS("opacity", "1");
  await expectRecordBody(page);
}

test("a task held on another's finding carries on when that task reports it with its card still up", async () => {
  const userDataDir = scratchDir("infinitary-finding-relay-");
  const db = openDatabase(userDataDir);
  // TaskService performs boot recovery in its constructor, so construct it
  // only before launch. Reconstructing it in a poll writes over live turns.
  const tasks = new TaskService({ db });
  const evidence = (name: string) => test.info().outputPath(name);
  // Enforce read-only observation on this connection while the app owns writes.
  db.pragma("query_only = ON");
  const app = await launchApp({ withMockProvider: true, userDataDir, scenarios: [findingRelay] });
  const { page } = app;
  let reader = "";
  let held = "";
  try {
    // Section 1: the first mate starts the reader and the rerun held on its finding.
    const input = promptInput(page);
    await input.fill(FINDING_RELAY_PROMPT);
    await input.press("Enter");
    await expect
      .poll(
        () => {
          const live = tasks.list();
          reader = live.find((task) => task.title === READER_TITLE)?.id ?? "";
          held = live.find((task) => task.title === HELD_TITLE)?.id ?? "";
          return Boolean(reader && held);
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // Section 2: the reader reports its finding while its own decision card is up.
    await expect
      .poll(
        () =>
          tasks.timeline(reader).some((event) => event.kind === "report" && event.text === FINDING),
        { timeout: 30_000 },
      )
      .toBe(true);
    const readerCards = (await page.evaluate(() => window.infinitary.cards.list())).filter(
      (card) => card.taskId === reader,
    );
    expect(readerCards.map((card) => [card.title, card.actions.length])).toEqual([
      [READER_CARD_TITLE, 2],
    ]);
    // The report woke the first mate, naming the rerun held on it.
    const sorts = () => new DecisionStore(db).recent(200);
    await expect
      .poll(
        () =>
          sorts().find(
            (row) =>
              row.taskId === reader && row.model === "rule:waited-on" && row.wake.includes(FINDING),
          )?.facts,
        { timeout: 30_000 },
      )
      .toMatchObject({ kind: "report", waiting: [{ id: held, title: HELD_TITLE }] });

    // Section 3: the first mate passes the finding on and ends the wait; the rerun carries on.
    const steers = () =>
      tasks
        .timeline(held)
        .filter((event) => event.kind === "steered" && event.actor === "firstmate");
    await expect
      .poll(() => steers().some((event) => event.text.includes(FINDING)), { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(
        () =>
          tasks
            .timeline(held)
            .some((event) => event.kind === "report" && event.text === `${RESUMED} ${FINDING}`),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(tasks.blockers(held)).toEqual([]);
    expect(tasks.get(reader)?.status).toBe("active");
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
          (task) => task.id === held,
        ),
      )
      .toMatchObject({ status: "active", blockedBy: [] });
    // Only the reader's own card is up: the relay raised none of the app's.
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.title),
    ).toEqual([READER_CARD_TITLE]);
    await waitForFirstmateIdle(page);
    await expandDock(page, "now");
    await openRecord(page, tasks.get(held)?.key ?? "", held);
    await expect(recordFrame(page).locator("[data-record-attention]")).toBeHidden();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== "running"),
    );
    await page.screenshot({ path: evidence("finding-relay-resumed.png") });
  } finally {
    writeFileSync(
      evidence("finding-relay-record.json"),
      JSON.stringify(
        {
          reader: tasks.timeline(reader),
          held: tasks.timeline(held),
          blockers: tasks.blockers(held).map((task) => task.key),
          sorts: new DecisionStore(db)
            .recent(200)
            .filter((row) => row.taskId === reader || row.taskId === held),
        },
        null,
        2,
      ),
    );
    writeFileSync(
      evidence("finding-relay-requests.json"),
      JSON.stringify(app.mockProvider?.requestBodies() ?? [], null, 2),
    );
    await app.close();
    db.close();
  }
});
