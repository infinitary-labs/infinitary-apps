/**
 * A put-off choice ("Not until…", INF-3846 piece 3, the captain's approved
 * plan: "A card can offer Not until…, naming a merge, a date or your word.
 * The app keeps it and shows the same card again at that moment."). On the
 * merge card the captain ruled the awaited moment a task's close, "the more
 * common primitive for communicating dependency", in place of a merge. The
 * defect it answers: a choice "Decide after PR #496 merges" was a plain
 * button, the reminder lived in a note, and nobody asked again for two days
 * after the merge. The captain then ruled it rides Automation ("our
 * automation system already has an event driven design - aren't we
 * supposed to just listen to those events and support all of them as
 * moments?"), with "a task closes" as a new event. Each case drives a real
 * CrewSupervisor through the crew harness on the host's one clock
 * (tests/helpers/idleLadderHarness.ts) beside a real Scheduler wired as the
 * app wires it: the crewmate emits its card through its own tool, the
 * captain clicks it, and the test reads the stack, the rules, the record
 * and what the crewmate and first mate heard.
 */
import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { fakeCrewmate, fakeCrewTimersEachTest, intentOf } from "../../../tests/helpers/crewHarness";
import {
  idleLadderHarness,
  idleWakes,
  minutes,
  settle,
  wakesThroughInbox,
} from "../../../tests/helpers/idleLadderHarness";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import { bindTool } from "../session/tools";
import { ScheduleStore } from "../storage/scheduleStore";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "../tasks/seedTask";
import type { CrewmateSpec } from "./crewSession";
import { waitThroughAutomation } from "./putOffs";
import { Scheduler } from "./scheduler";
import { TASK_CLOSED_EVENT, TASK_EVENTS_ID, withTaskEvents } from "./taskEvents";

fakeCrewTimersEachTest();

const STORAGE_QUESTION = {
  id: "storage-on",
  title: "Turn protected storage on for integration secrets?",
  body: "<p>Moving the secrets needs protected storage on. The secrets settings change is still open, so I can ask again once it closes.</p>",
};

describe("a put-off choice the app keeps (Not until…)", () => {
  const { clock, clockedSetup } = idleLadderHarness();

  /** A started crewmate task, the awaited secrets settings task beside it, and its emit_card. */
  async function crewmateWithQuestion(readOnly = false, looks: "answer" | "fail" = "answer") {
    const crewmate = fakeCrewmate();
    const h = wakesThroughInbox(
      clockedSetup(crewmate, {
        ...(readOnly
          ? {
              classifier: {
                classify: async () =>
                  ({ kind: "research", source: "classifier:test", version: "kc1" }) as const,
              },
            }
          : {}),
      }),
    );
    const settings = seedTask(h.tasks, {
      id: "settings",
      title: "Secrets settings",
      status: "running",
    });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Move integration secrets into the secret manager",
      intent: readOnly
        ? {
            ...intentOf("say whether protected storage should be on for integration secrets"),
            constraints: [{ kind: "read-only" }],
          }
        : intentOf("move integration secrets into the secret manager"),
    });
    await settle();
    const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
    const endTurn = async () => {
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await settle();
    };
    const shown = () =>
      h.supervisor.cards.snapshot().find((card) => card.taskId === taskId) as Card | undefined;
    const heard = () => crewmate.promptCalls.join("\n");
    // Automation as services.ts builds it, with the task events and a
    // put-off rule's run raising its card.
    const putOffs = h.supervisor.cards.putOffs;
    const rules = new ScheduleStore(h.db);
    const feed: string[] = [];
    const scheduler = new Scheduler({
      store: rules,
      notify: () => null,
      broadcastEvent: (event) => {
        if (event.type === "firstmate_note") feed.push(event.text);
      },
      now: () => clock.now,
      events:
        looks === "answer"
          ? withTaskEvents(h.tasks)
          : {
              ...withTaskEvents(h.tasks),
              look: async () => {
                throw new Error("The task record could not be read.");
              },
            },
      raise: (cardId) => void putOffs.raiseCard(cardId),
    });
    waitThroughAutomation(putOffs, scheduler, h.tasks);
    /** One minute of the shared tick: Automation and the ready sweep, with their looks answered. */
    const tick = async () => {
      scheduler.tick(clock.now);
      await scheduler.settled();
      await h.supervisor.watch.sweepGates(clock.now);
      await settle();
      await scheduler.settled();
    };
    return {
      ...h,
      crewmate,
      taskId,
      settings,
      emitCard,
      endTurn,
      shown,
      heard,
      rules,
      feed,
      scheduler,
      tick,
    };
  }

  it("keeps the card until the task it names closes, quiet and nobody's to move, then raises the same card", async () => {
    const h = await crewmateWithQuestion();
    await h.emitCard.run({
      ...STORAGE_QUESTION,
      actions: [
        { id: "yes", label: "Turn it on", default: true },
        {
          id: "after-settings",
          label: `Not until ${h.settings.key} closes`,
          until: { kind: "close", task: h.settings.key },
        },
      ],
    });
    await h.endTurn();
    const card = h.shown() as Card;
    const prompts = h.crewmate.promptCalls.length;

    h.supervisor.cardActions.act(card.id, "after-settings");
    await settle();
    await h.scheduler.settled();

    // The card is off the stack, its author heard the choice like any other,
    // and the task stays open and unanswered. An Automation rule, turned on
    // since the click was the captain's, waits for the task's close.
    expect(h.shown()).toBeUndefined();
    expect(h.crewmate.promptCalls.slice(prompts).join("\n")).toContain(
      `Not until ${h.settings.key} closes`,
    );
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "active", closedReason: null });
    expect(h.supervisor.cards.putOffs.forTask(h.taskId)).toEqual([
      expect.objectContaining({
        putOff: expect.objectContaining({
          action: "after-settings",
          until: { kind: "close", task: h.settings.id },
        }),
      }),
    ]);
    // The rule's making says so in the feed, as any rule's does.
    expect(h.feed).toEqual([
      expect.stringContaining(`Show the card "${STORAGE_QUESTION.title}" again`),
    ]);
    expect(h.rules.list()).toEqual([
      expect.objectContaining({
        state: "enabled",
        card: card.id,
        spec: {
          kind: "event",
          integration: TASK_EVENTS_ID,
          event: TASK_CLOSED_EVENT,
          filter: { task: h.settings.id },
        },
      }),
    ]);

    // Hours of idle with the task stopped by the captain: no nudge, no wake
    // to the first mate and no stall card.
    await h.endTurn();
    const idleSince = h.tasks.get(h.taskId)?.idleSince ?? clock.now;
    for (const at of [10, 30, 60, 120, 240]) {
      clock.now = idleSince + minutes(at);
      h.supervisor.watch.reconcileIdle(clock.now);
      await h.tick();
    }
    expect(idleWakes(h.ops)).toEqual([]);
    // The task reads as waiting on another task's work.
    expect(h.supervisor.postures.workPosture(h.tasks.get(h.taskId) as TaskRecord)).toMatchObject({
      state: "idle",
      reason: "dependency",
    });
    expect(h.supervisor.cards.snapshot().map((shown) => shown.id)).not.toContain(
      `card-stall-${h.taskId}`,
    );
    expect(h.shown()).toBeUndefined();

    // The awaited task closes, here dropped without merging: any close brings
    // the same card back at once, waiting on the captain, before any tick.
    h.tasks.close(h.settings.id, { status: "dropped", reason: "cancelled", actor: "captain" });
    await h.scheduler.settled();
    await settle();
    const back = h.shown() as Card;
    expect(back).toMatchObject({ id: card.id, title: STORAGE_QUESTION.title, body: card.body });
    expect(back.actions.map((action) => action.id)).toEqual(
      card.actions.map((action) => action.id),
    );
    expect(h.tasks.get(h.taskId)?.gate).toMatchObject({ kind: "captain", ref: card.id });
    expect(h.supervisor.cards.putOffs.forTask(h.taskId)).toEqual([]);
    // The rule ran once, raising the card, and leaves Automation finished.
    await h.tick();
    expect(h.rules.list()).toEqual([]);

    // Its answer now is an ordinary choice.
    h.supervisor.cardActions.act(card.id, "yes");
    await settle();
    expect(h.shown()).toBeUndefined();
    expect(h.supervisor.cards.putOffs.forTask(h.taskId)).toEqual([]);
  });

  it("raises a put-off on a date when that time comes, and not before", async () => {
    const h = await crewmateWithQuestion();
    const at = new Date(clock.now + minutes(90)).toISOString();
    await h.emitCard.run({
      ...STORAGE_QUESTION,
      actions: [
        { id: "yes", label: "Turn it on", default: true },
        { id: "later", label: "Not until later today", until: { kind: "date", at } },
      ],
    });
    await h.endTurn();
    const card = h.shown() as Card;
    h.supervisor.cardActions.act(card.id, "later");
    await settle();
    expect(h.rules.list()).toEqual([
      expect.objectContaining({ card: card.id, spec: { kind: "once", at: Date.parse(at) } }),
    ]);
    // A rule brings it back, so the task reads as waiting on that moment.
    await h.endTurn();
    expect(h.supervisor.postures.workPosture(h.tasks.get(h.taskId) as TaskRecord)).toMatchObject({
      state: "idle",
      reason: "dependency",
    });

    clock.now += minutes(89);
    await h.tick();
    expect(h.shown()).toBeUndefined();

    clock.now += minutes(1);
    await h.tick();
    expect(h.shown()?.id).toBe(card.id);
  });

  it("keeps a put-off until the captain's word, which the first mate passes on", async () => {
    const h = await crewmateWithQuestion();
    await h.emitCard.run({
      ...STORAGE_QUESTION,
      actions: [
        { id: "yes", label: "Turn it on", default: true },
        { id: "ask-me", label: "Not until I say", until: { kind: "word" } },
      ],
    });
    await h.endTurn();
    const card = h.shown() as Card;
    h.supervisor.cardActions.act(card.id, "ask-me");
    await settle();
    expect(h.rules.list()).toEqual([]);
    // Only the captain brings it back, so the task waits on the captain.
    await h.endTurn();
    expect(h.supervisor.postures.workPosture(h.tasks.get(h.taskId) as TaskRecord)).toMatchObject({
      state: "idle",
      reason: "captain",
    });

    clock.now += minutes(60 * 24 * 7);
    await h.tick();
    expect(h.shown()).toBeUndefined();

    expect(h.supervisor.cards.putOffs.raiseForTask(h.taskId)).toBe(1);
    expect(h.shown()?.id).toBe(card.id);
  });

  it("waits for any event an Automation rule can wait for, named as a rule names it", async () => {
    const h = await crewmateWithQuestion();
    await h.emitCard.run({
      ...STORAGE_QUESTION,
      actions: [
        { id: "yes", label: "Turn it on", default: true },
        {
          id: "after-settings",
          label: "Not until the settings task closes",
          until: {
            kind: "event",
            integration: "Tasks",
            event: TASK_CLOSED_EVENT,
            filter: { task: h.settings.key },
          },
        },
      ],
    });
    await h.endTurn();
    const card = h.shown() as Card;
    h.supervisor.cardActions.act(card.id, "after-settings");
    await settle();
    await h.scheduler.settled();
    expect(h.rules.list()).toEqual([
      expect.objectContaining({ card: card.id, spec: expect.objectContaining({ kind: "event" }) }),
    ]);

    await h.tick();
    expect(h.shown()).toBeUndefined();
    h.tasks.close(h.settings.id, { status: "done", reason: "merged", actor: "captain" });
    await h.scheduler.settled();
    await settle();
    expect(h.shown()?.id).toBe(card.id);
  });

  it("brings the card back at once when its rule cannot take its place in the event", async () => {
    const h = await crewmateWithQuestion(false, "fail");
    await h.emitCard.run({
      ...STORAGE_QUESTION,
      actions: [
        { id: "yes", label: "Turn it on", default: true },
        {
          id: "after-settings",
          label: `Not until ${h.settings.key} closes`,
          until: { kind: "close", task: h.settings.key },
        },
      ],
    });
    await h.endTurn();
    const card = h.shown() as Card;
    h.supervisor.cardActions.act(card.id, "after-settings");
    await settle();
    await h.scheduler.settled();
    await settle();
    expect(h.shown()?.id).toBe(card.id);
    expect(h.supervisor.cards.putOffs.kept(card.id)).toBeUndefined();
  });

  it("does not close an answer task: its answer is only put off", async () => {
    const h = await crewmateWithQuestion(true);
    expect(h.tasks.get(h.taskId)?.shape).toMatchObject({ deliverable: "answer" });
    await h.emitCard.run({
      ...STORAGE_QUESTION,
      actions: [
        { id: "yes", label: "Turn it on", default: true },
        { id: "ask-me", label: "Not until I say", until: { kind: "word" } },
      ],
    });
    await h.endTurn();
    h.supervisor.cardActions.act((h.shown() as Card).id, "ask-me");
    await settle();
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "active", closedReason: null });
  });

  it("lets go of a put-off whose own task closed, raising nothing", async () => {
    const h = await crewmateWithQuestion();
    await h.emitCard.run({
      ...STORAGE_QUESTION,
      actions: [
        { id: "yes", label: "Turn it on", default: true },
        {
          id: "after-settings",
          label: `Not until ${h.settings.key} closes`,
          until: { kind: "close", task: h.settings.key },
        },
      ],
    });
    await h.endTurn();
    h.supervisor.cardActions.act((h.shown() as Card).id, "after-settings");
    await settle();
    expect(h.rules.list()).toHaveLength(1);
    const made = h.feed.length;
    h.tasks.close(h.taskId, { status: "dropped", reason: "cancelled", actor: "captain" });
    expect(h.rules.list()).toEqual([]);
    // Taking the rule away says so in the feed, as any rule's deletion does.
    expect(h.feed.slice(made)).toEqual([
      expect.stringContaining(`Show the card "${STORAGE_QUESTION.title}" again`),
    ]);
    h.tasks.close(h.settings.id, { status: "done", reason: "merged", actor: "captain" });
    await h.tick();
    expect(h.supervisor.cards.snapshot().some((card) => card.taskId === h.taskId)).toBe(false);
    expect(h.cardStore.listPutOff()).toEqual([]);
  });

  it("lets go of a put-off on a card with no task once the row its click left open closes", async () => {
    // The careful review of the rebuild: a card with no task of its own
    // belongs to the row its click left open, and closing that row must let
    // the put-off and its rule go, not raise the card later with no row.
    const h = await crewmateWithQuestion();
    const cardId = "host-storage";
    h.supervisor.cards.hostCards.raiseHostCard({
      id: cardId,
      title: STORAGE_QUESTION.title,
      meta: "host",
      body: STORAGE_QUESTION.body,
      actions: [
        { id: "yes", label: "Turn it on", default: true },
        {
          id: "after-settings",
          label: `Not until ${h.settings.key} closes`,
          until: { kind: "close", task: h.settings.id },
        },
      ],
    });
    await settle();
    const row = h.tasks.capture.openCardTaskFor(cardId);
    expect(row).toBeDefined();
    h.supervisor.cardActions.act(cardId, "after-settings");
    await settle();
    await h.scheduler.settled();
    expect(h.supervisor.cards.putOffs.forTask(row?.id ?? "")).toHaveLength(1);
    expect(h.rules.list()).toHaveLength(1);

    h.tasks.close(row?.id ?? "", { status: "dropped", reason: "cancelled", actor: "captain" });
    expect(h.supervisor.cards.putOffs.kept(cardId)).toBeUndefined();
    expect(h.rules.list()).toEqual([]);
    h.tasks.close(h.settings.id, { status: "done", reason: "merged", actor: "captain" });
    await h.tick();
    expect(h.supervisor.cards.snapshot().map((card) => card.id)).not.toContain(cardId);
  });

  it("wakes the first mate to start the task a close put-off awaits while nobody has started it", async () => {
    // The careful review of the rebuild: a put-off waiting on a task nobody
    // started would wait forever, so that task counts among the waits, as a
    // declared wait on unstarted work does, and the first mate hears it.
    const h = await crewmateWithQuestion();
    const rotation = seedTask(h.tasks, {
      id: "rotation",
      title: "Rotate the integration keys",
      status: "queued",
      startPolicy: "on-request",
    });
    await h.emitCard.run({
      ...STORAGE_QUESTION,
      actions: [
        { id: "yes", label: "Turn it on", default: true },
        {
          id: "after-rotation",
          label: `Not until ${rotation.key} closes`,
          until: { kind: "close", task: rotation.key },
        },
      ],
    });
    await h.endTurn();
    h.supervisor.cardActions.act((h.shown() as Card).id, "after-rotation");
    await settle();

    h.crewmate.emit({
      type: "assistant_delta",
      taskId: h.taskId,
      text: "Waiting on the key rotation.",
    });
    await h.endTurn();
    expect(h.sorts.at(-1)).toEqual({
      taskId: h.taskId,
      verdict: "captain",
      rule: "waits-unstarted",
    });
    expect(h.ops.filter((line) => line.includes("reported on task")).at(-1)).toContain(
      `It waits on ${rotation.key} "Rotate the integration keys" (not started)`,
    );
    expect(h.supervisor.postures.workPosture(h.tasks.get(h.taskId) as TaskRecord)).toMatchObject({
      state: "idle",
      reason: "dependency",
    });
  });

  it("refuses a put-off the app could never see come true, naming the fix", async () => {
    const h = await crewmateWithQuestion();
    const offer = (until: {
      kind: "close" | "date" | "event" | "word";
      task?: string;
      at?: string;
      integration?: string;
      event?: string;
      filter?: Record<string, string>;
    }) =>
      h.emitCard.run({
        ...STORAGE_QUESTION,
        actions: [
          { id: "yes", label: "Turn it on", default: true },
          { id: "later", label: "Not until then", until },
        ],
      });
    await expect(offer({ kind: "close", task: "INF-999999" })).rejects.toThrow(
      'until task "INF-999999" names no task',
    );
    await expect(
      offer({ kind: "date", at: new Date(clock.now - minutes(1)).toISOString() }),
    ).rejects.toThrow("has already passed");
    await expect(offer({ kind: "date", at: "after lunch" })).rejects.toThrow("is not a time");
    await expect(offer({ kind: "event", integration: "Mail", event: "message" })).rejects.toThrow(
      'Nothing connected tells "message" from "Mail"',
    );
    // The task-close event names its task as a rule does; one that names no
    // task could only fire at once, so it is refused too.
    await expect(
      offer({
        kind: "event",
        integration: TASK_EVENTS_ID,
        event: TASK_CLOSED_EVENT,
        filter: { task: "INF-999999" },
      }),
    ).rejects.toThrow('No task is named "INF-999999"');
    h.tasks.close(h.settings.id, { status: "done", reason: "merged", actor: "captain" });
    await expect(offer({ kind: "close", task: h.settings.key })).rejects.toThrow(
      "has already closed",
    );
    expect(h.shown()).toBeUndefined();
  });
});
