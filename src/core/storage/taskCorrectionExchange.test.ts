import { describe, expect, it } from "vitest";
import { fakeCrewmate, fakeCrewTimersEachTest, setup } from "../../../tests/helpers/crewHarness";
import { seedTask } from "../tasks/seedTask";
import { TaskEventStore } from "./taskEventStore";

/** Intent: the accepted detector receives meaningful source-time exchange,
 * not a typed program result or a report falsely paired after a later steer.
 * Real saved event readings own chronology and original-caption provenance. */
fakeCrewTimersEachTest();
function fixture() {
  const h = setup(fakeCrewmate());
  seedTask(h.tasks, { id: "review", title: "Review the current scope", status: "running" });
  return new TaskEventStore(h.db);
}
const captain = "For the next 3 reviews, ask before adding scope.";
const report = "I reviewed the proposed scope and found two changes to discuss.";
describe("source-time task exchange", () => {
  it("keeps an earlier plain report before the later original captain input", () => {
    const events = fixture();
    events.insert({ taskId: "review", at: 1_000, kind: "report", actor: "crewmate", text: report });
    events.insert({
      taskId: "review",
      at: 1_000,
      kind: "steered",
      actor: "captain",
      text: "Decorated delivery words",
      captainText: captain,
    });
    expect(events.originalCaptainExchange("review")).toEqual({
      preceding: [
        { who: "author", text: report },
        { who: "captain", text: captain },
      ],
      unavailableContext: false,
    });
  });
  it("keeps a later plain report after its preceding captain input", () => {
    const events = fixture();
    events.insert({
      taskId: "review",
      at: 1_000,
      kind: "steered",
      actor: "captain",
      text: "Decorated delivery words",
      captainText: captain,
    });
    events.insert({ taskId: "review", at: 1_000, kind: "report", actor: "crewmate", text: report });
    expect(events.originalCaptainExchange("review")).toEqual({
      preceding: [
        { who: "captain", text: captain },
        { who: "author", text: report },
      ],
      unavailableContext: false,
    });
  });
  it("does not reconstruct a legacy caption from delivered words", () => {
    const events = fixture();
    events.insert({
      taskId: "review",
      at: 1_000,
      kind: "steered",
      actor: "captain",
      text: "Legacy delivery may include attached file text.",
    });
    events.insert({ taskId: "review", at: 1_000, kind: "report", actor: "crewmate", text: report });
    expect(events.originalCaptainExchange("review")).toEqual({
      preceding: [{ who: "author", text: report }],
      unavailableContext: true,
    });
  });
});
