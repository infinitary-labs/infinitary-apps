/**
 * The note on a part the captain stopped that is left as its parent's last
 * open part (INF-6663; docs/report-sort.md, "The last part the captain
 * stopped"). INF-6057 sat stopped for three days while its 15 siblings
 * closed, and nothing told the captain its parent now waited on it alone.
 * Each case drives a real CrewSupervisor through the crew harness on seeded
 * tasks and reads the cards, the sort ledger and the first mate's wakes.
 */

import { describe, expect, it } from "vitest";
import { fakeCrewmate, fakeCrewTimersEachTest } from "../../../tests/helpers/crewHarness";
import {
  idleLadderHarness,
  minutes,
  settle,
  wakesThroughInbox,
} from "../../../tests/helpers/idleLadderHarness";
import { seedTask } from "../tasks/seedTask";
import { STALL_WAKE_MS } from "./idleLadder";
import { lastPartNoteId } from "./lastPartNote";

fakeCrewTimersEachTest();

describe("the note on a stopped part left last under its parent (INF-6663)", () => {
  const { clock, clockedSetup } = idleLadderHarness();

  function harness() {
    const h = wakesThroughInbox(clockedSetup(fakeCrewmate()));
    const start = clock.now;
    const at = async (ms: number) => {
      clock.now = start + ms;
      h.supervisor.watch.reconcileIdle(clock.now);
      await settle();
    };
    const note = (taskId: string) => h.cards().find((shown) => shown.id === lastPartNoteId(taskId));
    const notes = (taskId: string) =>
      h.sorts.filter((row) => row.taskId === taskId && row.rule === "last-part-note");
    return { ...h, start, at, note, notes };
  }

  /**
   * INF-6052's shape: a parent filed on request, two parts that started,
   * and a third the captain stopped at filing.
   */
  function workstream(h: ReturnType<typeof harness>) {
    const parent = seedTask(h.tasks, {
      id: "triage",
      title: "Answer outside issues and pull requests",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    for (const [id, title] of [
      ["forms", "Add the issue forms"],
      ["labels", "Label new issues for triage"],
    ]) {
      seedTask(h.tasks, { id, title, parentId: parent.id, status: "running", createdAt: h.start });
    }
    const part = seedTask(h.tasks, {
      id: "plan",
      title: "Write the triage plan",
      parentId: parent.id,
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    expect(h.tasks.starts.declareCaptainStop(part.id, "firstmate")).toEqual({
      ok: true,
      changed: true,
    });
    return { parent, part };
  }

  const finish = (h: ReturnType<typeof harness>, id: string) =>
    h.tasks.close(id, { status: "done", reason: "finished", actor: "host" });

  it("tells the captain once, after the settle time, when the last other part closes", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(minutes(30));
    finish(h, "forms");
    await h.at(minutes(60));
    expect(h.note(part.id)).toBeUndefined();
    finish(h, "labels");
    await h.at(minutes(60) + STALL_WAKE_MS - minutes(1));
    expect(h.note(part.id)).toBeUndefined();
    await h.at(minutes(60) + STALL_WAKE_MS);
    const note = h.note(part.id);
    expect(note?.title).toBe(
      "Answer outside issues and pull requests waits only on Write the triage plan",
    );
    expect(note?.author).toBe("host");
    expect(note?.taskId).toBe(part.id);
    expect(note?.actions).toEqual([]);
    expect(note?.answeredBy).toBe("firstmate");
    expect(note?.body).toContain(
      "Write the triage plan is the only part of Answer outside issues and pull requests still open.",
    );
    expect(note?.body).toContain("It waits because you asked for it to wait");
    for (const later of [120, 600, 6000]) await h.at(minutes(later));
    expect(h.notes(part.id)).toHaveLength(1);
    expect(h.cards().filter((shown) => shown.id === lastPartNoteId(part.id))).toHaveLength(1);
    // The captain's stop still keeps the first mate's wake and the next-move card away.
    expect(h.ops.filter((line) => line.includes("is begun work"))).toEqual([]);
  });

  it("does not bring the note back after Got it, until another part closes later", async () => {
    const h = harness();
    const { parent, part } = workstream(h);
    await h.at(minutes(5));
    finish(h, "forms");
    finish(h, "labels");
    await h.at(minutes(5) + STALL_WAKE_MS);
    expect(h.note(part.id)).toBeDefined();
    h.supervisor.pressNote(lastPartNoteId(part.id));
    await settle();
    for (const later of [60, 600]) await h.at(minutes(later));
    expect(h.note(part.id)).toBeUndefined();
    expect(h.notes(part.id)).toHaveLength(1);

    // A new part filed and finished later leaves the stopped part last again.
    seedTask(h.tasks, {
      id: "docs",
      title: "Document the triage labels",
      parentId: parent.id,
      status: "running",
      createdAt: h.start + minutes(600),
    });
    await h.at(minutes(610));
    finish(h, "docs");
    await h.at(minutes(610) + STALL_WAKE_MS);
    expect(h.note(part.id)).toBeDefined();
    expect(h.notes(part.id)).toHaveLength(2);
  });

  it("takes the note down when the part starts", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(minutes(5));
    finish(h, "forms");
    finish(h, "labels");
    await h.at(minutes(5) + STALL_WAKE_MS);
    expect(h.note(part.id)).toBeDefined();
    h.tasks.updateFields(part.id, { startPolicy: "when-ready" }, "captain");
    await h.at(minutes(6) + STALL_WAKE_MS);
    expect(h.note(part.id)).toBeUndefined();
  });

  it("says nothing while another part is still open", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(minutes(5));
    finish(h, "forms");
    for (const later of [60, 600]) await h.at(minutes(later));
    expect(h.note(part.id)).toBeUndefined();
    expect(h.notes(part.id)).toEqual([]);
  });

  it("says nothing when the captain stopped the part after the other parts had closed", async () => {
    const h = harness();
    const parent = seedTask(h.tasks, {
      id: "triage",
      title: "Answer outside issues and pull requests",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    seedTask(h.tasks, {
      id: "forms",
      title: "Add the issue forms",
      parentId: parent.id,
      status: "running",
      createdAt: h.start,
    });
    const part = seedTask(h.tasks, {
      id: "plan",
      title: "Write the triage plan",
      parentId: parent.id,
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    await h.at(minutes(5));
    finish(h, "forms");
    await h.at(minutes(6));
    h.tasks.starts.declareCaptainStop(part.id, "firstmate");
    for (const later of [60, 600]) await h.at(minutes(later));
    expect(h.note(part.id)).toBeUndefined();
  });

  it("says nothing when the captain stopped the parent, or the parent delivers an answer", async () => {
    const stoppedParent = harness();
    const first = workstream(stoppedParent);
    stoppedParent.tasks.starts.declareCaptainStop(first.parent.id, "firstmate");
    await stoppedParent.at(minutes(5));
    finish(stoppedParent, "forms");
    finish(stoppedParent, "labels");
    for (const later of [60, 600]) await stoppedParent.at(minutes(later));
    expect(stoppedParent.note(first.part.id)).toBeUndefined();

    const plan = harness();
    seedTask(plan.tasks, {
      id: "triage-plan",
      title: "Plan the outside triage",
      status: "idle",
      shape: { kind: "research", deliverable: "answer" },
      createdAt: plan.start,
    });
    seedTask(plan.tasks, {
      id: "forms",
      title: "Add the issue forms",
      parentId: "triage-plan",
      status: "running",
      createdAt: plan.start,
    });
    seedTask(plan.tasks, {
      id: "idea",
      title: "Later: a triage bot",
      parentId: "triage-plan",
      status: "queued",
      startPolicy: "on-request",
      createdAt: plan.start,
    });
    plan.tasks.starts.declareCaptainStop("idea", "firstmate");
    await plan.at(minutes(5));
    finish(plan, "forms");
    for (const later of [60, 600]) await plan.at(minutes(later));
    expect(plan.note("idea")).toBeUndefined();
  });

  it("tells the captain about started work they moved to the backlog, left last under its parent", async () => {
    const h = harness();
    const parent = seedTask(h.tasks, {
      id: "triage",
      title: "Answer outside issues and pull requests",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    seedTask(h.tasks, {
      id: "forms",
      title: "Add the issue forms",
      parentId: parent.id,
      status: "running",
      createdAt: h.start,
    });
    seedTask(h.tasks, {
      id: "plan",
      title: "Write the triage plan",
      parentId: parent.id,
      status: "idle",
      createdAt: h.start,
    });
    h.supervisor.hostOps.moveToBacklog("plan", { actor: "captain", via: "tool", decision: null });
    await settle();
    await h.at(minutes(5));
    finish(h, "forms");
    await h.at(minutes(5) + STALL_WAKE_MS);
    expect(h.note("plan")?.title).toBe(
      "Answer outside issues and pull requests waits only on Write the triage plan",
    );
  });
});
