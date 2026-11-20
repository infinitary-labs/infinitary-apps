import { describe, expect, it } from "vitest";
import { fakeCrewmate, fakeCrewTimersEachTest, setup } from "../../../tests/helpers/crewHarness";
import { CORRECTION_CASES, CorrectionConsumer } from "../decisions/correctionConsumer";
import { CORRECTION_QUESTION } from "../decisions/correctionQuestion";
import { DecisionStore } from "../storage/decisionStore";

/** Intent: the accepted restart guarantee keeps a pending correction on its
 * own durable owner; generic task recovery must neither consume nor delete it.
 * The actual inbox, decision receipt and crew sweep exercise that boundary. */
fakeCrewTimersEachTest();
describe("service-owned inbox lanes", () => {
  it("preserves the positive case through both the boot sweep and a direct lane sweep", async () => {
    const h = setup(fakeCrewmate());
    const consumer = new CorrectionConsumer({
      inbox: h.inbox,
      ledger: new DecisionStore(h.db),
      now: () => Date.now(),
      exists: () => true,
      models: {
        allowsUse: () => true,
        decide: async () => ({
          correction: {
            value: "review",
            outcome: "answered",
            version: CORRECTION_QUESTION.version,
          },
        }),
      },
    });
    try {
      consumer.enqueue(
        {
          key: "ask:pending-project-rule",
          kind: "composer",
          askId: "pending-project-rule",
          at: Date.now(),
        },
        { facts: { latest_captain_reply: "For the next 3 reviews, ask before adding scope." } },
      );
      await consumer.drain();
      const before = h.inbox.allFor(CORRECTION_CASES);
      expect(before).toHaveLength(1);
      await h.supervisor.watch.sweepInbox(Date.now());
      expect(h.inbox.allFor(CORRECTION_CASES)).toEqual(before);
      await h.supervisor.watch.sweepTaskLane(CORRECTION_CASES, Date.now());
      expect(h.inbox.allFor(CORRECTION_CASES)).toEqual(before);
      expect(h.tasks.list()).toEqual([]);
    } finally {
      consumer.dispose();
    }
  });
});
