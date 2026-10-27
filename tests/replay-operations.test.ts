import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { replaySession } from "../scripts/replay/engine";
import { discoverSources } from "../scripts/replay-captain-session";

// INF-1430 piece 2: reconstruct the first mate's nine operation declarations,
// not a live-model score. Real host owners must keep code chores as changes.
it("replays the nine operations as effects and keeps chores as changes", async () => {
  const root = "tests/fixtures/operations-deliverable";
  const cases = JSON.parse(readFileSync(join(root, "cases.json"), "utf8")) as {
    source: string;
    title: string;
    operation: boolean;
  }[];
  const result = await replaySession(discoverSources({ name: "operations-deliverable", root }));
  expect(result.fidelity).toMatchObject({
    recorded_captain_turns: cases.length,
    replayed_captain_turns: cases.length,
    missing_tools: [],
    settle_timeouts: 0,
  });
  for (const item of cases) {
    const task = result.details.task_shapes.find((task) => task.title === item.title);
    expect(task, item.source).toMatchObject({
      deliverable: item.operation ? "operation" : "change",
    });
    if (item.operation) expect(task?.kind).toBe("unclear");
  }
});
