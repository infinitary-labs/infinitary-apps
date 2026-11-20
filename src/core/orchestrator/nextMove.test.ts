/**
 * The next-move check (`NextMove`; docs/report-sort.md, "The next-move
 * check"), INF-3846 piece 2: the captain's ask to find why a workstream
 * paused half way and broke continuity, and to avoid it by design. Every
 * open part of begun work is moving, waiting on the captain with a card up,
 * or stopped by the captain; otherwise the first mate is told once, and if
 * the part still stands after its turn the captain gets one card.
 * Each case drives a real CrewSupervisor through the crew harness on seeded
 * tasks and reads what the first mate was served, the cards and the record.
 */

import type { PutOffUntil } from "@shared/putOff";
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
import { nextMoveCardId, nextMoveCardTitle } from "./nextMove";

fakeCrewTimersEachTest();

describe("the next-move check (INF-3846 piece 2)", () => {
  const { clock, clockedSetup } = idleLadderHarness();

  /** The harness, its first mate live or paused, and a pass of the ladder at `ms` past the start. */
  function harness(firstmate: "live" | "paused" = "live") {
    const h = wakesThroughInbox(clockedSetup(fakeCrewmate()), firstmate);
    const start = clock.now;
    const at = async (ms: number) => {
      clock.now = start + ms;
      h.supervisor.watch.reconcileIdle(clock.now);
      await settle();
    };
    const told = (taskId: string) =>
      h.ops.filter((line) => line.includes(`"${h.tasks.get(taskId)?.title}" is begun work`));
    const card = (taskId: string) => h.cards().find((shown) => shown.id === nextMoveCardId(taskId));
    return { ...h, start, at, told, card };
  }

  /**
   * The workstream the captain named: a main task whose first part started,
   * and a second part filed on request that nothing will ever start.
   */
  function workstream(h: ReturnType<typeof harness>) {
    const main = seedTask(h.tasks, {
      id: "secrets-main",
      title: "Move secrets behind one owner",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    seedTask(h.tasks, {
      id: "secrets-1",
      title: "Add the secrets owner",
      parentId: main.id,
      status: "running",
      createdAt: h.start,
    });
    const part = seedTask(h.tasks, {
      id: "secrets-2",
      title: "Read secrets through the owner",
      parentId: main.id,
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    return { main, part };
  }

  /**
   * A first mate card about the task with a plain choice and a Not until
   * choice (INF-3846 piece 3), and the captain's click on Not until.
   */
  function putOff(h: ReturnType<typeof harness>, taskId: string, until: PutOffUntil): string {
    const asked = h.supervisor.cards.addFirstmateCard({
      taskId,
      title: `Go on with ${h.tasks.get(taskId)?.title}?`,
      body: "<p>It can wait for its moment.</p>",
      actions: [
        { id: "wait", label: "Leave it waiting", default: true },
        { id: "later", label: "Not until then", until },
      ],
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    h.supervisor.cardActions.act(asked, "later");
    return asked;
  }

  it("tells the first mate once after the settle time, then shows the captain one card, which comes down when the part starts", async () => {
    const h = harness();
    const { main, part } = workstream(h);
    await h.at(STALL_WAKE_MS - minutes(1));
    expect(h.told(part.id)).toEqual([]);
    await h.at(STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(1);
    expect(h.told(part.id)[0]).toContain(
      `it is a part of ${main.key} "Move secrets behind one owner", where work has started`,
    );
    expect(h.sorts.filter((row) => row.taskId === part.id).map((row) => row.rule)).toEqual([
      "next-move-wake",
    ]);
    // Only the part stands: the main task is read through its parts, and the
    // started part is the ladder's own.
    expect(h.ops.filter((line) => line.includes("is begun work"))).toHaveLength(1);
    // The first mate's turn handled the news and left it standing.
    await h.at(STALL_WAKE_MS + minutes(1));
    expect(h.card(part.id)?.title).toBe(nextMoveCardTitle("Read secrets through the owner"));
    expect(h.card(part.id)?.actions?.map((action) => action.label)).toEqual([
      "Start it",
      "Leave it",
    ]);
    for (const later of [30, 120, 600]) await h.at(minutes(later));
    expect(h.told(part.id)).toHaveLength(1);
    expect(h.cards().filter((shown) => shown.id === nextMoveCardId(part.id))).toHaveLength(1);
    expect(h.sorts.filter((row) => row.taskId === part.id).map((row) => row.rule)).toEqual([
      "next-move-wake",
      "next-move-card",
    ]);
    h.supervisor.cardActions.act(nextMoveCardId(part.id), "start");
    await settle();
    expect(h.tasks.get(part.id)?.status).toBe("active");
    await h.at(minutes(601));
    expect(h.card(part.id)).toBeUndefined();
  });

  it("raises no card while the first mate has not finished a turn on the news", async () => {
    const h = harness("paused");
    const { part } = workstream(h);
    for (const later of [10, 20, 60, 600]) await h.at(minutes(later));
    expect(h.told(part.id)).toHaveLength(1);
    expect(h.card(part.id)).toBeUndefined();
  });

  it("takes the card down when the first mate gives the part a next move", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(STALL_WAKE_MS);
    await h.at(STALL_WAKE_MS + minutes(1));
    expect(h.card(part.id)).toBeDefined();
    h.tasks.starts.declareCaptainStop(part.id, "firstmate");
    await h.at(STALL_WAKE_MS + minutes(2));
    expect(h.card(part.id)).toBeUndefined();
  });

  it("does not bring the card back once the captain chose Leave it in the same stay", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(STALL_WAKE_MS);
    await h.at(STALL_WAKE_MS + minutes(1));
    h.supervisor.cardActions.act(nextMoveCardId(part.id), "leave");
    await settle();
    for (const later of [30, 120, 600]) await h.at(minutes(later));
    expect(h.card(part.id)).toBeUndefined();
    expect(h.told(part.id)).toHaveLength(1);
  });

  it("counts a part as begun when started work waits on it", async () => {
    const h = harness();
    const blocker = seedTask(h.tasks, {
      id: "owner-first",
      title: "Settle the owner's shape",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    const waiter = seedTask(h.tasks, {
      id: "waiter",
      title: "Migrate the callers",
      status: "running",
      createdAt: h.start,
    });
    h.tasks.graph.link(blocker.id, waiter.id, "blocks", "firstmate");
    await h.at(STALL_WAKE_MS);
    expect(h.told(blocker.id)).toHaveLength(1);
    expect(h.told(blocker.id)[0]).toContain(
      `started work waits on it: ${waiter.key} "Migrate the callers"`,
    );
  });

  it("tells the first mate about started work it moved to the backlog, and nothing about the captain's own move", async () => {
    const h = harness();
    for (const [id, actor] of [
      ["parked-by-firstmate", "firstmate"],
      ["parked-by-captain", "captain"],
    ] as const) {
      seedTask(h.tasks, { id, title: `Parked by ${actor}`, status: "idle", createdAt: h.start });
      h.supervisor.hostOps.moveToBacklog(id, { actor, via: "tool", decision: null });
    }
    await settle();
    await h.at(STALL_WAKE_MS);
    expect(h.told("parked-by-firstmate")).toHaveLength(1);
    expect(h.told("parked-by-firstmate")[0]).toContain("is begun work (it started before)");
    expect(h.told("parked-by-captain")).toEqual([]);
  });

  it("leaves alone a part the captain stopped, and a part under a main task the captain stopped", async () => {
    const h = harness();
    const { part } = workstream(h);
    const stopped = h.tasks.starts.declareCaptainStop(part.id, "firstmate");
    expect(stopped).toEqual({ ok: true, changed: true });
    await h.at(STALL_WAKE_MS);
    expect(h.told(part.id)).toEqual([]);

    const other = harness();
    const second = workstream(other);
    // Stopping the main task stops its unstarted parts too.
    expect(other.tasks.starts.declareCaptainStop(second.main.id, "firstmate").ok).toBe(true);
    await other.at(STALL_WAKE_MS);
    expect(other.told(second.part.id)).toEqual([]);
  });

  // The review of this change: a failed start and an edit of the start
  // policy are lines that stop or start a part too.
  it("begins a new stay when a start fails and puts the part back on request", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(STALL_WAKE_MS);
    await h.at(STALL_WAKE_MS + minutes(1));
    h.supervisor.cardActions.act(nextMoveCardId(part.id), "leave");
    await settle();
    h.tasks.starts.claimForDispatch(part.id);
    await h.at(minutes(20));
    h.tasks.starts.returnStart(part.id, { kind: "failed", reason: "no account served it" });
    await h.at(minutes(20) + STALL_WAKE_MS - minutes(1));
    expect(h.told(part.id)).toHaveLength(1);
    await h.at(minutes(20) + STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(2);
    await h.at(minutes(21) + STALL_WAKE_MS);
    expect(h.card(part.id)).toBeDefined();
  });

  it("ends the captain's stop when a later edit sets the start policy again", async () => {
    const h = harness();
    const { part } = workstream(h);
    h.tasks.starts.declareCaptainStop(part.id, "firstmate");
    expect(h.tasks.starts.stoppedByCaptain(h.tasks.get(part.id) ?? part)).toBe(true);
    await h.at(minutes(1));
    h.tasks.updateFields(part.id, { startPolicy: "when-ready" }, "firstmate");
    await h.at(minutes(2));
    h.tasks.updateFields(part.id, { startPolicy: "on-request" }, "firstmate");
    expect(h.tasks.starts.stoppedByCaptain(h.tasks.get(part.id) ?? part)).toBe(false);
    await h.at(minutes(2) + STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(1);
  });

  // The captain's answer on the review: work they stopped is no reason for begun-ness.
  it("counts no work the captain stopped as the reason a part is begun, as a waiter or as a sibling", async () => {
    const h = harness();
    const blocker = seedTask(h.tasks, {
      id: "owner-first",
      title: "Settle the owner's shape",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    seedTask(h.tasks, {
      id: "waiter",
      title: "Migrate the callers",
      status: "idle",
      createdAt: h.start,
    });
    h.tasks.graph.link(blocker.id, "waiter", "blocks", "firstmate");
    h.supervisor.hostOps.moveToBacklog("waiter", { actor: "captain", via: "tool", decision: null });
    const { part } = workstream(h);
    h.supervisor.hostOps.moveToBacklog("secrets-1", {
      actor: "captain",
      via: "tool",
      decision: null,
    });
    await settle();
    for (const later of [10, 60, 600]) await h.at(minutes(later));
    expect(h.told(blocker.id)).toEqual([]);
    expect(h.told(part.id)).toEqual([]);
    expect(h.ops.filter((line) => line.includes("is begun work"))).toEqual([]);
  });

  // The captain's answer on the review: the stay begins when the part became standing.
  it("begins the stay when the last work the part waited on closes", async () => {
    const h = harness();
    const { part } = workstream(h);
    seedTask(h.tasks, {
      id: "first-step",
      title: "Add the owner's table",
      status: "running",
      createdAt: h.start,
    });
    h.tasks.graph.link("first-step", part.id, "blocks", "firstmate");
    await h.at(minutes(30));
    h.tasks.close("first-step", { status: "done", reason: "answered", actor: "host" });
    await h.at(minutes(30) + STALL_WAKE_MS - minutes(1));
    expect(h.told(part.id)).toEqual([]);
    await h.at(minutes(30) + STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(1);
    expect(h.told(part.id)[0]).toContain("has waited on request for 10m");
  });

  it("begins a new stay when another card about the part ends", async () => {
    const h = harness();
    const { part } = workstream(h);
    const asked = h.supervisor.cards.addFirstmateCard({
      taskId: part.id,
      title: "Start the second part now?",
      body: "<p>The first part is underway.</p>",
      actions: [
        { id: "start", label: "Start it", default: true },
        { id: "wait", label: "Wait" },
      ],
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    await h.at(minutes(30));
    expect(h.told(part.id)).toEqual([]);
    h.supervisor.cardActions.act(asked, "wait");
    await settle();
    await h.at(minutes(30) + STALL_WAKE_MS - minutes(1));
    expect(h.told(part.id)).toEqual([]);
    await h.at(minutes(31) + STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(1);
  });

  // The captain's answer on the review: begun-ness reads through live parents.
  it("reads begun work through parents: started work waiting on a parent, and parts under a sub-task of begun work", async () => {
    const h = harness();
    seedTask(h.tasks, {
      id: "group",
      title: "Rotate the keys",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    const leaf = seedTask(h.tasks, {
      id: "leaf",
      title: "List the keys",
      parentId: "group",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    seedTask(h.tasks, {
      id: "rollout",
      title: "Roll the new keys out",
      status: "running",
      createdAt: h.start,
    });
    h.tasks.graph.link("group", "rollout", "blocks", "firstmate");

    const { main } = workstream(h);
    seedTask(h.tasks, {
      id: "sub",
      title: "Callers of the owner",
      parentId: main.id,
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    const deep = seedTask(h.tasks, {
      id: "deep",
      title: "Move the first caller",
      parentId: "sub",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    await h.at(STALL_WAKE_MS);
    expect(h.told(leaf.id)).toHaveLength(1);
    expect(h.told(leaf.id)[0]).toContain(
      'started work waits on SCR-1 "Rotate the keys", which it is a part of: SCR-3 "Roll the new keys out"',
    );
    expect(h.told(deep.id)).toHaveLength(1);
    expect(h.told(deep.id)[0]).toContain('it is a part of SCR-4 "Move secrets behind one owner"');
  });

  it("leaves alone a part held at a gate, which starts by itself or waits on the captain", async () => {
    const h = harness();
    const { main } = workstream(h);
    // Reviewer's finding on INF-3860: a part whose start waits for a time is
    // not standing, since the ladder's gate sweep starts it when the time comes.
    const gated = seedTask(h.tasks, {
      id: "secrets-3",
      title: "Rotate the old secrets",
      parentId: main.id,
      status: "queued",
      startPolicy: "on-request",
      gate: { kind: "at-time", until: h.start + 24 * 60 * minutes(1) },
      createdAt: h.start,
    });
    await h.at(STALL_WAKE_MS);
    expect(h.told(gated.id)).toEqual([]);
    expect(h.told("secrets-2")).toHaveLength(1);
  });

  it("counts a part as begun when a part beside it already finished", async () => {
    const h = harness();
    const { part } = workstream(h);
    h.tasks.close("secrets-1", { status: "done", reason: "finished", actor: "host" });
    await h.at(STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(1);
  });

  it("refuses a stop on work that does not wait for a start", async () => {
    const h = harness();
    seedTask(h.tasks, { id: "queued-work", title: "Queued work", status: "queued" });
    const refused = h.tasks.starts.declareCaptainStop("queued-work", "firstmate");
    expect(refused.ok).toBe(false);
  });

  it("leaves alone a part with a card that asks the captain something", async () => {
    const h = harness();
    const { part } = workstream(h);
    h.supervisor.cards.addFirstmateCard({
      taskId: part.id,
      title: "Start the second part now?",
      body: "<p>The first part is underway.</p>",
      actions: [
        { id: "start", label: "Start it", default: true },
        { id: "wait", label: "Wait" },
      ],
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    await h.at(STALL_WAKE_MS);
    expect(h.told(part.id)).toEqual([]);
  });

  // INF-5004: a builder moved to the backlog while its reviewer's question
  // card was up was reported as begun work standing still.
  it("leaves alone started work whose reviewer's question card asks the captain something", async () => {
    const h = harness();
    seedTask(h.tasks, {
      id: "builder",
      title: "Fix the meter",
      status: "idle",
      createdAt: h.start,
    });
    seedTask(h.tasks, {
      id: "review",
      title: "Review: Fix the meter",
      status: "idle",
      parentId: "builder",
      shape: { kind: "review", kind_source: "host:review", basis: "builder" },
      createdAt: h.start,
    });
    h.supervisor.cards.emitCrewmateCard(
      "review",
      {
        id: "review-meter",
        title: "Review of the meter fix",
        body: "<p>Keep the Later copy?</p>",
        actions: [
          { id: "keep", label: "Keep the copy", default: true },
          { id: "change", label: "Change it" },
        ],
      },
      "Review",
    );
    h.supervisor.hostOps.moveToBacklog("builder", {
      actor: "firstmate",
      via: "tool",
      decision: null,
    });
    await settle();
    await h.at(STALL_WAKE_MS);
    expect(h.told("builder")).toEqual([]);
  });

  // INF-4165 finding 3: the first mate asked about three held tasks on one
  // card of its own, and the app still raised a standing-still card for each.
  it("counts a first mate question that names the part in related as its question, and takes the app's card down", async () => {
    const h = harness();
    const { part } = workstream(h);
    await h.at(STALL_WAKE_MS);
    await h.at(STALL_WAKE_MS + minutes(1));
    expect(h.card(part.id)).toBeDefined();
    // The first mate's own decision, filed as emit_card files one without
    // task_id, whose related names the part.
    const asked = h.supervisor.cards.addFirstmateCard({
      title: "Three steps wait on things only you can do",
      body: "<p>Each waits on a step only you can take.</p>",
      actions: [
        { id: "wait", label: "Leave them waiting", default: true },
        { id: "start", label: "Start them" },
      ],
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const question = h.tasks.capture.fileDecision({
      id: "fm-question",
      title: "Three steps wait on things only you can do",
      cardId: asked,
    });
    h.tasks.graph.link(question.id, part.id, "related", "firstmate");
    await h.at(STALL_WAKE_MS + minutes(2));
    expect(h.card(part.id)).toBeUndefined();
    for (const later of [60, 600]) await h.at(minutes(later));
    expect(h.card(part.id)).toBeUndefined();
    expect(h.told(part.id)).toHaveLength(1);
    // Once that question is answered, the part stands again and is told anew.
    h.supervisor.cardActions.act(asked, "wait");
    await settle();
    await h.at(minutes(601) + STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(2);
  });

  it("does not count a first mate question that names other work, or a note naming the part", async () => {
    const h = harness();
    const { main, part } = workstream(h);
    const asked = h.supervisor.cards.addFirstmateCard({
      title: "Go on with the secrets work?",
      body: "<p>The owner is underway.</p>",
      actions: [
        { id: "go", label: "Go on", default: true },
        { id: "wait", label: "Wait" },
      ],
    });
    const told = h.supervisor.cards.addFirstmateCard({
      title: "Where the secrets work stands",
      body: "<p>Halfway.</p>",
      actions: [],
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const question = h.tasks.capture.fileDecision({
      id: "fm-other",
      title: "Go on?",
      cardId: asked,
    });
    h.tasks.graph.link(question.id, main.id, "related", "firstmate");
    // A note the first mate answered with: its record is a question, closed at birth.
    const note = h.tasks.capture.fileQuestion({
      id: "fm-note",
      title: "Where the secrets work stands",
      outcome: "<p>Halfway.</p>",
      cardId: told,
    });
    h.tasks.graph.link(note.id, part.id, "related", "firstmate");
    await h.at(STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(1);
  });

  it("leaves ideas filed for later alone: on-request work under a task that delivers an answer, or on its own", async () => {
    const h = harness();
    const plan = seedTask(h.tasks, {
      id: "plan",
      title: "Plan the secrets move",
      status: "idle",
      shape: { kind: "research", deliverable: "answer" },
      createdAt: h.start,
    });
    const idea = seedTask(h.tasks, {
      id: "idea",
      title: "Later: rotate every secret",
      parentId: plan.id,
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    const alone = seedTask(h.tasks, {
      id: "alone",
      title: "Someday: a secrets audit",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    for (const later of [10, 60, 600]) await h.at(minutes(later));
    expect(h.told(idea.id)).toEqual([]);
    expect(h.told(alone.id)).toEqual([]);
  });

  it("ends the walk at a live task that delivers an answer, even under a main task with a started part", async () => {
    // The captain's answer (b) on review INF-3891's ideas-under-live-plan-begun:
    // work filed under a live plan stays an idea for later, whatever started above it.
    const h = harness();
    const { main, part } = workstream(h);
    const plan = seedTask(h.tasks, {
      id: "plan",
      title: "Plan the callers' move",
      parentId: main.id,
      status: "idle",
      shape: { kind: "research", deliverable: "answer" },
      createdAt: h.start,
    });
    const idea = seedTask(h.tasks, {
      id: "idea",
      title: "Later: move the test callers",
      parentId: plan.id,
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    await h.at(STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(1);
    expect(h.told(idea.id)).toEqual([]);
  });

  it("reads an on-request task that delivers an answer itself, though ideas sit under it", async () => {
    // Review INF-3891's answer-parent-skipped-as-container: the walk never reads
    // the parts of an answer task, so the task must not be skipped for them.
    const h = harness();
    const { main } = workstream(h);
    const plan = seedTask(h.tasks, {
      id: "plan",
      title: "Plan the callers' move",
      parentId: main.id,
      status: "queued",
      startPolicy: "on-request",
      shape: { kind: "research", deliverable: "answer" },
      createdAt: h.start,
    });
    const idea = seedTask(h.tasks, {
      id: "idea",
      title: "Later: move the test callers",
      parentId: plan.id,
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    await h.at(STALL_WAKE_MS);
    expect(h.told(plan.id)).toHaveLength(1);
    expect(h.told(idea.id)).toEqual([]);
  });
  // INF-3928: a put-off (Not until…) is the captain holding the work, so no
  // standing-still wake or card follows one.
  it("leaves alone a part the captain put off, and started work in the backlog they put off, until the card is back and answered", async () => {
    const h = harness();
    const { part } = workstream(h);
    seedTask(h.tasks, { id: "parked", title: "Parked work", status: "idle", createdAt: h.start });
    h.supervisor.hostOps.moveToBacklog("parked", {
      actor: "firstmate",
      via: "tool",
      decision: null,
    });
    await settle();
    const asked = putOff(h, part.id, { kind: "word" });
    putOff(h, "parked", { kind: "date", at: h.start + minutes(60 * 24) });
    await settle();
    expect(h.supervisor.cards.putOffs.forTask(part.id)).toHaveLength(1);
    expect(h.supervisor.cards.putOffs.forTask("parked")).toHaveLength(1);
    for (const later of [10, 60, 600]) await h.at(minutes(later));
    expect(h.told(part.id)).toEqual([]);
    expect(h.told("parked")).toEqual([]);
    expect(h.card(part.id)).toBeUndefined();
    expect(h.card("parked")).toBeUndefined();

    // The captain's word brings the same card back, and their answer on it
    // ends the hold: the part stands again and the first mate hears once.
    expect(h.supervisor.cards.putOffs.raiseForTask(part.id)).toBe(1);
    await h.at(minutes(601));
    expect(h.told(part.id)).toEqual([]);
    h.supervisor.cardActions.act(asked, "wait");
    await settle();
    await h.at(minutes(601) + STALL_WAKE_MS);
    expect(h.told(part.id)).toHaveLength(1);
  });

  it("leaves alone the parts of a main task the captain put off", async () => {
    const h = harness();
    const { main, part } = workstream(h);
    putOff(h, main.id, { kind: "date", at: h.start + minutes(60 * 24) });
    await settle();
    for (const later of [10, 60, 600]) await h.at(minutes(later));
    expect(h.told(part.id)).toEqual([]);
    expect(h.card(part.id)).toBeUndefined();
  });

  it("reads the task a close put-off waits for as begun through it, from when the put-off was kept", async () => {
    const h = harness();
    const { part } = workstream(h);
    // On its own, on-request work is an idea for later.
    const settings = seedTask(h.tasks, {
      id: "settings",
      title: "Turn protected storage on",
      status: "queued",
      startPolicy: "on-request",
      createdAt: h.start,
    });
    await h.at(minutes(5));
    putOff(h, part.id, { kind: "close", task: settings.key });
    await settle();
    await h.at(minutes(5) + STALL_WAKE_MS - minutes(1));
    expect(h.told(settings.id)).toEqual([]);
    await h.at(minutes(5) + STALL_WAKE_MS);
    expect(h.told(part.id)).toEqual([]);
    expect(h.told(settings.id)).toHaveLength(1);
    expect(h.told(settings.id)[0]).toContain(
      `started work waits on it: ${part.key} "Read secrets through the owner"`,
    );
    await h.at(minutes(6) + STALL_WAKE_MS);
    expect(h.card(settings.id)?.title).toBe(nextMoveCardTitle("Turn protected storage on"));
    expect(h.card(part.id)).toBeUndefined();
  });
});
