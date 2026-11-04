import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { renderWake, replyWordsSpan, type TypedWake } from "../../src/core/orchestrator/wakes";
import { appPathsFor, crewmateCardPicturesDir } from "../../src/core/paths";
import { keepValidationEvidence } from "../../src/core/pi/validationEvidence";
import { openDatabase } from "../../src/core/storage/db";
import { ACTIVITY_PLACES } from "../../src/core/tasks/recordActivity";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { DEMO_POSTER, GIF_DEMO_RECORDING } from "./demoFixtures";
import { launchApp } from "./launch";
import {
  expandDock,
  expectRecordSized,
  openGroup,
  pressRow,
  recordCard,
  recordFrame,
  recordTab,
} from "./rails";
import { seedCrewTranscript } from "./transcriptFixtures";
import { pressKey, runFromSearch, untilFocused } from "./windowKeys";

/**
 * A task's Activity leaves nothing out (FI3-1189's rule 2, "fold instead of
 * hiding"; docs/task-record.md, "What Activity holds"). The record is one
 * the app boots into, written through the one writer as the app writes it:
 * the app's own bookkeeping and news, a crewmate's update and the report
 * that restates it, a reply the captain typed under a card, repeated check
 * readings and a close. The captain reads every event but the evidence as a
 * row or under the row it led to, opened from the keyboard. What the
 * crewmate did reads from the session the app kept for it (rule 3,
 * "A crewmate's actions"), folded the same way.
 */

const ID = "activity-folds";
const WORDS = "merge the fix first, then rerun it";

async function seeded(): Promise<{ userDataDir: string; transcript: string }> {
  const userDataDir = scratchDir("infinitary-record-activity-");
  const db = openDatabase(userDataDir);
  let at = Date.now() - 60 * 60_000;
  const tasks = new TaskService({ db, strict: true, now: () => (at += 60_000) });
  seedTask(tasks, {
    id: ID,
    title: "Rerun the practice release's Mac check",
    intent: { goal: "The practice release passes.", userWords: "rerun the practice release" },
    status: "idle",
  });
  tasks.note(ID, "a fresh working copy of main", { news: false });
  tasks.noteProgress(ID, "The rerun failed on a different journey; reading its log.");
  tasks.recordReport(ID, {
    text: "The Mac check failed again on another journey. I filed it as its own task.",
    summary: "The rerun failed on a different journey, and I filed it.",
  });
  const reply: TypedWake = {
    facts: {
      kind: "thread-reply",
      card: { id: "card-folds", title: "Rerun failed" },
      words: WORDS,
    },
  };
  const words = replyWordsSpan(reply);
  tasks.recordSteer(ID, {
    text: renderWake(reply),
    actor: "captain",
    outcome: "mid-turn",
    via: "thread",
    decision: null,
    cardId: "card-folds",
    inboxId: null,
    ...(words ? { words } : {}),
  });
  for (const ci of ["pending", "pending", "green"] as const) {
    seedDelivery(tasks, ID, { ci, prNumber: 977 }, { kind: "ci", text: `CI ${ci}` });
  }
  tasks.note(ID, "The captain approved merging #977.", { news: true });
  // INF-125: a historical fixture's unavailable live boundary remains explicit, not a pass.
  const head = "a".repeat(40);
  tasks.recordLiveValidation(
    ID,
    {
      kind: "plan",
      previousRevision: 0,
      reason: "The workflow is the requested runtime boundary.",
      scenarios: [
        {
          id: "mac-workflow",
          source: "rerun the practice release",
          importance: "required",
          action: "Run the practice release's Mac check.",
          expected: "The workflow completes successfully.",
          adverse: "A failed or unavailable run must not become a live pass.",
          environment: "Disposable practice release",
          signal: "The actual workflow reports its result.",
          boundary: "Mac workflow runner",
        },
      ],
    },
    { head },
  );
  // INF-203 F4: show the actual stored readings after bytes leave the delivery row.
  const transcript = JSON.stringify(tasks.timeline(ID).filter((event) => event.kind === "ci"));
  // e2e-fixture: input -- supply authored proof for the real evidence keeper to retain
  writeFileSync(join(userDataDir, "proof-readings.json"), transcript);
  const poster = join(userDataDir, "proof-poster.png");
  const recording = join(userDataDir, "proof-recording.gif");
  if (!DEMO_POSTER.bytes) throw new Error("The recorded fixture must supply its poster bytes.");
  // e2e-fixture: input -- supply the real fixture poster to the evidence keeper
  writeFileSync(poster, DEMO_POSTER.bytes);
  // e2e-fixture: input -- supply the real fixture recording to the evidence keeper
  writeFileSync(recording, GIF_DEMO_RECORDING.bytes);
  tasks.recordLiveValidation(
    ID,
    await keepValidationEvidence(
      {
        kind: "run",
        id: "isolated-record",
        head,
        scenarioRevision: 1,
        completion: "complete",
        verdict: "inconclusive",
        reason: "This isolated fixture cannot exercise the actual runner.",
        observations: [
          {
            scenario: "mac-workflow",
            result: "untested",
            live: false,
            actual: "No actual Mac workflow runner is connected to this fixture.",
            evidence: ["picture", "recording", "readings"],
            standIns: [
              "Stored workflow readings",
              "Captioned media fixture; not proof of workflow execution",
            ],
            unproven: ["Actual workflow execution"],
            attempted: ["Read the stored workflow results."],
            missingCapability: "Mac workflow runner",
            reason: "The isolated fixture has no actual workflow runner.",
          },
        ],
        evidence: [
          { id: "picture", path: "proof-poster.png", description: DEMO_POSTER.alt },
          {
            id: "recording",
            path: "proof-recording.gif",
            poster: "proof-poster.png",
            description: "A retained media fixture, not an actual workflow run.",
          },
          {
            id: "readings",
            path: "proof-readings.json",
            description: "The stored check readings; not live workflow proof.",
          },
        ],
      },
      {
        taskId: ID,
        worktree: userDataDir,
        dir: crewmateCardPicturesDir(appPathsFor(userDataDir), ID),
      },
    ),
    { head },
  );
  seedDelivery(tasks, ID, { validationHead: head });
  tasks.close(ID, { status: "done", reason: "merged", actor: "host" });
  tasks.markWorkspaceRemoved(ID);
  db.close();
  return { userDataDir, transcript };
}

test("a record's Activity folds minor events under the row they led to, opened by keys", async () => {
  const { userDataDir, transcript } = await seeded();
  const app = await launchApp({ userDataDir });
  try {
    const { page } = app;
    const detail: TaskDetail = await page.evaluate((id) => window.infinitary.tasks.detail(id), ID);
    // Nothing about the task is left out: every event but the evidence is a row or under one.
    const read = detail.activityLog.flatMap((row) => [
      row.id,
      ...(row.folded ?? []).map((line) => line.id),
    ]);
    expect(read.sort((a, b) => a - b)).toEqual(
      detail.events
        .filter((event) => ACTIVITY_PLACES[event.kind] !== "evidence")
        .map((event) => event.id),
    );
    // The app's news is a row; the captain's reply reads as the captain's own words.
    const news = detail.events.find((event) => event.data?.news === true);
    expect(detail.activityLog.map((row) => row.id)).toContain(news?.id);
    const steer = detail.activityLog.find((row) => row.kind === "steered");
    expect(steer?.text).toContain(WORDS);
    expect(steer?.text.length).toBeLessThan(
      detail.events.find((event) => event.kind === "steered")?.text.length ?? 0,
    );
    // The report keeps the update before it, folded under it.
    const report = detail.activityLog.find((row) => row.kind === "report");
    expect(report?.folded?.map((line) => line.kind)).toContain("progress");

    await expandDock(page, "now");
    await openGroup(page, "landed");
    await pressRow(page, detail.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", ID);
    const body = recordFrame(page);
    await pressKey(recordTab(page, "activity"), "Enter");
    const line = body.locator('[data-record-event="report"]');
    const folded = line.locator("[data-record-folded]");
    await expect(line.locator("[data-record-folded-count]")).toBeVisible();
    await expect(folded.first()).toBeHidden();
    await pressKey(line.locator(":scope > summary"), "Enter");
    await expect(folded).toHaveCount(report?.folded?.length ?? 0);
    await expect(folded.first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(folded.first()).toBeHidden();

    // INF-100 captain reply: proof is supporting history under Details;
    // the merge completion card, not this record, presents the result first.
    const details = body.locator('[data-record-section="details"] > summary');
    const proof = body.locator('[data-validation-scenario="mac-workflow"]');
    const proofSummary = proof.locator(":scope > summary");
    await expect(proof).toBeHidden();
    // The More row ends the Info tab (INF-2261).
    await pressKey(recordTab(page, "info"), "Enter");
    await runFromSearch(app.app, page, "focus.card-body");
    await pressKey(details, "Enter");
    await expect(proofSummary).toBeVisible();
    await expectRecordSized(page);
    await page.keyboard.press("Tab");
    await untilFocused(proofSummary);
    await page.keyboard.press("Enter");
    await expect(proofSummary).toBeInViewport({ ratio: 1 });
    await expect(proof.locator("[data-validation-observation]")).toBeVisible();
    await expect(proof.locator("[data-validation-observation]")).toContainText(
      detail.liveValidation?.rows[0]?.reason ?? "missing proof reason",
    );
    await expect(proof.locator("pre")).toHaveText(transcript);
    // INF-125: retained pictures and recordings use the existing keyboard viewer,
    // not a native player inside the opaque record frame (its URL cannot play there).
    await runFromSearch(app.app, page, "focus.card-body");
    await pressKey(proof.locator("figure img").first(), "Enter");
    const viewer = page.locator("[data-picture-viewer]");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText(detail.title, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await pressKey(proof.locator("[data-inf-demo-play]"), "Enter");
    await expect(viewer.locator("[data-demo-animation]")).toBeVisible();
    await pressKey(viewer.locator("[data-demo-player] button"), "Enter");
    await expect(viewer.locator("[data-demo-animation]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(viewer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await pressKey(proofSummary, "Enter");
    await expect(proof.locator("[data-validation-observation]")).toBeHidden();
    await page.keyboard.press("Shift+Tab");
    await untilFocused(details);
    await page.keyboard.press("Enter");
    await expect(proof).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(proofSummary).toBeVisible();
    await expectRecordSized(page);
    await page.keyboard.press("Tab");
    await untilFocused(proofSummary);
    await page.keyboard.press("Enter");
    await expect(proof.locator("[data-validation-observation]")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(proof.locator("[data-validation-observation]")).toBeHidden();
  } finally {
    await app.close();
  }
});

const ACTED = "actions-fold";
const SESSION = "5a1d2c3e-0f00-4bcd-8e11-2a6f0c9d7b10";

/** A record whose crewmate's session the app kept, as the Claude client writes one. */
function seededWithSession(): { userDataDir: string; described: string[] } {
  const userDataDir = scratchDir("infinitary-record-actions-");
  const db = openDatabase(userDataDir);
  const base = Date.now() - 60 * 60_000;
  let at = base;
  const tasks = new TaskService({ db, strict: true, now: () => at });
  seedTask(tasks, {
    id: ACTED,
    title: "Fix the knowledge references journey",
    intent: { goal: "The journey passes every run.", userWords: "fix the flaky journey" },
    status: "idle",
  });
  at = base + 4 * 60_000;
  tasks.noteProgress(ACTED, "The journey opens the panel before its data arrives.");
  at = base + 7 * 60_000;
  tasks.noteProgress(ACTED, "The journey passes alone; running it three times.");
  at = base + 9 * 60_000;
  tasks.recordReport(ACTED, {
    text: "The journey waits for the panel's data now. It passed three runs in a row.",
    summary: "The journey waits for its data now.",
  });
  at = base + 12 * 60_000;
  tasks.close(ACTED, { status: "done", reason: "merged", actor: "host" });
  tasks.markWorkspaceRemoved(ACTED);
  db.close();

  const iso = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
  const lines: object[] = [
    { type: "queue-operation", operation: "enqueue", sessionId: SESSION, timestamp: iso(1) },
  ];
  const call = (minutes: number, name: string, input: object) =>
    lines.push({
      type: "assistant",
      sessionId: SESSION,
      isSidechain: false,
      uuid: `a${lines.length}`,
      timestamp: iso(minutes),
      message: {
        id: `m${lines.length}`,
        role: "assistant",
        content: [{ type: "tool_use", id: `t${lines.length}`, name, input }],
      },
    });
  const described = [
    "Read the failing journey's log",
    "Run the journey alone",
    "Run the journey three times in a row",
    "Push the branch",
  ];
  call(2, "Bash", { command: "gh run view --log-failed", description: described[0] });
  call(3.9, "mcp__infinitary__note_progress", { text: "The journey opens the panel too early." });
  call(6, "Bash", { command: "pnpm exec playwright test", description: described[1] });
  call(8, "Bash", { command: "for i in 1 2 3; do pnpm e2e; done", description: described[2] });
  call(8.9, "mcp__infinitary__report", { text: "The journey waits for its data now." });
  call(10, "Bash", { command: "git push", description: described[3] });

  seedCrewTranscript(userDataDir, ACTED, `${SESSION}.jsonl`, lines);
  return { userDataDir, described };
}

test("a record's Activity folds what the crewmate did under the row it led to, read from its session", async () => {
  const { userDataDir, described } = seededWithSession();
  const app = await launchApp({ userDataDir });
  try {
    const { page } = app;
    const detail: TaskDetail = await page.evaluate(
      (id) => window.infinitary.tasks.detail(id),
      ACTED,
    );
    // Each call but those to the app's own tools, in the line the crewmate wrote, under the
    // row it led to: the update, the report (with the update it restates), and the close.
    const under = (kind: string) =>
      detail.activityLog.find((row) => row.kind === kind)?.actions?.map((action) => action.text);
    expect(under("progress")).toEqual([described[0]]);
    expect(under("report")).toEqual([described[1], described[2]]);
    expect(detail.activityLog.at(-1)?.actions?.map((action) => action.text)).toEqual([
      described[3],
    ]);
    expect(detail.activityLog.flatMap((row) => row.actions ?? [])).toHaveLength(described.length);
    // Read, never copied: the timeline holds no row for an action.
    expect(detail.events.some((event) => described.includes(event.text))).toBe(false);

    await expandDock(page, "now");
    await openGroup(page, "landed");
    await pressRow(page, detail.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", ACTED);
    const body = recordFrame(page);
    await pressKey(recordTab(page, "activity"), "Enter");
    const line = body.locator('[data-record-event="report"]');
    const actions = line.locator('[data-record-folded="action"]');
    await expect(line.locator("[data-record-folded-count]")).toBeVisible();
    await expect(actions.first()).toBeHidden();
    await pressKey(line.locator(":scope > summary"), "Enter");
    await expect(actions).toHaveCount(2);
    await expect(actions.first()).toBeVisible();
  } finally {
    await app.close();
  }
});
