import type { DecisionAnswer } from "@shared/decisions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppDatabase, openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { SettingsStore } from "../storage/settingsStore";
import { CORRECTION_CASES, CORRECTION_QUESTIONS, CorrectionConsumer } from "./correctionConsumer";
import { CORRECTION_QUESTION, correctionState } from "./correctionQuestion";
import { DecisionModels, type DecisionRun } from "./decisionModel";

/** Intent: approved decision-only delivery is asynchronous, source-keyed and
 * review-only. Real SQLite/settings/DecisionModels consume disposable typed
 * provider receipts; these tests prove protocol behavior, not recognition. */
const dbs: AppDatabase[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const db of dbs.splice(0)) db.close();
});
function fixture(receipt: DecisionAnswer, hold = false) {
  const db = openInMemoryDatabase();
  dbs.push(db);
  const settings = new SettingsStore(db);
  const grant = (enabled: boolean) => settings.setDecisionUses({ "reply-checks": { on: enabled } });
  let resolve: ((run: DecisionRun) => void) | undefined;
  const decide = vi.fn(async () =>
    hold
      ? new Promise<DecisionRun>((done) => {
          resolve = done;
        })
      : { answers: { correction: receipt }, usage: [] },
  );
  const models = new DecisionModels({
    settings,
    adapted: { id: "fixture", native: false, decide },
  });
  const inbox = new InboxStore(db, { now: () => 1_000 });
  const ledger = new DecisionStore(db);
  const options = { inbox, ledger, models, exists: () => true, now: () => 1_000 };
  const consumer = new CorrectionConsumer(options);
  stops.push(() => consumer.dispose());
  const state = correctionState(
    {
      latestReply: "For the next 3 reviews, keep the scope unchanged.",
      preceding: [],
      unavailableContext: false,
    },
    12_000,
  );
  if (!state) throw new Error("The ordinary source fixture does not fit.");
  const source = {
    key: "ask:source-one",
    kind: "composer" as const,
    askId: "source-one",
    at: 1_000,
  };
  return {
    db,
    inbox,
    ledger,
    models,
    consumer,
    options,
    decide,
    state,
    source,
    grant,
    release: () => resolve?.({ answers: { correction: receipt }, usage: [] }),
  };
}
const review: DecisionAnswer = {
  value: "review",
  outcome: "answered",
  version: CORRECTION_QUESTION.version,
  source: "fixture/model",
};

describe("durable correction consumer", () => {
  it("records one result and a typed review wake, and reuses it after a restart", async () => {
    const h = fixture(review);
    h.consumer.enqueue(h.source, h.state);
    h.consumer.enqueue(h.source, h.state);
    await h.consumer.drain();
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.ledger.correction(h.source.key)?.answer).toEqual(review);
    expect(h.inbox.allFor(CORRECTION_QUESTIONS)).toEqual([]);
    const cases = h.inbox.allFor(CORRECTION_CASES);
    expect(cases).toHaveLength(1);
    expect(h.inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.facts)).toEqual([
      { kind: "correction-review", source: h.source, inputId: cases[0]?.id },
    ]);
    h.consumer.dispose();
    const restarted = new CorrectionConsumer(h.options);
    stops.push(() => restarted.dispose());
    restarted.enqueue(h.source, h.state);
    await restarted.drain();
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(1);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(0);
  });

  it.each<DecisionAnswer>([
    { ...review, value: "ordinary" },
    { ...review, value: "unclear", outcome: "abstained" },
    { ...review, value: "unclear", outcome: "failed", reason: "provider" },
  ])(
    "quietly records $outcome/$value without a first-mate event or fallback duty",
    async (answer) => {
      const h = fixture(answer);
      h.consumer.enqueue(h.source, h.state);
      await h.consumer.drain();
      expect(h.ledger.correction(h.source.key)?.answer).toEqual(answer);
      expect(h.inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual([]);
      expect(h.inbox.allFor(CORRECTION_CASES)).toEqual([]);
    },
  );

  it("does not dispatch unapproved data or revive a withdrawn in-flight reply after a new grant", async () => {
    const h = fixture(review, true);
    h.grant(false);
    h.consumer.enqueue(h.source, h.state);
    expect(h.inbox.allFor(CORRECTION_QUESTIONS)).toEqual([]);
    expect(h.decide).not.toHaveBeenCalled();
    h.grant(true);
    h.consumer.enqueue(h.source, h.state);
    const running = h.consumer.drain();
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalledTimes(1));
    h.grant(false);
    h.consumer.withdraw();
    h.grant(true);
    h.release();
    await running;
    expect(h.inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual([]);
    expect(h.inbox.allFor(CORRECTION_QUESTIONS)).toEqual([]);
    expect(h.ledger.correction(h.source.key)).toBeUndefined();
  });
});
