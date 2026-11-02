import { expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { DecisionStore } from "./decisionStore";

// INF-2186, captain's supervisionLog/recent context freeze: seeking the
// newest outcomes must not sort the whole retained decision ledger first.
it("seeks the newest supervision outcomes without sorting retained history", () => {
  const db = freshDatabase();
  const decisions = new DecisionStore(db);
  try {
    const ids: number[] = [];
    for (let turn = 0; turn < 20; turn += 1) {
      ids.push(
        decisions.recordSort({
          taskId: "refresh-fix",
          wake: "report",
          verdict: "captain",
          summary: "The completed check needs the captain's answer.",
        }),
      );
      decisions.recordRouting({
        taskId: "refresh-fix",
        provider: "openai-codex",
        model: "gpt-6.1-sol",
        bucket: "high",
        served: "medium",
        rule: "R8",
        reasons: ["Use the available model for the work."],
      });
    }
    const count = 5;
    const prepare = vi.spyOn(db, "prepare");
    let query: string | undefined;
    try {
      expect(decisions.recent(count).map((row) => row.id)).toEqual(ids.slice(-count).reverse());
      query = prepare.mock.calls[0]?.[0];
    } finally {
      prepare.mockRestore();
    }
    if (!query) throw new Error("The outcome read prepared no query");
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(count) as { detail: string }[];
    console.info(
      JSON.stringify({
        intent: "INF-2186 recent supervision outcomes",
        plan: plan.map((row) => row.detail),
      }),
    );
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
  } finally {
    db.close();
  }
});
