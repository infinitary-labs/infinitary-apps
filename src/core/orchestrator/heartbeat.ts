import { HEARTBEAT_RULE_ID } from "@shared/heartbeat";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import type { InboxStore } from "../storage/inboxStore";
import type { ScheduleStore } from "../storage/scheduleStore";
import { FIRSTMATE_USAGE_TASK_ID, type UsageStore } from "../storage/usageStore";
import type { TaskService } from "../tasks/taskService";
import { standingWork, standingWorkText } from "./standingWork";

/**
 * The heartbeat (INF-6664 piece 2; docs/automation.md, "The heartbeat"): the
 * rule the Heartbeat runbook brings asks here on each tick whether a beat is
 * due, and a beat carries the standing list (`standingWork`). A beat goes out
 * only when one of two reasons holds, the captain's choice on the plan: the
 * list has a row marked new, or the first mate's prompt cache is about to
 * end after a quiet spell.
 */

const MINUTE_MS = 60_000;

/** The rule's interval, and the least time between two beats. */
export const HEARTBEAT_MINUTES = 55;

/**
 * Minutes after the first mate's last request ended at which a quiet beat is
 * due. The Claude seat writes its cache for an hour, and each read restarts
 * that hour from when the request began; the usage ledger records a request
 * when it ended, so the beat comes 50 minutes after that end, which keeps
 * the plan's five minutes of margin for a request up to five minutes long.
 */
export const QUIET_MINUTES = 50;

/**
 * Minutes after the first mate's last request ended past which a quiet beat
 * no longer goes: the cache has ended, or ends before a beat could read it,
 * so a beat would pay a cold read to find nothing (the plan rules that out).
 * The hour runs from when the request began, before its recorded end, so
 * the two minutes short of the hour cover a request up to two minutes long;
 * a beat on a longer one may land cold, and the cold-beat rest stops the
 * ones after it.
 */
export const QUIET_UNTIL_MINUTES = 58;

/**
 * Quiet beats in a row, with no other first mate turn among them, after
 * which the heartbeat rests until the first mate's next turn: twelve quiet
 * beats cost about one cold read (the plan's measure).
 */
export const REST_AFTER_BEATS = 12;

/** A beat that read less than this share of its input from the cache found it cold. */
export const COLD_CACHE_SHARE = 0.5;

/** The fixed line a beat opens with, before the standing list. */
// i18n-exempt: sent to the first mate in English; History and the phone's automation page show it as sent
export const HEARTBEAT_LINE =
  'Heartbeat: a scheduled turn with no news in it. Read the standing list below as the Heartbeat runbook says, and end with one line that starts "Found:".';

export type HeartbeatFacts = {
  /** When the newest beat went out. */
  lastBeatAt?: number;
  /** When the first mate's newest request ended, as the usage ledger recorded it. */
  lastRequestEndedAt?: number;
  /** Whether the standing list has a row marked new. */
  newRow: boolean;
  /** The newest beats in a row with no other first mate turn among them or since. */
  quietBeats: number;
  /** The share of its input the newest beat's first request read from the cache. */
  lastBeatCacheShare?: number;
  /** Whether the provider that served the first mate's last request is known to keep its cache for an hour. */
  hourCache: boolean;
};

export type HeartbeatAnswer = "deliver" | "wait" | "rest";

/**
 * Whether a beat is due now. A new row delivers once 55 minutes passed since
 * the last beat, resting or not, since it is news. A quiet beat needs a seat
 * whose cache is known to last an hour and from 50 to 58 minutes since the
 * first mate's last request ended, inside that hour, and answers `rest`
 * instead while the heartbeat rests.
 */
export function heartbeatDue(facts: HeartbeatFacts, now: number): HeartbeatAnswer {
  const beatPassed =
    facts.lastBeatAt === undefined || now - facts.lastBeatAt >= HEARTBEAT_MINUTES * MINUTE_MS;
  if (!beatPassed) return "wait";
  if (facts.newRow) return "deliver";
  if (!facts.hourCache || facts.lastRequestEndedAt === undefined) return "wait";
  const quiet = now - facts.lastRequestEndedAt;
  if (quiet < QUIET_MINUTES * MINUTE_MS || quiet >= QUIET_UNTIL_MINUTES * MINUTE_MS) return "wait";
  const cold =
    facts.quietBeats > 0 &&
    facts.lastBeatCacheShare !== undefined &&
    facts.lastBeatCacheShare < COLD_CACHE_SHARE;
  return facts.quietBeats >= REST_AFTER_BEATS || cold ? "rest" : "deliver";
}

export type HeartbeatHost = {
  schedules: Pick<ScheduleStore, "runs">;
  usage: Pick<UsageStore, "readingsSince" | "lastReading">;
  tasks: TaskService;
  inbox: Pick<InboxStore, "woken" | "recordOnce">;
};

/** A beat ready to go: its prompt, and the step that marks its new rows told. */
export type HeartbeatBeat = { prompt: string; seen: () => void };

/**
 * The facts `heartbeatDue` reads, from the rule's runs and the first mate's
 * usage ledger. A beat's turn is the span from its run's firing to its
 * settling (a turn's last request is recorded before the turn settles its
 * runs); a request outside every beat's span is another turn.
 */
export function heartbeatFacts(host: HeartbeatHost, now: number): HeartbeatFacts {
  const beats = host.schedules
    .runs(HEARTBEAT_RULE_ID, REST_AFTER_BEATS + 1)
    .filter((run) => run.delivery !== "cancelled");
  const oldest = beats.at(-1);
  const readings = oldest ? host.usage.readingsSince(FIRSTMATE_USAGE_TASK_ID, oldest.firedAt) : [];
  const spans = beats.map((run) => ({
    from: run.firedAt,
    to:
      run.delivery === "waiting" || run.settledAt === null
        ? Number.POSITIVE_INFINITY
        : run.settledAt,
  }));
  let quietBeats = 0;
  for (const [index, span] of spans.entries()) {
    const counted = spans.slice(0, index + 1);
    const other = readings.some(
      (reading) =>
        reading.at > span.from &&
        !counted.some((beat) => reading.at >= beat.from && reading.at <= beat.to),
    );
    if (other) break;
    quietBeats += 1;
  }
  const newest = spans[0];
  const first = newest
    ? readings.find((reading) => reading.at >= newest.from && reading.at <= newest.to)
    : undefined;
  const read = first?.cache_read ?? null;
  const whole = (first?.input ?? 0) + (read ?? 0) + (first?.cache_write ?? 0);
  const lastRequest = host.usage.lastReading(FIRSTMATE_USAGE_TASK_ID);
  return {
    ...(beats[0] ? { lastBeatAt: beats[0].firedAt } : {}),
    ...(lastRequest ? { lastRequestEndedAt: lastRequest.at } : {}),
    newRow: false,
    quietBeats,
    ...(read !== null && whole > 0 ? { lastBeatCacheShare: read / whole } : {}),
    // The cache that matters is the one the last request wrote, on whichever seat served it.
    hourCache: lastRequest?.provider === CLAUDE_PROVIDER_ID,
  };
}

/** The beat due now, or undefined when none is. */
export function heartbeatBeat(host: HeartbeatHost, now: number): HeartbeatBeat | undefined {
  const list = standingWork(host, now);
  const facts = { ...heartbeatFacts(host, now), newRow: list.rows.some((row) => row.new) };
  if (heartbeatDue(facts, now) !== "deliver") return undefined;
  return {
    prompt: `${HEARTBEAT_LINE}\n\n${standingWorkText(host.tasks, list, now)}`,
    seen: () => {
      for (const row of list.rows) if (row.new) host.inbox.recordOnce(row.taskId, row.once);
    },
  };
}
