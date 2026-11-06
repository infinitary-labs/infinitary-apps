import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANSWER_DONE_LABEL } from "@shared/cardLeave";
import type { Card } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import {
  completionBody,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  handedCard,
  intentOf,
  SETTLE_MERGE,
  type SetupExtras,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import {
  ABANDON,
  APPROVE_AND_BUILD,
  SAVE_AND_DEFER,
  START_THE_NEXT_STEP,
} from "../prompts/cardContract";
import type { EmittedAction } from "../session/tools";
import { FIRSTMATE_RECIPIENT, type InboxStore } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskStore";
import { seedTask } from "../tasks/seedTask";
import { seedProject } from "../workspace/seedProject";
import { isCardClosedSteer } from "./captainWakes";
import type { CrewmateSpec } from "./crewSession";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

/**
 * The deliverable axis (crew-posture rationalization Task B, captain
 * rulings F1-F4 and "make sure the crewmate doesn't attempt to commit
 * changes or raise PRs"). An answer task is a first-class fact on the
 * record: derived by the host, told the truth in its brief, refused every
 * way of shipping, and closed when the captain resolves its card.
 */
describe("the deliverable axis (Task B)", () => {
  const research = {
    classify: async () =>
      ({ kind: "research", source: "classifier:xai/grok-cheap", version: "kc1-abc" }) as const,
  };

  async function investigation(crewmate: FakeCrewmate, extras: SetupExtras = {}) {
    const harness = setup(crewmate, { classifier: research, ...extras });
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Why is the meter idle",
      intent: { ...intentOf("why is nothing running?"), constraints: [{ kind: "read-only" }] },
    });
    await tick();
    return { ...harness, taskId };
  }

  it("stamps the deliverable on the record and tells the crewmate it ships nothing", async () => {
    const crewmate = fakeCrewmate();
    const { tasks, taskId } = await investigation(crewmate);
    expect(tasks.get(taskId)?.shape).toMatchObject({ kind: "research", deliverable: "answer" });
    const brief = crewmate.promptCalls[0] ?? "";
    // The three facts an answer task is told, and the two lines it is not.
    expect(brief).toContain("this task's deliverable is an answer, not a change");
    expect(brief).toContain("commit nothing, push nothing, and open no pull request");
    expect(brief).toContain("Care: none - this task ships nothing");
    expect(brief).not.toContain("Delivery: ");
    expect(brief).not.toContain("Care: Default");
    // And no rigor is stamped either: the record says it ships nothing.
    expect(tasks.get(taskId)?.shape?.rigor).toBeUndefined();
  });

  it("refuses merge-pr and land on an answer task, and keeps discard", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, taskId } = await investigation(crewmate);
    for (const mode of ["merge-pr", "land"] as const) {
      expect(
        await supervisor.settling.settle.settleTask(taskId, mode, true, "firstmate"),
      ).toContain("delivers an answer, not a change");
    }
    expect(tasks.get(taskId)?.status).toBe("active");
    await supervisor.settling.settle.settleTask(taskId, "discard", true, "captain");
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
  });

  it("refuses a card carrying a settle effect: an answer task emits no completion card", async () => {
    const crewmate = fakeCrewmate();
    const { specs, taskId } = await investigation(crewmate);
    expect(taskId).toBeTruthy();
    expect(() =>
      specs[0]?.onCard?.({
        requiredActions: [],
        title: "Ready to merge",
        body: completionBody("<p>Found it.</p>"),
        actions: [{ id: "merge", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
      }),
    ).toThrow(/deliverable is an answer/);
  });

  it("closes done/answered when the captain chooses on its crewmate's card", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs, cards, inbox, taskId } = await investigation(crewmate);
    specs[0]?.onCard?.({
      title: "The meter is idle because the claim query filters on repo_id",
      body: "<p>The claim query filters on repo_id.</p><p>Seven idle rows share an empty repo_id; the query skips every one.</p>",
      actions: [
        { id: "noted", label: "Got it", default: true },
        { id: "dig", label: "Dig further" },
      ],
    });
    await tick();
    const card = cards().find((entry) => entry.taskId === taskId) as Card;
    specs[0]?.onReport?.("The decision is ready.");
    supervisor.cardActions.act(card.id, "noted");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
    expect(tasks.timeline(taskId).some((event) => event.text.includes('chose "Got it"'))).toBe(
      true,
    );
    const wake = inbox.pending(FIRSTMATE_RECIPIENT)[0];
    expect(wake).toMatchObject({ ref: taskId, origin: "agent" });
    expect(JSON.parse(wake ? renderWake(wake).replace("[fm-op] ", "") : "{}")).toEqual({
      version: 1,
      event: "answer_task_closed",
      task: { id: taskId, key: tasks.get(taskId)?.key, title: "Why is the meter idle" },
      card: { id: card.id, title: "The meter is idle because the claim query filters on repo_id" },
      choice: { id: "noted", label: "Got it", effect: null },
      close: { status: "done", reason: "answered", actor: "captain" },
      read: { tool: "tasks", arguments: { key: tasks.get(taskId)?.key } },
      next: `This receipt is not the plan. For any choice that files, starts or saves work, use read to recover the full report, closing offer and submitted answers before acting. Judge the choice by meaning, not its label: ${APPROVE_AND_BUILD}, ${START_THE_NEXT_STEP} and ${SAVE_AND_DEFER} are examples, not an allowlist. Routine acknowledgements and choices that abandon work (for example, ${ABANDON}) need no read. Follow HANDOFF: reuse an existing successor for authorized work, save deferred work unstarted, and keep design-only and later gates.`,
    });
    expect(crewmate.steer).not.toHaveBeenCalled();
  });

  /**
   * INF-1226: INF-1220 asked the captain's consent to sign a test app, and
   * the captain's allow closed the task answered before anything was
   * signed. A card its crewmate declares `continues` is something it goes
   * on from, not its answer: the choice reaches the crewmate, and its
   * answer card's choice closes the task. (`asking` alone is no such
   * declaration: a planner's question card still closes its plan, as
   * "parent tasks with planned children" holds.)
   */
  it("keeps the task open and steers its crewmate when the captain chooses on a card it declared continues", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs, cards, inbox, taskId } = await investigation(crewmate);
    const consent = {
      title: "Allow signing the Secrets test app on the Mac mini?",
      body: "<p>I rebuilt INF-1109's unsigned Secrets test app on Kun's Mac mini.</p><p>Signing it needs your permission to use your Developer ID identity there.</p>",
      continues: true as const,
      actions: [
        { id: "leave-blocked", label: "Leave blocked" },
        { id: "allow-mac-mini-signing", label: "Allow signing on the Mac mini", default: true },
      ],
    };
    specs[0]?.onCard?.(consent);
    await tick();
    const asked = cards().find((entry) => entry.taskId === taskId) as Card;
    specs[0]?.onReport?.(
      "The unsigned test app is rebuilt; signing waits on the captain's consent.",
    );
    crewmate.finishPrompt();
    await tick();

    supervisor.cardActions.act(asked.id, "allow-mac-mini-signing");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "active" });
    expect(crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: {
          kind: "card-choice",
          to: "crewmate",
          source: "chrome",
          card: { title: consent.title },
          choice: { id: "allow-mac-mini-signing", label: "Allow signing on the Mac mini" },
        },
      }),
    );
    expect(inbox.pending(FIRSTMATE_RECIPIENT)).toEqual([]);

    // Its answer, on a card it does not go on from, closes it.
    specs[0]?.onCard?.({
      title: "The Secrets test app is signed with your Developer ID identity",
      body: "<p>Every signature names team 9T2J7MNUP9.</p><p>Each has hardened runtime and a timestamp.</p>",
      actions: [
        { id: "noted", label: "Got it", default: true },
        { id: "recheck", label: "Check the signatures again" },
      ],
    });
    await tick();
    const answer = cards().find((entry) => entry.taskId === taskId) as Card;
    specs[0]?.onReport?.("The Mac mini signed the Secrets test app.");
    supervisor.cardActions.act(answer.id, "noted");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
    expect(answerClosedWakes(inbox)).toEqual([
      expect.objectContaining({
        event: "answer_task_closed",
        card: { id: answer.id, title: answer.title },
        choice: { id: "noted", label: "Got it", effect: null },
      }),
    ]);
  });

  /**
   * INF-990 friction 7: INF-945 carried no read-only constraint, its goal
   * asked for a preview before the buttons were built, the classifier
   * called it a plan, and the captain's "Build with this look" on the
   * preview closed the build as answered mid-work.
   */
  it("keeps a build with no read-only constraint open when its preview card is chosen on, whatever the classifier calls it", async () => {
    const crewmate = fakeCrewmate();
    let asked = 0;
    const harness = setup(crewmate, {
      classifier: {
        classify: async () => {
          asked += 1;
          return { kind: "plan", source: "classifier:xai/grok-cheap", version: "kc1-abc" };
        },
      },
    });
    const { supervisor, tasks, specs, cards } = harness;
    const { taskId } = await supervisor.intake.commission({
      title: "Build the agreed iOS app card, Activity and tab fixes",
      intent: {
        goal: "Build the approved INF-944 plan for the Infinitary iOS app as one change. Before deciding the action buttons, first show the captain a playable preview comparing the Mac's row buttons with glass buttons on its own card, and build the buttons only after he picks.",
        userWords: "the action buttons are WAY too big... looking very odd on the phone.",
        constraints: [
          {
            kind: "free",
            text: "implement: on request until I accept, then Queued. Ground it on the plan (basis) - its recorded spec and my choice - from the plan's branch if it has one; on Save and defer it waits on request until I press Start or ask. The simplest change that meets the accepted plan.",
          },
        ],
      },
    });
    await tick();
    expect(asked).toBe(1);
    expect(tasks.get(taskId)?.shape).toMatchObject({ kind: "plan", deliverable: "change" });
    const brief = crewmate.promptCalls[0] ?? "";
    expect(brief).not.toContain("deliverable is an answer");
    expect(brief).toContain("Delivery: ");
    specs[0]?.onCard?.({
      title: "Pick the look for the phone card's choices",
      body: "<p>I recommend the Mac's row for the card's choices.</p><p>Both looks keep the Mac's size.</p>",
      asking: true,
      actions: [
        { id: "hold-build", label: "Hold the build" },
        { id: "build-with-pick", label: "Build with this look", default: true },
      ],
    });
    await tick();
    const card = cards().find((entry) => entry.taskId === taskId) as Card;
    specs[0]?.onReport?.("The preview is up; I build the rest of the approved plan meanwhile.");
    supervisor.cardActions.act(card.id, "build-with-pick");
    await tick();
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(crewmate.aborts).toHaveLength(0);
  });

  /**
   * INF-721 friction 1: "A card choice outranks a cancel: the task closes as
   * answered and the first mate hears it". INF-648's crewmate was mid-turn
   * when the captain chose "Free the lock and restart both" on this card;
   * the answered close stopped that turn, the turn's end closed the task
   * cancelled, and the first mate never heard the choice.
   */
  const STUCK_JOBS_CARD = {
    title: "Both Mac journey jobs are stuck at the check lock and have run nothing",
    body: "<p>Yes, both jobs are stuck: neither has run a single journey.</p><p>Both have waited at the Mac mini's check lock since 9:52 AM.</p>",
    actions: [
      { id: "free-only", label: "Only free the lock" },
      { id: "leave", label: "Leave them" },
      { id: "free-and-restart", label: "Free the lock and restart both", default: true },
    ],
  };

  /** The first mate's one wake about the close: the receipt of the captain's choice. */
  function answerClosedWakes(inbox: InboxStore) {
    return inbox
      .pending(FIRSTMATE_RECIPIENT)
      .map((row) => JSON.parse(renderWake(row).replace("[fm-op] ", "")));
  }

  const CHOSE_FREE_AND_RESTART = expect.objectContaining({
    event: "answer_task_closed",
    choice: { id: "free-and-restart", label: "Free the lock and restart both", effect: null },
    close: { status: "done", reason: "answered", actor: "captain" },
  });

  // A backend ends a stopped turn before its abort returns (Pi waits for
  // idle; a computer that runs work lets the waiting prompt go) or after it.
  it.each([
    ["before", true],
    ["after", false],
  ])(
    "closes answered and wakes the first mate when the chosen-on turn ends %s the close (INF-721)",
    async (_order, endsWithAbort) => {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks, specs, cards, inbox, taskId } = await investigation(crewmate);
      specs[0]?.onCard?.(STUCK_JOBS_CARD);
      await tick();
      const card = cards().find((entry) => entry.taskId === taskId) as Card;
      specs[0]?.onReport?.("Both jobs are stuck, not slow.", undefined, {
        wait: { reason: "choose the next move", cardId: card.id },
      });
      crewmate.finishPrompt();
      await tick();
      // A steer starts another turn, and the captain chooses while it runs.
      await supervisor.steer.steerCrewmate(taskId, "INF-599's helpers still hold the lock.");
      await tick();
      expect(tasks.get(taskId)?.activity).toBe("running");
      if (endsWithAbort) {
        crewmate.abort = async () => {
          crewmate.aborts.push(undefined);
          crewmate.finishPrompt();
        };
      }
      supervisor.cardActions.act(card.id, "free-and-restart");
      await tick();
      if (!endsWithAbort) {
        crewmate.finishPrompt();
        await tick();
      }
      expect(crewmate.aborts).toHaveLength(1);
      expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
      expect(answerClosedWakes(inbox)).toEqual([CHOSE_FREE_AND_RESTART]);
    },
  );

  it.each(["cancel", "choice"])(
    "closes answered when a cancel and the choice land at once, the %s first (INF-721)",
    async (first) => {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks, specs, cards, inbox, taskId } = await investigation(crewmate);
      specs[0]?.onCard?.(STUCK_JOBS_CARD);
      await tick();
      const card = cards().find((entry) => entry.taskId === taskId) as Card;
      specs[0]?.onReport?.("Both jobs are stuck, not slow.");
      let cancelled: Promise<void>;
      if (first === "cancel") {
        cancelled = supervisor.sessions.interruptCrewmate(taskId, "cancel");
        supervisor.cardActions.act(card.id, "free-and-restart");
      } else {
        supervisor.cardActions.act(card.id, "free-and-restart");
        cancelled = supervisor.sessions.interruptCrewmate(taskId, "cancel");
      }
      await cancelled;
      crewmate.finishPrompt();
      await tick();
      expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
      expect(answerClosedWakes(inbox)).toEqual([CHOSE_FREE_AND_RESTART]);
    },
  );

  it.each([
    "Got it",
    ABANDON,
    APPROVE_AND_BUILD,
    START_THE_NEXT_STEP,
    SAVE_AND_DEFER,
    "Start the fix",
    "Implement the correction",
  ])("serves recovery guidance by meaning, not the label %s", async (label) => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards, inbox, taskId, tasks } = await investigation(crewmate);
    specs[0]?.onCard?.({
      title: "The meter is idle",
      body: "<p>The claim query filters on repo_id.</p><p>Seven idle rows.</p>",
      actions: [
        { id: "noted", label, default: true },
        { id: "dig", label: "Dig further" },
      ],
    });
    await tick();
    const card = cards().find((entry) => entry.taskId === taskId) as Card;
    specs[0]?.onReport?.("The decision is ready.");
    supervisor.cardActions.act(card.id, "noted");
    await tick();
    const key = tasks.get(taskId)?.key;
    expect(inbox.pending(FIRSTMATE_RECIPIENT).map(renderWake)).toEqual([
      `[fm-op] {"version":1,"event":"answer_task_closed","task":{"id":"${taskId}","key":"${key}","title":"Why is the meter idle"},"card":{"id":"${card.id}","title":"The meter is idle"},"choice":{"id":"noted","label":"${label}","effect":null},"close":{"status":"done","reason":"answered","actor":"captain"},"read":{"tool":"tasks","arguments":{"key":"${key}"}},"next":"This receipt is not the plan. For any choice that files, starts or saves work, use read to recover the full report, closing offer and submitted answers before acting. Judge the choice by meaning, not its label: ${APPROVE_AND_BUILD}, ${START_THE_NEXT_STEP} and ${SAVE_AND_DEFER} are examples, not an allowlist. Routine acknowledgements and choices that abandon work (for example, ${ABANDON}) need no read. Follow HANDOFF: reuse an existing successor for authorized work, save deferred work unstarted, and keep design-only and later gates."}`,
    ]);
  });

  it("hands a direct effect to the shell and reports it to Firstmate without steering twice", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, inbox, specs, cards, taskId } = await investigation(crewmate);
    specs[0]?.onCard?.({
      title: "Open the setting",
      body: "<p>Continue in Settings.</p><p>The setting is available there.</p>",
      actions: [
        {
          id: "open",
          label: "Open settings",
          default: true,
          effect: { kind: "open", target: "settings" },
        },
        { id: "stay", label: "Stay here" },
      ],
    });
    await tick();
    const card = cards().find((entry) => entry.taskId === taskId) as Card;
    specs[0]?.onReport?.("The decision is ready.");
    expect(supervisor.cardActions.act(card.id, "open")).toEqual({
      effect: { kind: "open", target: "settings" },
    });
    await tick();
    const pending = inbox.pending(FIRSTMATE_RECIPIENT)[0];
    const payload = JSON.parse(pending ? renderWake(pending).replace("[fm-op] ", "") : "");
    expect(payload.choice).toEqual({
      id: "open",
      label: "Open settings",
      effect: { kind: "open", target: "settings" },
    });
    expect(crewmate.steer).not.toHaveBeenCalled();
  });

  // INF-2794: the minus reaches nobody; only Got it gives the note's author its turn.
  it("INF-1879: Got it on an unmarked note neither finishes nor creates a Done receipt", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs, cards, inbox, ops, taskId } = await investigation(crewmate);
    specs[0]?.onCard?.({ title: "The answer", body: "<p>Found it.</p>", actions: [] });
    await tick();
    const card = cards().find((entry) => entry.taskId === taskId) as Card;
    specs[0]?.onReport?.("The answer is on its card for the captain to read.", undefined, {
      wait: { reason: "read the answer", cardId: card.id },
    });
    crewmate.finishPrompt();
    await tick();
    expect(inbox.pending(FIRSTMATE_RECIPIENT)).toEqual([]);
    const opsBefore = ops.length;

    // An unmarked note gives its author a turn, not a task receipt or ending.
    const promptsBeforeRead = crewmate.promptCalls.length;
    supervisor.close(card.id);
    await tick();
    expect(crewmate.promptCalls).toHaveLength(promptsBeforeRead);
    supervisor.pressNote(card.id);
    await tick();
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(crewmate.promptCalls).toHaveLength(promptsBeforeRead + 1);
    expect(crewmate.promptCalls.at(-1)).toContain(
      renderWake({
        facts: { kind: "card-closed", card: { id: card.id, title: card.title }, read: true },
      }),
    );
    expect(tasks.get(taskId)?.gate).toBeNull();
    expect(ops.slice(opsBefore)).toEqual([]);
    expect(supervisor.hostOps.runTaskOp(taskId, "answer-done")).toContain("no answer ready");
    expect(tasks.get(taskId)?.status).toBe("active");
  });

  // INF-1879 replaces INF-1732's implicit close receipt with explicit Done.
  async function answerCardUp(crewmate: FakeCrewmate, actions: EmittedAction[] = []) {
    const harness = await investigation(crewmate);
    harness.specs[0]?.onCard?.({
      title: "The answer",
      body: "<p>INF-1718 stayed open because no report set the finished flag.</p>",
      actions,
      answering: true,
    });
    await tick();
    const card = harness.cards().find((entry) => entry.taskId === harness.taskId) as Card;
    harness.specs[0]?.onReport?.("The answer is on its card for the captain to read.", undefined, {
      wait: { reason: "read the answer", cardId: card.id },
    });
    crewmate.finishPrompt();
    await tick();
    return { ...harness, card };
  }

  it("closes the answer task answered when the captain presses Done on its marked answer note, with no finished report (INF-1732)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, taskId, card } = await answerCardUp(crewmate);
    const prompts = crewmate.promptCalls.length;
    supervisor.close(card.id);
    await tick();
    expect(tasks.get(taskId)?.status).toBe("active");
    supervisor.watch.reconcileIdle(card.createdAt + 30 * 24 * 60 * 60 * 1000);
    await tick();
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(crewmate.promptCalls).toHaveLength(prompts);
    expect(supervisor.hostOps.runTaskOp(taskId, "answer-done")).toBeUndefined();
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
    // The task is closed: its crewmate has no close left to judge.
    expect(crewmate.promptCalls.slice(prompts).filter(isCardClosedSteer)).toEqual([]);
  });

  it("INF-1879: a finished report's receipt still leaves an answer put aside waiting for explicit Done", async () => {
    const { supervisor, tasks, specs, taskId, card } = await answerCardUp(fakeCrewmate());
    supervisor.close(card.id);
    await tick();
    expect(supervisor.cards.snapshot().find((entry) => entry.id === card.id)?.minimized).toBe(true);
    const receipt = specs[0]?.onReport?.("The answer is complete.", undefined, { finished: true });
    expect(receipt).toContain(ANSWER_DONE_LABEL);
    expect(tasks.get(taskId)?.status).toBe("active");
  });

  it("INF-1879: a declared choice id matching the host Done operation keeps its ordinary choice semantics", async () => {
    const { supervisor, tasks, taskId, card } = await answerCardUp(fakeCrewmate(), [
      { id: "answer-done", label: "Accept this answer", default: true },
      { id: "more", label: "Investigate further" },
    ]);
    supervisor.cardActions.act(card.id, "answer-done");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
  });

  it("keeps the answer task open when the captain closes a decision marked answering without choosing (INF-1732)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, taskId, card } = await answerCardUp(crewmate, [
      { id: "file", label: "File the fix", default: true },
      { id: "leave", label: "Leave it" },
    ]);
    supervisor.close(card.id);
    await tick();
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(crewmate.promptCalls.some(isCardClosedSteer)).toBe(false);
  });

  it("keeps the answer task open when the captain closes a marked answer note whose reply waits on its crewmate (INF-1732)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, taskId, card } = await answerCardUp(crewmate);
    await supervisor.cardActions.replyToCard(card.id, "but why did the flag not get set?");
    await tick();
    supervisor.close(card.id);
    await tick();
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(supervisor.cards.snapshot().find((entry) => entry.id === card.id)?.minimized).toBe(true);
    expect(supervisor.hostOps.runTaskOp(taskId, "answer-done")).toContain("no answer ready");
  });

  /**
   * FI3-1581: the captain closes the crewmate's answer card, the crewmate
   * reports finished, and Firstmate then puts its own card on that task.
   */
  async function dismissedAndFinished(crewmate: FakeCrewmate) {
    const harness = await investigation(crewmate);
    const { supervisor, specs, cards, taskId } = harness;
    specs[0]?.onCard?.({ title: "Mac CI costs", body: "<p>Found it.</p>", actions: [] });
    await tick();
    const card = cards().find((entry) => entry.taskId === taskId) as Card;
    specs[0]?.onReport?.("The answer is on its card.", undefined, {
      wait: { reason: "read the answer", cardId: card.id },
    });
    crewmate.finishPrompt();
    await tick();
    supervisor.pressNote(card.id);
    await supervisor.steer.steerCrewmate(taskId, "I read the answer; report what remains.");
    await tick();
    specs[0]?.onReport?.("Own vs rent: owning wins for sustained work.", undefined, {
      finished: true,
    });
    crewmate.finishPrompt();
    await tick();
    return harness;
  }

  it("keeps a Firstmate note on the stack when settle_task answered closes the task (FI3-1581)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, taskId } = await dismissedAndFinished(crewmate);
    const fmCardId = supervisor.addFirstmateCard({
      taskId,
      title: "Own vs rent for Mac CI",
      body: "<p>Buying Macs costs far less for steady use.</p>",
      actions: [],
    });
    const settled = await supervisor.settling.declared.closeAnswerUsedAsBasis(taskId);
    await tick();
    expect(settled).toMatchObject({ ok: true });
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
    expect(supervisor.cards.snapshot().map((entry) => entry.id)).toContain(fmCardId);
  });

  it("keeps a Firstmate note emitted in an earlier turn when the task closes answered (FI3-1581)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, taskId } = await dismissedAndFinished(crewmate);
    const fmCardId = supervisor.addFirstmateCard({
      taskId,
      title: "Own vs rent for Mac CI",
      body: "<p>Buying Macs costs far less for steady use.</p>",
      actions: [],
    });
    supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    await tick();
    expect(cards().map((entry) => entry.id)).toContain(fmCardId);
    expect(await supervisor.settling.declared.closeAnswerUsedAsBasis(taskId)).toMatchObject({
      ok: true,
    });
    await tick();
    expect(cards().map((entry) => entry.id)).toContain(fmCardId);
  });

  it("refuses settle_task answered while a Firstmate question on the task is still open (FI3-1581)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, taskId } = await dismissedAndFinished(crewmate);
    const fmCardId = supervisor.addFirstmateCard({
      taskId,
      title: "Own vs rent for Mac CI",
      body: "<p>Buying Macs costs far less for steady use.</p>",
      actions: [
        { id: "ok", label: "Got it", default: true },
        { id: "more", label: "Dig further" },
      ],
    });
    const settled = await supervisor.settling.declared.closeAnswerUsedAsBasis(taskId);
    expect(settled.ok).toBe(false);
    expect(settled.text).toContain('its card "Own vs rent for Mac CI" still asks the captain');
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(supervisor.cards.snapshot().map((entry) => entry.id)).toContain(fmCardId);
  });

  it("keeps a queued row a change when the classifier calls it research (INF-990 friction 7)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate, { classifier: research });
    const { taskId } = await supervisor.intake.commission({
      title: "Look into it later",
      intent: intentOf("when the gate clears, find out why the meter idles"),
      startAfter: { at: Date.now() - 1000 },
    });
    // Queued before the classifier ran: the deliverable is what the typed
    // constraints alone say, so the stored brief carries a Delivery line.
    expect(tasks.get(taskId)?.shape?.deliverable).toBe("change");
    expect(tasks.get(taskId)?.prompt).toContain("Delivery: ");

    await supervisor.watch.sweepGates(Date.now());
    await tick();
    // The gate-open classification routes it, and never makes undeclared
    // work an answer: the brief the crewmate ran from keeps its posture.
    expect(tasks.get(taskId)?.shape).toMatchObject({ kind: "research", deliverable: "change" });
    const brief = crewmate.promptCalls[0] ?? "";
    expect(brief).toContain("Delivery: ");
    expect(brief).not.toContain("deliverable is an answer");
  });

  /**
   * A crewmate on a direct-pr project files a follow-up, and the classifier
   * sorts it when it starts (FI3-598). The follow-up has no intent: its
   * brief is the one rendered at filing, before any kind existed.
   */
  async function filedFollowup(kind: "research" | "fix") {
    const origin = fakeCrewmate();
    const followup = fakeCrewmate();
    const harness = setup(origin, {
      crewmates: [followup],
      openChange: vi.fn(async () => "opened"),
      checkChange: vi.fn(async () => "green"),
      readWorkflow: vi.fn(async () => "workflow log"),
      downloadArtifact: vi.fn(async () => "downloaded ZIP"),
      classifier: {
        classify: async (input) =>
          ({
            kind: input.title === "Fix the merge check" ? "fix" : kind,
            source: "classifier:test",
            version: "kc1",
          }) as const,
      },
    });
    // The project's folder is there; starting a task needs nothing in it (the workspace is mocked).
    const folder = join(harness.paths.fleetDir, "checks");
    mkdirSync(folder, { recursive: true });
    const repo = seedProject(harness.db, {
      id: "checks",
      name: "checks",
      path: folder,
      setupKind: "init",
      delivery: "direct-pr",
    });
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Fix the merge check",
      intent: intentOf("fix the merge check"),
      repoId: repo.id,
    });
    await tick();
    harness.specs[0]?.onFollowup?.({
      title: "Investigate cancelled duplicate checks",
      goal: "Find out why a cancelled check run keeps the version red",
      why: "A later run passed on the same version",
    });
    const filed = harness.tasks.graph.discoveredFrom(taskId)[0] as TaskRecord;
    expect(filed.intent).toBeNull();
    expect(filed.prompt).toContain("Delivery: direct-pr");
    await harness.supervisor.starts.startQueuedNow(filed.key);
    await tick();
    return {
      shape: harness.tasks.get(filed.id)?.shape,
      brief: followup.promptCalls[0] ?? "",
      spec: harness.specs[1] as CrewmateSpec,
    };
  }

  it("briefs a follow-up the classifier calls an answer as one, matching the tools it gets (FI3-598)", async () => {
    const { shape, brief, spec } = await filedFollowup("research");
    expect(shape).toMatchObject({ kind: "research", deliverable: "answer" });
    // No posture it cannot act on, and the answer's shape in its place.
    expect(brief).not.toContain("Delivery: ");
    expect(brief).not.toContain("Care: Default");
    expect(brief).toContain("this task's deliverable is an answer, not a change");
    expect(brief).toContain("Care: none - this task ships nothing");
    // An answer gets no origin section, so it keeps the line telling it to read the origin.
    expect(brief).toContain("Read the origin's report and card with the tasks query");
    expect(brief).not.toContain("Recorded origin ");
    expect(spec.onOpenChange).toBeUndefined();
    expect(spec.onCheckChange).toBeUndefined();
    expect(spec.onReadWorkflow).toBeDefined();
    expect(spec.onDownloadArtifact).toBeDefined();
  });

  it("keeps a follow-up the classifier calls a change on its posture, rigor and delivery tools (FI3-598)", async () => {
    const { shape, brief, spec } = await filedFollowup("fix");
    expect(shape).toMatchObject({ kind: "fix", deliverable: "change", rigor: "standard" });
    expect(brief).toContain("Delivery: direct-pr");
    expect(brief).toContain("Care: Default (standard)");
    expect(brief).not.toContain("deliverable is an answer");
    // A change is handed its origin's findings, so its origin reaches it
    // once: the section, without the filing's line telling it to go and read them.
    expect(brief.split("Recorded origin ").length).toBe(2);
    expect(brief).not.toContain("Read the origin's report and card with the tasks query");
    expect(await spec.onOpenChange?.({ title: "t", body: "b" })).toBe("opened");
    expect(await spec.onCheckChange?.()).toBe("green");
  });

  it("carries a verified basis's report and card into the builder's brief", async () => {
    const answerCrew = fakeCrewmate();
    const builderCrew = fakeCrewmate();
    const { supervisor, tasks, specs, cards, cardStore, paths } = setup(answerCrew, {
      crewmates: [builderCrew],
      classifier: {
        classify: async (input) =>
          input.title.startsWith("Why")
            ? ({ kind: "research", source: "classifier:test", version: "kc1" } as const)
            : ({ kind: "implement", source: "classifier:test", version: "kc1" } as const),
      },
    });
    const answer = await supervisor.intake.commission({
      title: "Why is the meter idle",
      intent: intentOf("why is nothing running?"),
    });
    await tick();
    const fullCard = `<p>The claim query filters on repo_id.</p><h3>Scope</h3><details><summary>Full specification</summary>${"<p>Full scoped clause.</p>".repeat(800)}</details><h3>Amendment</h3><p>Amendment: replacement-only height interpolation; stable external pager.</p>`;
    specs[0]?.onCard?.({
      title: "The claim query filters on repo_id",
      body: fullCard,
      actions: [],
    });
    await tick();
    const card = cards().find((entry) => entry.taskId === answer.taskId) as Card;
    answerCrew.emit({
      type: "assistant_delta",
      taskId: answer.taskId,
      text: "Found it: the claim query filters on repo_id.",
    });
    answerCrew.emit({ type: "turn_end", taskId: answer.taskId });
    answerCrew.finishPrompt();
    await tick();
    const answers = [
      { name: "look", values: ['{"tiltDeg":57}'], changed: true, json: true as const },
    ];
    supervisor.cardActions.replyToCard(
      card.id,
      "build it as adjusted",
      undefined,
      undefined,
      answers,
    );
    await tick();
    supervisor.close(card.id);
    await tick();
    const key = tasks.get(answer.taskId)?.key ?? answer.taskId;
    tasks.turns.recordReport(answer.taskId, { text: "The investigation is complete." });
    const earlyAmendment = `First-draw at final responsive width. ${"Exact scoped evidence. ".repeat(100)}Reduced motion.`;
    cardStore.appendMessage({ cardId: card.id, who: "captain", text: earlyAmendment, at: 1 });
    for (let i = 0; i < 15; i++)
      cardStore.appendMessage({
        cardId: card.id,
        who: "crewmate",
        text: `Later discussion ${i}`,
        at: 2 + i,
      });
    cardStore.appendMessage({ cardId: card.id, who: "host", text: "   ", at: 20 });

    const built = await supervisor.intake.commission({
      title: "Fix the claim query",
      intent: intentOf("fix it then"),
      shape: { basis: key },
    });
    await tick();
    const brief = builderCrew.promptCalls[0] ?? "";
    expect(brief).toContain(`grounded in ${key}`);
    expect(brief).toContain("Found it: the claim query filters on repo_id.");
    // The card is a file of the builder's own the brief names, whole, past
    // the old 16 KiB cut; the brief itself carries none of its HTML.
    const handed = handedCard(brief);
    expect(handed.body).toBe(fullCard);
    expect(handed.file).toBe(join(paths.crewmatesDir, built.taskId, "source-cards", `${key}.html`));
    expect(brief).not.toContain("<p>The claim query filters on repo_id.</p>");
    expect(brief).not.toContain("Full scoped clause.");
    // The choice, the settings and the thread stay words in the brief.
    expect(brief).toContain("build it as adjusted");
    expect(brief).toContain('"tiltDeg":57');
    expect(brief).toContain("latest submitted settings/answers");
    expect(brief).toContain(earlyAmendment);
    expect(brief).toContain("- crewmate: Later discussion 14");
    // A blank message says nothing, so the thread quotes none.
    expect(brief).not.toContain("- host:");
    tasks.turns.recordReport(answer.taskId, { text: "A later short closure." });
    tasks.turns.recordReport(built.taskId, { text: "Builder finished." });
    for (let i = 0; i < 550; i++) tasks.noteProgress(built.taskId, `Later checkpoint ${i}`);
    const reread = await specs[1]?.onQueryTasks?.({ key: tasks.get(built.taskId)?.key });
    expect(reread?.rows[0]?.brief).toBe(brief);
    expect(handedCard(reread?.rows[0]?.brief ?? "").body).toBe(fullCard);
    expect(reread?.rows[0]?.brief).toContain('"tiltDeg":57');
    const evidence = process.env.INFINITARY_SPEC_DELIVERY_EVIDENCE;
    if (evidence)
      writeFileSync(
        evidence,
        JSON.stringify(
          {
            served: brief,
            cardFile: handed,
            retrievedBuilder: reread?.rows[0],
            retrievedSource: (await specs[1]?.onQueryTasks?.({ key }))?.rows[0],
          },
          null,
          2,
        ),
      );
  });

  it("hands a builder the prototype its basis was built from, not the cards that came after (FI3-658)", async () => {
    const mockCrew = fakeCrewmate();
    const builderCrew = fakeCrewmate();
    const { supervisor, tasks, specs, cards, cardStore } = setup(mockCrew, {
      crewmates: [builderCrew],
      classifier: {
        classify: async () =>
          ({ kind: "implement", source: "classifier:test", version: "kc1" }) as const,
      },
    });
    const prototypeBody =
      "<p>Layout B puts each label in a side column.</p><p>At 360 px every status line fits the top row.</p>";
    const mock = await supervisor.intake.commission({
      title: "Mock a roomier hover card",
      intent: intentOf("i'd like to see some mocks and decide"),
    });
    await tick();
    // The prototype, and the captain's Build it with the settings left on it.
    specs[0]?.onCard?.({
      title: "Three mocks to pick from",
      body: prototypeBody,
      actions: [
        { id: "build-it", label: "Build it", default: true },
        { id: "abandon", label: "Abandon" },
      ],
    });
    mockCrew.emit({ type: "turn_end", taskId: mock.taskId });
    mockCrew.finishPrompt();
    await tick();
    const prototype = cards().find((entry) => entry.taskId === mock.taskId) as Card;
    const settings = [
      { name: "settings", values: ['{"layout":"B","maxWidthPx":360}'], changed: true, json: true },
    ] as const;
    supervisor.cardActions.act(prototype.id, "build-it", "chrome", { answers: settings });
    await tick();
    // The build goes on, and other cards land on the same task: a Firstmate
    // note the captain closes, a Firstmate decision the captain answers, and the
    // crewmate's own completion card, merged.
    supervisor.close(
      supervisor.addFirstmateCard({
        taskId: mock.taskId,
        title: "The prototype did not have build approval",
        body: "<p>A Firstmate note about the build.</p>",
        actions: [],
      }),
    );
    supervisor.cardActions.act(
      supervisor.addFirstmateCard({
        taskId: mock.taskId,
        title: "Keep the build going?",
        body: "<p>A Firstmate decision about the build.</p>",
        actions: [{ id: "keep-going", label: "Keep going", default: true }],
      }),
      "keep-going",
    );
    await tick();
    cardStore.upsert({
      ...prototype,
      id: `${prototype.id}-built`,
      createdAt: Date.now() + 1,
      title: "The hover card is built",
      body: "<p>Completion card body.</p>",
      actions: [
        {
          id: "merge",
          label: "Merge the pull request",
          variant: "primary",
          effect: { kind: "settle", mode: "merge" },
        },
      ],
    });
    cardStore.resolve(`${prototype.id}-built`, "merge");
    tasks.turns.recordReport(mock.taskId, { text: "Built as picked: layout B at 360 px." });
    tasks.close(mock.taskId, { status: "done", reason: "merged", actor: "captain" });
    const key = tasks.get(mock.taskId)?.key ?? mock.taskId;

    await supervisor.intake.commission({
      title: "Show the model and reasoning in the hover card",
      intent: intentOf("build on the hover card"),
      shape: { basis: key },
    });
    await tick();
    const brief = builderCrew.promptCalls[0] ?? "";
    expect(brief).toContain(`grounded in ${key}`);
    expect(handedCard(brief).body).toBe(prototypeBody);
    expect(brief).not.toContain(prototypeBody);
    expect(brief).toContain('The captain closed it by choosing "Build it".');
    expect(brief).toContain("The captain's latest submitted settings/answers");
    expect(brief).toContain('"maxWidthPx":360');
    for (const later of [
      "Completion card body.",
      "A Firstmate note about the build.",
      "A Firstmate decision about the build.",
      '"Keep going"',
    ]) {
      expect(brief).not.toContain(later);
    }
  });

  it("hands a builder its basis card as a file, whole with its script, style and pictures (FI3-700)", async () => {
    const builder = fakeCrewmate();
    const picture = `proto7-${"ab".repeat(16)}.png`;
    const prototype = [
      "<style>.meter{transform:rotate(57deg)}</style>",
      '<div class="meter" data-tilt="57"></div>',
      `<img src="app-frame://images/${picture}" alt="The tilted meter">`,
      "<script>document.querySelector('.meter').dataset.ready = 'yes';</script>",
    ].join("");
    const { supervisor, tasks, paths } = setup(builder, {
      savedCards: [
        {
          id: "card-proto7-1",
          taskId: "proto7",
          author: "crewmate",
          priority: 1,
          title: "Two meters to pick from",
          meta: "",
          body: prototype,
          actions: [
            { id: "build-it", label: "Build it", default: true },
            { id: "abandon", label: "Abandon" },
          ],
          status: "ready",
          createdAt: Date.now(),
        },
      ],
    });
    seedTask(tasks, {
      id: "proto7",
      title: "Mock the meter",
      status: "completed",
      shape: { kind: "plan", kind_source: "classifier:test", deliverable: "answer" },
      outcome: "Two meters; the captain picked the tilted one.",
    });
    supervisor.cards.addMessage("card-proto7-1", "captain", "tilt it a little less");
    supervisor.cardActions.act("card-proto7-1", "build-it", "chrome", {
      answers: [{ name: "tilt", values: ["57"], changed: true }],
    });
    await tick();
    const key = tasks.get("proto7")?.key ?? "proto7";

    const built = await supervisor.intake.commission({
      title: "Build the tilted meter",
      intent: intentOf("build it"),
      shape: { basis: key },
    });
    await tick();
    const brief = builder.promptCalls.at(-1) ?? "";
    const pictureFile = `${paths.crewmatesDir}/proto7/cards/${picture}`;
    // The file holds the card exactly as the captain read it, its picture
    // pointing at the host's copy instead of a link only the app can open.
    const handed = handedCard(brief);
    expect(handed.file).toBe(join(paths.crewmatesDir, built.taskId, "source-cards", `${key}.html`));
    expect(handed.body).toBe(prototype.replace(`app-frame://images/${picture}`, pictureFile));
    // The brief names the file and the picture, and keeps the rest in words.
    for (const html of ["<style>", "<script>", "data-tilt", "app-frame://"]) {
      expect(brief).not.toContain(html);
    }
    expect(brief).toContain(`open them to see the design the captain saw:\n- ${pictureFile}`);
    expect(brief).toContain('The captain closed it by choosing "Build it".');
    expect(brief).toContain("- tilt:");
    expect(brief).toContain("- captain: tilt it a little less");
  });

  it("hands a follow-up its origin's card as a file too", async () => {
    const finder = fakeCrewmate();
    const fixer = fakeCrewmate();
    const { supervisor, tasks, specs, cards, paths } = setup(finder, { crewmates: [fixer] });
    const found = await supervisor.intake.commission({
      title: "Fix the keychain prompt",
      intent: intentOf("fix the keychain thing"),
    });
    await tick();
    const finding = "<p>The meter test races its timer.</p><script>void 0;</script>";
    specs[0]?.onCard?.({ title: "A flaky meter test", body: finding, actions: [] });
    await tick();
    expect(cards().some((card) => card.taskId === found.taskId)).toBe(true);
    specs[0]?.onFollowup?.({ title: "Flaky meter test", goal: "unflake it", why: "it races" });
    finder.finishPrompt();
    await tick();
    const filed = tasks.graph.discoveredFrom(found.taskId)[0];
    if (!filed) throw new Error("no follow-up was filed");

    expect(await supervisor.starts.startQueuedNow(filed.key)).toContain("Started");
    await tick();
    const brief = fixer.promptCalls.at(-1) ?? "";
    const originKey = tasks.get(found.taskId)?.key ?? found.taskId;
    expect(brief).toContain(`Recorded origin ${originKey}`);
    const handed = handedCard(brief);
    expect(handed.body).toBe(finding);
    expect(handed.file).toBe(
      join(paths.crewmatesDir, filed.id, "source-cards", `${originKey}.html`),
    );
    expect(brief).not.toContain("races its timer");
  });

  it("hands a follow-up grounded on its own origin that origin once, as its basis", async () => {
    const finder = fakeCrewmate();
    const fixer = fakeCrewmate();
    const { supervisor, tasks, specs } = setup(finder, { crewmates: [fixer] });
    const found = await supervisor.intake.commission({
      title: "Find the meter race",
      intent: intentOf("why does the meter test flake?"),
    });
    await tick();
    specs[0]?.onFollowup?.({ title: "Flaky meter test", goal: "unflake it", why: "it races" });
    finder.finishPrompt();
    await tick();
    tasks.turns.recordReport(found.taskId, { text: "The meter test races its timer." });
    const filed = tasks.graph.discoveredFrom(found.taskId)[0];
    if (!filed) throw new Error("no follow-up was filed");
    const originKey = tasks.get(found.taskId)?.key ?? found.taskId;
    // Firstmate names the origin as the follow-up's basis. The stamp writer
    // no longer accepts a basis, so the edit goes through the field writer.
    tasks.updateFields(filed.id, { basis: originKey }, "firstmate");

    await supervisor.starts.startQueuedNow(filed.key);
    await tick();
    const brief = fixer.promptCalls.at(-1) ?? "";
    expect(brief).toContain(`grounded in ${originKey}`);
    expect(brief).toContain("The meter test races its timer.");
    expect(brief).not.toContain("Recorded origin ");
    expect(brief).not.toContain("Read the origin's report and card with the tasks query");
  });

  it("keeps the card whole in the brief when its file cannot be written", async () => {
    const builder = fakeCrewmate();
    const { supervisor, tasks, cardStore, paths } = setup(builder);
    seedTask(tasks, {
      id: "ans9",
      title: "Why the meter idles",
      status: "completed",
      outcome: "The claim query filters on repo_id.",
    });
    const body = `<p>The claim query filters on repo_id.</p>${"<p>Clause.</p>".repeat(2000)}`;
    cardStore.upsert({
      id: "card-ans9-1",
      taskId: "ans9",
      author: "crewmate",
      priority: 1,
      title: "The claim query filters on repo_id",
      meta: "",
      body,
      actions: [],
      status: "ready",
      createdAt: Date.now(),
    });
    const planned = supervisor.intake.plan({
      title: "Fix the claim query",
      intent: intentOf("fix it"),
      shape: { basis: tasks.get("ans9")?.key ?? "ans9" },
    });
    // A file where the folder belongs: the save fails, nothing is lost.
    mkdirSync(join(paths.crewmatesDir, planned.id), { recursive: true });
    writeFileSync(join(paths.crewmatesDir, planned.id, "source-cards"), "in the way");
    expect(await supervisor.starts.startQueuedNow(planned.key)).toContain("Started");
    await tick();
    const brief = builder.promptCalls.at(-1) ?? "";
    expect(brief).toContain(`Its card, as the captain read it:\n${body}`);
    expect(brief).not.toContain("open it to read the card");
  });
});
