import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@core/storage/db";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CandidateMiss,
  cardEvidenceKind,
  DEFAULT_WINDOW_MS,
  deriveMissCandidates,
  inForwardWindow,
  isTurnFailedWake,
  main,
  parseArgs,
  summarize,
} from "../scripts/derive-miss-candidates.ts";
import { defaultUserDataDir } from "../scripts/dispatch-corpus/userData.ts";
import { RELEASE_USER_DATA_FOLDER, USER_DATA_FOLDERS } from "../src/shared/userDataFolders";
import { scratchDir } from "./helpers/scratchDirs";
import { withScratchHome } from "./helpers/scratchHome";

/**
 * The live firstmate.db is on the captain's MacBook, so the deriver is
 * proven here against a fixture built with the app's OWN migrations: the
 * schema under test is the real one, only the rows are ours.
 */

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const WINDOW = DEFAULT_WINDOW_MS;

type OutcomeInsert = {
  taskId: string;
  wake: string;
  verdict: "routine" | "captain";
  summary: string;
  at: number;
  cardId?: string | null;
  missed?: { note: string; at: number };
};

type CardInsert = {
  id: string;
  taskId: string;
  title: string;
  createdAt: number;
  resolvedAt: number;
  chosenAction: string;
  kind?: string;
  author?: "firstmate" | "crewmate" | "host";
  actions?: Array<{
    id: string;
    label: string;
    effect?: { kind: "settle"; mode: "merge" | "discard" };
  }>;
};

function insertTask(
  tasks: TaskService,
  id: string,
  title: string,
  status: "idle" | "failed" | "completed" | "cancelled" = "idle",
): void {
  seedTask(tasks, {
    id,
    title,
    prompt: "brief",
    repoId: null,
    repoDir: "/fleet",
    worktreeDir: `/worktrees/${id}`,
    branch: `fm/${id}`,
    sessionFile: null,
    accountId: null,
    status,
    createdAt: T0 - HOUR,
  });
}

function insertOutcome(db: ReturnType<typeof openDatabase>, input: OutcomeInsert): number {
  const info = db
    .prepare(
      `INSERT INTO decisions (kind, task_id, wake, verdict, summary, at, card_id, missed_escalation, missed_note, missed_at) VALUES ('sort', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      input.wake,
      input.verdict,
      input.summary,
      input.at,
      input.cardId ?? null,
      input.missed ? 1 : null,
      input.missed?.note ?? null,
      input.missed?.at ?? null,
    );
  return Number(info.lastInsertRowid);
}

function insertCard(db: ReturnType<typeof openDatabase>, input: CardInsert): void {
  db.prepare(
    `INSERT INTO cards
      (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at, resolved_at, chosen_action)
     VALUES (?, ?, ?, ?, 1, ?, '', '', ?, 'ready', ?, ?, ?)`,
  ).run(
    input.id,
    input.taskId,
    input.kind ?? "decision",
    input.author ?? "crewmate",
    input.title,
    JSON.stringify(input.actions ?? []),
    input.createdAt,
    input.resolvedAt,
    input.chosenAction,
  );
}

function buildFixture(dir: string): string {
  const db = openDatabase(dir);
  let taskNow = T0 - HOUR;
  const tasks = new TaskService({ db, strict: true, now: () => taskNow });

  insertTask(tasks, "t-escalated", "Escalate me");
  insertTask(tasks, "t-quiet", "Nothing happens");
  insertTask(tasks, "t-late", "Outside the window");
  insertTask(tasks, "t-turnfail", "Provider 529");
  insertTask(tasks, "t-taskfail", "The whole task died", "failed");
  insertTask(tasks, "t-card", "Captain answered a card");
  insertTask(tasks, "t-interrupt-wake", "Task interruption recorded without an actor");
  insertTask(tasks, "t-settle", "Captain settled via a card");
  insertTask(tasks, "t-captain-first", "Already escalated");
  insertTask(tasks, "t-other", "Evidence on a different task");
  insertTask(tasks, "t-oldcard", "Card existed before the routine");
  insertTask(tasks, "t-both", "Escalation and a failed turn");
  insertTask(tasks, "t-flagged", "C3 already labelled this one");
  insertTask(tasks, "t-secret", "Wake carries a live key");
  insertTask(tasks, "t-close-dismissed", "Close action dismissed");
  insertTask(tasks, "t-close-acted", "Close action chosen");
  insertTask(tasks, "t-close-withdrawn", "Close action withdrawn");

  // Positive: routine then a captain verdict inside the window.
  insertOutcome(db, {
    taskId: "t-escalated",
    wake: '[fm-op] crewmate 1 reported on task t-escalated "Escalate me": CI is red.',
    verdict: "routine",
    summary: "CI is still running.",
    at: T0,
  });
  insertOutcome(db, {
    taskId: "t-escalated",
    wake: '[fm-op] crewmate 1 reported on task t-escalated "Escalate me": merge conflict.',
    verdict: "captain",
    summary: "The PR is stuck on a merge conflict.",
    at: T0 + HOUR,
    cardId: "card-conflict",
  });

  // Negative: routine with nothing after.
  insertOutcome(db, {
    taskId: "t-quiet",
    wake: '[fm-op] crewmate 1 reported on task t-quiet "Nothing happens": tests passed.',
    verdict: "routine",
    summary: "Tests passed.",
    at: T0,
  });

  // Negative: deterioration outside the 24h window.
  insertOutcome(db, {
    taskId: "t-late",
    wake: '[fm-op] crewmate 1 reported on task t-late "Outside the window": still going.',
    verdict: "routine",
    summary: "Still going.",
    at: T0,
  });
  insertOutcome(db, {
    taskId: "t-late",
    wake: '[fm-op] crewmate 1 reported on task t-late "Outside the window": now on fire.',
    verdict: "captain",
    summary: "Now on fire.",
    at: T0 + 25 * HOUR,
  });

  // Positive: later turn_failed wake, even if that later verdict is also routine.
  insertOutcome(db, {
    taskId: "t-turnfail",
    wake: '[fm-op] crewmate 1 reported on task t-turnfail "Provider 529": starting.',
    verdict: "routine",
    summary: "Starting.",
    at: T0,
  });
  insertOutcome(db, {
    taskId: "t-turnfail",
    wake: `[fm-op] crewmate 1's turn on task t-turnfail "Provider 529" failed: HTTP 529. The crewmate is still steerable; you can retry, steer, or interrupt it.`,
    verdict: "routine",
    summary: "The provider flaked.",
    at: T0 + 2 * HOUR,
  });

  // Positive: later terminal task-failure wake.
  insertOutcome(db, {
    taskId: "t-taskfail",
    wake: '[fm-op] crewmate 1 reported on task t-taskfail "The whole task died": working.',
    verdict: "routine",
    summary: "Working.",
    at: T0,
  });
  insertOutcome(db, {
    taskId: "t-taskfail",
    wake: `[fm-op] task t-taskfail "The whole task died" failed: uncaught exception`,
    verdict: "captain",
    summary: "The task died.",
    at: T0 + 3 * HOUR,
  });

  // Positive: captain-resolved card produced after the routine.
  insertOutcome(db, {
    taskId: "t-card",
    wake: '[fm-op] crewmate 1 reported on task t-card "Captain answered a card": PR green.',
    verdict: "routine",
    summary: "PR is green.",
    at: T0,
  });
  insertCard(db, {
    id: "card-land",
    taskId: "t-card",
    title: "Land the PR?",
    createdAt: T0 + HOUR,
    resolvedAt: T0 + 2 * HOUR,
    chosenAction: "land",
  });

  insertOutcome(db, {
    taskId: "t-interrupt-wake",
    wake: '[fm-op] crewmate 1 reported on task t-interrupt-wake "Task interruption recorded without an actor": working.',
    verdict: "routine",
    summary: "Working.",
    at: T0,
  });
  insertOutcome(db, {
    taskId: "t-interrupt-wake",
    wake: '[fm-op] crewmate 1 was interrupted on task t-interrupt-wake "Task interruption recorded without an actor"; it can still be told what to do.',
    verdict: "routine",
    summary: "The task was interrupted.",
    at: T0 + HOUR,
  });

  insertOutcome(db, {
    taskId: "t-settle",
    wake: '[fm-op] crewmate 1 reported on task t-settle "Captain settled via a card": ready.',
    verdict: "routine",
    summary: "Ready to merge.",
    at: T0,
  });
  insertCard(db, {
    id: "card-settle",
    taskId: "t-settle",
    title: "Merge the work?",
    createdAt: T0 + HOUR,
    resolvedAt: T0 + 90 * 60 * 1000,
    chosenAction: "merge-current",
    kind: "card",
    author: "crewmate",
    actions: [
      {
        id: "merge-current",
        label: "Merge",
        effect: { kind: "settle", mode: "merge" },
      },
    ],
  });

  // Negative: a captain (not routine) row is never a candidate source.
  insertOutcome(db, {
    taskId: "t-captain-first",
    wake: '[fm-op] crewmate 1 reported on task t-captain-first "Already escalated": needs you.',
    verdict: "captain",
    summary: "Needs you.",
    at: T0,
  });
  insertOutcome(db, {
    taskId: "t-captain-first",
    wake: `[fm-op] task t-captain-first "Already escalated" failed: boom`,
    verdict: "captain",
    summary: "Then it failed.",
    at: T0 + HOUR,
  });

  // Negative: evidence on a different task does not taint this routine.
  insertOutcome(db, {
    taskId: "t-other",
    wake: '[fm-op] crewmate 1 reported on task t-other "Evidence on a different task": fine.',
    verdict: "routine",
    summary: "Fine.",
    at: T0,
  });
  insertOutcome(db, {
    taskId: "t-escalated",
    wake: '[fm-op] crewmate 1 reported on task t-escalated "Escalate me": still the other task.',
    verdict: "captain",
    summary: "Unrelated later escalation on t-escalated, already counted there.",
    at: T0 + 4 * HOUR,
  });

  // Negative: a card that already existed before the routine is not
  // "subsequently produced", even if the captain resolved it later.
  insertOutcome(db, {
    taskId: "t-oldcard",
    wake: '[fm-op] crewmate 1 reported on task t-oldcard "Card existed before the routine": ok.',
    verdict: "routine",
    summary: "Ok.",
    at: T0,
  });
  insertCard(db, {
    id: "card-old",
    taskId: "t-oldcard",
    title: "Pre-existing",
    createdAt: T0 - HOUR,
    resolvedAt: T0 + HOUR,
    chosenAction: "land",
  });

  // Positive: one routine, two evidence kinds.
  insertOutcome(db, {
    taskId: "t-both",
    wake: '[fm-op] crewmate 1 reported on task t-both "Escalation and a failed turn": going.',
    verdict: "routine",
    summary: "Going.",
    at: T0,
  });
  insertOutcome(db, {
    taskId: "t-both",
    wake: `[fm-op] crewmate 1's turn on task t-both "Escalation and a failed turn" failed: 529`,
    verdict: "captain",
    summary: "The turn failed and it needs you.",
    at: T0 + HOUR,
  });

  // C3 already flagged: still a weak C2 candidate, never rewritten as confirmed.
  insertOutcome(db, {
    taskId: "t-flagged",
    wake: '[fm-op] crewmate 1 reported on task t-flagged "C3 already labelled this one": quiet.',
    verdict: "routine",
    summary: "Quiet.",
    at: T0,
    missed: { note: "you should have told me", at: T0 + 10 * HOUR },
  });
  insertOutcome(db, {
    taskId: "t-flagged",
    wake: '[fm-op] crewmate 1 reported on task t-flagged "C3 already labelled this one": actually bad.',
    verdict: "captain",
    summary: "Actually bad.",
    at: T0 + HOUR,
  });

  // Redaction: a live key in the wake must not reach the JSONL.
  insertOutcome(db, {
    taskId: "t-secret",
    wake: '[fm-op] crewmate 1 reported on task t-secret "Wake carries a live key": sk-ant-SECRETVALUE99',
    verdict: "routine",
    summary: "Using sk-ant-SECRETVALUE99",
    at: T0,
  });
  insertOutcome(db, {
    taskId: "t-secret",
    wake: `[fm-op] crewmate 1's turn on task t-secret "Wake carries a live key" failed: 401 sk-ant-SECRETVALUE99`,
    verdict: "captain",
    summary: "Auth died.",
    at: T0 + HOUR,
  });

  // Crewmate-closed card is not captain contact.
  insertCard(db, {
    id: "card-crew-closed",
    taskId: "t-quiet",
    title: "Crewmate closed this",
    createdAt: T0 + HOUR,
    resolvedAt: T0 + 2 * HOUR,
    chosenAction: "closed",
  });

  for (const taskId of ["t-close-dismissed", "t-close-acted", "t-close-withdrawn"]) {
    insertOutcome(db, {
      taskId,
      wake: `[fm-op] crewmate reported on task ${taskId}: choose how to proceed.`,
      verdict: "routine",
      summary: "Waiting for a choice.",
      at: T0,
    });
    insertCard(db, {
      id: `card-${taskId}`,
      taskId,
      title: "Current close action",
      createdAt: T0 + HOUR,
      resolvedAt: T0 + 2 * HOUR,
      chosenAction: "close",
      kind: "card",
      author: "crewmate",
      actions: [{ id: "close", label: "Send guidance" }],
    });
  }
  taskNow = T0 + 2 * HOUR;
  tasks.capture.recordCardResolved("t-close-dismissed", {
    cardId: "card-t-close-dismissed",
    title: "Current close action",
    action: "dismissed",
    actor: "captain",
  });
  tasks.capture.recordCardResolved("t-close-acted", {
    cardId: "card-t-close-acted",
    title: "Current close action",
    action: "close",
    actor: "captain",
  });
  tasks.capture.recordCardResolved("t-close-withdrawn", {
    cardId: "card-t-close-withdrawn",
    title: "Current close action",
    action: "closed",
    actor: "firstmate",
  });

  db.close();
  return join(dir, "firstmate.db");
}

describe("miss deriver - card evidence kinds", () => {
  /** A card row as the pre-P1 store wrote it: reserved ids, no declared actions. */
  const legacy = (chosen: string) => ({
    id: `card-${chosen}`,
    kind: "decision",
    author: null,
    chosen_action: chosen,
    actions_json: "[]",
  });
  /** A card as the store writes it now: the actions the emitter declared. */
  const current = (chosen: string, actions: unknown[], author = "crewmate") => ({
    id: author === "firstmate" ? `card-fm-${chosen}` : `card-${chosen}`,
    kind: "card",
    author,
    chosen_action: chosen,
    actions_json: JSON.stringify(actions),
  });

  it("maps the pre-P1 reserved ids the way the host used to dispatch them", () => {
    expect(cardEvidenceKind(legacy("interrupt-task"))).toBe("captain_interrupt");
    expect(cardEvidenceKind(legacy("cancel-task"))).toBe("captain_interrupt");
    expect(cardEvidenceKind(legacy("blue"))).toBe("captain_steer");
    expect(cardEvidenceKind(legacy("land"))).toBe("captain_resolved_card");
    expect(cardEvidenceKind(legacy("dismiss"))).toBe("captain_resolved_card");
    expect(cardEvidenceKind(legacy("later"))).toBe("captain_resolved_card");
    expect(cardEvidenceKind(legacy("closed"))).toBeNull();
  });

  it("reads a current card by the effect its own action declared", () => {
    // A settle is host-owned teardown: the crewmate is never steered by it,
    // whatever the button happens to be called.
    expect(
      cardEvidenceKind(
        current("merge-pr", [
          { id: "merge-pr", label: "Merge the PR", effect: { kind: "settle", mode: "merge" } },
        ]),
      ),
    ).toBe("captain_resolved_card");
    expect(
      cardEvidenceKind(
        current("open-subscriptions", [
          {
            id: "open-subscriptions",
            label: "Open Subscriptions",
            effect: { kind: "open", target: "subscriptions" },
          },
        ]),
      ),
    ).toBe("captain_resolved_card");
    // An action with no effect is the one thing that reaches the crewmate.
    expect(
      cardEvidenceKind(current("use-postgres", [{ id: "use-postgres", label: "Use Postgres" }])),
    ).toBe("captain_steer");
    expect(
      cardEvidenceKind(current("open-settings", [{ id: "open-settings", label: "Try this" }])),
    ).toBe("captain_steer");
    expect(
      cardEvidenceKind(current("answer", [{ id: "answer", label: "Use this" }], "firstmate")),
    ).toBe("captain_resolved_card");
  });

  it("never reads a host withdrawal as captain contact", () => {
    // The words the host writes when a card leaves the stack with nobody
    // choosing anything: a close_card default, the duplicate label, a
    // recovered credential, a settled task retiring its cards.
    expect(cardEvidenceKind(legacy("closed"))).toBeNull();
    expect(cardEvidenceKind(legacy("duplicate"))).toBeNull();
    expect(cardEvidenceKind(legacy("recovered"))).toBeNull();
    expect(cardEvidenceKind(legacy("discarded"))).toBeNull();
  });
});

describe("miss deriver - window", () => {
  it("counts a later insert at the same millisecond, and drops rows past the end", () => {
    expect(inForwardWindow(T0, 2, T0, 1, WINDOW)).toBe(true);
    expect(inForwardWindow(T0, 1, T0, 1, WINDOW)).toBe(false);
    expect(inForwardWindow(T0 + WINDOW, 9, T0, 1, WINDOW)).toBe(true);
    expect(inForwardWindow(T0 + WINDOW + 1, 9, T0, 1, WINDOW)).toBe(false);
    expect(inForwardWindow(T0 - 1, 9, T0, 1, WINDOW)).toBe(false);
  });
});

describe("miss deriver - fixture firstmate.db", () => {
  let dir = "";
  let dbPath = "";
  let candidates: CandidateMiss[] = [];
  let byTask: Map<string, CandidateMiss>;

  beforeEach(() => {
    dir = scratchDir("infinitary-c2-");
    dbPath = buildFixture(dir);
    candidates = deriveMissCandidates({ dbPath, windowMs: WINDOW }).candidates;
    byTask = new Map(candidates.map((row) => [row.task_id, row]));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a candidate when a routine is followed by a captain verdict inside the window", () => {
    const row = byTask.get("t-escalated");
    expect(row).toBeDefined();
    expect(row?.evidence.some((item) => item.kind === "captain_escalation")).toBe(true);
    expect(row?.rationale).toContain("later captain verdict");
  });

  it("does not emit a candidate for a routine with nothing bad after it", () => {
    expect(byTask.has("t-quiet")).toBe(false);
  });

  it("does not emit a candidate when the deterioration is outside the window", () => {
    expect(byTask.has("t-late")).toBe(false);
  });

  it("treats a later turn_failed wake as evidence even when that later verdict is routine", () => {
    const row = byTask.get("t-turnfail");
    expect(row?.evidence.map((item) => item.kind)).toEqual(["turn_failed"]);
  });

  it("treats a later task-failure wake as evidence", () => {
    const row = byTask.get("t-taskfail");
    expect(row?.evidence.some((item) => item.kind === "task_failure")).toBe(true);
    expect(row?.evidence.some((item) => item.kind === "captain_escalation")).toBe(true);
  });

  it("treats a captain-resolved card produced after the routine as evidence", () => {
    const row = byTask.get("t-card");
    expect(row?.evidence).toEqual([
      expect.objectContaining({
        kind: "captain_resolved_card",
        card_id: "card-land",
        chosen_action: "land",
        resolution: "acted",
      }),
    ]);
  });

  it("keeps wake-derived interruption evidence actor-unknown", () => {
    const row = byTask.get("t-interrupt-wake");
    expect(row?.evidence).toEqual([
      expect.objectContaining({
        kind: "interruption",
        actor: "unknown",
        wake: expect.stringContaining("was interrupted on task t-interrupt-wake"),
        rationale: expect.stringContaining("record does not say by whom"),
      }),
    ]);
    expect(row?.evidence.some((item) => item.kind === "captain_interrupt")).toBe(false);
  });

  it("treats a settle-effect card as a resolution, never a steer", () => {
    const row = byTask.get("t-settle");
    expect(row?.evidence).toEqual([
      expect.objectContaining({
        kind: "captain_resolved_card",
        chosen_action: "merge-current",
        resolution: "acted",
      }),
    ]);
    expect(row?.evidence.some((item) => item.kind === "captain_steer")).toBe(false);
  });

  it("never makes a captain (non-routine) row into a candidate source", () => {
    expect(byTask.has("t-captain-first")).toBe(false);
    expect(candidates.every((row) => row.routine.outcome_id !== undefined)).toBe(true);
  });

  it("does not treat a pre-existing card resolved after the routine as subsequently produced", () => {
    expect(byTask.has("t-oldcard")).toBe(false);
  });

  it("uses the recorded action to distinguish close choices from dismissal and withdrawal", () => {
    const dismissed = byTask.get("t-close-dismissed");
    expect(dismissed?.evidence).toEqual([
      expect.objectContaining({
        kind: "captain_resolved_card",
        chosen_action: "close",
        resolution: "dismissed",
      }),
    ]);
    expect(dismissed?.evidence.some((item) => item.kind === "captain_steer")).toBe(false);

    const acted = byTask.get("t-close-acted");
    expect(acted?.evidence).toEqual([
      expect.objectContaining({
        kind: "captain_steer",
        chosen_action: "close",
        resolution: "acted",
      }),
    ]);

    expect(byTask.has("t-close-withdrawn")).toBe(false);
  });

  it("carries every evidence kind that fired on one routine", () => {
    const row = byTask.get("t-both");
    expect(row?.evidence.map((item) => item.kind).sort()).toEqual([
      "captain_escalation",
      "turn_failed",
    ]);
  });

  it("labels every candidate weak and unconfirmed, even a C3-flagged row", () => {
    expect(candidates.length).toBeGreaterThan(0);
    for (const row of candidates) {
      expect(row.label).toEqual({
        kind: "under_escalation",
        weak: true,
        confirmed: false,
        confidence: "unconfirmed",
      });
    }
    const flagged = byTask.get("t-flagged");
    expect(flagged?.routine.c3_flagged).toBe(true);
    expect(flagged?.label.confirmed).toBe(false);
    expect(flagged?.label.weak).toBe(true);
  });

  it("does not write C3's confirmed-miss columns", () => {
    // Re-open the same file the deriver just read (it opened readonly).
    const db = openDatabase(dir);
    const flagged = db
      .prepare(
        "SELECT missed_escalation, missed_note, missed_at FROM supervision_outcomes WHERE task_id = 't-flagged' AND verdict = 'routine'",
      )
      .get() as { missed_escalation: number; missed_note: string; missed_at: number };
    expect(flagged.missed_escalation).toBe(1);
    expect(flagged.missed_note).toBe("you should have told me");
    const quiet = db
      .prepare("SELECT missed_escalation FROM supervision_outcomes WHERE task_id = 't-quiet'")
      .get() as { missed_escalation: number | null };
    expect(quiet.missed_escalation).toBeNull();
    db.close();
  });

  it("redacts live keys in the routine and the evidence", () => {
    const row = byTask.get("t-secret");
    const blob = JSON.stringify(row);
    expect(blob).not.toContain("sk-ant-SECRETVALUE99");
    expect(blob).toContain("[redacted api key]");
  });

  it("emits one JSON object per line, each round-tripping as a weak candidate", () => {
    const out = join(dir, "candidates.jsonl");
    expect(main(["--db", dbPath, "--out", out])).toBe(0);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines.length).toBe(candidates.length);
    const parsed = lines.map((line) => JSON.parse(line) as CandidateMiss);
    expect(parsed.every((row) => row.label.weak === true && row.label.confirmed === false)).toBe(
      true,
    );
    expect(new Set(parsed.map((row) => row.id)).size).toBe(parsed.length);
  });
});

describe("miss deriver - CLI", () => {
  it("takes the db path and window as parameters so exported data runs anywhere", () => {
    const args = parseArgs(["--user-data", "/exported/userData"]);
    expect(args.dbPath).toBe("/exported/userData/firstmate.db");
    expect(args.windowHours).toBe(24);
    const split = parseArgs(["--db", "/b.db", "--window-hours", "6", "--out", "/c.jsonl"]);
    expect(split.dbPath).toBe("/b.db");
    expect(split.windowHours).toBe(6);
    expect(split.out).toBe("/c.jsonl");
    expect(parseArgs(["--", "--db", "/b.db"]).dbPath).toBe("/b.db");
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--db"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--window-hours", "0"])).toThrow(/positive number/);
  });

  it("defaults to the installed release's userData on this machine", () => {
    const previous = process.env.INFINITARY_USER_DATA_DIR;
    process.env.INFINITARY_USER_DATA_DIR = "/tmp/override";
    expect(defaultUserDataDir()).toBe("/tmp/override");
    delete process.env.INFINITARY_USER_DATA_DIR;
    // The folder the release app really opens (src/shared/userDataFolders.ts),
    // or, before the one-time move, Firstmate 3000's (the Infinitary rename's
    // step 10), read under a scratch home rather than this computer's.
    withScratchHome((appData) => {
      expect(defaultUserDataDir()).toBe(join(appData, RELEASE_USER_DATA_FOLDER));
      mkdirSync(join(appData, USER_DATA_FOLDERS.fm.release), { recursive: true });
      expect(defaultUserDataDir()).toBe(join(appData, USER_DATA_FOLDERS.fm.release));
      mkdirSync(join(appData, RELEASE_USER_DATA_FOLDER));
      expect(defaultUserDataDir()).toBe(join(appData, RELEASE_USER_DATA_FOLDER));
    });
    if (previous !== undefined) process.env.INFINITARY_USER_DATA_DIR = previous;
  });

  it("fails loudly when the database is missing", () => {
    const empty = scratchDir("infinitary-c2-empty-");
    expect(main(["--user-data", empty])).toBe(1);
    rmSync(empty, { recursive: true, force: true });
  });

  it("honours a shorter window so a 25h deterioration drops out", () => {
    const dir = scratchDir("infinitary-c2-window-");
    const dbPath = buildFixture(dir);
    const day = deriveMissCandidates({ dbPath, windowMs: WINDOW });
    const hour = deriveMissCandidates({ dbPath, windowMs: HOUR });
    expect(day.candidates.some((row) => row.task_id === "t-turnfail")).toBe(true);
    expect(hour.candidates.some((row) => row.task_id === "t-turnfail")).toBe(false);
    expect(hour.candidates.some((row) => row.task_id === "t-escalated")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("summarises what it derived without calling anything confirmed", () => {
    const text = summarize({
      candidates: [
        {
          id: "routine#1",
          task_id: "t1",
          task_title: "x",
          task_status: "idle",
          window: { start: 0, end: 1, ms: 1 },
          routine: {
            outcome_id: 1,
            task_id: "t1",
            at: 0,
            wake: "w",
            summary: "s",
            card_id: null,
            model: null,
            prompt_sha: null,
            tools_sha: null,
            steered: null,
            wake_kind: null,
            c3_flagged: false,
          },
          evidence: [
            { kind: "captain_escalation", at: 1, rationale: "later captain" },
            { kind: "turn_failed", at: 1, rationale: "failed" },
          ],
          rationale: "later captain; failed",
          label: {
            kind: "under_escalation",
            weak: true,
            confirmed: false,
            confidence: "unconfirmed",
          },
        },
      ],
      dbPath: "/tmp/firstmate.db",
      windowMs: WINDOW,
      routineCount: 4,
    });
    expect(text).toContain("candidates: 1 (weak, unconfirmed)");
    expect(text).toContain("captain_escalation=1");
    expect(text).not.toContain("confirmed miss");
  });
});

describe("miss deriver - a ledger row's typed wake facts (P6)", () => {
  let dir = "";

  beforeEach(() => {
    dir = scratchDir("infinitary-c2-facts-");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sortRow(
    db: ReturnType<typeof openDatabase>,
    input: { taskId: string; wake: string; at: number; facts?: object },
  ): void {
    db.prepare(
      `INSERT INTO decisions (kind, task_id, wake, facts_json, verdict, summary, at, rule)
       VALUES ('sort', ?, ?, ?, 'routine', 'sorted', ?, 'stopped')`,
    ).run(input.taskId, input.wake, input.facts ? JSON.stringify(input.facts) : null, input.at);
  }

  it("reads a typed wake by its facts, and never by words its excerpt happens to quote", () => {
    const db = openDatabase(dir);
    const tasks = new TaskService({ db, strict: true, now: () => T0 - HOUR });
    insertTask(tasks, "t-typed", "Typed failure");
    insertTask(tasks, "t-quoted", "Quoted failure");
    const typed = { id: "t-typed", title: "Typed failure" };
    const quoted = { id: "t-quoted", title: "Quoted failure" };
    sortRow(db, { taskId: "t-typed", wake: "[fm-op] started", at: T0 });
    // The facts say a turn failed; these words would not.
    sortRow(db, {
      taskId: "t-typed",
      wake: "[fm-op] the crewmate stopped at the provider",
      at: T0 + HOUR,
      facts: { kind: "turn-failed", task: typed, crewmate: "crewmate 1", error: "HTTP 529" },
    });
    sortRow(db, { taskId: "t-quoted", wake: "[fm-op] started", at: T0 });
    // A report that quotes a failed turn is a report.
    const quote = `[fm-op] crewmate 2 reported on task t-quoted "Quoted failure": crewmate 2's turn on task t-quoted "Quoted failure" failed: HTTP 529, so I retried and it is green.`;
    expect(isTurnFailedWake(quote, "t-quoted")).toBe(true);
    sortRow(db, {
      taskId: "t-quoted",
      wake: quote,
      at: T0 + HOUR,
      facts: {
        kind: "report",
        task: quoted,
        crewmate: "crewmate 2",
        excerpt: "quoted",
        filed: [],
        cards: [],
      },
    });
    db.close();

    const byTask = new Map(
      deriveMissCandidates({ dbPath: join(dir, "firstmate.db"), windowMs: WINDOW }).candidates.map(
        (row) => [row.task_id, row],
      ),
    );
    expect(byTask.get("t-typed")?.evidence.map((item) => item.kind)).toEqual(["turn_failed"]);
    expect(byTask.has("t-quoted")).toBe(false);
  });
});
