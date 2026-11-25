/**
 * The decision on a part the captain stopped that is left as its parent's
 * last open part (INF-6663; docs/report-sort.md, "The last part the captain
 * stopped"). INF-6057 sat stopped for three days while its 15 siblings
 * closed, and nothing asked the captain about it once its parent waited on
 * it alone.
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
import { lastPartCardId } from "./lastPartCard";

fakeCrewTimersEachTest();

describe("the card on a stopped part left last under its parent (INF-6663)", () => {
  const { clock, clockedSetup } = idleLadderHarness();

  function harness() {
    const h = wakesThroughInbox(clockedSetup(fakeCrewmate()));
    const start = clock.now;
    const at = async (ms: number) => {
      clock.now = start + ms;
      h.supervisor.watch.reconcileIdle(clock.now);
      await settle();
    };
    const card = (taskId: string) => h.cards().find((shown) => shown.id === lastPartCardId(taskId));
    const raised = (taskId: string) =>
      h.sorts.filter((row) => row.taskId === taskId && row.rule === "last-part-card");
    return { ...h, start, at, card, raised };
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
    ] as const) {
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

  it("asks the captain once, after the settle time, when the last other part closes", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(minutes(30));
    finish(h, "forms");
    await h.at(minutes(60));
    expect(h.card(part.id)).toBeUndefined();
    finish(h, "labels");
    await h.at(minutes(60) + STALL_WAKE_MS - minutes(1));
    expect(h.card(part.id)).toBeUndefined();
    await h.at(minutes(60) + STALL_WAKE_MS);
    const card = h.card(part.id);
    expect(card?.title).toBe(
      "Answer outside issues and pull requests waits only on Write the triage plan",
    );
    expect(card?.author).toBe("host");
    expect(card?.taskId).toBe(part.id);
    expect(card?.actions).toEqual([
      {
        id: "start",
        label: "Start now",
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "start-task", arg: part.id },
      },
      { id: "keep", label: "Keep it waiting", variant: "secondary" },
    ]);
    expect(card?.answeredBy).toBe("firstmate");
    expect(card?.body).toContain(
      "Write the triage plan is the only part of Answer outside issues and pull requests still open.",
    );
    expect(card?.body).toContain("It waits because you asked for it to wait");
    for (const later of [120, 600, 6000]) await h.at(minutes(later));
    expect(h.raised(part.id)).toHaveLength(1);
    expect(h.cards().filter((shown) => shown.id === lastPartCardId(part.id))).toHaveLength(1);
    // The captain's stop still keeps the first mate's wake and the next-move card away.
    expect(h.ops.filter((line) => line.includes("is begun work"))).toEqual([]);
  });

  it("does not bring the card back after Keep it waiting, until another part closes later", async () => {
    const h = harness();
    const { parent, part } = workstream(h);
    await h.at(minutes(5));
    finish(h, "forms");
    finish(h, "labels");
    await h.at(minutes(5) + STALL_WAKE_MS);
    expect(h.card(part.id)).toBeDefined();
    h.supervisor.cardActions.act(lastPartCardId(part.id), "keep");
    await settle();
    for (const later of [60, 600]) await h.at(minutes(later));
    expect(h.card(part.id)).toBeUndefined();
    expect(h.raised(part.id)).toHaveLength(1);

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
    expect(h.card(part.id)).toBeDefined();
    expect(h.raised(part.id)).toHaveLength(2);
  });

  it("starts the part on Start now", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(minutes(5));
    finish(h, "forms");
    finish(h, "labels");
    await h.at(minutes(5) + STALL_WAKE_MS);
    expect(h.tasks.get(part.id)?.status).toBe("open");
    h.supervisor.cardActions.act(lastPartCardId(part.id), "start");
    await settle();
    expect(h.tasks.get(part.id)?.status).toBe("active");
    expect(h.card(part.id)).toBeUndefined();
    for (const later of [60, 600]) await h.at(minutes(later));
    expect(h.card(part.id)).toBeUndefined();
    expect(h.raised(part.id)).toHaveLength(1);
  });

  it("takes the card down when the part starts some other way", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(minutes(5));
    finish(h, "forms");
    finish(h, "labels");
    await h.at(minutes(5) + STALL_WAKE_MS);
    expect(h.card(part.id)).toBeDefined();
    h.tasks.updateFields(part.id, { startPolicy: "when-ready" }, "captain");
    await h.at(minutes(6) + STALL_WAKE_MS);
    expect(h.card(part.id)).toBeUndefined();
  });

  it("says nothing while another part is still open", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(minutes(5));
    finish(h, "forms");
    for (const later of [60, 600]) await h.at(minutes(later));
    expect(h.card(part.id)).toBeUndefined();
    expect(h.raised(part.id)).toEqual([]);
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
    expect(h.card(part.id)).toBeUndefined();
  });

  it("says nothing when the captain stopped the parent, or the parent delivers an answer", async () => {
    const stoppedParent = harness();
    const first = workstream(stoppedParent);
    stoppedParent.tasks.starts.declareCaptainStop(first.parent.id, "firstmate");
    await stoppedParent.at(minutes(5));
    finish(stoppedParent, "forms");
    finish(stoppedParent, "labels");
    for (const later of [60, 600]) await stoppedParent.at(minutes(later));
    expect(stoppedParent.card(first.part.id)).toBeUndefined();

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
    expect(plan.card("idea")).toBeUndefined();
  });

  it("asks the captain about started work they moved to the backlog, left last under its parent", async () => {
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
    expect(h.card("plan")?.title).toBe(
      "Answer outside issues and pull requests waits only on Write the triage plan",
    );
  });
});
