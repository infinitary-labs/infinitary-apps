import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { stallCardId, stallCardTitle } from "../../src/core/orchestrator/idleLadder";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { formatDurationShort } from "../../src/shared/quotaSignals";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { taskKey, taskKeyLinks } from "./rails";
import {
  STUCK_ALERT_ANSWER,
  STUCK_ALERT_QUESTION,
  stuckAlertReply,
} from "./scenarios/stuckAlertReply";
import { cardReply, cardSurface, expectNoCard, shownCard, shownEntry } from "./stack";

/**
 * The idle ladder's last rung, from the captain's chair (idle crew recovery,
 * captain-approved 2026-09-26; the sibling of report-sort.spec.ts). A
 * crewmate stopped with nothing running and no question for him; it was
 * nudged, the Firstmate was told twice and did nothing, and then the app
 * closed. At the next launch the saved clock is overdue, so the host puts
 * the task to him on a card of its own - once, in plain words, with three
 * ways out and a reply row. INF-1670, the captain's words: "i would remove
 * the "drop task" option and leave nuanced operations to the reply". His
 * question under it reaches the first mate, whose answer lands in the
 * card's thread. INF-3143, the captain's direction A ("Park it where it
 * shows up"): Back to backlog, in Keep waiting's place, parks a task whose
 * blocker nothing will change soon instead of a Nudge starting the cycle
 * again - the card leaves, and the task stays started with its work kept.
 *
 * Promised result: the alert shows Nudge, Back to backlog and Discard and a
 * reply row; a reply is answered in its thread; Back to backlog parks the
 * task in the backlog with its working copy kept.
 * Data: a task saved idle past both wakes, and the stand-in first mate.
 * Completion: the answer in the thread, then the card gone and the board
 * reading the task as started in the backlog. Platform: Electron, the hermetic launcher and the stand-in
 * provider; no account, outside service or shared resource.
 */

const TASK_TITLE = "Tidy the docs";
/** How long it has been idle when the app launches. */
const IDLE_MS = 90 * 60_000;
const WAIT_TITLE = "Publish the docs";

/**
 * The stall card's title, derived from its own record: the host names how
 * long the task has been stuck from the same moment it saves as the card's
 * `createdAt` (`raiseStallCard`), so a launch slowed by a loaded Mac reads
 * "1h 31m" and is still exact (INF-1436: the fixed "1h 30m" held only when
 * the card went up within 30 seconds of seeding).
 */
async function stallTitle(page: Page, taskId: string, taskTitle: string, idleSince: number) {
  const id = stallCardId(taskId);
  const createdAt = async () =>
    (await page.evaluate(() => window.infinitary.cards.list())).find((card) => card.id === id)
      ?.createdAt;
  await expect.poll(createdAt).toBeDefined();
  const raisedAt = await createdAt();
  if (raisedAt === undefined) throw new Error(`Expected the card ${id}`);
  return stallCardTitle(taskTitle, formatDurationShort(raisedAt - idleSince));
}

test("a crewmate stuck past every nudge and wake is the app's own card, which takes a reply the first mate answers", async () => {
  const userDataDir = scratchDir("infinitary-idle-ladder-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  const worktreeDir = join(userDataDir, "worktrees", "stuck-task");
  mkdirSync(worktreeDir, { recursive: true });
  seedTask(tasks, {
    id: "stuck-task",
    title: TASK_TITLE,
    status: "completed",
    worktreeDir,
    outcome: "I updated the index. The glossary still needs a pass.",
  });
  const now = Date.now();
  const idleSince = now - IDLE_MS;
  tasks.turns.recordRecovery("stuck-task", {
    rung: 2,
    count: 2,
    at: now - 35 * 60_000,
    idleSince,
  });
  db.close();

  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [stuckAlertReply],
  });
  try {
    const { page } = launched;
    const title = await stallTitle(page, "stuck-task", TASK_TITLE, idleSince);
    await expect(shownCard(page, title)).toBeVisible();
    // Its head names the task once, by the key that leads it as on every
    // card about a task (INF-418: it read "SCR-1 · SCR-1").
    const key = await taskKey(page, TASK_TITLE);
    const head = shownCard(page, title).locator("[data-card-head]");
    await expect(taskKeyLinks(head.locator("[data-card-key]"))).toHaveText([key]);
    expect((await head.innerText()).split(key)).toHaveLength(2);
    const body = cardBody(page, title);
    await expect(body.getByText("What it last said: I updated the index.")).toBeVisible();
    await expect(body.getByText("For anything else, reply here.")).toBeVisible();
    const entry = shownEntry(page);
    for (const label of ["Nudge", "Back to backlog", "Discard"]) {
      await expect(entry.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    for (const gone of ["Drop task", "Keep waiting"])
      await expect(entry.getByRole("button", { name: gone, exact: true })).toHaveCount(0);
    // The app's own card, and none of the machinery names itself.
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    expect(
      cards.filter((card) => card.taskId === "stuck-task").map((card) => [card.id, card.author]),
    ).toEqual([[stallCardId("stuck-task"), "host"]]);
    await expect(body.getByText(/ladder|wake|steer|supervis|harness|inbox|rung/i)).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath("idle-ladder-stall-card.png") });

    // The captain asks under it; the first mate answers in its thread.
    const reply = cardReply(page);
    await expect(reply.field).toBeVisible();
    await reply.field.click();
    await reply.field.fill(STUCK_ALERT_QUESTION);
    await reply.send.click();
    const thread = entry.locator("[data-card-thread]");
    await expect(thread.getByText(STUCK_ALERT_QUESTION)).toBeVisible();
    await expect(thread.getByText(STUCK_ALERT_ANSWER)).toBeVisible({ timeout: 30_000 });
    await expect(shownCard(page, title)).toBeVisible();

    // Back to backlog parks it: the alert leaves, the task stays started in
    // the backlog, and its working copy stays.
    await entry.getByRole("button", { name: "Back to backlog", exact: true }).click();
    await expectNoCard(page, title);
    const parked = () =>
      page.evaluate(async () => {
        const board = await window.infinitary.tasks.board();
        const task = board.tasks.find((each) => each.id === "stuck-task");
        return { status: task?.status, inBacklog: task?.backlogSince !== undefined };
      });
    await expect.poll(parked).toEqual({ status: "active", inBacklog: true });
    expect(existsSync(worktreeDir)).toBe(true);
  } finally {
    await launched.close();
  }
});

/**
 * The same last rung on a task that reached its limit of tries at the
 * checks, whose question the Firstmate never put to the captain: its
 * captain gate does not hold the card back. The card's words are
 * idleLadder.test.ts's.
 */

/**
 * A wait its crewmate declared with no card up (FI3-435, and INF-11 from the
 * captain's words "make this missed escalation structurally impossible"):
 * the outcome is up to the captain, and the crewmate said so in its report -
 * here after he closed its note and it judged he may still want something.
 * Nothing on his screen asks him, so the first mate owes the card; its
 * clock is as overdue as the stuck task's above, with both wakes let go, so
 * the app puts the wait to him on its own card. The card's words are
 * idleLadder.waits.test.ts's; only a ready card lists a task under "waiting
 * on you" (FI3-702), which task-wait-reason.spec.ts owns.
 */
test("a crewmate's declared wait on the captain with no card up is put to him on the app's own card", async () => {
  const userDataDir = scratchDir("infinitary-idle-ladder-wait-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  const worktreeDir = join(userDataDir, "worktrees", "waiting-task");
  mkdirSync(worktreeDir, { recursive: true });
  seedTask(tasks, {
    id: "waiting-task",
    title: WAIT_TITLE,
    status: "completed",
    worktreeDir,
    outcome: "The docs are published.",
  });
  const reason = "decide whether to keep the old pages";
  tasks.turns.recordReport("waiting-task", {
    text: "The docs are published; the captain may still want the old pages kept.",
    declared: { wait: { reason } },
  });
  // The gate the wait placed when it was reported, so the launch reads the
  // same hold rather than placing it afresh.
  tasks.placement.setGate("waiting-task", { kind: "captain", reason });
  const now = Date.now();
  const idleSince = now - IDLE_MS;
  tasks.turns.recordRecovery("waiting-task", {
    rung: 2,
    count: 2,
    at: now - 35 * 60_000,
    idleSince,
  });
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    const title = await stallTitle(page, "waiting-task", WAIT_TITLE, idleSince);
    await expect(shownCard(page, title)).toBeVisible();
    // It names what the crewmate waits on him to do.
    await expect(cardBody(page, title).getByText(reason)).toBeVisible();
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    expect(cards.map((card) => [card.id, card.author])).toEqual([
      [stallCardId("waiting-task"), "host"],
    ]);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath("idle-ladder-declared-wait.png") });
  } finally {
    await launched.close();
  }
});

/**
 * A finished crewmate that stopped behind its own outcome note without
 * declaring a wait (FI3-438). A note holds nothing, so the ladder still
 * climbs - but what it sends names the note instead of claiming no card is
 * up: the nudge, so the crewmate names it in a declared wait rather than
 * posting it again, and the Firstmate's wake, so it does not ask for the
 * card again. The served words are the unit tests' to own; this reads the
 * typed facts the ledger keeps, and that each served wake names the note.
 */
test("a crewmate stopped behind its outcome note is nudged about that note, and Firstmate hears the note is up", async () => {
  const userDataDir = scratchDir("infinitary-idle-ladder-note-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  const cards = new CardStore(db);
  const now = Date.now();
  const seedWithNote = (id: string, title: string) => {
    const worktreeDir = join(userDataDir, "worktrees", id);
    mkdirSync(worktreeDir, { recursive: true });
    const record = seedTask(tasks, {
      id,
      title,
      status: "completed",
      worktreeDir,
      outcome: `${title}: it is out.`,
    });
    const note = { id: `card-${id}-outcome`, title: `${title} is out` };
    cards.upsert({
      ...note,
      taskId: id,
      author: "crewmate",
      priority: 30,
      meta: record.key,
      body: "<p>It is out.</p>",
      actions: [],
      status: "ready",
      createdAt: now - 20 * 60_000,
    });
    return note;
  };
  // Idle past the nudge's ten minutes.
  const nudgedNote = seedWithNote("nudged-task", "Release the docs");
  tasks.turns.recordRecovery("nudged-task", {
    rung: 0,
    count: 0,
    at: null,
    idleSince: now - 15 * 60_000,
  });
  // Nudged ten minutes and more ago, and still idle.
  const wokenNote = seedWithNote("woken-task", "Release the guide");
  tasks.turns.recordRecovery("woken-task", {
    rung: 1,
    count: 0,
    at: now - 15 * 60_000,
    idleSince: now - 25 * 60_000,
  });

  const launched = await launchApp({ withMockProvider: true, userDataDir });
  const sorts = () => new DecisionStore(db).recent(100);
  const factsOf = (taskId: string, kind: string) =>
    sorts().find((row) => row.taskId === taskId && row.facts?.kind === kind) ?? null;
  try {
    // The boot reconcile climbed both: neither note held the turn.
    await expect
      .poll(() => factsOf("nudged-task", "idle-nudge")?.facts)
      .toMatchObject({
        kind: "idle-nudge",
        note: nudgedNote,
      });
    await expect
      .poll(() => factsOf("woken-task", "idle-stall")?.facts)
      .toMatchObject({
        kind: "idle-stall",
        note: wokenNote,
      });
    // Each wake names its note; the Firstmate was served its own, byte for
    // byte (its context block lists the note too, so the wake is matched).
    expect(factsOf("nudged-task", "idle-nudge")?.wake).toContain(nudgedNote.id);
    const served = factsOf("woken-task", "idle-stall")?.wake.split("\n")[0] ?? "";
    expect(served).toContain(wokenNote.id);
    await expect
      .poll(() =>
        (launched.mockProvider?.requestBodies() ?? []).some((body) =>
          body.includes(JSON.stringify(served).slice(1, -1)),
        ),
      )
      .toBe(true);
    // Both notes are still up, and nothing put a card of its own beside them.
    expect(
      (await launched.page.evaluate(() => window.infinitary.cards.list()))
        .map((card) => card.id)
        .sort(),
    ).toEqual([nudgedNote.id, wokenNote.id].sort());
  } finally {
    writeFileSync(
      test.info().outputPath("idle-ladder-note-record.json"),
      JSON.stringify(
        {
          sorts: sorts().filter(
            (row) => row.taskId === "nudged-task" || row.taskId === "woken-task",
          ),
          firstmateServed: (launched.mockProvider?.requestBodies() ?? []).filter(
            (body) => body.includes(wokenNote.id) || body.includes(nudgedNote.id),
          ),
        },
        null,
        2,
      ),
    );
    await launched.close();
    db.close();
  }
});
