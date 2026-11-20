import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { type FreezeIncident, freezeWake } from "../freeze/freezeRecorder";
import type { VersionSummary } from "../freeze/freezeTally";
import { idleStallWays } from "../orchestrator/holds";
import { IDLE_NUDGE_TEXT, idleNudge } from "../orchestrator/idleWakes";
import { jobBoundOnce, jobBoundWake } from "../orchestrator/jobWakes";
import {
  CUT_OFF_ONCE_PREFIX,
  cutOffOnce,
  providerBackWake,
  providerCutOffWake,
  stillDownOnce,
  stillDownWake,
} from "../orchestrator/outageWakes";
import {
  laneText,
  laneTurnText,
  RESTART_REPLAY_NOTE,
  renderWake,
  type TypedWake,
} from "../orchestrator/wakes";
import {
  FIRSTMATE_RECIPIENT,
  INBOX_ATTEMPT_MAX,
  INBOX_DEDUPE_WINDOW_MS,
  INBOX_GRACE_MS,
  InboxStore,
  inboxBackoffMs,
  SUPERVISION_RECIPIENT,
} from "./inboxStore";

/** A store on a clock the test moves (the host's one clock, injected). */
function setup(start = Date.now()) {
  const db = freshDatabase();
  const clock = { now: start };
  const now = () => clock.now;
  return { db, clock, now, inbox: new InboxStore(db, { now }) };
}

describe("InboxStore", () => {
  it("retires only obsolete typed requests on the specified lane, preserving prose and unrelated queued work", () => {
    const { db, inbox } = setup();
    inbox.enqueue(FIRSTMATE_RECIPIENT, { facts: { kind: "welcome" } }, "first-run", "scheduled");
    const prose = inbox.enqueue(
      FIRSTMATE_RECIPIENT,
      "a legacy welcome request",
      "first-run",
      "scheduled",
    );
    const other = inbox.enqueue(
      FIRSTMATE_RECIPIENT,
      { facts: { kind: "captain-turn", words: "start a task", imagesDropped: false } },
      "ask",
      "captain",
    );
    const crew = inbox.enqueue("task-1", { facts: { kind: "welcome" } });
    expect(inbox.retireTypedWakes(FIRSTMATE_RECIPIENT, ["welcome"])).toBe(1);
    expect(inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.id)).toEqual([prose, other]);
    expect(inbox.allFor("task-1").map((row) => row.id)).toEqual([crew]);
    expect(inbox.retireTypedWakes(FIRSTMATE_RECIPIENT, ["welcome"])).toBe(0);
    db.close();
  });

  it("invalidates presentation after the transaction, including honest retry, and detaches cleanly", async () => {
    const { db, inbox } = setup();
    const readings: boolean[] = [];
    const detach = inbox.onChange(() =>
      readings.push(inbox.hasDeliverable("task-1", INBOX_ATTEMPT_MAX)),
    );
    const id = inbox.transaction(() => {
      const id = inbox.enqueue("task-1", "Reply captured");
      inbox.markDelivered([id]);
      expect(readings).toEqual([]);
      return id;
    });
    await Promise.resolve();
    expect(readings).toEqual([false]);
    inbox.releaseAfterProviderFailure([id]);
    await Promise.resolve();
    expect(readings).toEqual([false, true]);
    inbox.ack([id]);
    await Promise.resolve();
    expect(readings).toEqual([false, true, false]);
    detach();
    inbox.enqueue("task-1", "Another reply");
    await Promise.resolve();
    expect(readings).toHaveLength(3);
    db.close();
  });

  it("delivers fresh rows immediately and spaces retries by the grace", () => {
    const { inbox } = setup();
    const id = inbox.enqueue("task-1", "do the thing");
    const now = Date.now();
    expect(inbox.pending("task-1", now).map((row) => row.id)).toEqual([id]);

    inbox.markDelivered([id]);
    // In-flight: not pending.
    expect(inbox.pending("task-1", now)).toHaveLength(0);

    inbox.release([id]);
    // Released but inside the grace: still not due.
    expect(inbox.pending("task-1", now)).toHaveLength(0);
    // Past the grace: due again, with the attempt counted.
    const later = now + INBOX_GRACE_MS + 1000;
    const due = inbox.pending("task-1", later);
    expect(due).toHaveLength(1);
    expect(due[0]?.attempts).toBe(1);
  });

  it("ack deletes; the row is gone for good", () => {
    const { inbox } = setup();
    const id = inbox.enqueue(FIRSTMATE_RECIPIENT, "op");
    inbox.markDelivered([id]);
    inbox.ack([id]);
    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(0);
  });

  it("lists the rows a session holds, typed as they were queued, until each is acked", () => {
    const { inbox } = setup();
    const held = inbox.enqueue(FIRSTMATE_RECIPIENT, {
      facts: { kind: "queued-started", task: { id: "t1", title: "Fix" } },
    });
    const waiting = inbox.enqueue(FIRSTMATE_RECIPIENT, "op");
    inbox.enqueue("task-1", "guidance");
    expect(inbox.inFlight(FIRSTMATE_RECIPIENT)).toEqual([]);
    inbox.markDelivered([held]);
    expect(inbox.inFlight(FIRSTMATE_RECIPIENT).map((row) => [row.id, row.facts?.kind])).toEqual([
      [held, "queued-started"],
    ]);
    expect(inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.id)).toEqual([waiting]);
    inbox.ack([held]);
    expect(inbox.inFlight(FIRSTMATE_RECIPIENT)).toEqual([]);
  });

  it("gives a turn a quit or crash cut its attempt back at boot, so repeated quits never spend the ladder", () => {
    const { db, clock, now } = setup();
    let inbox = new InboxStore(db, { now });
    const id = inbox.enqueue("task-1", "Dispatch the release workflow");
    // One more quit than the message has tries, each inside the turn serving it.
    for (let cut = 1; cut <= INBOX_ATTEMPT_MAX + 1; cut += 1) {
      const began = clock.now;
      inbox.markDelivered([id]);
      clock.now += 30_000;
      // A new store over the same database is the next launch.
      inbox = new InboxStore(db, { now });
      expect(inbox.resetInFlight()).toBe(1);
      expect(inbox.allFor("task-1")).toEqual([
        expect.objectContaining({ id, attempts: 0, cuts: cut, escalatedAt: null }),
      ]);
      expect(inbox.spent("task-1", INBOX_ATTEMPT_MAX)).toEqual([]);
      // Still due one grace after the cut attempt began.
      expect(inbox.pending("task-1", began + INBOX_GRACE_MS - 1)).toEqual([]);
      clock.now = began + INBOX_GRACE_MS;
      expect(
        inbox.pending("task-1", clock.now, { maxAttempts: INBOX_ATTEMPT_MAX }).map((row) => row.id),
      ).toEqual([id]);
    }
    // A refusal after the cuts still spends its attempt.
    inbox.markDelivered([id]);
    inbox.release([id]);
    expect(inbox.allFor("task-1")[0]).toMatchObject({ attempts: 1, cuts: INBOX_ATTEMPT_MAX + 1 });
  });

  it("leaves a lane whose turn runs on another computer in flight at boot, its attempt spent", () => {
    const { db, inbox } = setup();
    const here = inbox.enqueue("task-1", "guidance");
    const there = inbox.enqueue("task-2", "guidance");
    inbox.markDelivered([here, there]);
    const fresh = new InboxStore(db);
    expect(fresh.resetInFlight(["task-2"])).toBe(1);
    expect(fresh.allFor("task-1")[0]).toMatchObject({ attempts: 0, cuts: 1 });
    expect(fresh.inFlight("task-2")[0]).toMatchObject({ attempts: 1, cuts: 0 });
  });

  it("opens a cut row's replay with the restart note, and quotes it without one", () => {
    const { db, clock, now, inbox } = setup();
    const cut = inbox.enqueue("task-1", "Dispatch the release workflow");
    inbox.markDelivered([cut]);
    const fresh = new InboxStore(db, { now });
    fresh.resetInFlight();
    fresh.enqueue("task-1", "Also tag the release");
    clock.now += INBOX_GRACE_MS;
    const rows = fresh.pending("task-1", clock.now);
    expect(rows.map((row) => row.cuts)).toEqual([1, 0]);
    expect(laneTurnText(rows)).toBe(
      `${RESTART_REPLAY_NOTE}\n\nDispatch the release workflow\n\nAlso tag the release`,
    );
    expect(laneText(rows)).toBe("Dispatch the release workflow Also tag the release");
  });

  it("starts a reassigned row's ladder over, its cuts included", () => {
    const { db, inbox } = setup();
    const id = inbox.enqueue(SUPERVISION_RECIPIENT, "op");
    inbox.markDelivered([id]);
    const fresh = new InboxStore(db);
    fresh.resetInFlight();
    expect(fresh.reassign([id], FIRSTMATE_RECIPIENT)).toBe(1);
    expect(fresh.allFor(FIRSTMATE_RECIPIENT)[0]).toMatchObject({ attempts: 0, cuts: 0 });
  });

  it("excludes spent rows from task-lane retries and surfaces them once for escalation", () => {
    const { inbox } = setup();
    const id = inbox.enqueue("task-1", "guidance");
    for (let attempt = 0; attempt < INBOX_ATTEMPT_MAX; attempt += 1) {
      inbox.markDelivered([id]);
      inbox.release([id]);
    }
    const later = Date.now() + INBOX_GRACE_MS + 1000;
    // The task lane's budget is spent: no more delivery attempts.
    expect(inbox.pending("task-1", later, { maxAttempts: INBOX_ATTEMPT_MAX })).toHaveLength(0);
    // The firstmate lane has no budget: it keeps waiting at the grace cadence.
    expect(inbox.pending("task-1", later)).toHaveLength(1);
    const spent = inbox.spent("task-1", INBOX_ATTEMPT_MAX);
    expect(spent.map((row) => row.id)).toEqual([id]);
    inbox.markEscalated(id);
    // Escalated once: never again a candidate, for retry or escalation.
    expect(inbox.spent("task-1", INBOX_ATTEMPT_MAX)).toHaveLength(0);
    expect(inbox.pending("task-1", later)).toHaveLength(0);
    // Still on the lane for the teardown notice.
    expect(inbox.allFor("task-1")).toHaveLength(1);
  });

  it("a provider failure spends no attempt and backs off 90 s, 3, 5, 10, then 15 minutes, forever", () => {
    const { inbox, clock } = setup();
    const id = inbox.enqueue("task-1", "the captain's reply");
    const minutes = (n: number) => n * 60_000;
    const waits: number[] = [];
    // Twelve failed turns: far past the three attempts the ladder allows a
    // refusal. The row never escalates and is never spent.
    for (let failure = 1; failure <= 12; failure += 1) {
      const due = inbox.pending("task-1", clock.now, { maxAttempts: INBOX_ATTEMPT_MAX });
      expect(due.map((row) => row.id)).toEqual([id]);
      inbox.markDelivered([id]);
      inbox.releaseAfterProviderFailure([id]);
      const [row] = inbox.allFor("task-1");
      expect(row?.attempts).toBe(0);
      expect(row?.failures).toBe(failure);
      const wait = (row?.nextAttemptAt ?? 0) - clock.now;
      waits.push(wait);
      // Not due a moment before its backoff ends; due the moment it does.
      expect(inbox.pending("task-1", clock.now + wait - 1)).toHaveLength(0);
      clock.now += wait;
    }
    expect(waits).toEqual([
      90_000,
      minutes(3),
      minutes(5),
      minutes(10),
      ...Array.from({ length: 8 }, () => minutes(15)),
    ]);
    expect(inbox.spent("task-1", INBOX_ATTEMPT_MAX)).toEqual([]);
    expect(inboxBackoffMs(500)).toBe(minutes(15));
  });

  it("a spent allowance is not asked again before its reset, however short the backoff", () => {
    const { inbox, clock } = setup();
    const id = inbox.enqueue("task-1", "the captain's reply");
    const resetsAt = clock.now + 2 * 3_600_000;
    inbox.markDelivered([id]);
    inbox.releaseAfterProviderFailure([id], { notBefore: resetsAt });
    // The attempt is not spent, and the failure is counted like any other.
    expect(inbox.allFor("task-1")[0]).toMatchObject({ attempts: 0, failures: 1 });
    // Due at the reset, not at the 90 s backoff.
    expect(inbox.pending("task-1", clock.now + 90_000)).toHaveLength(0);
    expect(inbox.pending("task-1", resetsAt - 1)).toHaveLength(0);
    expect(inbox.pending("task-1", resetsAt).map((row) => row.id)).toEqual([id]);
    // A reset already past leaves the backoff in charge.
    inbox.markDelivered([id]);
    inbox.releaseAfterProviderFailure([id], { notBefore: clock.now - 1 });
    expect(inbox.allFor("task-1")[0]?.nextAttemptAt).toBe(clock.now + inboxBackoffMs(2));
  });

  it("the provider answering ends a lane's outage: every row still backing off is due now", () => {
    const { inbox, clock } = setup();
    const failed = inbox.enqueue("task-1", "first");
    inbox.markDelivered([failed]);
    inbox.releaseAfterProviderFailure([failed]);
    const since = clock.now;
    clock.now = since + 10_000;
    inbox.markDelivered([failed]);
    inbox.releaseAfterProviderFailure([failed]);
    expect(inbox.outage("task-1")).toEqual({ failures: 2, since });
    expect(inbox.outage("task-2")).toEqual({ failures: 0, since: null });
    // Still backing off, and still guidance that will be delivered.
    expect(inbox.pending("task-1", clock.now)).toHaveLength(0);
    expect(inbox.hasDeliverable("task-1", INBOX_ATTEMPT_MAX)).toBe(true);

    inbox.endOutage("task-1");
    expect(inbox.outage("task-1")).toEqual({ failures: 0, since: null });
    expect(inbox.pending("task-1", clock.now).map((row) => row.id)).toEqual([failed]);
  });

  it("says whether a wake about a task still waits on a lane, handed to no turn", () => {
    const { inbox } = setup();
    expect(inbox.holdsUndelivered(FIRSTMATE_RECIPIENT, "t1")).toBe(false);
    const id = inbox.enqueue(FIRSTMATE_RECIPIENT, "idle wake", "t1");
    expect(inbox.holdsUndelivered(FIRSTMATE_RECIPIENT, "t1")).toBe(true);
    expect(inbox.holdsUndelivered(FIRSTMATE_RECIPIENT, "t2")).toBe(false);
    expect(inbox.holdsUndelivered("t1", "t1")).toBe(false);
    // Backing off after a failed turn, it still waits.
    inbox.markDelivered([id]);
    expect(inbox.holdsUndelivered(FIRSTMATE_RECIPIENT, "t1")).toBe(false);
    inbox.releaseAfterProviderFailure([id]);
    expect(inbox.holdsUndelivered(FIRSTMATE_RECIPIENT, "t1")).toBe(true);
    inbox.markDelivered([id]);
    inbox.ack([id]);
    expect(inbox.holdsUndelivered(FIRSTMATE_RECIPIENT, "t1")).toBe(false);
  });

  it("a refusal still spends the ladder, due one grace after its attempt began", () => {
    const { inbox, clock } = setup();
    const id = inbox.enqueue("task-1", "guidance");
    const began = clock.now;
    inbox.markDelivered([id]);
    // A turn that ran long and then failed for a reason the ladder counts.
    clock.now = began + 60_000;
    inbox.release([id]);
    expect(inbox.allFor("task-1")[0]).toMatchObject({ attempts: 1, failures: 0 });
    expect(inbox.pending("task-1", began + INBOX_GRACE_MS - 1)).toHaveLength(0);
    expect(inbox.pending("task-1", began + INBOX_GRACE_MS)).toHaveLength(1);
  });

  it("a steer no turn read goes back due now, its attempt given back", () => {
    const { inbox, clock } = setup();
    const id = inbox.enqueue("task-1", "guidance");
    inbox.markDelivered([id]);
    // The session accepted it, and the turn ended before reading it.
    clock.now += 60_000;
    inbox.reparkUndelivered([id]);
    expect(inbox.allFor("task-1")[0]).toMatchObject({ attempts: 0, failures: 0 });
    expect(inbox.pending("task-1", clock.now).map((row) => row.id)).toEqual([id]);
  });

  it("counts guidance that will still be delivered, never a spent or set-aside row", () => {
    const { inbox } = setup();
    expect(inbox.hasDeliverable("task-1", INBOX_ATTEMPT_MAX)).toBe(false);
    const id = inbox.enqueue("task-1", "guidance");
    expect(inbox.hasDeliverable("task-1", INBOX_ATTEMPT_MAX)).toBe(true);
    // In flight: the turn carrying it is the witness, not the lane.
    inbox.markDelivered([id]);
    expect(inbox.hasDeliverable("task-1", INBOX_ATTEMPT_MAX)).toBe(false);
    inbox.release([id]);
    expect(inbox.hasDeliverable("task-1", INBOX_ATTEMPT_MAX)).toBe(true);
    for (let attempt = 1; attempt < INBOX_ATTEMPT_MAX; attempt += 1) {
      inbox.markDelivered([id]);
      inbox.release([id]);
    }
    expect(inbox.hasDeliverable("task-1", INBOX_ATTEMPT_MAX)).toBe(false);
    inbox.markEscalated(id);
    expect(inbox.hasDeliverable("task-1", INBOX_ATTEMPT_MAX)).toBe(false);
  });

  it("keeps lanes separate and lists recipients holding rows", () => {
    const { inbox } = setup();
    inbox.enqueue(FIRSTMATE_RECIPIENT, "op");
    inbox.enqueue("task-1", "a");
    inbox.enqueue("task-1", "b");
    expect(inbox.recipientsWithRows().sort()).toEqual([FIRSTMATE_RECIPIENT, "task-1"]);
    expect(inbox.pending("task-1").map((row) => row.text)).toEqual(["a", "b"]);
    inbox.deleteFor("task-1");
    expect(inbox.recipientsWithRows()).toEqual([FIRSTMATE_RECIPIENT]);
  });
});

describe("InboxStore wake dedupe by content (WI-3)", () => {
  it("two identical wakes yield one row; a changed payload yields a second", () => {
    const { inbox } = setup();
    const first = inbox.enqueueWake(SUPERVISION_RECIPIENT, "crew-1 reported: plan", "agent", "t1");
    expect(first).not.toBeNull();
    expect(
      inbox.enqueueWake(SUPERVISION_RECIPIENT, "crew-1 reported: plan", "agent", "t1"),
    ).toBeNull();
    expect(inbox.allFor(SUPERVISION_RECIPIENT).map((row) => row.id)).toEqual([first]);

    const second = inbox.enqueueWake(
      SUPERVISION_RECIPIENT,
      "crew-1 reported: fixed",
      "agent",
      "t1",
    );
    expect(second).not.toBeNull();
    expect(inbox.allFor(SUPERVISION_RECIPIENT).map((row) => row.text)).toEqual([
      "crew-1 reported: plan",
      "crew-1 reported: fixed",
    ]);
  });

  it("compares only with the last wake on the same lane and ref", () => {
    const { inbox } = setup();
    inbox.enqueueWake(SUPERVISION_RECIPIENT, "same", "agent", "t1");
    // Another task, another lane, no ref: each is its own last wake.
    expect(inbox.enqueueWake(SUPERVISION_RECIPIENT, "same", "agent", "t2")).not.toBeNull();
    expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, "same", "agent", "t1")).not.toBeNull();
    expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, "same", "agent")).not.toBeNull();
    // A different wake in between makes the repeat new information again.
    inbox.enqueueWake(SUPERVISION_RECIPIENT, "other", "agent", "t1");
    expect(inbox.enqueueWake(SUPERVISION_RECIPIENT, "same", "agent", "t1")).not.toBeNull();
    expect(
      inbox
        .allFor(SUPERVISION_RECIPIENT)
        .filter((row) => row.ref === "t1")
        .map((r) => r.text),
    ).toEqual(["same", "other", "same"]);
  });

  it("dedupes against the newest acked wake only inside the window", () => {
    const { inbox, clock } = setup(1_000_000);
    const id = inbox.enqueueWake(SUPERVISION_RECIPIENT, "stale self-brief", "agent", "t1") ?? 0;
    inbox.markDelivered([id]);
    inbox.ack([id]);

    clock.now = 1_000_000 + INBOX_DEDUPE_WINDOW_MS - 1;
    expect(inbox.enqueueWake(SUPERVISION_RECIPIENT, "stale self-brief", "agent", "t1")).toBeNull();

    clock.now = 1_000_000 + INBOX_DEDUPE_WINDOW_MS + 1;
    expect(
      inbox.enqueueWake(SUPERVISION_RECIPIENT, "stale self-brief", "agent", "t1"),
    ).not.toBeNull();
  });

  it("a newer live row outranks an older acked one", () => {
    const { inbox } = setup();
    const a = inbox.enqueueWake(SUPERVISION_RECIPIENT, "A", "agent", "t1") ?? 0;
    inbox.ack([a]);
    inbox.enqueueWake(SUPERVISION_RECIPIENT, "B", "agent", "t1");
    // The last wake is the pending B, so A is new again.
    expect(inbox.enqueueWake(SUPERVISION_RECIPIENT, "A", "agent", "t1")).not.toBeNull();
    // And an acked B is newer than the acked A.
    const rows = inbox.allFor(SUPERVISION_RECIPIENT);
    inbox.ack(rows.map((row) => row.id));
    expect(inbox.enqueueWake(SUPERVISION_RECIPIENT, "A", "agent", "t1")).toBeNull();
    expect(inbox.enqueueWake(SUPERVISION_RECIPIENT, "B", "agent", "t1")).not.toBeNull();
  });

  it("dedupes content, never delivery: resetInFlight still redelivers a never-acked row", () => {
    const { db, inbox } = setup();
    const id = inbox.enqueueWake(SUPERVISION_RECIPIENT, "crew-1 reported", "agent", "t1") ?? 0;
    inbox.markDelivered([id]);
    // The same wake while its row is in flight is not a second event.
    expect(inbox.enqueueWake(SUPERVISION_RECIPIENT, "crew-1 reported", "agent", "t1")).toBeNull();
    // The process dies before the ack: the boot sweep re-presents that row.
    const fresh = new InboxStore(db);
    expect(fresh.resetInFlight()).toBe(1);
    const later = Date.now() + INBOX_GRACE_MS + 1000;
    const due = fresh.pending(SUPERVISION_RECIPIENT, later);
    expect(due.map((row) => row.id)).toEqual([id]);
    expect(due[0]).toMatchObject({ attempts: 0, cuts: 1 });
  });

  it("plain enqueue always records: steers and briefs are acts, not wakes", () => {
    const { inbox } = setup();
    const first = inbox.enqueue("task-1", "continue");
    const second = inbox.enqueue("task-1", "continue");
    expect(second).not.toBe(first);
    expect(inbox.allFor("task-1")).toHaveLength(2);
    // A wake after them still dedupes against the lane's newest row.
    expect(inbox.enqueueWake("task-1", "continue", "agent")).toBeNull();
  });

  /**
   * Replay (Sep 14, crewmate ba13eadd). Before WI-1 every prompt end woke
   * supervision with the crewmate's last non-empty text, so the session
   * fixture's twelve prompt ends produced twelve wakes: the self-brief five
   * times over (its own turn plus four empty-text job-result turns), then
   * the garbage text seven times. WI-1 already stops the empty-text wakes at
   * the source; this proves the store collapses such a storm on its own -
   * both while the wakes pile up and when supervision acks each before the
   * next arrives, as it did that night.
   */
  describe("replay: crewmate ba13eadd's wake storm", () => {
    type Line =
      | { type: "session" }
      | { type: "replay_control"; timestamp: string }
      | {
          type: "message";
          timestamp: string;
          message: { role: string; content: string | Array<{ type: string; text?: string }> };
        };

    function preWi1Wakes(): { at: number; payload: string }[] {
      const url = new URL(
        "../../../tests/fixtures/replay/sep14/crewmates/ba13eadd/sessions/2026-09-14T02-18-13-396Z_ba13eadd.jsonl",
        import.meta.url,
      );
      const lines = readFileSync(url, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Line);
      const wakes: { at: number; payload: string }[] = [];
      let lastCompleteText = "";
      let turnText = "";
      for (const [index, line] of lines.entries()) {
        if (line.type === "replay_control") break;
        if (line.type !== "message" || line.message.role !== "assistant") continue;
        const { content } = line.message;
        if (Array.isArray(content)) {
          for (const part of content) if (part.type === "text") turnText += part.text ?? "";
        }
        const next = lines.slice(index + 1).find((entry) => entry.type !== "session");
        const promptEnds = next?.type !== "message" || next.message.role === "user";
        if (!promptEnds) continue;
        if (turnText.trim()) lastCompleteText = turnText;
        turnText = "";
        wakes.push({
          at: Date.parse(line.timestamp),
          payload: `[fm-op] crew-1 reported on task ba13eadd "Replay": ${lastCompleteText}`,
        });
      }
      return wakes;
    }

    it.each([
      ["piling up on the lane", false],
      ["acked by supervision before the next arrives", true],
    ])("the repeated self-brief wakes become one while %s", (_label, drain) => {
      const { inbox, clock } = setup();
      const recorded: string[] = [];
      for (const wake of preWi1Wakes()) {
        clock.now = wake.at;
        const id = inbox.enqueueWake(SUPERVISION_RECIPIENT, wake.payload, "agent", "ba13eadd");
        if (id === null) continue;
        recorded.push(wake.payload);
        if (drain) {
          inbox.markDelivered([id]);
          inbox.ack([id]);
        }
      }
      expect(recorded.filter((payload) => payload.includes("Self-brief"))).toHaveLength(1);
      expect(recorded).toHaveLength(2);
    });
  });
});

describe("the typed wake envelope (the primitives review, P3)", () => {
  const stall = (idleMs: number): TypedWake => ({
    facts: {
      kind: "idle-stall",
      task: { id: "t1", title: "Job" },
      crewmate: "crewmate 1",
      key: "FI3-1",
      idleMs,
      thread: false,
      nudged: true,
      wakes: 1,
    },
    ways: idleStallWays("t1"),
  });

  it("a typed wake reads back as its facts and ways, prose as its text, each with its columns", () => {
    const { inbox } = setup();
    inbox.enqueue(FIRSTMATE_RECIPIENT, stall(20 * 60_000), "t1", "agent");
    inbox.enqueue(FIRSTMATE_RECIPIENT, "[fm-op] a background job finished", undefined, "agent");
    inbox.enqueue("t1", idleNudge());
    expect(
      [...inbox.allFor(FIRSTMATE_RECIPIENT), ...inbox.allFor("t1")].map(
        ({ v, origin, ref, facts, ways, text }) => ({ v, origin, ref, facts, ways, text }),
      ),
    ).toEqual([
      { v: 1, origin: "agent", ref: "t1", ...stall(20 * 60_000), text: undefined },
      {
        v: 1,
        origin: "agent",
        ref: null,
        facts: undefined,
        ways: undefined,
        text: "[fm-op] a background job finished",
      },
      { v: 1, origin: null, ref: null, ...idleNudge(), ways: undefined, text: undefined },
    ]);
    // What the drain serves from the row is what the body renders to.
    const [typed] = inbox.allFor(FIRSTMATE_RECIPIENT);
    expect(typed && renderWake(typed)).toBe(renderWake(stall(20 * 60_000)));
    expect(inbox.allFor("t1").map(renderWake)).toEqual([IDLE_NUDGE_TEXT]);
  });

  it("a typed wake dedupes by its origin, ref and facts, never by how they were built", () => {
    const { inbox } = setup();
    const first = inbox.enqueueWake(FIRSTMATE_RECIPIENT, stall(60_000), "agent", "t1");
    expect(first).not.toBeNull();
    // The same facts, built in another key order: the same wake.
    const { facts, ways } = stall(60_000);
    const reordered = Object.fromEntries(Object.entries(facts).reverse()) as typeof facts;
    expect(
      inbox.enqueueWake(FIRSTMATE_RECIPIENT, { facts: reordered, ways }, "agent", "t1"),
    ).toBeNull();
    // Another origin or another ref is its own last wake.
    expect(
      inbox.enqueueWake(FIRSTMATE_RECIPIENT, stall(60_000), "supervision", "t1"),
    ).not.toBeNull();
    expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, stall(60_000), "agent", "t2")).not.toBeNull();
    // A changed fact is new information.
    expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, stall(120_000), "agent", "t2")).not.toBeNull();
    expect(inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => [row.origin, row.ref])).toEqual([
      ["agent", "t1"],
      ["supervision", "t1"],
      ["agent", "t2"],
      ["agent", "t2"],
    ]);
  });

  describe("a wake that goes out once per fact (migration 49)", () => {
    const task = { id: "t1", title: "Fix", key: "SCR-1", crewmate: "crewmate 1" };
    /** The still-down wake of the outage that began at `since`, `downMs` in. */
    const stillDown = (since: number, downMs: number) =>
      stillDownWake(task, { since, failures: 4 }, since + downMs);

    it("is queued once for its name, whatever else happens on the lane", () => {
      const { db, inbox, clock, now } = setup(1_000_000);
      const id = inbox.enqueueWake(FIRSTMATE_RECIPIENT, stillDown(0, 900_000), "agent", "t1");
      expect(id).not.toBeNull();
      expect(inbox.woken("t1", stillDownOnce(0))).toBe(true);
      // Later measurements of the same outage are the same once.
      expect(
        inbox.enqueueWake(FIRSTMATE_RECIPIENT, stillDown(0, 960_000), "agent", "t1"),
      ).toBeNull();
      // An intervening wake on the same task, then the ack, then long after.
      inbox.enqueueWake(FIRSTMATE_RECIPIENT, "[fm-op] t1 reported.", "agent", "t1");
      inbox.markDelivered([id ?? 0]);
      inbox.ack(inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.id));
      clock.now = 1_000_000 + INBOX_DEDUPE_WINDOW_MS * 12;
      expect(
        inbox.enqueueWake(FIRSTMATE_RECIPIENT, stillDown(0, 3_600_000), "agent", "t1"),
      ).toBeNull();
      // A new store over the same database (a restart) reads the same record.
      const restarted = new InboxStore(db, { now });
      expect(restarted.woken("t1", stillDownOnce(0))).toBe(true);
      expect(
        restarted.enqueueWake(FIRSTMATE_RECIPIENT, stillDown(0, 4_000_000), "agent", "t1"),
      ).toBeNull();
      expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual([]);
    });

    it("allows one alpha freeze summary per installed version after ack, dismissal and restart (INF-2205)", () => {
      const { db, inbox, clock, now } = setup();
      const project = { id: "infinitary", name: "Infinitary" };
      const interrupted = {
        incidentId: "native-wait",
        status: "interrupted" as const,
        at: "2026-10-31T07:12:04.512Z",
      };
      // A version's summary as the next version's first start sends it (INF-3044).
      const summary = (version: string, example: FreezeIncident): VersionSummary => ({
        version,
        runs: 1,
        runningMs: 60_000,
        stalls: "wallMs" in example ? 1 : 0,
        stallMs: "wallMs" in example ? example.wallMs : 0,
        cpuMs: "wallMs" in example ? example.cpuMs : 0,
        interrupted: "wallMs" in example ? 0 : 1,
        locations: [],
        example,
      });
      const wake = freezeWake(summary("0.6.2-alpha.44", interrupted), project);
      const id = inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, "scheduled");
      expect(id).not.toBeNull();
      inbox.markDelivered([id ?? 0]);
      inbox.ack([id ?? 0]);
      // Closing an offer has no authority over inbox_once. Intervening captain
      // activity and time beyond content dedupe likewise cannot reset it.
      inbox.enqueue(FIRSTMATE_RECIPIENT, "Captain dismissed the freeze offer", "agent");
      clock.now += INBOX_DEDUPE_WINDOW_MS * 12;
      const restarted = new InboxStore(db, { now });
      const another = {
        at: interrupted.at,
        wallMs: 1020,
        cpuMs: 986,
        frames: [{ name: "taskIdsWithRef", file: "index.js", line: 48213, column: 22 }],
      };
      expect(
        restarted.enqueueWake(
          FIRSTMATE_RECIPIENT,
          freezeWake(summary("0.6.2-alpha.44", another), project),
          "scheduled",
        ),
      ).toBeNull();
      expect(
        restarted.enqueueWake(
          FIRSTMATE_RECIPIENT,
          freezeWake(summary("0.6.2-alpha.45", another), project),
          "scheduled",
        ),
      ).not.toBeNull();
    });

    it("another outage, another job or another task is its own once", () => {
      const { inbox } = setup();
      const job = { jobId: "poll-1", command: "gh run watch", startedAt: 5 };
      const wakes: [TypedWake, string][] = [
        [stillDown(0, 900_000), "t1"],
        [stillDown(2_000_000, 900_000), "t1"],
        [stillDown(0, 900_000), "t2"],
        [jobBoundWake(task, job, 7_200_005), "t1"],
        [jobBoundWake(task, { ...job, jobId: "poll-2" }, 7_200_005), "t1"],
      ];
      for (const [wake, ref] of wakes) {
        expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, "agent", ref)).not.toBeNull();
      }
      expect(
        inbox.enqueueWake(FIRSTMATE_RECIPIENT, jobBoundWake(task, job, 9e6), "agent", "t1"),
      ).toBeNull();
      expect(inbox.woken("t1", jobBoundOnce(job))).toBe(true);
      expect(inbox.woken("t2", jobBoundOnce(job))).toBe(false);
    });

    it("an account's cut-off and its end go out once each, and the cut-offs heard are read back", () => {
      const { db, inbox, now } = setup();
      const account = { id: "acct_claude", provider: "Claude" };
      const tasks = [{ id: "t1", title: "Fix" }];
      const cutOff = (since: number) =>
        providerCutOffWake(account, { class: "refused", since }, tasks);
      expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, cutOff(5), "agent")).not.toBeNull();
      expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, cutOff(5), "agent")).toBeNull();
      expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, cutOff(9), "agent")).not.toBeNull();
      const back = providerBackWake(account, 9, tasks);
      expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, back, "agent")).not.toBeNull();
      expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, back, "agent")).toBeNull();
      // A task closing does not forget an account's facts.
      inbox.purgeTask("t1");
      const restarted = new InboxStore(db, { now });
      expect(restarted.wokenNames("", CUT_OFF_ONCE_PREFIX)).toEqual([
        cutOffOnce("acct_claude", 5),
        cutOffOnce("acct_claude", 9),
      ]);
      expect(restarted.woken("", back.once ?? "")).toBe(true);
      // The prefix is a prefix, never a pattern: an account id with LIKE
      // wildcards in it names only itself.
      expect(restarted.wokenNames("", `${CUT_OFF_ONCE_PREFIX}acct%`)).toEqual([]);
    });

    it("a host steer that names one records it with its row, and always inserts", () => {
      const { inbox } = setup();
      const settled: TypedWake & { once: string } = {
        facts: { kind: "checks-settled", outcome: "passed", head: "cafe0001", count: 2 },
        once: "check-watch:cafe0001:0",
      };
      expect(inbox.woken("t1", settled.once)).toBe(false);
      const id = inbox.enqueueSteerOnce("t1", settled);
      expect(inbox.woken("t1", settled.once)).toBe(true);
      expect(inbox.allFor("t1").map((row) => row.id)).toEqual([id]);
      // A steer is the host's act: it inserts, and the emitter reads `woken` first.
      expect(inbox.enqueueSteerOnce("t1", settled)).toBeGreaterThan(id);
      inbox.purgeTask("t1");
      expect(inbox.woken("t1", settled.once)).toBe(false);
    });

    it("plain enqueue never reads or records it, and a task purge forgets it", () => {
      const { inbox } = setup();
      inbox.enqueue(FIRSTMATE_RECIPIENT, stillDown(0, 900_000), "t1", "agent");
      expect(inbox.woken("t1", stillDownOnce(0))).toBe(false);
      expect(
        inbox.enqueueWake(FIRSTMATE_RECIPIENT, stillDown(0, 960_000), "agent", "t1"),
      ).not.toBeNull();
      expect(inbox.woken("t1", stillDownOnce(0))).toBe(true);
      inbox.purgeTask("t1");
      expect(inbox.woken("t1", stillDownOnce(0))).toBe(false);
    });
  });
});
