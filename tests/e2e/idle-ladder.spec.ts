import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { stallCardId, stallCardTitle } from "../../src/core/orchestrator/idleLadder";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { formatDurationShort } from "../../src/shared/quotaSignals";
import { DROP_TASK_LABEL } from "../../src/shared/recordDrop";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { taskKey, taskKeyLinks } from "./rails";
import { cardSurface, expectNoCard, shownCard } from "./stack";

/**
 * The idle ladder's last rung, from the captain's chair (idle crew recovery,
 * captain-approved 2026-09-26; the sibling of report-sort.spec.ts). A
 * crewmate stopped with nothing running and no question for him; it was
 * nudged, the Firstmate was told twice and did nothing, and then the app
 * closed. At the next launch the saved clock is overdue, so the host puts
 * the task to him on a card of its own - once, in plain words, with three
 * ways out - and his click on Drop task ends the task.
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

test("a crewmate stuck past every nudge and wake is the app's own card, and Drop task ends it", async () => {
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
  tasks.recordRecovery("stuck-task", {
    rung: 2,
    count: 2,
    at: now - 35 * 60_000,
    idleSince,
  });
  db.close();

  const launched = await launchApp({ userDataDir });
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
    for (const label of ["Continue", DROP_TASK_LABEL, "Discard"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    // One card, the app's own, and none of the machinery names itself.
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    expect(cards.map((card) => [card.id, card.author])).toEqual([
      ["card-stall-stuck-task", "host"],
    ]);
    await expect(body.getByText(/ladder|wake|steer|supervis|harness|inbox|rung/i)).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath("idle-ladder-stall-card.png") });

    await page.getByRole("button", { name: DROP_TASK_LABEL, exact: true }).click();
    await expectNoCard(page, title);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const board = await window.infinitary.tasks.board();
          return board.tasks.find((task) => task.id === "stuck-task")?.status;
        }),
      )
      .toBe("dropped");
  } finally {
    await launched.close();
  }
});

/**
 * The same last rung on a task that reached its limit of tries at the
 * checks, whose question the Firstmate never put to the captain: its
 * captain gate does not hold the card back. The card's words are
 * crewSupervisor.test.ts's.
 */
test("a capped task stuck past every wake is still put to the captain on the app's own card", async () => {
  const userDataDir = scratchDir("infinitary-idle-ladder-cap-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  const worktreeDir = join(userDataDir, "worktrees", "capped-task");
  mkdirSync(worktreeDir, { recursive: true });
  seedTask(tasks, {
    id: "capped-task",
    title: "Fix the gauge test",
    status: "completed",
    worktreeDir,
    outcome: "The checks failed again on the gauge test.",
  });
  const head = "abc1234def5678";
  const now = Date.now();
  tasks.recordDelivery("capped-task", {
    headSha: head,
    ci: "red",
    ciRounds: 3,
    ciRedHead: head,
    ciCapAt: now - 90 * 60_000,
  });
  tasks.setGate("capped-task", { kind: "captain", ref: head, reason: "the CI cap" });
  tasks.recordRecovery("capped-task", {
    rung: 2,
    count: 2,
    at: now - 35 * 60_000,
    idleSince: now - 90 * 60_000,
  });
  db.close();

  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    // The cap's captain gate does not hide it: the host puts the task to
    // him on its own card.
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.infinitary.cards.list()).some(
            (card) => card.taskId === "capped-task" && card.author === "host",
          ),
        ),
      )
      .toBe(true);
    await expect(cardSurface(page)).toBeVisible();
  } finally {
    await launched.close();
  }
});

/**
 * A wait its crewmate declared with no card up (FI3-435, and INF-11 from the
 * captain's words "make this missed escalation structurally impossible"):
 * the outcome is up to the captain, and the crewmate said so in its report -
 * here after he closed its note and it judged he may still want something.
 * Nothing on his screen asks him, so the first mate owes the card; its
 * clock is as overdue as the stuck task's above, with both wakes let go, so
 * the app puts the wait to him on its own card. The card's words are
 * crewSupervisor.test.ts's; only a ready card lists a task under "waiting
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
  tasks.recordReport("waiting-task", {
    text: "The docs are published; the captain may still want the old pages kept.",
    declared: { wait: { reason } },
  });
  // The gate the wait placed when it was reported, so the launch reads the
  // same hold rather than placing it afresh.
  tasks.setGate("waiting-task", { kind: "captain", reason });
  const now = Date.now();
  const idleSince = now - IDLE_MS;
  tasks.recordRecovery("waiting-task", {
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
      ["card-stall-waiting-task", "host"],
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
  tasks.recordRecovery("nudged-task", {
    rung: 0,
    count: 0,
    at: null,
    idleSince: now - 15 * 60_000,
  });
  // Nudged ten minutes and more ago, and still idle.
  const wokenNote = seedWithNote("woken-task", "Release the guide");
  tasks.recordRecovery("woken-task", {
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
