import { expect, it } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { DecisionStore } from "../storage/decisionStore";
import { servedSlots } from "./router";

// INF-2186: the board's tier read decoded every historical routing decision.
it("reads only the latest chosen slot per requested task, not its routing history", () => {
  const db = freshDatabase();
  const decisions = new DecisionStore(db);
  const taskIds = ["waits", "places"];
  const served = "medium" as const;
  try {
    for (let turn = 0; turn < 40; turn += 1)
      for (const taskId of taskIds)
        decisions.recordRouting({
          taskId,
          provider: "openai-codex",
          model: "gpt-6.1-sol",
          bucket: "high",
          served,
          rule: "R8",
          reasons: ["Serve the task at its available slot."],
        });
    // A later attempt that chose nothing did not change what the crewmate was served.
    for (const taskId of taskIds)
      decisions.recordRouting({
        taskId,
        provider: null,
        model: null,
        bucket: "high",
        served: null,
        rule: "R8",
        reasons: ["No eligible account."],
      });
    let slots: ReturnType<typeof servedSlots> = new Map();
    const reads = rowsRead(db, () => {
      slots = servedSlots(decisions, [...taskIds, "never-routed"]);
    });
    expect(slots).toEqual(new Map(taskIds.map((id) => [id, served])));
    console.info(
      JSON.stringify({ intent: "INF-2186 served slots", histories: 40, reads, slots: [...slots] }),
    );
    expect(reads).toBe(slots.size);
  } finally {
    db.close();
  }
});
