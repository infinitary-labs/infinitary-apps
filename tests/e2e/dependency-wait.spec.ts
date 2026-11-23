import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import {
  expandDock,
  expectRecordBody,
  hideRecord,
  pressRow,
  recordBar,
  recordBarButton,
  recordCard,
} from "./rails";
import {
  DEPENDENCY_RESUMED_REPORT,
  DEPENDENCY_WAIT_MARKER,
  DEPENDENCY_WAIT_PROMPT,
  DEPENDENCY_WAIT_REPORT,
  DEPENDENCY_WAIT_TITLE,
  dependencyWait,
} from "./scenarios/dependencyWait";

/**
 * A wait on separately owned work that is underway (FI3-250), from the
 * captain's chair. Firstmate starts a crewmate behind work another crewmate
 * holds and links that work as its blocker; the crewmate reports the wait.
 * The app closes, and when it opens again the waiting crewmate's clock is
 * as overdue as the idle ladder's stuck task (`idle-ladder.spec.ts`), yet
 * no stall card goes up: it reads as waiting on that work. When the captain
 * drops that work from its record, the host resumes the waiting crewmate,
 * once, and it carries on. The served words are the unit tests' to own.
 */

/** Chromium drops native clicks into a hidden window's sandboxed frames. */
async function openRecord(page: Page, key: string, id: string): Promise<void> {
  await pressRow(page, key);
  await expect(recordCard(page)).toHaveAttribute("data-task-record", id);
  await expect(recordCard(page)).toHaveCSS("opacity", "1");
  await expectRecordBody(page);
}

/** One record on the stack at a time, so its bar is the one clicked. */
async function closeRecord(page: Page): Promise<void> {
  await hideRecord(page).click();
  await expect(recordCard(page)).toHaveCount(0);
}

test("a task waiting on work underway stays waiting past every idle rung and resumes when that work closes", async () => {
  const userDataDir = scratchDir("infinitary-dependency-wait-");
  const db = openDatabase(userDataDir);
  // TaskService performs boot recovery in its constructor, so construct it
  // only before launch. Reconstructing it in a poll writes over live turns.
  const tasks = new TaskService({ db });
  const worktreeDir = join(userDataDir, "worktrees", "owner");
  mkdirSync(worktreeDir, { recursive: true });
  const owner = seedTask(tasks, {
    id: "owner",
    title: `Land the ${DEPENDENCY_WAIT_MARKER}`,
    status: "idle",
    worktreeDir,
    outcome: "Working on the fixture.",
  });
  const evidence = (name: string) => test.info().outputPath(name);
  // Enforce read-only observation on this connection while the app owns writes.
  db.pragma("query_only = ON");
  let app = await launchApp({ withMockProvider: true, scenarios: [dependencyWait], userDataDir });
  const requests: string[] = [];
  let waitingId = "";
  try {
    // Section 1: Firstmate starts the crewmate behind the owner's work.
    const input = promptInput(app.page);
    await input.fill(`${DEPENDENCY_WAIT_PROMPT} ${owner.key}`);
    await input.press("Enter");
    await expect
      .poll(
        async () => {
          const board = await app.page.evaluate(() => window.infinitary.tasks.board());
          waitingId = board.tasks.find((task) => task.title === DEPENDENCY_WAIT_TITLE)?.id ?? "";
          return waitingId;
        },
        { timeout: 30_000 },
      )
      .not.toBe("");
    await expect
      .poll(() => tasks.graph.blockers(waitingId).map((task) => task.id), {
        timeout: 30_000,
      })
      .toEqual([owner.id]);
    await expect
      .poll(() => tasks.get(waitingId)?.outcome, { timeout: 30_000 })
      .toBe(DEPENDENCY_WAIT_REPORT);
    await expect.poll(() => tasks.get(waitingId)?.activity, { timeout: 30_000 }).toBe("idle");
    requests.push(...(app.mockProvider?.requestBodies() ?? []));
    await app.close();

    // Section 2: the app was closed for an hour and a half. The ladder had
    // nudged the crewmate and told Firstmate twice, the second time 35
    // minutes ago - the clock that puts a stuck task on the app's own card.
    const now = Date.now();
    // The app is stopped; only the offline recovery setup may write here.
    db.pragma("query_only = OFF");
    tasks.turns.recordRecovery(waitingId, {
      rung: 2,
      count: 2,
      at: now - 35 * 60_000,
      idleSince: now - 90 * 60_000,
    });
    db.pragma("query_only = ON");
    app = await launchApp({ withMockProvider: true, scenarios: [dependencyWait], userDataDir });
    const { page } = app;
    // The boot reconcile read every idle record: the owner's clock started.
    await expect.poll(() => tasks.get(owner.id)?.idleSince ?? null).not.toBeNull();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
          (task) => task.title === DEPENDENCY_WAIT_TITLE,
        ),
      )
      .toMatchObject({
        status: "active",
        blockedBy: [owner.key],
        workPosture: { state: "idle", reason: "dependency" },
      });
    expect(await page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
    expect(tasks.get(waitingId)?.recoveryRung).toBe(2);
    const steers = () =>
      tasks
        .timeline(waitingId)
        .filter((event) => event.kind === "steered" && event.actor === "supervisor");
    expect(steers()).toEqual([]);
    await expandDock(page, "now");
    await openRecord(page, tasks.get(waitingId)?.key ?? "", waitingId);
    await expect(recordCard(page).locator("[data-record-attention]")).toContainText(owner.key);
    // The picture waits for Firstmate's turn to end: a busy character dims the stack.
    await waitForFirstmateIdle(page);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: evidence("dependency-wait-waiting.png") });
    await closeRecord(page);

    // Section 3: the captain drops the work it waits on, from its record.
    await openRecord(page, owner.key, owner.id);
    await recordBarButton(page, "end").click();
    await expect(recordBar(page)).toHaveAttribute("data-record-footer", "confirm");
    await recordBarButton(page, "next").click();
    await expect.poll(() => tasks.get(owner.id)?.status, { timeout: 30_000 }).toBe("dropped");
    if ((await recordCard(page).count()) > 0) await closeRecord(page);
    await expect
      .poll(
        () =>
          tasks
            .timeline(waitingId)
            .some(
              (event) =>
                event.kind === "report" && event.text.startsWith(DEPENDENCY_RESUMED_REPORT),
            ),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(steers()).toHaveLength(1);
    expect(steers()[0]?.text).toContain(owner.key);
    expect(tasks.get(waitingId)?.outcome).toContain(owner.key);
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).filter(
        (card) => card.author === "host",
      ),
    ).toEqual([]);
    await openRecord(page, tasks.get(waitingId)?.key ?? "", waitingId);
    await expect(recordCard(page).locator("[data-record-attention]")).toBeHidden();
    await waitForFirstmateIdle(page);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: evidence("dependency-wait-resumed.png") });
    writeFileSync(
      evidence("dependency-wait-record.json"),
      JSON.stringify(
        {
          timeline: tasks.timeline(waitingId),
          sorts: new DecisionStore(db).recent(100).filter((row) => row.taskId === waitingId),
        },
        null,
        2,
      ),
    );
  } finally {
    requests.push(...(app.mockProvider?.requestBodies() ?? []));
    writeFileSync(evidence("dependency-wait-requests.json"), JSON.stringify(requests, null, 2));
    await app.close();
    db.close();
  }
});
