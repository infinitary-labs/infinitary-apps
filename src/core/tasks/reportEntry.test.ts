import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { reportEntryOf } from "./reportEntry";
import { seedTask } from "./seedTask";
import { queryTasks } from "./taskQuery";
import { TaskService } from "./taskService";

// INF-1296 piece 1 (plan B): a report and the result it carried live on the
// report's entry alone, and the captain's "existing users don't get
// regressed": a result an older release kept on the task's delivery facts
// still reads, with the precedence it had, until a later report carries one.

const T0 = Date.parse("2026-10-20T16:00:00.000Z");

function setup() {
  const db = openInMemoryDatabase();
  let at = T0;
  const tasks = new TaskService({ db, strict: true, now: () => (at += 1_000) });
  seedTask(tasks, { id: "finder", title: "Find the flaky journeys", status: "idle" });
  /** What a release before this one wrote beside each result: a copy on the delivery facts. */
  const asOlderRelease = (value: Record<string, unknown>, when: number, id = "finder") =>
    db
      .prepare(
        "UPDATE task_record_history SET delivery_json = json_set(coalesce(delivery_json, '{}'), '$.result', json(?)) WHERE task_id = ?",
      )
      .run(JSON.stringify({ at: when, value }), id);
  return { db, tasks, asOlderRelease };
}

const FOUND = { files: ["tests/e2e/knowledge.spec.ts", "tests/e2e/notes.spec.ts"] };

describe("reports and results as entries (INF-1296 piece 1)", () => {
  it("keeps a report's result on its entry alone, and the newest result stands until a later report carries another", () => {
    const { tasks } = setup();
    tasks.turns.recordReport("finder", {
      text: "Two journeys fail on the queue clock.",
      declared: { result: FOUND },
    });
    expect(tasks.get("finder")?.delivery?.result).toBeUndefined();
    const first = tasks.latestResult("finder");
    expect(first?.value).toEqual(FOUND);
    tasks.turns.recordReport("finder", { text: "Still watching the nightly run." });
    expect(tasks.latestResult("finder")).toEqual(first);
    tasks.turns.recordReport("finder", {
      text: "Only one fails now.",
      declared: { result: { files: [FOUND.files[0]] } },
    });
    expect(tasks.latestResult("finder")?.value).toEqual({ files: [FOUND.files[0]] });
    expect(tasks.reportEntries("finder").map((entry) => entry.result)).toEqual([
      FOUND,
      null,
      { files: [FOUND.files[0]] },
    ]);
  });

  it("reads an older release's saved result copy unchanged, until a report written after it carries a newer one", () => {
    const { tasks, asOlderRelease } = setup();
    tasks.turns.recordReport("finder", {
      text: "Two journeys fail on the queue clock.",
      summary: "Two journeys fail.",
      declared: { result: FOUND },
    });
    const reported = tasks.reportEntries("finder")[0];
    asOlderRelease(FOUND, reported?.at ?? 0);
    const byKey = () => queryTasks(tasks, { key: tasks.get("finder")?.key }).rows[0];
    expect(byKey()?.result).toEqual(FOUND);
    expect(byKey()?.reports).toEqual([
      { event_id: reported?.eventId, text: "Two journeys fail on the queue clock." },
    ]);

    // The copy is evidence: it stays saved as it was, and a report with no result keeps it.
    tasks.turns.recordReport("finder", { text: "Still watching the nightly run." });
    expect(tasks.get("finder")?.delivery?.result).toEqual({ at: reported?.at, value: FOUND });
    expect(byKey()?.result).toEqual(FOUND);

    tasks.turns.recordReport("finder", { text: "One left.", declared: { result: { files: [] } } });
    expect(byKey()?.result).toEqual({ files: [] });
    expect(tasks.get("finder")?.delivery?.result).toEqual({ at: reported?.at, value: FOUND });
  });

  it("keeps an older copy's precedence where the copies disagree, and reads a copy no entry holds", () => {
    const { tasks, asOlderRelease } = setup();
    tasks.turns.recordReport("finder", { text: "Found them.", declared: { result: FOUND } });
    const at = tasks.reportEntries("finder")[0]?.at ?? 0;
    asOlderRelease({ files: ["from the delivery copy"] }, at);
    expect(tasks.latestResult("finder")?.value).toEqual({ files: ["from the delivery copy"] });

    seedTask(tasks, {
      id: "copied",
      title: "A copy whose report no longer says it",
      status: "idle",
    });
    tasks.turns.recordReport("copied", { text: "Done." });
    expect(tasks.latestResult("copied")).toBeUndefined();
    asOlderRelease(FOUND, T0, "copied");
    expect(tasks.latestResult("copied")).toEqual({ at: T0, value: FOUND });
    expect(tasks.latestResult("missing")).toBeUndefined();
  });

  it("reads a report whose facts an older writer stored in another shape without guessing them", () => {
    const { tasks } = setup();
    tasks.turns.recordReport("finder", { text: "Done." });
    const event = tasks.timeline("finder").find((entry) => entry.kind === "report");
    if (!event) throw new Error("The report was not recorded.");
    const odd = {
      ...event,
      data: { summary: 7, result: ["not", "an", "object"], waitingOnCaptain: "soon" },
    };
    expect(reportEntryOf(odd)).toMatchObject({
      text: "Done.",
      summary: null,
      result: null,
      declared: {},
    });
  });
});
