/**
 * Accepted session-audit finding: a Starting feed line names every finished
 * prerequisite by title and key, rather than its internal id.
 * The real supervisor dispatches stored task dependencies; only the model
 * session and workspace use the shared crew harness stand-ins.
 */
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";

fakeCrewTimersEachTest();

describe("completed prerequisites in the start feed", () => {
  it.each([1, 3])("names all %i finished tasks by title and key", async (count) => {
    const { supervisor, tasks, events, sessions } = setup(fakeCrewmate());
    const prerequisites = ["Split card handling", "Check saved answers", "Review task delivery"]
      .slice(0, count)
      .map((title) => supervisor.intake.plan({ title, intent: intentOf(title) }));
    const dependent = supervisor.intake.plan({
      title: "Simplify card ownership",
      intent: intentOf("Give each card one owner"),
      blockedBy: prerequisites.map((task) => task.id),
      startPolicy: "when-ready",
    });
    await supervisor.watch.sweepGates(Date.now());
    expect(sessions.open).not.toHaveBeenCalled();
    for (const prerequisite of prerequisites) {
      tasks.close(prerequisite.id, { status: "done", reason: "answered", actor: "host" });
    }
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    expect(tasks.get(dependent.id)?.status).toBe("active");
    expect(sessions.open).toHaveBeenCalledTimes(1);
    const starts = events.filter(
      (event) => event.type === "firstmate_note" && event.text.startsWith("Starting "),
    );
    expect(starts).toEqual([
      {
        type: "firstmate_note",
        text: `Starting "${dependent.title}" - ${prerequisites
          .map((task) => `"${task.title}" (${task.key})`)
          .join(" and ")} finished.`,
      },
    ]);
  });
});
