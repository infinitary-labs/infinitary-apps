/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/tasks/
 */
import { createHash } from "node:crypto";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { ChangePresentationRecord } from "../../src/shared/changePresentation";
import { changePresentationSchema } from "../../src/shared/changePresentation";
import type { CheckRepairLedger } from "../../src/shared/checkRepair";
import type { LiveValidation } from "../../src/shared/liveValidation";
import { liveValidationSchema } from "../../src/shared/liveValidation";
import { BOARD_RECENT_MS } from "../../src/shared/tasks";
import { seedDelivery } from "../helpers/taskDelivery";

/**
 * A saved record the size of the captain's own, for the freeze journey
 * (main-thread-freeze.spec.ts; INF-2061's plan, "seeds a record of your
 * size") and the latency measure. Each count is a reading of the captain's
 * record, never a guess:
 *
 * - 160,094 task events (INF-2059's reading, the history the open messages
 *   walked);
 * - about 3,400 tasks (INF-940's reading, the task list sorted through a
 *   disk file);
 * - 33 open messages in 13 chains (INF-2061's reading);
 * - the rest is INF-3896's reading, taken because a record with none of it
 *   ran every suspect path under 40 ms while the captain's paused the app:
 *   goals, cards with the offers that carry their words, links between
 *   tasks, the delivery records a task board row carries (its change story,
 *   live validation and CI repair), the board's week of closed work, the
 *   open cards that name earlier work, and the heaviest task record.
 *
 * Only counts and sizes come from the captain's record; every word is made
 * here. Every row goes through the stores the app writes with (`seedTask`,
 * `TaskService`, `CardStore`, and `seedDelivery` for the delivery records),
 * so the record holds what the app itself writes: the events are a
 * crewmate's progress lines, the most common event the app records.
 */
export const CAPTAIN_RECORD = {
  taskEvents: 160_094,
  tasks: 3_400,
  openMessages: 33,
  chains: 13,
  /** Every closed task's goal together, and the longest one. */
  goalChars: 2_202_275,
  longestGoal: 333_951,
  /** Closed cards, each with the offer that put it up, and their words together. */
  cards: 6_449,
  cardBodyChars: 66_786_785,
  /** Links between tasks. */
  links: 3_872,
  /** Rows on the full task board: the chains plus the week's closed work. */
  boardRows: 1_701,
  /** What the board's rows carry in delivery records, part by part. */
  delivery: { presentation: 9_059_061, liveValidation: 5_201_750, ciRepair: 1_769_421 },
  /** Open cards, their size as the window receives them, and the earlier work they name. */
  openCards: 9,
  openCardBytes: 244_225,
  openCardKeys: 17,
  openCardKeysOffBoard: 15,
  /** The heaviest task record: the card offers opening it reads. */
  heaviestOffers: 248,
} as const;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Rows written in one transaction before the seed hands the event loop a
 * turn. The one writer prepares its statements on every call, and
 * better-sqlite3 frees a statement only on a turn after the garbage
 * collector finds it unused, so a seed that wrote all 160,094 events in one
 * synchronous call held every statement it had prepared until it returned,
 * several gigabytes in the test's worker, and the Linux runner ended the
 * freeze journey with "worker process exited unexpectedly (signal=SIGKILL)".
 * Yielding each thousand writes keeps the worker near its starting size.
 */
export const WRITES_PER_TURN = 1_000;

const aTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const WORDS =
  "the change keeps each check honest and reads only the rows it needs while the board stays current for the captain who reviews every story before a merge and the crew records what it verified with pictures logs and the steps it took to show the work end to end".split(
    " ",
  );

/** Plain words, exactly `chars` long, varied by `salt`. */
export function prose(chars: number, salt = 0): string {
  const parts: string[] = [];
  let length = 0;
  for (let index = salt; length < chars; index += 7) {
    const word = WORDS[index % WORDS.length] as string;
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(" ").slice(0, chars);
}

/** `total` split into `count` whole shares that add up to it exactly. */
function share(total: number, count: number, index: number): number {
  return Math.floor((total * (index + 1)) / count) - Math.floor((total * index) / count);
}

/** A full commit id made from `seed`. */
const commit = (seed: string) => createHash("sha1").update(seed).digest("hex");

/** Plain words of `chars` characters in all, as entries of at most 4,000 each (the story's limit). */
function entries(chars: number, salt: number): string[] {
  const out: string[] = [];
  for (let left = chars; left > 0; left -= 4_003)
    out.push(prose(Math.min(left, 4_000), salt + out.length));
  return out;
}

/** A change story of about `chars` characters as saved, in the shape the app saves. */
function story(taskId: string, chars: number): ChangePresentationRecord {
  const rating = (salt: number) => ({ level: "low" as const, why: prose(60, salt) });
  const shaped = (verification: string[]) =>
    changePresentationSchema.parse({
      version: 2,
      taskId,
      revision: 1,
      destination: {
        host: "github.com",
        projectId: 1,
        fullName: "example/project",
        visibility: "public",
      },
      title: "fix: keep the board current",
      base: commit(`${taskId}-base`),
      head: commit(`${taskId}-head`),
      why: [prose(300, 1)],
      whatChanged: [prose(200, 2), prose(200, 3)],
      before: [prose(200, 4)],
      after: [prose(200, 5)],
      views: [],
      noPicture: prose(160, 6),
      checked: [{ check: prose(100, 7), result: prose(160, 8) }],
      verification,
      risk: {
        blast: rating(10),
        behavior: rating(11),
        undo: rating(12),
        evidence: rating(13),
        sensitivity: rating(14),
        novelty: rating(15),
        deps: rating(16),
      },
      requiredActions: [],
      unfinished: [],
      projectText: "",
      assets: [],
      pictures: [],
    });
  // The fixed fields' size, then the verification lines fill the rest.
  const rest = chars - JSON.stringify({ revisions: [shaped([])], receipts: [] }).length;
  return { revisions: [shaped(entries(rest, 17))], receipts: [] };
}

/** A live validation record of about `chars` characters. */
function validation(taskId: string, chars: number, at: number): LiveValidation {
  const head = commit(`${taskId}-head`);
  const part = Math.max(1, Math.floor((chars - 700) / 8));
  const words = (salt: number) => prose(Math.min(part, 4_000), salt);
  const scenario = {
    id: "board-current",
    source: "the task's goal",
    importance: "required" as const,
    action: words(21),
    expected: words(22),
    adverse: words(23),
    environment: words(24),
    signal: words(25),
    boundary: words(26),
  };
  return liveValidationSchema.parse({
    scenarioRevision: 1,
    scenarios: [scenario],
    plans: [{ revision: 1, reason: prose(80, 27), scenarios: [], at }],
    runs: [
      {
        kind: "run",
        id: "run-1",
        head,
        scenarioRevision: 1,
        revision: 1,
        deviceId: null,
        at,
        completion: "complete",
        verdict: "go",
        reason: prose(80, 28),
        observations: [
          {
            scenario: "board-current",
            result: "pass",
            live: true,
            actual: words(29),
            evidence: [],
            standIns: [],
            unproven: [],
            attempted: [],
          },
        ],
        evidence: [],
      },
    ],
    reviews: [],
    permissions: [],
  });
}

/** A CI repair ledger of about `chars` characters. */
function repair(taskId: string, chars: number, at: number): CheckRepairLedger {
  const headSha = commit(`${taskId}-head`);
  const evidence = prose(Math.max(1, Math.floor((chars - 400) / 2)), 31);
  return {
    failures: [{ headSha, checks: ["typecheck-lint-build"] }],
    diagnoses: [
      { headSha, check: "typecheck-lint-build", classification: "own-regression", evidence, at },
    ],
    repairs: [
      {
        id: "repair-1",
        sourceHead: headSha,
        headSha: commit(`${taskId}-repaired`),
        check: "typecheck-lint-build",
        evidence: prose(Math.max(1, chars - 400 - evidence.length), 32),
        outcome: "passed",
      },
    ],
  };
}

/** Runs `write` with the clock reading `at`, for the store that reads `Date.now` itself. */
function atTime<T>(at: number, write: () => T): T {
  const real = Date.now;
  Date.now = () => at;
  try {
    return write();
  } finally {
    Date.now = real;
  }
}

/**
 * Writes the record into `userDataDir` and answers the ids of the tasks the
 * open messages are about. Older work is closed, as most of a long record
 * is, the newest of it within the board's week; the open messages' work
 * waits in the backlog, so no crewmate starts. It writes in transactions of
 * `WRITES_PER_TURN` rows and gives the event loop a turn between them, and
 * refuses a record whose counts differ from `CAPTAIN_RECORD`.
 */
export async function seedCaptainSizedRecord(
  userDataDir: string,
  now = Date.now(),
): Promise<{ chainTasks: string[]; heaviestTask: string }> {
  const db = openDatabase(userDataDir);
  try {
    let clock = now;
    const tasks = new TaskService({ db, strict: true, now: () => clock });
    const cards = new CardStore(db);
    const chainTasks: string[] = [];
    const ids: string[] = [];
    /** Runs `write(index)` for each index in `[from, to)`, a transaction per turn. */
    const inTurns = async (from: number, to: number, write: (index: number) => void) => {
      for (let first = from; first < to; first += WRITES_PER_TURN) {
        const last = Math.min(first + WRITES_PER_TURN, to);
        db.transaction(() => {
          for (let index = first; index < last; index += 1) write(index);
        })();
        await aTurn();
      }
    };
    const R = CAPTAIN_RECORD;
    const closed = R.tasks - R.chains;
    // The board's week holds the newest closed work, one close every
    // `spacing`, and the older work closed before it at the same pace.
    const boardClosed = R.boardRows - R.chains;
    const spacing = BOARD_RECENT_MS / (boardClosed + 1);
    const closedAt = (index: number) => now - (closed - index) * spacing;
    const firstOnBoard = closed - boardClosed;
    const longest = closed - 1;
    const goalEach = (index: number) =>
      index === longest ? R.longestGoal : share(R.goalChars - R.longestGoal, closed - 1, index);
    await inTurns(0, R.tasks, (index) => {
      const id = `history-${index}`;
      const isChain = index >= closed;
      const at = isChain ? now - HOUR_MS : closedAt(index);
      clock = at - HOUR_MS;
      seedTask(tasks, {
        id,
        title: `Earlier work ${index}`,
        prompt: `Finish piece ${index} of the earlier work.`,
        status: isChain ? "queued" : "completed",
        ...(isChain ? { startPolicy: "on-request" as const } : {}),
        ...(isChain ? {} : { intent: { goal: prose(goalEach(index), index), userWords: "" } }),
        createdAt: clock,
      });
      if (!isChain && index >= firstOnBoard) {
        const part = index - firstOnBoard;
        seedDelivery(tasks, id, {
          presentation: story(id, share(R.delivery.presentation, boardClosed, part)),
          liveValidation: validation(id, share(R.delivery.liveValidation, boardClosed, part), at),
          ciRepair: repair(id, share(R.delivery.ciRepair, boardClosed, part), at),
        });
      }
      clock = at;
      if (!isChain)
        tasks.close(
          id,
          index % 7 === 0
            ? { status: "dropped", reason: "cancelled", actor: "host" }
            : { status: "done", reason: "finished", actor: "host" },
        );
      if (isChain) chainTasks.push(id);
      ids.push(id);
    });
    clock = now;
    // The heaviest record is the newest closed work, so a journey can open it from the board.
    const heaviestTask = ids[longest - 1] as string;
    // Closed cards, each put up by its offer and answered: the heaviest
    // record's first, then one by one over the rest of the closed work.
    const cardOwner = (index: number) =>
      index < R.heaviestOffers ? heaviestTask : (ids[index % closed] as string);
    await inTurns(0, R.cards, (index) => {
      const taskId = cardOwner(index);
      const createdAt = Math.min(now, (tasks.get(taskId)?.createdAt ?? now) + index);
      const body = `<p>${prose(share(R.cardBodyChars, R.cards, index) - 7, index)}</p>`;
      const id = `history-card-${index}`;
      const offerId = `${id}-offer`;
      const actions = [
        { id: "later", label: "Not now", variant: "ghost" as const },
        { id: "go", label: "Go ahead", variant: "primary" as const, default: true },
      ];
      cards.upsert({
        id,
        taskId,
        author: "crewmate",
        priority: 30,
        title: `Earlier choice ${index}`,
        meta: "crewmate",
        body,
        actions,
        status: "ready",
        createdAt,
        lifecycleId: id,
        offerId,
      });
      cards.observe({
        id: offerId,
        kind: "offer",
        cardId: id,
        lifecycleId: id,
        taskId,
        at: createdAt,
        actor: "crewmate",
        source: "tool",
        offerId,
        payload: {
          basis: "emitted",
          fingerprint: createHash("sha256").update(body).digest("hex"),
          author: "crewmate",
          title: `Earlier choice ${index}`,
          meta: "crewmate",
          body,
          actions,
        },
      });
      atTime(createdAt + 60_000, () => cards.resolve(id, "go"));
    });
    // Links between closed work: each to the work before it, then to the
    // work two before it, and so on, so no two are the same.
    await inTurns(0, R.links, (index) => {
      const step = 1 + Math.floor(index / closed);
      const from = index % closed;
      tasks.graph.link(
        ids[from] as string,
        ids[(from + step) % closed] as string,
        "related",
        "host",
      );
    });
    // The open cards, on the chains' work, name earlier work: most of it
    // closed before the board's week, the rest within it.
    const named = Array.from({ length: R.openCardKeys }, (_, index) => {
      const at =
        index < R.openCardKeysOffBoard
          ? Math.floor((firstOnBoard * (index + 1)) / (R.openCardKeysOffBoard + 1))
          : longest - 2 - index;
      return tasks.get(ids[at] as string)?.key as string;
    });
    db.transaction(() => {
      for (let index = 0; index < R.openCards; index += 1) {
        const keys = named.filter((_, at) => at % R.openCards === index);
        const lead = `<p>This builds on ${keys.join(", ")}.</p>`;
        // The size as the window receives it, less the rest of the card's fields.
        const words = share(R.openCardBytes, R.openCards, index) - 300 - lead.length;
        cards.upsert({
          id: `open-card-${index}`,
          taskId: chainTasks[index % R.chains] as string,
          author: "crewmate",
          priority: 30,
          title: `Plan for piece ${index}`,
          meta: "crewmate",
          body: `${lead}<p>${prose(words - 7, index)}</p>`,
          actions: [],
          status: "ready",
          createdAt: now - (R.openCards - index) * 60_000,
        });
      }
    })();
    // Each open message is about one chain's task: the first one starts the
    // chain, and every later one about the same work joins it.
    await inTurns(0, R.openMessages, (index) => {
      const askId = `open-message-${index}`;
      const taskId = chainTasks[index % R.chains] as string;
      tasks.capture.openAsk({
        id: askId,
        text: `How is piece ${index} going?`,
        at: now - (R.openMessages - index) * 60_000,
      });
      tasks.capture.attachAsk(askId, taskId, "tool:spawn_task");
      tasks.capture.closeAsk(askId, "closed");
      tasks.capture.setAskDelivery(askId, "covered");
    });
    // The rest of the history: progress lines spread over every task. A
    // timeline past its cap folds its oldest lines into one, so the seed
    // writes until the count is the captain's.
    const events = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM task_events").get() as { n: number }).n;
    for (
      let written = 0, left = R.taskEvents - events();
      left > 0;
      left = R.taskEvents - events()
    ) {
      const from = written;
      written += left;
      await inTurns(from, written, (index) => {
        tasks.noteProgress(
          ids[index % ids.length] as string,
          `Checked part ${index} of the change.`,
        );
      });
    }
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const counts = {
      taskEvents: events(),
      tasks: count("SELECT COUNT(*) AS n FROM tasks"),
      cards: count("SELECT COUNT(*) AS n FROM cards WHERE resolved_at IS NOT NULL"),
      links: count("SELECT COUNT(*) AS n FROM task_links"),
    };
    if (
      counts.taskEvents !== R.taskEvents ||
      counts.tasks !== R.tasks ||
      counts.cards !== R.cards ||
      counts.links !== R.links
    )
      throw new Error(
        `The seeded record holds ${counts.tasks} tasks, ${counts.taskEvents} task events, ${counts.cards} closed cards and ${counts.links} links, not the captain's ${R.tasks}, ${R.taskEvents}, ${R.cards} and ${R.links}.`,
      );
    return { chainTasks, heaviestTask };
  } finally {
    db.close();
  }
}
