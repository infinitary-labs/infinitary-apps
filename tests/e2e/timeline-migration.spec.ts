import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardService } from "../../src/core/orchestrator/cardService";
import { appPathsFor, crewmateSessionsDir } from "../../src/core/paths";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase, TASK_RECORD_RETIREMENT_VERSION } from "../../src/core/storage/db";
import { RETIRED_TASK_COLUMNS } from "../../src/core/storage/taskRecordProjection";
import { CrewActions } from "../../src/core/tasks/crewActions";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { TaskTimeline } from "../../src/core/tasks/taskTimeline";
import type { Card } from "../../src/shared/cards";
import type { TaskDetail } from "../../src/shared/tasks";
import { timelineActorWords } from "../../src/shared/timelineWords";
import { scratchDir } from "../helpers/scratchDirs";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { sinceLastUser } from "./mockProvider";
import { expandDock, openGroup, pressRow, recordFrame, recordTab } from "./rails";
import { readSavedData } from "./savedData";
import { UPGRADED_TIMELINE_PROMPT, upgradedTimelineRead } from "./scenarios/upgradedTimelineRead";
import { starterFor } from "./starters";
import { seedCrewTranscript } from "./transcriptFixtures";
import { pressKey } from "./windowKeys";

const ID = "retained-timeline";
const ORIGINAL = "Two fixes pass the practice release.";
const FIRST_MODEL = starterFor("openai-codex", "low");
const LATER_MODEL = starterFor("openai-codex", "premium");
const REVISED = "Only the queue flush passes the Windows check.";

/**
 * INF-1296 B piece 5, captain: good e2e coverage so existing users do not regress.
 * Promise: upgrade, keyboard reading and restart preserve exact historical sources,
 * legacy overlap and unknown times; Activity and the real agent tool read the same
 * normalized entries, without repeating a choice or granting permission.
 * Data: a predecessor-format profile written by the actual task/card owners and
 * retained Pi session format. Completion: UI disclosures, tool payloads and saved
 * effect/permission records agree. Platform: Electron, the hermetic launcher and
 * the scripted provider; no account, outside service, signing or shared resource.
 */
function olderProfile() {
  const userDataDir = scratchDir("timeline-upgrade-");
  const db = openDatabase(userDataDir, TASK_RECORD_RETIREMENT_VERSION - 1);
  // Today's card writer names INF-1610's later `answering` and INF-1670's
  // `answered_by` columns, and its thread writer INF-2225's shared-card
  // columns, lent to the older schema here; their own migrations leave a
  // column already there.
  db.exec("ALTER TABLE cards ADD COLUMN answering INTEGER");
  db.exec("ALTER TABLE cards ADD COLUMN answered_by TEXT");
  db.exec("ALTER TABLE card_messages ADD COLUMN contributor_json TEXT");
  db.exec("ALTER TABLE card_messages ADD COLUMN answers_message INTEGER");
  db.exec("ALTER TABLE card_messages ADD COLUMN clarification INTEGER");
  db.exec("ALTER TABLE card_messages ADD COLUMN response_id TEXT");
  const at = Date.now() - 3600000;
  const now = () => at;
  const tasks = new TaskService({ db, strict: true, now });
  const cardStore = new CardStore(db);
  const cards = new CardService({
    tasks,
    cardStore,
    now,
    syncCaptainGate: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
    broadcastThread: () => {},
  });
  seedTask(tasks, {
    id: ID,
    title: "Rerun the practice release's Mac check",
    status: "idle",
    intent: { goal: "The practice release passes.", userWords: "rerun the practice release" },
    prompt: "Goal: The practice release passes.",
    shape: { kind: "implement", internal_step: true },
  });
  tasks.recordBrief(ID, ["Goal: The practice release passes."]);
  const offer = {
    id: "which-fix",
    title: "Which fix should I keep?",
    body: `<p>${ORIGINAL}</p>`,
    actions: [
      { id: "flush", label: "Await the queue flush", default: true },
      { id: "retry", label: "Keep the retry" },
    ],
  };
  const cardId = cards.emitCrewmateCard(ID, offer, "Rerun");
  cards.addMessage(cardId, "captain", "does the flush cover Windows too?");
  cards.addMessage(cardId, "crewmate", "Yes: the flush runs on every platform.");
  cards.resolve(cards.get(cardId) as Card, "flush", "flush");
  // A release before piece 1 recorded this overlap without an explicit alias.
  db.prepare(
    "UPDATE task_events SET data_json = json_remove(data_json, '$.observation') WHERE task_id = ? AND kind = 'card_resolved'",
  ).run(ID);
  // Reconstruct an older saved lifecycle that reopened an answered question.
  // Current emits forbid this; only fixture construction uses the older rule,
  // keeping the real offer/choice writers and all historical assertions intact.
  const olderWriter = (cards as unknown as { emits: { refuseAnsweredRevision: () => void } }).emits;
  const currentRule = olderWriter.refuseAnsweredRevision;
  olderWriter.refuseAnsweredRevision = () => {};
  try {
    cards.emitCrewmateCard(ID, { ...offer, body: `<p>${REVISED}</p>` }, "Rerun");
  } finally {
    olderWriter.refuseAnsweredRevision = currentRule;
  }
  cards.resolve(cards.get(cardId) as Card, "flush", "flush", undefined, "crewmate");
  tasks.noteProgress(ID, "The Mac and Windows checks pass.");
  tasks.turns.recordReport(ID, {
    text: "The queue flush passes both checks. I kept it and removed the retry.",
    summary: "The queue flush passes both checks.",
    declared: { result: { kept: "flush" } },
  });
  const sessions = crewmateSessionsDir(appPathsFor(userDataDir), ID);
  const file = "2026-10-20T16-00-00-000Z_practice.jsonl";
  seedCrewTranscript(userDataDir, ID, file, [
    { type: "session", version: 3, id: "practice", cwd: "/work/practice" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "read-release",
            name: "read",
            arguments: { path: "/work/practice/release.yml" },
          },
        ],
      },
    },
    {
      type: "message",
      timestamp: new Date(at).toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "run-check",
            name: "bash",
            arguments: { command: "pnpm check", description: "Run the practice release checks" },
          },
        ],
      },
    },
  ]);
  tasks.turns.setSessionFile(ID, join(sessions, file));
  tasks.close(ID, { status: "done", reason: "finished", actor: "host" });
  tasks.placement.markWorkspaceRemoved(ID);
  const actions = new CrewActions({ recordDirOf: () => sessions, appTools: new Set() });
  const timeline = new TaskTimeline({
    tasks,
    cards: cardStore,
    actions: (record) => actions.sourced(record),
  });
  const readings = timeline.history(ID);
  const sources = timeline.sources(ID);
  const record = tasks.get(ID)!;
  const events = tasks.timeline(ID);
  db.close();
  return { userDataDir, readings, sources, record, events };
}

function effects(userDataDir: string) {
  return readSavedData(userDataDir, (db) => ({
    choices: db
      .prepare(
        "SELECT id, actor, payload_json FROM card_observations WHERE task_id = ? AND kind IN ('action', 'effect_receipt') ORDER BY seq",
      )
      .all(ID),
    permissions: db.prepare("SELECT * FROM task_permissions WHERE task_id = ?").all(ID),
  }));
}

async function agentTimeline(app: LaunchedApp, key: string) {
  const prompt = `${UPGRADED_TIMELINE_PROMPT} ${key}`;
  await askFirstmate(app.page, prompt);
  const results = (app.mockProvider?.requestBodies() ?? [])
    .map(sinceLastUser)
    .filter(
      (turn) =>
        turn.user.includes(prompt) &&
        turn.results.some((result) => result.startsWith("field timeline as json,")),
    )
    .at(-1)
    ?.results.filter((result) => result.startsWith("field timeline as json,"));
  if (!results?.length) throw new Error("The agent did not read the timeline.");
  const joined = results
    .map((result) =>
      result.replace(
        /^field timeline as json, offset \d+, nextOffset (?:\d+|none), length \d+\n/,
        "",
      ),
    )
    .join("");
  return JSON.parse(joined) as ReturnType<TaskTimeline["sources"]>;
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires this pattern before testInfo; Electron owns the page.
test("existing-user history stays exact, complete and effect-free through upgrade and restart", async ({}, testInfo) => {
  expect(FIRST_MODEL).not.toBe(LATER_MODEL);
  const saved = olderProfile();
  const beforeEffects = effects(saved.userDataDir);
  expect(saved.readings.some(({ entry }) => entry.content.kind === "session-observation")).toBe(
    false,
  );
  const launch = () =>
    launchApp({
      userDataDir: saved.userDataDir,
      withMockProvider: true,
      scenarios: [upgradedTimelineRead],
    });
  let app = await launch();
  try {
    const detail: TaskDetail = await app.page.evaluate(
      (id) => window.infinitary.tasks.detail(id),
      ID,
    );
    expect(detail.timeline).toEqual(saved.readings);
    expect(detail.events).toEqual(
      saved.events
        .map((event) => ({ ...event, ref: event.ref ?? null }))
        .map(({ taskId: _task, identity: _identity, ...event }) => event),
    );
    expect(detail.intent).toEqual(saved.record.intent);
    expect(
      detail.timeline
        ?.filter(({ entry }) => entry.content.kind === "session-action")
        .map(({ entry }) => entry.at),
    ).toEqual([
      null,
      saved.sources.find(
        ({ entry }) => entry.content.kind === "session-action" && entry.at !== null,
      )?.entry.at,
    ]);
    expect(
      detail.timeline?.filter(({ entry }) => entry.content.kind === "card-choice"),
    ).toHaveLength(3);
    expect(
      detail.timeline?.some(
        ({ entry }) => entry.content.kind === "card-choice" && entry.actor?.kind === "frame",
      ),
    ).toBe(true);
    const columns = readSavedData(saved.userDataDir, (db) =>
      (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    for (const column of RETIRED_TASK_COLUMNS) expect(columns).not.toContain(column);

    await expandDock(app.page, "now");
    await openGroup(app.page, "landed");
    await pressRow(app.page, detail.key);
    const body = recordFrame(app.page);
    await pressKey(recordTab(app.page, "activity"), "Enter");
    const earlier = body.locator("[data-record-earlier]");
    if (await earlier.isVisible()) await pressKey(earlier.locator(":scope > summary"), "Enter");
    for (const { entry, text, activityRowId } of detail.timeline ?? []) {
      if (activityRowId !== undefined) {
        const parent = detail.timeline?.find(
          ({ entry: candidate }) =>
            candidate.content.ref.source === "task-event" &&
            candidate.content.ref.eventId === activityRowId,
        );
        if (!parent) throw new Error("The action's declared Activity parent is missing");
        const grouped = body.locator(`[data-timeline-entry="${parent.entry.id}"]`);
        if (!(await grouped.evaluate((node) => (node as HTMLDetailsElement).open)))
          await pressKey(grouped.locator(":scope > summary"), "Enter");
      }
      const row = body.locator(`[data-timeline-entry="${entry.id}"]`);
      // A folded source stays reachable inside the event it led to.
      const parent = row.locator("xpath=ancestor::details[@data-record-event][1]");
      if (await parent.count()) {
        const opened = await parent.evaluate((node) => (node as HTMLDetailsElement).open);
        if (!opened) await pressKey(parent.locator(":scope > summary"), "Enter");
      }
      await expect(row).toBeVisible();
      await expect(row.locator(":scope > summary")).toContainText(entry.summary);
      if (!(await row.evaluate((node) => (node as HTMLDetailsElement).open)))
        await pressKey(row.locator(":scope > summary"), "Enter");
      if (text) await expect(row).toContainText(text);
      if (entry.at === null) await expect(row).toContainText("Undated");
      if (entry.actor?.kind === "frame")
        await expect(row).toContainText(timelineActorWords(entry.actor));
      await pressKey(row.locator(":scope > summary"), "Enter");
    }
    const original = detail.timeline?.find(
      ({ entry, text }) => entry.content.kind === "card-offer" && text?.includes(ORIGINAL),
    );
    expect(original?.text).not.toContain(REVISED);
    expect(effects(saved.userDataDir)).toEqual(beforeEffects);
    const read = await agentTimeline(app, detail.key);
    const current = await app.page.evaluate((id) => window.infinitary.tasks.detail(id), ID);
    const readIds = new Set(read.map(({ entry }) => entry.id));
    expect(read.map(({ entry }) => entry)).toEqual(
      current.timeline?.filter(({ entry }) => readIds.has(entry.id)).map(({ entry }) => entry),
    );
    // The first mate can append its own decision after its read; it cannot rewrite the read's cut.
    const cut = Math.max(
      ...read.flatMap(({ entry }) =>
        entry.content.ref.source === "task-event" ? [entry.content.ref.eventId] : [],
      ),
    );
    for (const { entry } of current.timeline ?? []) {
      if (readIds.has(entry.id)) continue;
      expect(entry.content.ref.source).toBe("task-event");
      if (entry.content.ref.source === "task-event")
        expect(entry.content.ref.eventId).toBeGreaterThan(cut);
    }
    for (const source of saved.sources) expect(read).toContainEqual(source);
    expect(effects(saved.userDataDir)).toEqual(beforeEffects);
    await app.close();
    app = await launch();
    const restarted = await app.page.evaluate((id) => window.infinitary.tasks.detail(id), ID);
    expect(restarted.timeline).toEqual(current.timeline);
    expect(effects(saved.userDataDir)).toEqual(beforeEffects);
    await app.close();
    const db = openDatabase(saved.userDataDir);
    const tasks = new TaskService({ db, strict: true });
    const token = tasks.get(ID)?.sessionFile;
    if (!token) throw new Error("The older conversation lost its resume binding.");
    const observed = {
      file: token,
      computer: "This computer",
      device_id: null,
      provider: "openai-codex",
      model: FIRST_MODEL,
      account_id: null,
      began: "resume",
    };
    tasks.turns.setSessionFile(ID, token, observed);
    const firstObservation = tasks.archive.sessionObservations(ID);
    tasks.turns.setSessionFile(ID, token, observed);
    expect(tasks.archive.sessionObservations(ID)).toEqual(firstObservation);
    tasks.turns.setSessionFile(ID, token, { ...observed, model: LATER_MODEL });
    const changedObservations = tasks.archive.sessionObservations(ID);
    tasks.turns.setSessionFile(ID, token, { ...observed, model: LATER_MODEL });
    expect(tasks.archive.sessionObservations(ID)).toEqual(changedObservations);
    expect(tasks.archive.sessions(ID).filter((session) => session.current)).toHaveLength(1);
    expect(tasks.archive.sessions(ID).find((session) => session.current)?.model).toBe(LATER_MODEL);
    db.close();
    app = await launch();
    const observedHistory = await app.page.evaluate((id) => window.infinitary.tasks.detail(id), ID);
    const observations = observedHistory.timeline?.filter(
      ({ entry }) => entry.content.kind === "session-observation",
    );
    expect(observations).toHaveLength(2);
    expect(observations?.[0]?.details).toContain(FIRST_MODEL);
    expect(observations?.[1]?.details).toContain(LATER_MODEL);
    const observedSources = await agentTimeline(app, detail.key);
    const observedRecords = observedSources.flatMap(({ record }) =>
      record?.source === "session-observation" ? [record.observation] : [],
    );
    expect(observedRecords.map((record) => record.model)).toEqual([FIRST_MODEL, LATER_MODEL]);
    for (const record of observedRecords) expect(record).not.toHaveProperty("resume_token");
    expect(effects(saved.userDataDir)).toEqual(beforeEffects);
    await testInfo.attach("retained-history", {
      body: Buffer.from(
        JSON.stringify(
          { saved: saved.sources, after: restarted.timeline, effects: beforeEffects },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});
