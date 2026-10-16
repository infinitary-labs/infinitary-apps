import type { FmEvent } from "@shared/events";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { ScheduleStore } from "../storage/scheduleStore";
import { computeNextFire, Scheduler } from "./scheduler";
import { TICK_PERIOD_MS, Ticker } from "./ticker";
import { renderWake, type TypedWake } from "./wakes";

/** What the Firstmate's drain serves for a fired schedule: the wake, through the inbox. */
function served(wake: TypedWake): string {
  const inbox = new InboxStore(openInMemoryDatabase());
  inbox.enqueue(FIRSTMATE_RECIPIENT, wake, undefined, "scheduled");
  const [row] = inbox.allFor(FIRSTMATE_RECIPIENT);
  if (!row) throw new Error("the wake was not recorded");
  return renderWake(row);
}

function setup() {
  const store = new ScheduleStore(openInMemoryDatabase());
  const fired: string[] = [];
  const origins: string[] = [];
  const events: FmEvent[] = [];
  const scheduler = new Scheduler({
    store,
    notify: (wake, origin) => {
      fired.push(served(wake));
      origins.push(origin);
    },
    broadcastEvent: (event) => events.push(event),
  });
  return { store, scheduler, fired, origins, events };
}

it("persists captain authority across a scheduler restart and carries it in typed wakes", () => {
  const store = new ScheduleStore(openInMemoryDatabase());
  const scheduler = new Scheduler({ store, notify: () => {}, broadcastEvent: () => {} });
  const requested = scheduler.create({ kind: "every", minutes: 30 }, "a captain request", true);
  // A reminder Firstmate set for itself: a one-time one, since a recurring
  // rule nobody directed waits as a draft.
  const autonomous = scheduler.create(
    { kind: "once", at: Date.now() + 30 * 60_000 },
    "an autonomous reminder",
  );
  const wakes: TypedWake[] = [];
  const restarted = new Scheduler({
    store,
    notify: (wake) => wakes.push(wake),
    broadcastEvent: () => {},
  });
  restarted.tick(Math.max(requested.nextFire, autonomous.nextFire));
  expect(wakes.map((wake) => wake.facts)).toEqual([
    {
      kind: "scheduled",
      prompt: "a captain request",
      catchUp: false,
      captainRequested: true,
      run: expect.any(Number),
      rule: { id: requested.id },
    },
    {
      kind: "scheduled",
      prompt: "an autonomous reminder",
      catchUp: false,
      captainRequested: false,
      run: expect.any(Number),
      rule: { id: autonomous.id },
    },
  ]);
});

describe("computeNextFire", () => {
  it("advances a recurring schedule from the given moment", () => {
    expect(computeNextFire({ kind: "every", minutes: 30 }, 1_000_000)).toBe(
      1_000_000 + 30 * 60_000,
    );
  });

  it("picks today's daily time when still ahead, tomorrow's otherwise", () => {
    const base = new Date(2026, 7, 19, 8, 0, 0, 0).getTime();
    const next = computeNextFire({ kind: "daily", hour: 9, minute: 30 }, base);
    expect(new Date(next).getHours()).toBe(9);
    expect(new Date(next).getMinutes()).toBe(30);
    expect(next - base).toBeLessThan(24 * 60 * 60 * 1000);
    const past = computeNextFire({ kind: "daily", hour: 7, minute: 0 }, base);
    expect(new Date(past).getDate()).toBe(20);
  });
});

describe("Scheduler (R3)", () => {
  it("creates with a feed line and fires the prompt into the notify seam", () => {
    const { scheduler, fired, origins, events } = setup();
    const record = scheduler.create(
      { kind: "every", minutes: 30 },
      "check the release dashboard",
      true,
    );
    const note = events.find((event) => event.type === "firstmate_note");
    expect(note && "text" in note ? note.text : "").toContain("Scheduled - every 30 minutes");

    scheduler.tick(record.nextFire - 1000);
    expect(fired).toEqual([]);
    scheduler.tick(record.nextFire + 1000);
    expect(fired).toEqual([
      `[fm-op] scheduled by automation ${record.id}: check the release dashboard`,
    ]);
    // The fire is stamped scheduled - the stamp is what gates note creation.
    expect(origins).toEqual(["scheduled"]);
  });

  it("advances a recurring fire from now, so an overdue schedule fires once", () => {
    const { scheduler, store, fired } = setup();
    const record = scheduler.create({ kind: "every", minutes: 30 }, "recurring check", true);
    // Three intervals pass unseen (the app was closed); one catch-up fire.
    const later = record.nextFire + 3 * 30 * 60_000;
    scheduler.tick(later, { catchUp: true });
    expect(fired).toEqual([
      `[fm-op] scheduled by automation ${record.id} (catch-up - missed while Infinitary was closed; 3 more occurrences folded in): recurring check`,
    ]);
    // The next fire is a full interval from now, not from the missed past.
    expect(store.get(record.id)?.nextFire).toBe(later + 30 * 60_000);
  });

  it("fires a one-shot once and retires it", () => {
    const { scheduler, store, fired } = setup();
    const at = Date.now() + 60_000;
    const record = scheduler.create({ kind: "once", at }, "remind me about the cert");
    scheduler.tick(at + 1);
    scheduler.tick(at + 2);
    expect(fired).toHaveLength(1);
    // It is done while its delivery waits, and never fires a second time.
    expect(store.get(record.id)?.state).toBe("completed");
  });

  it("removes a one-time rule from Automation once Firstmate's turn handled it", () => {
    const db = openInMemoryDatabase();
    const store = new ScheduleStore(db);
    const inbox = new InboxStore(db);
    const events: FmEvent[] = [];
    const scheduler = new Scheduler({
      store,
      notify: (wake, origin) => inbox.enqueue(FIRSTMATE_RECIPIENT, wake, undefined, origin),
      inbox,
      broadcastEvent: (event) => events.push(event),
    });
    const at = Date.now() + 60_000;
    const once = scheduler.create({ kind: "once", at }, "remind me about the cert", true, "Cert");
    scheduler.tick(at + 1);
    // Fired, its prompt still waiting for Firstmate: it stays listed, as done.
    expect(scheduler.rules().map((rule) => [rule.id, rule.state])).toEqual([
      [once.id, "completed"],
    ]);
    const [row] = inbox.allFor(FIRSTMATE_RECIPIENT);
    if (!row) throw new Error("the fire was not delivered");

    scheduler.noteDecision({
      schema: 1,
      decision: "d1",
      startedAt: at + 2,
      endedAt: at + 3,
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
          segments: [{ kind: "wake", origin: "scheduled", length: 1, inboxId: row.id }],
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
    });
    // Handled: the rule and its history leave Automation, and the feed says so.
    expect(scheduler.rules()).toEqual([]);
    expect(scheduler.history(once.id)).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "firstmate_note",
      text: "Automation finished and removed - Cert",
    });
  });

  it("enforces the recurring floor and future one-shots", () => {
    const { scheduler } = setup();
    expect(() => scheduler.create({ kind: "every", minutes: 5 }, "too eager")).toThrow(
      /at most every 15 minutes/,
    );
    expect(() => scheduler.create({ kind: "once", at: Date.now() - 1000 }, "too late")).toThrow(
      /future time/,
    );
    expect(() => scheduler.create({ kind: "every", minutes: 15 }, "  ")).toThrow(/needs a prompt/);
  });

  it("cancels with a feed line and is idempotent", () => {
    const { scheduler, events } = setup();
    const record = scheduler.create({ kind: "every", minutes: 60 }, "hourly check");
    expect(scheduler.cancel(record.id)).toBe(true);
    expect(scheduler.cancel(record.id)).toBe(false);
    const cancelNote = events.filter(
      (event) => event.type === "firstmate_note" && event.text.includes("cancelled"),
    );
    expect(cancelNote).toEqual([
      { type: "firstmate_note", text: "Schedule cancelled - hourly check" },
    ]);
    expect(scheduler.list()).toEqual([]);
  });

  it("runs on the host's ticker and clock: one catch-up at start, then each tick, until stopped", () => {
    const { store } = setup();
    let clock = Date.UTC(2026, 8, 26, 12);
    const fired: string[] = [];
    const scheduler = new Scheduler({
      store,
      notify: (wake) => fired.push(served(wake)),
      broadcastEvent: () => {},
      now: () => clock,
    });
    const record = scheduler.create({ kind: "every", minutes: 30 }, "ticker check", true);
    expect(record.nextFire).toBe(clock + 30 * 60_000);
    const ticker = new Ticker({ now: () => clock, timers: { repeat: () => 0, cancel: () => {} } });

    // Overdue at boot: the catch-up fires once, before any tick.
    clock = record.nextFire + 1;
    scheduler.start(ticker);
    scheduler.start(ticker);
    expect(fired).toEqual([
      `[fm-op] scheduled by automation ${record.id} (catch-up - missed while Infinitary was closed): ticker check`,
    ]);

    clock += 30 * 60_000;
    ticker.tick();
    expect(fired).toHaveLength(2);
    expect(fired[1]).toBe(`[fm-op] scheduled by automation ${record.id}: ticker check`);

    // Stopped, the schedule leaves the ticker; the name is free again.
    scheduler.stop();
    clock += 30 * 60_000;
    ticker.tick();
    expect(fired).toHaveLength(2);
    expect(() => ticker.register("schedules", TICK_PERIOD_MS, () => {})).not.toThrow();
  });
});
