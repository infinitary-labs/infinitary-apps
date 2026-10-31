import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AnswerDeliveryCheck } from "@core/orchestrator/answerDeliveryCheck";
import { CrewSupervisor } from "@core/orchestrator/crewSupervisor";
import { FirstmateAgent } from "@core/orchestrator/firstmateAgent";
import { TICK_PERIOD_MS, Ticker } from "@core/orchestrator/ticker";
import { appPathsFor } from "@core/paths";
import type { ModelRuntime } from "@core/pi/types";
import { CardStore } from "@core/storage/cardStore";
import { InboxStore } from "@core/storage/inboxStore";
import { SettingsStore } from "@core/storage/settingsStore";
import { TaskEventStore } from "@core/storage/taskEventStore";
import { seedTask } from "@core/tasks/seedTask";
import { TaskProtocol } from "@core/tasks/taskProtocol";
import { TaskService } from "@core/tasks/taskService";
import { WorkPresentation } from "@core/tasks/workPresentation";
import { RepoRegistry } from "@core/workspace/repoRegistry";
import type { WorkspaceService } from "@core/workspace/workspaceService";
import type { Card } from "@shared/cards";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freshDatabase } from "./helpers/database";
import { fakeBinding, fakeSessionFactory } from "./helpers/fakeSession";
import { scratchDir } from "./helpers/scratchDirs";
import { outsideCensus } from "./helpers/statementCheck";

// The scale check (INF-2061, direction B, built as INF-2069): the reads the
// app repeats on its main thread - a first mate turn's context build, the
// answer-delivery sweep, one minute pass and a task board update - must not
// grow with closed history. Five main thread freezes (INF-703, INF-940,
// INF-1348, INF-1956, INF-2059) were synchronous SQLite whose cost grew
// with the saved record while the tests used a few rows. This seeds a
// record sized from the captain's real readings, counts each read's
// statements and the rows they return, adds three times the closed history
// again, and fails when any count moved. It counts work, never time
// (captain's B1). A walk that returns no rows (INF-2059's) is the
// statement check's to catch (docs/testing.md, "The statement check").

vi.setConfig({ testTimeout: 300_000 });

/**
 * The captain's record when INF-2059 was measured: 160,094 task events
 * over about 3,400 tasks (INF-940), so about 47 events a task, and 33 open
 * messages in 13 chains.
 */
const CLOSED_TASKS = 3_400;
const EVENTS_PER_TASK = 47;
const OPEN_CHAINS = 13;
const OPEN_MESSAGES = 33;
/** The live work beside them: running crew, queued work and the last week's closed work. */
const RUNNING = OPEN_CHAINS;
const QUEUED = 20;
const RECENTLY_CLOSED = 40;

/** Closed tasks seeded per transaction; see addClosedHistory. */
const SEED_BATCH = 200;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 31, 17, 0, 0);

type Count = { runs: number; rows: number };
type Counts = Record<string, Count>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

it("keeps each repeated read's statements and rows when closed history quadruples", async () => {
  const record = await buildRecord();
  // Each read once first: the app repeats them, so a first read's one-time
  // work (a boot sweep, a cache) is not what grows with the record.
  await record.measure();
  const base = await record.measure();
  // Each read reads the record; a read that read nothing would pass vacuously.
  for (const [read, counts] of Object.entries(base))
    expect(Object.keys(counts).length, `${read} ran no statement`).toBeGreaterThan(0);
  // The same reads again on the same record read the same: a count that
  // moves below moved because the closed history grew.
  expect(await record.measure()).toEqual(base);
  await record.addClosedHistory(3 * CLOSED_TASKS);
  const quadrupled = await record.measure();
  await record.dispose();
  expect(movedCounts(base, quadrupled), "a repeated read grew with closed history").toEqual({});
});

/** Per read, each statement whose runs or returned rows differ between the two records. */
type Moved = { caller: string; before: Count | null; after: Count | null };

function movedCounts(
  before: Record<string, Counts>,
  after: Record<string, Counts>,
): Record<string, Record<string, Moved>> {
  const moved: Record<string, Record<string, Moved>> = {};
  for (const read of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[read] ?? {};
    const is = after[read] ?? {};
    for (const sql of new Set([...Object.keys(was), ...Object.keys(is)])) {
      const a = was[sql] ?? null;
      const b = is[sql] ?? null;
      if (a?.runs === b?.runs && a?.rows === b?.rows) continue;
      moved[read] ??= {};
      moved[read][sql] = {
        caller: callers.get(`${read}\n${sql}`)?.at ?? "unknown",
        before: a,
        after: b,
      };
    }
  }
  return moved;
}

/**
 * Per read and statement, the app code behind the run that returned the most
 * rows, for a failure to name: the run that grew, not the statement's first.
 */
const callers = new Map<string, { rows: number; at: string }>();

/**
 * The app's own frames that ran a statement, innermost first, up to four:
 * the store that ran it and the code that asked. A test's frames are not the app's.
 */
function appCaller(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const at = /at (?:(\S+) \()?.*?\/(src\/[^():]+):(\d+)/.exec(line);
    if (!at || /\.test\.tsx?$/.test(at[2] ?? "")) continue;
    frames.push(`${at[1] ?? "<anonymous>"} (${at[2]}:${at[3]})`);
    if (frames.length === 4) break;
  }
  return frames.join(" <- ") || "unknown";
}

/**
 * Counts every statement run on any connection while `work` runs, and the
 * rows each returned, by its text. A write returns no rows.
 */
async function counted(read: string, work: () => void | Promise<void>): Promise<Counts> {
  const counts: Counts = {};
  const add = (source: string, rows: number) => {
    const sql = source.replace(/\s+/g, " ").trim();
    const most = callers.get(`${read}\n${sql}`);
    if (!most || rows > most.rows) callers.set(`${read}\n${sql}`, { rows, at: appCaller() });
    const count = counts[sql] ?? { runs: 0, rows: 0 };
    counts[sql] = { runs: count.runs + 1, rows: count.rows + rows };
  };
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Database.Statement;
  probe.close();
  const original = {
    get: statement.get,
    all: statement.all,
    iterate: statement.iterate,
    run: statement.run,
  };
  const target = statement as unknown as Record<string, unknown>;
  target.get = function (this: Database.Statement, ...args: unknown[]) {
    const row = original.get.apply(this, args as never);
    add(this.source, row === undefined ? 0 : 1);
    return row;
  };
  target.all = function (this: Database.Statement, ...args: unknown[]) {
    const rows = original.all.apply(this, args as never) as unknown[];
    add(this.source, rows.length);
    return rows;
  };
  target.iterate = function* (this: Database.Statement, ...args: unknown[]) {
    let rows = 0;
    try {
      for (const row of original.iterate.apply(this, args as never)) {
        rows += 1;
        yield row;
      }
    } finally {
      add(this.source, rows);
    }
  };
  target.run = function (this: Database.Statement, ...args: unknown[]) {
    const result = original.run.apply(this, args as never);
    add(this.source, 0);
    return result;
  };
  try {
    await work();
  } finally {
    Object.assign(target, original);
  }
  return counts;
}

/** Lets the minute pass's asynchronous checks finish their reads. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function buildRecord() {
  const paths = appPathsFor(scratchDir("infinitary-scale-check-"));
  const db = freshDatabase();
  const now = () => Date.now();
  const repos = new RepoRegistry(db, paths.fleetDir);
  const tasks = new TaskService({ db, repos, strict: true, now });
  const cardStore = new CardStore(db);
  const inbox = new InboxStore(db, { now });
  const settings = new SettingsStore(db);
  const taskEvents = new TaskEventStore(db);

  let closedSeeded = 0;
  /**
   * Closed work from before the board's week: tasks, their events, cards,
   * threads and answered messages. The app's writers prepare about 135
   * statements a task, and better-sqlite3 frees a statement only after the
   * event loop turns, so one transaction over every task held about 3 GB at
   * 3,400 tasks and the Linux runner killed the worker. A turn between
   * batches lets them go.
   */
  const addClosedHistory = async (count: number) => {
    for (let batch = 0; batch < count; batch += SEED_BATCH) {
      await new Promise((resolve) => setImmediate(resolve));
      seedClosed(Math.min(SEED_BATCH, count - batch));
    }
  };
  const seedClosed = (count: number) => {
    outsideCensus(
      db.transaction(() => {
        for (let n = 0; n < count; n += 1) {
          const index = closedSeeded++;
          const id = `closed-${index}`;
          vi.setSystemTime(NOW - 10 * DAY - index * 60_000);
          seedTask(tasks, {
            id,
            title: `Closed work ${index}`,
            status: "idle",
            outcome: `Finished closed work ${index}.`,
          });
          const askId = `closed-ask-${index}`;
          tasks.openAsk({ id: askId, text: `Please do closed work ${index}.` });
          tasks.attachAsk(askId, id, "tool:spawn_task");
          tasks.closeAsk(askId, "closed");
          // Seeding wrote about five events; the rest are the crewmate's notes.
          for (let event = 5; event < EVENTS_PER_TASK - 1; event += 1)
            taskEvents.insert({
              taskId: id,
              at: Date.now(),
              actor: "crewmate",
              kind: "note",
              text: `Step ${event} of closed work ${index}.`,
              data: { news: false },
              feed: false,
            });
          const cardId = `card-${id}`;
          cardStore.upsert(card(cardId, id, `Closed work ${index} is done`));
          cardStore.appendMessage({ cardId, who: "captain", text: "Looks good." });
          cardStore.resolve(cardId, "merge");
          tasks.markAnswered([askId], cardId);
          tasks.close(id, { status: "done", reason: "merged", actor: "host" });
        }
      }),
    );
  };

  await addClosedHistory(CLOSED_TASKS);
  vi.setSystemTime(NOW - 3 * DAY);
  for (let index = 0; index < RECENTLY_CLOSED; index += 1) {
    const id = `recent-${index}`;
    seedTask(tasks, { id, title: `Recent work ${index}`, status: "idle", outcome: "Done." });
    tasks.close(id, { status: "done", reason: "merged", actor: "host" });
  }
  vi.setSystemTime(NOW - DAY);
  for (let index = 0; index < QUEUED; index += 1)
    seedTask(tasks, {
      id: `queued-${index}`,
      title: `Queued work ${index}`,
      status: "queued",
      startPolicy: "on-request",
    });
  // The open messages: each chain's work is a running task, and the
  // messages after a chain's first join it.
  let message = 0;
  for (let chain = 0; chain < RUNNING; chain += 1) {
    const id = `running-${chain}`;
    seedTask(tasks, { id, title: `Running work ${chain}`, status: "idle" });
    const members =
      Math.floor(OPEN_MESSAGES / OPEN_CHAINS) + (chain < OPEN_MESSAGES % OPEN_CHAINS ? 1 : 0);
    for (let member = 0; member < members; member += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      const askId = `open-ask-${message++}`;
      tasks.openAsk({ id: askId, text: `About running work ${chain}, part ${member}.` });
      tasks.attachAsk(askId, id, "tool:spawn_task");
      tasks.closeAsk(askId, "closed");
      tasks.setAskDelivery(askId, "covered");
    }
    cardStore.upsert(card(`card-${id}`, id, `Running work ${chain} has a question`));
  }
  vi.setSystemTime(NOW);

  const events: unknown[] = [];
  const supervisor = new CrewSupervisor({
    sessions: { pi: fakeSessionFactory() },
    bind: async (accountId) => fakeBinding(accountId),
    workspace: {
      removeTaskWorktree: async () => {},
      retireTaskWorktree: async () => ({ outcome: "removed" as const, kept: null }),
    } as unknown as WorkspaceService,
    repos,
    tasks,
    cardStore,
    inbox,
    paths,
    now,
    broadcastEvent: (event) => events.push(event),
    broadcastCards: () => {},
  });
  const selfSourceDir = join(paths.userData, "self-source");
  mkdirSync(selfSourceDir, { recursive: true });
  const agent = new FirstmateAgent({
    paths,
    inbox,
    settings,
    modelRuntime: {} as ModelRuntime,
    availableModels: () => [{ provider: "fm-mock", id: "mock-1" }],
    quotaModels: () => undefined,
    quotaLine: () => "codex 62% weekly on_pace",
    repos,
    supervisor,
    tasks,
    broadcastEvent: (event) => events.push(event),
    selfSourceDir,
    now,
  });
  // The answer-delivery check as the first mate builds it.
  const delivery = new AnswerDeliveryCheck({
    tasks,
    inbox,
    now,
    raiseNotice: (notice) => supervisor.raiseHostCard(notice),
    cardTitle: (cardId) => supervisor.cardsSnapshot().find((shown) => shown.id === cardId)?.title,
    ending: supervisor.askEnding,
  });
  // The board as services.ts builds it, over the supervisor's facts.
  const protocol = new TaskProtocol({
    tasks,
    repos,
    cards: {
      listOpen: () => cardStore.listOpen(),
      snapshot: () => supervisor.cardsSnapshot(),
      forTask: (taskId, extraIds) => cardStore.forTask(taskId, extraIds),
    },
    workPosture: (record) => supervisor.workPosture(record),
    place: (record) => supervisor.taskPlace(record),
    computerMove: (record) => supervisor.computerMoveFacts(record),
    runsOn: (record) => supervisor.runsOnFact(record),
    broadcastEvent: (event) => events.push(event),
    emit: () => {},
    now,
    coalesceMs: 60 * 60 * 1000,
  });
  // The minute pass as services.ts registers it: the crew's watchdog
  // checks and the work presentation refresh.
  const ticker = new Ticker({ now, timers: { repeat: () => 0, cancel: () => {} } });
  const presentation = new WorkPresentation({
    tasks,
    protocol,
    broadcastEvent: (event) => events.push(event),
  });
  supervisor.startWatchdog(ticker);
  ticker.register("work-presentation", TICK_PERIOD_MS, () => presentation.schedule());

  return {
    addClosedHistory: async (count: number) => {
      const at = Date.now();
      await addClosedHistory(count);
      vi.setSystemTime(at);
    },
    measure: async (): Promise<Record<string, Counts>> => {
      vi.setSystemTime(Date.now() + TICK_PERIOD_MS);
      await settle();
      return {
        "first mate context": await counted("first mate context", () => {
          agent.buildContextBlock();
        }),
        "answer-delivery sweep": await counted("answer-delivery sweep", () => delivery.sweep()),
        "minute pass": await counted("minute pass", async () => {
          ticker.tick();
          await settle();
        }),
        "task board update": await counted("task board update", () => {
          protocol.board();
        }),
      };
    },
    dispose: async () => {
      protocol.dispose();
      presentation.dispose();
      await supervisor.disposeAll();
      db.close();
    },
  };
}

function card(id: string, taskId: string, title: string): Card {
  return {
    id,
    taskId,
    author: "crewmate",
    priority: 30,
    title,
    meta: "crewmate",
    body: `<p>${title}.</p>`,
    actions: [],
    status: "ready",
    createdAt: Date.now(),
  };
}
