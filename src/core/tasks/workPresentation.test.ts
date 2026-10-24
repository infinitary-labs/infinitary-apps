import type { FmEvent } from "@shared/events";
import type { WorkPosture } from "@shared/workPosture";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "./seedTask";
import { TaskProtocol } from "./taskProtocol";
import { TaskService } from "./taskService";
import { WorkPresentation } from "./workPresentation";

/**
 * INF-1073: the captain still saw keystrokes lag in the message box while
 * crewmates were started and messaged, and asked for a guard that cannot
 * fail on a busy Mac. These tests count work, never time: how many
 * presentation passes one change runs and how many postures they read.
 */

function setup() {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, now: () => 10_000 });
  // Three crewmates waiting on their next request and two planned tasks,
  // the shape of a fleet the captain types beside.
  for (const id of ["crew-1", "crew-2", "crew-3"])
    seedTask(tasks, {
      id,
      title: `Inspect the input preparation ${id}`,
      status: "idle",
      outcome: "Inspection recorded; waiting for the next request.",
    });
  for (const id of ["planned-1", "planned-2"])
    seedTask(tasks, { id, title: `Review ${id}`, status: "queued", startPolicy: "on-request" });
  const postures = new Map<string, WorkPosture>();
  const reads: string[] = [];
  const events: FmEvent[] = [];
  let passes = 0;
  const protocol = new TaskProtocol({
    tasks,
    workPosture: (record) => {
      reads.push(record.id);
      return postures.get(record.id) ?? { state: "idle", reason: "inactive" };
    },
    repos: { get: () => undefined },
    cards: { listOpen: () => [], snapshot: () => [] },
    // The board push reads postures too; these tests count the pass alone.
    coalesceMs: 60_000,
    broadcastEvent: (event) => broadcast(event),
    emit: () => {},
  });
  const refresh = protocol.refreshPresentation.bind(protocol);
  protocol.refreshPresentation = (read) => {
    passes += 1;
    return refresh(read);
  };
  let onCounts: (() => void) | undefined;
  // The event seam as services wires it: every event reaches the pass.
  const broadcast = (event: FmEvent) => {
    events.push(event);
    presentation.heard(event);
    if (event.type === "crew_counts") onCounts?.();
  };
  const presentation = new WorkPresentation({ tasks, protocol, broadcastEvent: broadcast });
  const settled = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    tasks,
    postures,
    reads,
    events,
    presentation,
    passes: () => passes,
    settled,
    onCounts: (fn: () => void) => {
      onCounts = fn;
    },
    reset: () => {
      reads.length = 0;
      events.length = 0;
      passes = 0;
    },
    close: () => {
      presentation.dispose();
      protocol.dispose();
      db.close();
    },
  };
}

const live = 5;
const changedEvents = (events: FmEvent[]) => events.filter((e) => e.type === "task_changed");

describe("the presentation pass (INF-1073)", () => {
  it("reads each live row's posture once for one task write, and counts the crew from those readings", async () => {
    const f = setup();
    f.presentation.schedule();
    await f.settled();
    f.reset();
    // A crewmate's turn starts: its record is written and its posture moves.
    f.postures.set("crew-1", { state: "active", reason: "turn" });
    f.tasks.setActivity("crew-1", "running");
    await f.settled();
    expect(f.passes()).toBe(1);
    // The pass reads each live row once; every other read is a published
    // row's own task_changed (the write, then the republish).
    expect(f.reads.length).toBe(live + changedEvents(f.events).length);
    expect(changedEvents(f.events).length).toBe(2);
    expect(f.events.filter((e) => e.type === "crew_counts")).toEqual([
      { type: "crew_counts", working: 1, idle: 2, queued: 2 },
    ]);
    f.close();
  });

  it("runs one pass for a burst of writes made in one go", async () => {
    const f = setup();
    f.presentation.schedule();
    await f.settled();
    f.reset();
    for (const id of ["crew-1", "crew-2", "crew-3"]) {
      f.postures.set(id, { state: "active", reason: "turn" });
      f.tasks.setActivity(id, "running");
    }
    await f.settled();
    expect(f.passes()).toBe(1);
    expect(f.events.filter((e) => e.type === "crew_counts")).toEqual([
      { type: "crew_counts", working: 3, idle: 0, queued: 2 },
    ]);
    f.close();
  });

  it("still runs the next pass for a change made while the pass announces, and for another owner's counts", async () => {
    const f = setup();
    f.presentation.schedule();
    await f.settled();
    f.reset();
    let reacted = false;
    f.onCounts(() => {
      if (reacted) return;
      reacted = true;
      // Something heard the counts and moved another crewmate.
      f.postures.set("crew-2", { state: "active", reason: "job" });
      f.tasks.setActivity("crew-2", "running");
    });
    f.postures.set("crew-1", { state: "active", reason: "turn" });
    f.tasks.setActivity("crew-1", "running");
    await f.settled();
    expect(f.passes()).toBe(2);
    expect(f.events.filter((e) => e.type === "crew_counts").at(-1)).toEqual({
      type: "crew_counts",
      working: 2,
      idle: 1,
      queued: 2,
    });
    // The supervisor's own counts (a turn ended without a write) ask too.
    f.reset();
    f.onCounts(() => {});
    f.postures.set("crew-1", { state: "idle", reason: "inactive" });
    f.presentation.heard({ type: "crew_counts", working: 1, idle: 2, queued: 2 });
    await f.settled();
    expect(f.passes()).toBe(1);
    f.close();
  });
});
