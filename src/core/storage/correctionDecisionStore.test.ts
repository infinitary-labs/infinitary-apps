import { createHash, randomUUID } from "node:crypto";
import { type DecisionAnswer, decisionAnswerSchema } from "@shared/decisions";
import { afterEach, describe, expect, it } from "vitest";
import { CORRECTION_QUESTION } from "../decisions/correctionQuestion";
import { failedAnswer, questionVersion } from "../decisions/decisionModel";
import { type AppDatabase, openInMemoryDatabase } from "./db";
import { type CorrectionDecisionInput, DecisionStore } from "./decisionStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "./inboxStore";

/**
 * Intent: the approved correction-retention plan requires source-keyed result
 * reuse, no task per composer reply, and result/wake/ack atomicity. Disposable
 * SQLite databases and ordinary typed model receipts exercise that storage
 * boundary; these tests do not simulate or claim classifier accuracy.
 */
const databases: AppDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = openInMemoryDatabase();
  databases.push(db);
  const ledger = new DecisionStore(db);
  const inbox = new InboxStore(db);
  const sourceKey = `ask:${randomUUID()}`;
  const version = questionVersion(CORRECTION_QUESTION, CORRECTION_QUESTION.instructions);
  const answer = decisionAnswerSchema.parse({
    value: "review",
    outcome: "answered",
    source: "jev/disposable-test-model",
    version,
  });
  const input: CorrectionDecisionInput = {
    sourceKey,
    at: 1_000,
    questionId: "correction",
    stateSha: createHash("sha256")
      .update(JSON.stringify({ latest_captain_reply: "Keep the proposed scope unchanged." }))
      .digest("hex"),
    answer,
  };
  return { db, ledger, inbox, input, version };
}

function tasksCount(db: AppDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
}

describe("correction receipts in the existing decision ledger", () => {
  it("retains the first result for the same source without creating a task", () => {
    const h = fixture();
    const before = tasksCount(h.db);
    const recorded = h.ledger.recordCorrection({
      ...h.input,
      // An unconstrained provider explanation can echo input; it is not a receipt fact.
      answer: { ...h.input.answer, detail: "Keep the proposed scope unchanged." },
    });
    expect(recorded).toMatchObject(h.input);
    expect(recorded.answer).not.toHaveProperty("detail");
    expect(recorded.taskId).toBeUndefined();
    const later: DecisionAnswer = { ...h.input.answer, value: "ordinary" };
    expect(h.ledger.recordCorrection({ ...h.input, answer: later, at: 2_000 })).toEqual(recorded);
    expect(new DecisionStore(h.db).correction(h.input.sourceKey)).toEqual(recorded);
    expect(tasksCount(h.db)).toBe(before);
    expect(h.ledger.correction(`ask:${randomUUID()}`)).toBeUndefined();
  });

  it("also retains abstentions and failures rather than losing a quiet result", () => {
    const h = fixture();
    const failed = failedAnswer(CORRECTION_QUESTION, "no-model", h.version);
    const recorded = h.ledger.recordCorrection({ ...h.input, answer: failed });
    expect(recorded.answer).toEqual(failed);
    expect(h.ledger.recordCorrection(h.input)).toEqual(recorded);
    const other = h.ledger.recordCorrection({
      ...h.input,
      sourceKey: `card:${randomUUID()}`,
      answer: { ...h.input.answer, value: "unclear", outcome: "abstained" },
    });
    expect(other.id).not.toBe(recorded.id);
    expect(other.answer.outcome).toBe("abstained");
  });

  it("commits the result, existing inbox wake and input acknowledgement together", () => {
    const h = fixture();
    const recipient = "correction-receipt-test";
    const inputId = h.inbox.enqueue(recipient, JSON.stringify({ sourceKey: h.input.sourceKey }));
    h.inbox.markDelivered([inputId]);
    expect(() =>
      h.ledger.transaction(() => {
        h.ledger.recordCorrection(h.input);
        h.inbox.enqueue(FIRSTMATE_RECIPIENT, "Review this candidate.", h.input.sourceKey);
        h.inbox.ack([inputId]);
        throw new Error("Stop before the transaction commits");
      }),
    ).toThrow("Stop before the transaction commits");
    expect(h.ledger.correction(h.input.sourceKey)).toBeUndefined();
    expect(h.inbox.get(inputId)).toBeDefined();
    expect(h.inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual([]);

    h.ledger.transaction(() => {
      h.ledger.recordCorrection(h.input);
      h.inbox.enqueue(FIRSTMATE_RECIPIENT, "Review this candidate.", h.input.sourceKey);
      h.inbox.ack([inputId]);
    });
    expect(h.ledger.correction(h.input.sourceKey)?.answer).toEqual(h.input.answer);
    expect(h.inbox.get(inputId)).toBeUndefined();
    expect(h.inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(1);
  });
});
