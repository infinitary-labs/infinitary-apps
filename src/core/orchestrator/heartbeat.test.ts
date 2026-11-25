/**
 * The heartbeat (INF-6664 piece 2; docs/automation.md, "The heartbeat"), as
 * the captain chose its cadence on the plan: a beat only when one of the two
 * reasons holds - a new row on the standing list, or the first mate's cache
 * about to end after a quiet spell on a seat whose cache lasts an hour.
 * The gaps come from the plan's measured record of the first mate: quiet
 * gaps of 44.5 minutes kept the cache, the one gap of 61.8 minutes lost it,
 * and a cold read took 23.4% of its input from the cache.
 */

import { HEARTBEAT_RULE_ID } from "@shared/heartbeat";
import type { DecisionRecord } from "@shared/provenance";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { ScheduleStore } from "../storage/scheduleStore";
import { FIRSTMATE_USAGE_TASK_ID, UsageStore } from "../storage/usageStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { HEARTBEAT_LINE, heartbeatBeat } from "./heartbeat";
import { BROUGHT_RULE_REFUSAL, Scheduler } from "./scheduler";

const MINUTE = 60_000;
/** Nov 24, 2026, 1:00 PM UTC. */
const T0 = Date.UTC(2026, 10, 24, 13, 0);

function turn(startedAt: number, endedAt: number, inboxIds: number[]): DecisionRecord {
  return {
    schema: 1,
    decision: `d-${startedAt}`,
    startedAt,
    endedAt,
    producer: {
      actor: "firstmate",
      role: "firstmate",
      model: null,
      accountId: null,
      thinkingLevel: null,
    },
    contract: { version: "1", promptSha: null, toolsSha: null },
    trigger: "wake",
    served: {
      sessionFile: null,
      prompt: {
        textSha256: "",
        entryId: null,
        parentEntryId: null,
        frame: null,
        segments: inboxIds.map((inboxId) => ({
          kind: "wake",
          origin: "scheduled",
          length: 1,
          inboxId,
        })),
        prefix: null,
      },
      steers: [],
    },
    disposition: {
      outcome: "clean",
      error: null,
      inbox: "acked",
      asks: [],
      toolCalls: [],
      cards: [],
      tasks: [],
      verdict: null,
      outcomeId: null,
      handoffInboxId: null,
    },
  };
}

type Cache = { read: number; write: number };
const WARM: Cache = { read: 157_398, write: 2_326 };
/** The plan's one cold read: 93,372 tokens written again, 23.4% of its input read from the cache. */
const COLD: Cache = { read: 28_500, write: 93_372 };

function fixture(seat: string = CLAUDE_PROVIDER_ID) {
  const db = freshDatabase();
  const clock = { now: T0 };
  const now = () => clock.now;
  const tasks = new TaskService({ db, strict: true, now });
  const inbox = new InboxStore(db, { now });
  const schedules = new ScheduleStore(db);
  const usage = new UsageStore(db);
  const notes: string[] = [];
  const scheduler = new Scheduler({
    store: schedules,
    notify: (wake, origin) => inbox.enqueue(FIRSTMATE_RECIPIENT, wake, undefined, origin),
    inbox,
    broadcastEvent: (event) => {
      if (event.type === "firstmate_note") notes.push(event.text);
    },
    now,
    heartbeat: (at) => heartbeatBeat({ schedules, usage, tasks, inbox }, at),
  });
  /**
   * One first mate request ending now. Its default is the plan's median quiet
   * turn: 157,398 tokens read from the cache and 2,326 written.
   */
  const request = (cache: Cache = WARM) =>
    usage.record({
      taskId: FIRSTMATE_USAGE_TASK_ID,
      model: { provider: seat, id: "served-model" },
      usage: { input: 3, output: 56, cacheRead: cache.read, cacheWrite: cache.write },
      at: clock.now,
    });
  /** The heartbeat's prompts waiting in the first mate's inbox. */
  const beats = () =>
    inbox
      .allFor(FIRSTMATE_RECIPIENT)
      .filter((row) => row.facts?.kind === "scheduled" && row.facts.rule?.id === HEARTBEAT_RULE_ID);
  /** The first mate handles every waiting beat in a turn of one request, a minute long. */
  const handle = (cache?: Cache) => {
    const ids = beats().map((row) => row.id);
    const started = clock.now;
    clock.now += MINUTE / 2;
    request(cache);
    clock.now += MINUTE / 2;
    inbox.ack(ids);
    scheduler.noteDecision(turn(started, clock.now, ids), "Found: nothing needed me.");
  };
  /** Tick once a minute until `until`, handling each beat as it comes; answers when each beat went out. */
  const run = (until: number, cache?: Cache) => {
    const fired: number[] = [];
    while (clock.now < until) {
      clock.now += MINUTE;
      scheduler.tick(clock.now);
      if (beats().length > 0) {
        fired.push(clock.now);
        handle(cache);
      }
    }
    return fired;
  };
  return { db, clock, tasks, inbox, schedules, usage, scheduler, notes, request, beats, run };
}

describe("the heartbeat rule", () => {
  it("comes with the runbook's wake as one captain-requested rule every 55 minutes, and goes with it", () => {
    const f = fixture();
    f.scheduler.keepBrought(true);
    f.scheduler.keepBrought(true);
    expect(f.scheduler.rules()).toEqual([
      {
        id: HEARTBEAT_RULE_ID,
        spec: { kind: "every", minutes: 55 },
        prompt: HEARTBEAT_LINE,
        nextFire: T0 + 55 * MINUTE,
        createdAt: T0,
        captainRequested: true,
        name: "Heartbeat",
        state: "enabled",
        revision: 1,
        brought: "heartbeat",
      },
    ]);
    f.scheduler.keepBrought(false);
    expect(f.scheduler.rules()).toEqual([]);
  });

  it("keeps a paused rule paused across starts, and keeps its runs once the runbook goes off", () => {
    const f = fixture();
    f.scheduler.keepBrought(true);
    f.request();
    expect(f.run(T0 + 60 * MINUTE)).toEqual([T0 + 55 * MINUTE]);
    f.scheduler.pause(HEARTBEAT_RULE_ID);
    f.scheduler.keepBrought(true);
    expect(f.scheduler.rule(HEARTBEAT_RULE_ID).state).toBe("paused");
    f.scheduler.keepBrought(false);
    f.scheduler.keepBrought(true);
    expect(f.scheduler.rule(HEARTBEAT_RULE_ID).state).toBe("enabled");
    expect(f.scheduler.history(HEARTBEAT_RULE_ID).map((run) => run.firedAt)).toEqual([
      T0 + 55 * MINUTE,
    ]);
  });

  it("refuses an edit or a delete, naming where it goes, and leaves the rule as it was", () => {
    const f = fixture();
    f.scheduler.keepBrought(true);
    const before = f.scheduler.rule(HEARTBEAT_RULE_ID);
    expect(() => f.scheduler.update(HEARTBEAT_RULE_ID, { prompt: "Something else." })).toThrow(
      BROUGHT_RULE_REFUSAL,
    );
    expect(() => f.scheduler.update(HEARTBEAT_RULE_ID, {}, { enable: true })).toThrow(
      BROUGHT_RULE_REFUSAL,
    );
    expect(() => f.scheduler.cancel(HEARTBEAT_RULE_ID)).toThrow(BROUGHT_RULE_REFUSAL);
    expect(BROUGHT_RULE_REFUSAL).toContain("Settings, Runbooks");
    expect(f.scheduler.rule(HEARTBEAT_RULE_ID)).toEqual(before);
  });

  it("pauses and resumes like any rule, and Pause all pauses it", () => {
    const f = fixture();
    f.scheduler.keepBrought(true);
    expect(f.scheduler.pause(HEARTBEAT_RULE_ID).state).toBe("paused");
    expect(f.scheduler.resume(HEARTBEAT_RULE_ID).state).toBe("enabled");
    expect(f.scheduler.pauseAll()).toBe(1);
    expect(f.scheduler.rule(HEARTBEAT_RULE_ID).state).toBe("paused");
  });
});

describe("when a beat goes out", () => {
  it("sends one beat in a 61.8-minute quiet gap, 50 minutes after the last request ended", () => {
    const f = fixture();
    f.scheduler.keepBrought(true);
    f.clock.now = T0 + 60 * MINUTE;
    f.request();
    expect(f.run(T0 + 60 * MINUTE + 61.8 * MINUTE)).toEqual([T0 + 110 * MINUTE]);
  });

  it("sends none in a 44.5-minute quiet gap", () => {
    const f = fixture();
    f.scheduler.keepBrought(true);
    f.clock.now = T0 + 60 * MINUTE;
    f.request();
    expect(f.run(T0 + 60 * MINUTE + 44.5 * MINUTE)).toEqual([]);
  });

  it("rests after twelve quiet beats in a row until the first mate's next turn", () => {
    const f = fixture();
    f.scheduler.keepBrought(true);
    f.request();
    const fired = f.run(T0 + 14 * 55 * MINUTE);
    expect(fired).toHaveLength(12);
    expect(f.schedules.runs(HEARTBEAT_RULE_ID).at(-1)?.found).toBe("Found: nothing needed me.");
    // Another turn: the captain asked something.
    f.request();
    expect(f.run(f.clock.now + 51 * MINUTE)).toHaveLength(1);
  });

  it("rests after a beat that read 23% of its input from the cache, until another turn", () => {
    const f = fixture();
    f.scheduler.keepBrought(true);
    f.request();
    expect(f.run(T0 + 3 * 55 * MINUTE, COLD)).toEqual([T0 + 55 * MINUTE]);
    f.request();
    expect(f.run(f.clock.now + 51 * MINUTE)).toHaveLength(1);
  });

  it("sends no quiet beat on a seat whose cache life is not known, but sends a new row", () => {
    const f = fixture("openai-codex");
    f.scheduler.keepBrought(true);
    f.request();
    expect(f.run(T0 + 3 * 55 * MINUTE)).toEqual([]);
    seedTask(f.tasks, { id: "plan", title: "Approved plan", status: "queued", createdAt: T0 });
    seedTask(f.tasks, {
      id: "p1",
      title: "Piece 1",
      parentId: "plan",
      status: "running",
      createdAt: T0,
    });
    seedTask(f.tasks, {
      id: "p2",
      title: "Piece 2",
      parentId: "plan",
      status: "queued",
      startPolicy: "on-request",
      createdAt: f.clock.now,
    });
    expect(f.tasks.starts.declareCaptainStop("p2", "firstmate")).toEqual({
      ok: true,
      changed: true,
    });
    const at = f.clock.now;
    expect(f.run(at + 2 * MINUTE)).toEqual([at + MINUTE]);
  });

  it("carries the standing list, marks its new rows told, and does not send them again", () => {
    const f = fixture("openai-codex");
    f.scheduler.keepBrought(true);
    seedTask(f.tasks, { id: "plan", title: "Approved plan", status: "queued", createdAt: T0 });
    seedTask(f.tasks, {
      id: "p1",
      title: "Piece 1",
      parentId: "plan",
      status: "running",
      createdAt: T0,
    });
    const parked = seedTask(f.tasks, {
      id: "p4",
      title: "Piece 4",
      parentId: "plan",
      status: "queued",
      startPolicy: "on-request",
      createdAt: T0,
    });
    f.tasks.starts.declareCaptainStop("p4", "firstmate");
    f.clock.now = T0 + 54 * MINUTE;
    f.scheduler.tick(f.clock.now);
    f.clock.now = T0 + 55 * MINUTE;
    f.scheduler.tick(f.clock.now);
    const [row] = f.beats();
    if (row?.facts?.kind !== "scheduled") throw new Error("No beat went out.");
    expect(row.facts.prompt.startsWith(`${HEARTBEAT_LINE}\n\n`)).toBe(true);
    expect(row.facts.prompt).toContain(parked.key);
    expect(row.facts.captainRequested).toBe(true);
    expect(f.inbox.woken("p4", `standing:${T0}:0`)).toBe(true);
    f.inbox.ack([row.id]);
    f.scheduler.noteDecision(turn(f.clock.now, f.clock.now + MINUTE, [row.id]));
    // The same row a day later is new again (its 1-day mark); before that, nothing.
    expect(f.run(T0 + 24 * 60 * MINUTE - MINUTE)).toEqual([]);
    expect(f.run(T0 + 24 * 60 * MINUTE)).toEqual([T0 + 24 * 60 * MINUTE]);
  });

  it("drops a beat due while the app was closed, and sends none while one still waits", () => {
    const f = fixture();
    f.scheduler.keepBrought(true);
    f.request();
    f.clock.now = T0 + 3 * 60 * MINUTE;
    f.scheduler.tick(f.clock.now, { catchUp: true });
    expect(f.beats()).toEqual([]);
    expect(f.scheduler.rule(HEARTBEAT_RULE_ID).nextFire).toBe(f.clock.now + 55 * MINUTE);
    f.clock.now += 55 * MINUTE;
    f.scheduler.tick(f.clock.now);
    expect(f.beats()).toHaveLength(1);
    // Unhandled, the beat waits; a later tick past the next mark sends no second one.
    f.clock.now += 120 * MINUTE;
    f.scheduler.tick(f.clock.now);
    expect(f.beats()).toHaveLength(1);
  });
});
