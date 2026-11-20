import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
} from "../../../tests/helpers/crewHarness";
import { DecisionStore } from "../storage/decisionStore";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import { CORRECTION_CASES, CorrectionConsumer } from "./correctionConsumer";
import { CORRECTION_QUESTION } from "./correctionQuestion";
import { CorrectionSources } from "./correctionSources";

/** Intent: the approved detector must not delay ordinary delivery to the
 * current author. Real tab input, durable rows and a live disposable model
 * session cross that boundary while the classifier deliberately stays held. */
fakeCrewTimersEachTest();
describe("correction checks do not hold author delivery", () => {
  it("delivers a genuine tab correction while its question is still unanswered", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Review the current scope",
      intent: intentOf("Review the current scope"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const answer = {
      correction: {
        value: "ordinary" as const,
        outcome: "answered" as const,
        version: CORRECTION_QUESTION.version,
      },
    };
    let release: ((value: typeof answer) => void) | undefined;
    let sourceKey: string | undefined;
    const decide = vi.fn(
      () =>
        new Promise<typeof answer>((resolve) => {
          release = resolve;
        }),
    );
    const consumer = new CorrectionConsumer({
      inbox: h.inbox,
      ledger: new DecisionStore(h.db),
      now: () => Date.now(),
      exists: () => true,
      models: { allowsUse: () => true, decide },
    });
    const sources = new CorrectionSources({
      cards: h.cardStore,
      consumer,
      allowed: () => true,
      task: (id) => h.tasks.get(id),
      project: () => undefined,
    });
    const stop = h.inbox.onEnqueue((row) => {
      if (
        row.recipient === taskId &&
        row.facts?.kind === "crewmate-tab-line" &&
        row.facts.captainText !== undefined
      ) {
        sourceKey = `crew-input:${row.id}`;
        sources.crewmate(
          { kind: "crewmate-tab", key: sourceKey, taskId, inboxId: row.id, at: row.createdAt },
          row.facts.captainText,
        );
      }
    });
    try {
      const text = "For the next 3 reviews, ask before adding scope.";
      expect(await h.supervisor.steer.steerFromCrewmateTab(taskId, text)).toEqual({ ok: true });
      await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(crewmate.steers).toHaveLength(1));
      expect(crewmate.steers[0]?.text).toContain(text);
      expect(h.inbox.allFor(CORRECTION_CASES)).toEqual([]);
      expect(
        h.inbox
          .allFor(FIRSTMATE_RECIPIENT)
          .filter((row) => row.facts?.kind === "correction-review"),
      ).toEqual([]);
      release?.(answer);
      await vi.waitFor(() =>
        expect(sourceKey && new DecisionStore(h.db).correction(sourceKey)?.answer).toEqual(
          answer.correction,
        ),
      );
    } finally {
      stop();
      consumer.dispose();
      release?.(answer);
    }
  });
});
