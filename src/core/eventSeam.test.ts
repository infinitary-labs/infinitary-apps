import type { FmEvent } from "@shared/events";
import { describe, expect, it } from "vitest";
import { createEventSeam } from "./eventSeam";
import { ActivityStore } from "./storage/activityStore";
import { openInMemoryDatabase } from "./storage/db";
import { seedTask } from "./tasks/seedTask";
import { TaskService } from "./tasks/taskService";

/**
 * The one event seam (docs/architecture.md, "feed lines only via the
 * `broadcastEvent` seam"), held at the unit layer when the app wiring was
 * split into its owners (INF-2625's plan): where a note about a task is
 * written, which listeners hear an event, and when a settled run's line is
 * rewritten or withdrawn (docs/orchestrator-contract.md, "Settled runs").
 * The feed reading a task's note back is core.projects.test.ts's, through the
 * booted core.
 */

function seam() {
  const db = openInMemoryDatabase();
  const activity = new ActivityStore(db, () => 1_000);
  const tasks = new TaskService({ db, now: () => 1_000 });
  seedTask(tasks, { id: "task-1", title: "Fix the login page", status: "queued" });
  const emitted: FmEvent[] = [];
  const live: FmEvent[] = [];
  const recorded: string[] = [];
  const built = createEventSeam({
    tasks,
    activity,
    sharing: { record: (event) => void recorded.push(event.name) },
    crewLive: { apply: (event) => void live.push(event) },
    emit: (channel, payload) => {
      if (channel === "inf:event") emitted.push(payload as FmEvent);
    },
  });
  const lines = () => activity.recent().map((line) => line.text);
  const noted = (taskId: string) =>
    tasks
      .timeline(taskId)
      .filter((event) => event.kind === "note")
      .map((event) => event.text);
  return { ...built, activity, noted, emitted, live, recorded, lines };
}

const step = (text: string, run: { id: string; withdrawn?: boolean }): FmEvent => ({
  type: "personalized",
  text,
  actor: "captain",
  run,
});

describe("createEventSeam", () => {
  it("writes a note about a known task on that task's record, not the feed", () => {
    const { broadcastEvent, noted, emitted, lines } = seam();
    broadcastEvent({ type: "firstmate_note", text: "Its job stopped.", taskId: "task-1" });
    expect(noted("task-1")).toEqual(["Its job stopped."]);
    expect(emitted).toEqual([]);
    expect(lines()).toEqual([]);
  });

  it("keeps a note about a task it cannot find as a feed line, and tells every listener", () => {
    const { broadcastEvent, attachObserve, attachPresentation, noted, emitted, live, lines } =
      seam();
    const observed: FmEvent[] = [];
    const heard: FmEvent[] = [];
    attachObserve((event) => observed.push(event));
    attachPresentation((event) => heard.push(event));
    const note: FmEvent = { type: "firstmate_note", text: "A job stopped.", taskId: "gone" };
    broadcastEvent(note);
    expect(noted("task-1")).toEqual([]);
    expect(lines()).toEqual(["A job stopped."]);
    expect(emitted).toEqual([note]);
    expect(live).toEqual([note]);
    expect(observed).toEqual([note]);
    expect(heard).toEqual([note]);
  });

  it("rewrites a settled run's line in place while it is Activity's newest", () => {
    const { broadcastEvent, activityRun, lines } = seam();
    expect(activityRun()).toBeNull();
    broadcastEvent(step("panels moved left", { id: "run-1" }));
    expect(activityRun()).toBe("run-1");
    broadcastEvent(step("panels moved right", { id: "run-1" }));
    expect(lines()).toEqual(["Captain · panels moved right"]);
    expect(activityRun()).toBe("run-1");
  });

  it("starts a new line for a run once another line came after it", () => {
    const { broadcastEvent, activityRun, lines } = seam();
    broadcastEvent(step("panels moved left", { id: "run-1" }));
    broadcastEvent({ type: "firstmate_note", text: "Something else happened." });
    expect(activityRun()).toBeNull();
    broadcastEvent(step("panels moved right", { id: "run-1" }));
    expect(lines()).toEqual([
      "Captain · panels moved left",
      "Something else happened.",
      "Captain · panels moved right",
    ]);
    expect(activityRun()).toBe("run-1");
  });

  it("takes a run's line away when the run came back where it started", () => {
    const { broadcastEvent, activityRun, lines } = seam();
    broadcastEvent({ type: "firstmate_note", text: "Before the run." });
    broadcastEvent(step("panels moved left", { id: "run-1" }));
    broadcastEvent(step("panels moved back", { id: "run-1", withdrawn: true }));
    expect(lines()).toEqual(["Before the run."]);
    expect(activityRun()).toBeNull();
  });
});
