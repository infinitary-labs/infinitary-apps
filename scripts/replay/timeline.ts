/**
 * What the recording says happened, in the order the replay plays it
 * (`./engine.ts`): every input the captain or the outside world gave,
 * and what the recording says about the cards, steers and spawns those
 * inputs are matched to.
 */

import type {
  DeliveryActionKind,
  DeliveryNote,
} from "../../src/core/orchestrator/answerDelivery.ts";
import { taskIdFromSpawnResult } from "../extract-dispatch-corpus.ts";
import {
  numberColumn,
  type RecordedTables,
  stringColumn,
  type TableRow,
} from "../recorded-tables.ts";
import {
  type CrewRecording,
  type JsonRecord,
  MATCH_LOOKAHEAD_MS,
  normalizeWording,
  type RecordedCall,
  type RecordedFirstmateTurn,
} from "./recording.ts";

export type TimelineEvent =
  | { at: number; order: number; type: "captain"; turn: RecordedFirstmateTurn }
  | { at: number; order: number; type: "crew-start"; alias: string }
  | {
      at: number;
      order: number;
      type: "crew-input";
      alias: string;
      segment: number;
      input:
        | { kind: "job"; text: string }
        | { kind: "choice"; title: string; actionId: string }
        | { kind: "other" };
    }
  | { at: number; order: number; type: "crew-cancel"; alias: string }
  | {
      at: number;
      order: number;
      type: "card-resolution";
      cardId: string;
      taskAlias: string | null;
      title: string;
      action: string;
      source: "chrome" | "frame";
    }
  | {
      at: number;
      order: number;
      type: "thread-reply";
      cardId: string;
      taskAlias: string | null;
      title: string | null;
      text: string;
      /** The captain turn the reply was, when it reached the Firstmate. */
      turn: RecordedFirstmateTurn | null;
    };

export const SPAWN_TOOLS = new Set(["spawn_crewmate", "create_task"]);

/**
 * What a recorded call's own answer says happened, for the answer-delivery
 * row. Read off the recording, never the replay: the replay re-runs today's
 * tools, so a refusal the host no longer makes would otherwise hide the
 * message that went unanswered that night. A lookup, or a call the recording
 * holds no answer for, says nothing.
 */
const RECORDED_ACTION: Record<string, { kind: DeliveryActionKind; ok: (text: string) => boolean }> = {
  emit_card: { kind: "card", ok: (text) => text.startsWith("Card shown") },
  close_card: { kind: "close", ok: (text) => text.startsWith("Closed card") },
  emote: { kind: "reaction", ok: () => true },
  spawn_crewmate: { kind: "work", ok: (text) => text.startsWith("Commissioned") },
  steer_crewmate: { kind: "work", ok: (text) => text.startsWith("Steered") },
  interrupt_crewmate: { kind: "work", ok: () => true },
  settle_task: { kind: "work", ok: (text) => !/^(PR merge blocked|Cannot )/.test(text) },
  create_task: { kind: "record", ok: (text) => text.startsWith("Planned") },
  update_task: { kind: "record", ok: (text) => /^(Updated|Dropped|Started)/.test(text) },
  link_tasks: { kind: "record", ok: () => true },
  schedule_prompt: { kind: "record", ok: () => true },
  cancel_schedule: { kind: "record", ok: () => true },
  remember: { kind: "record", ok: () => true },
  forget: { kind: "record", ok: () => true },
  // Only a write that changed the collection acts; a refusal or a repeated
  // request answers in other words.
  record_knowledge: {
    kind: "record",
    ok: (text) => /^(Recorded|Revised|Assessed|Linked|Retired) /.test(text),
  },
  app_change: { kind: "record", ok: () => true },
  personalize: { kind: "record", ok: () => true },
  install_plugin: { kind: "record", ok: () => true },
  setup_repo: { kind: "record", ok: () => true },
  configure_repo: { kind: "record", ok: () => true },
  unregister_repo: { kind: "record", ok: () => true },
  flag_missed_escalation: { kind: "record", ok: () => true },
  flag_duplicate: { kind: "record", ok: () => true },
};

export function recordedDelivery(
  name: string,
  result: { text: string; isError: boolean } | undefined,
): DeliveryNote | null {
  const action = RECORDED_ACTION[name];
  if (!action || !result) return null;
  if (!result.isError && action.ok(result.text)) {
    return { outcome: "action", kind: action.kind, tool: name };
  }
  return name === "emit_card"
    ? { outcome: "refused", tool: name, reason: "card-refused" }
    : null;
}

function withdrawalKey(cardId: string, reason: string): string {
  return `${cardId}\u0000${reason}`;
}

/**
 * Every close_card the recording shows its emitter making, Firstmate's or a
 * crewmate's, keyed by card id and reason. The host stores that reason as
 * the card's `chosen_action` (`closed` when none was given), so a resolution
 * matching one of these is the emitter's own withdrawal, never the
 * captain's choice. Only a call whose recorded answer closed the card
 * counts; one answered "already closed" withdrew nothing.
 */
function recordedWithdrawals(
  turns: readonly RecordedFirstmateTurn[],
  crew: Iterable<CrewRecording>,
): Set<string> {
  const closed = (text: string | undefined) =>
    text !== undefined && RECORDED_ACTION.close_card?.ok(text) === true;
  const keys = new Set<string>();
  const note = (args: JsonRecord) => {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (typeof args.card_id === "string" && reason) keys.add(withdrawalKey(args.card_id, reason));
  };
  for (const turn of turns) {
    for (const call of turn.calls) {
      if (call.name === "close_card" && !call.result?.isError && closed(call.result?.text)) {
        note(call.args);
      }
    }
  }
  for (const recording of crew) {
    for (const segment of recording.segments) {
      for (const message of segment.messages) {
        for (const part of message.parts) {
          if (part.type !== "toolCall" || part.name !== "close_card") continue;
          if (closed(segment.results.get(part.id))) note(part.args);
        }
      }
    }
  }
  return keys;
}

/**
 * retireTaskCards writes the task's close reason into chosen_action. The
 * card must already exist when its own task closes, and resolve no earlier
 * than that close. A declared action remains a possible captain choice,
 * even when its id happens to equal the close reason; incomplete evidence
 * likewise stays on the ordinary admission path.
 */
function recordedRetirement(card: TableRow, task: TableRow | undefined): boolean {
  if (!task || (task.status !== "done" && task.status !== "dropped")) return false;
  const reason = stringColumn(task, "closed_reason");
  const closedAt = numberColumn(task, "closed_at");
  const createdAt = numberColumn(card, "created_at");
  const resolvedAt = numberColumn(card, "resolved_at");
  if (
    !reason ||
    stringColumn(card, "chosen_action") !== reason ||
    closedAt === null ||
    createdAt === null ||
    resolvedAt === null ||
    createdAt > closedAt ||
    resolvedAt < closedAt
  )
    return false;
  const actions = JSON.parse(stringColumn(card, "actions_json") ?? "[]") as { id: string }[];
  return !actions.some((action) => action.id === reason);
}

/**
 * The background-job notice a recorded crewmate input carries: the whole
 * input, or its tail where the host batched it behind another input with a
 * blank line between. The current host serves the notice on its own.
 */
function jobNotice(text: string): string | null {
  if (text.startsWith("[job]")) return text;
  const at = text.indexOf("\n\n[job] ");
  return at >= 0 ? text.slice(at + 2) : null;
}

/** The host's words for a captain's choice on a crewmate's card, as recorded: the card's title and the action. */
export const RECORDED_CHOICE = /^Card "(.*)": the user chose "(.*)" \((\S+)\)\.$/s;

/** A Firstmate steer the recording holds, to one crewmate, in the words it was served. */
export type RecordedSteer = { words: string; turn: RecordedFirstmateTurn; delivered: boolean };

/** What the recording says happened, read once before the replay plays it. */
export type RecordedTimeline = {
  /** Every input the captain or the outside world gave, in recorded order. */
  events: TimelineEvent[];
  /** The recording's first moment: rows created before it are the state the replay starts from. */
  begins: number;
  /** The recorded Firstmate turn whose spawn started each crewmate, by its recorded task id. */
  spawnTurns: Map<string, RecordedFirstmateTurn>;
  /** The Firstmate's recorded steers, by the crewmate each went to. */
  steers: Map<string, RecordedSteer[]>;
  /** Captain turns that were a footer click on a Firstmate card: its resolution plays them. */
  cardChoiceTurns: Set<RecordedFirstmateTurn>;
  /** Captain turns that were replies in a Firstmate card's thread: their reply plays them. */
  threadReplyTurns: Set<RecordedFirstmateTurn>;
  /** Recorded resolutions that were their emitter's own withdrawal, by title. */
  withdrawnCards: string[];
  /** Recorded resolutions written by task retirement, by title: host output, never choices. */
  retiredCards: string[];
  /** The captain's replies in card threads. */
  threadReplies: number;
};

/** Every input the captain or the outside world gave, in recorded order. */
export function recordedTimeline(recording: {
  captainTurns: readonly RecordedFirstmateTurn[];
  opTurns: readonly RecordedFirstmateTurn[];
  crew: ReadonlyMap<string, CrewRecording>;
  tables: RecordedTables;
}): RecordedTimeline {
  const { captainTurns, opTurns, crew, tables } = recording;
  const timeline: RecordedTimeline = {
    events: [],
    begins: Number.POSITIVE_INFINITY,
    spawnTurns: new Map(),
    steers: new Map(),
    cardChoiceTurns: new Set(),
    threadReplyTurns: new Set(),
    withdrawnCards: [],
    retiredCards: [],
    threadReplies: 0,
  };
  const events = timeline.events;
  let order = 0;
  const spawned = new Set<string>();
  for (const turn of [...captainTurns, ...opTurns]) {
    for (const call of turn.calls) {
      if (call.name === "steer_crewmate") noteSteer(timeline.steers, tables, call, turn);
      if (!SPAWN_TOOLS.has(call.name) || !call.result) continue;
      const id = taskIdFromSpawnResult(call.result.text);
      if (!id) continue;
      spawned.add(id);
      if (!timeline.spawnTurns.has(id)) timeline.spawnTurns.set(id, turn);
    }
  }
  const resolvedByTable = new Set<string>();
  const withdrawals = recordedWithdrawals(
    [...captainTurns, ...opTurns],
    crew.values(),
  );
  const recordedTasks = new Map(tables.tasks.map((row) => [stringColumn(row, "id"), row]));
  for (const row of tables.cards) {
    const id = stringColumn(row, "id");
    const resolvedAt = numberColumn(row, "resolved_at");
    const resolution = stringColumn(row, "chosen_action");
    if (!id || resolvedAt === null || !resolution) continue;
    const title = stringColumn(row, "title") ?? "";
    // The emitter's own close_card is not the captain's input: it plays
    // when its recorded call does. Its row holds the call's reason, or
    // `closed` without one; only the recorded call tells that reason from
    // an action id (FI3-287).
    if (resolution === "closed" || withdrawals.has(withdrawalKey(id, resolution))) {
      timeline.withdrawnCards.push(title);
      continue;
    }
    const taskAlias = stringColumn(row, "task_id");
    // A settled task's retirement is host output, not a second captain
    // input. The recorded close facts prove it even without tool evidence
    // on the card itself (FI3-989).
    if (taskAlias && recordedRetirement(row, recordedTasks.get(taskAlias))) {
      timeline.retiredCards.push(title);
      continue;
    }
    const source = resolution.startsWith("script:") ? "frame" : "chrome";
    const action = source === "frame" ? resolution.slice("script:".length) : resolution;
    resolvedByTable.add(`${taskAlias ?? ""}|${title}`);
    // A new recording stores the footer click as captain speech. It is
    // replayed by this resolution, not a second converse with its label.
    if (id.startsWith("card-fm-") && action !== "close" && source === "chrome") {
      const actions = JSON.parse(stringColumn(row, "actions_json") ?? "[]") as {
        id: string;
        label: string;
      }[];
      const label = actions.find((entry) => entry.id === action)?.label;
      const turn = captainTurns.find(
        (candidate) =>
          label &&
          candidate.user.startsWith(`${label}\nChoice on card "${title}"`) &&
          Math.abs(candidate.at - resolvedAt) <= MATCH_LOOKAHEAD_MS,
      );
      if (turn) timeline.cardChoiceTurns.add(turn);
    }
    events.push({
      at: resolvedAt,
      order: order++,
      type: "card-resolution",
      cardId: id,
      taskAlias,
      title,
      action,
      source,
    });
  }
  for (const row of tables.card_messages) {
    const cardId = stringColumn(row, "card_id");
    const at = numberColumn(row, "at");
    const text = stringColumn(row, "text")?.trim();
    // Only the captain's lines are inputs: the author's answer and the
    // host's "revised" line are what the replay is about to produce.
    if (stringColumn(row, "who") !== "captain" || !cardId || at === null || !text) continue;
    const card = tables.cards.find((candidate) => stringColumn(candidate, "id") === cardId);
    // A reply that reached the Firstmate was a captain turn about the
    // card; the reply plays it, so it is not a second converse.
    const turn = captainTurns.find(
      (candidate) =>
        !timeline.cardChoiceTurns.has(candidate) &&
        !timeline.threadReplyTurns.has(candidate) &&
        candidate.user === text &&
        Math.abs(candidate.at - at) <= MATCH_LOOKAHEAD_MS,
    );
    if (turn) timeline.threadReplyTurns.add(turn);
    timeline.threadReplies += 1;
    events.push({
      at,
      order: order++,
      type: "thread-reply",
      cardId,
      taskAlias: card ? stringColumn(card, "task_id") : null,
      title: card ? stringColumn(card, "title") : null,
      text,
      turn: turn ?? null,
    });
  }
  for (const turn of captainTurns) {
    if (!timeline.cardChoiceTurns.has(turn) && !timeline.threadReplyTurns.has(turn))
      events.push({ at: turn.at, order: order++, type: "captain", turn });
  }
  // A row is seeded only when it existed before the recording's first
  // moment (`seedBefore`). One created inside it by a crewmate the replay
  // holds no recording of is never seeded, so its own recorded crewmate
  // is commissioned at its first turn, as a standalone one is.
  timeline.begins = Math.min(
    ...events.map((event) => event.at),
    ...[...crew.values()].flatMap((recording) =>
      recording.segments.slice(0, 1).map((segment) => segment.at),
    ),
  );
  const seeded = new Set(
    tables.tasks
      .filter((row) => (numberColumn(row, "created_at") ?? timeline.begins) < timeline.begins)
      .map((row) => stringColumn(row, "id")),
  );
  for (const [alias, recording] of crew) {
    const first = recording.segments[0];
    if (!first) continue;
    if (!spawned.has(alias)) {
      if (seeded.has(alias) && !isStandaloneCrew(tables, crew, alias)) continue;
      events.push({ at: first.at, order: order++, type: "crew-start", alias });
    }
    for (const [index, segment] of recording.segments.entries()) {
      if (index === 0) continue;
      const choice = RECORDED_CHOICE.exec(segment.user);
      const job = jobNotice(segment.user);
      let input: Extract<TimelineEvent, { type: "crew-input" }>["input"] = { kind: "other" };
      if (job) input = { kind: "job", text: job };
      else if (choice && !resolvedByTable.has(`${alias}|${choice[1]}`)) {
        input = { kind: "choice", title: choice[1] ?? "", actionId: choice[3] ?? "" };
      }
      events.push({
        at: segment.at,
        order: order++,
        type: "crew-input",
        alias,
        segment: index,
        input,
      });
    }
    if (recording.cancelAt !== null) {
      events.push({ at: recording.cancelAt, order: order++, type: "crew-cancel", alias });
    }
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  return timeline;
}

/**
 * A recorded Firstmate steer, kept by the crewmate it went to: its words,
 * the turn that sent it, and whether its recorded answer says it landed.
 */
function noteSteer(
  steersTo: Map<string, RecordedSteer[]>,
  tables: RecordedTables,
  call: RecordedCall,
  turn: RecordedFirstmateTurn,
): void {
  const ref = typeof call.args.task_id === "string" ? call.args.task_id : null;
  const message = typeof call.args.message === "string" ? call.args.message : null;
  if (!ref || !message) return;
  const row = tables.tasks.find((task) => stringColumn(task, "key") === ref);
  const alias = (row ? stringColumn(row, "id") : null) ?? ref;
  const steers = steersTo.get(alias) ?? [];
  steers.push({
    words: normalizeWording(message),
    turn,
    delivered: recordedDelivery(call.name, call.result)?.outcome === "action",
  });
  steersTo.set(alias, steers);
}

/** A crewmate session whose task row the tables also carry but that no spawn names. */
function isStandaloneCrew(
  tables: RecordedTables,
  crew: ReadonlyMap<string, CrewRecording>,
  alias: string,
): boolean {
  const row = tables.tasks.find((task) => stringColumn(task, "id") === alias);
  const created = row ? numberColumn(row, "created_at") : null;
  const first = crew.get(alias)?.segments[0]?.at ?? 0;
  return created !== null && created >= first - 60_000;
}
