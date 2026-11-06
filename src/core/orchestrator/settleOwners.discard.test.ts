/**
 * Closing work as the settle owners do it (docs/task-record.md): a
 * discard that closes the record and its cards, the first mate's closing
 * note, work another task carries on, the pull request a discard closes, an
 * external release, an idle task landed through the workspace, and an
 * answer task another task builds on.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */

import type { Card } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  type SetupExtras,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { ForgeError, type ForgePull } from "../forge";
import type { KindInput } from "../routing/kindClassifier";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskStore";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { taskFeedLine } from "../tasks/taskFeed";
import type { TaskService } from "../tasks/taskService";
import { FLEET_STARTED_CHANGE_WORDS, type SpawnIntent } from "./intentBrief";
import { closingNoteTitle, droppedLine } from "./settleWords";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it("discarding closes the record, retires its cards, and drops only the worktree (D2)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, workspace, tasks, cardStore } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "c",
      intent: intentOf("clean up later"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");

    expect(await supervisor.settling.settle.settleTask(taskId, "discard")).toBe("Discarded.");
    await tick();
    // The row survives, closed; its timeline says why; the card row stays
    // resolved rather than deleted.
    expect(tasks.get(taskId)).toMatchObject({
      status: "dropped",
      closedReason: "discarded",
      workspaceState: "removed",
    });
    expect(tasks.get(taskId)?.closedAt).toBeGreaterThan(0);
    expect(tasks.timeline(taskId).map((event) => event.kind)).toEqual([
      "created",
      "dispatched",
      "briefed",
      "status",
      "note",
    ]);
    expect(cards().filter((card) => card.taskId === taskId)).toEqual([]);
    expect(cardStore.listOpen().filter((card) => card.taskId === taskId)).toEqual([]);
    expect(workspace.removeTaskWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, branch: `fm/task-${taskId}` }),
    );
    // Settled means settled: a second discard has nothing to do.
    expect(await supervisor.settling.settle.settleTask(taskId, "discard")).toContain(
      "already discarded",
    );
  });

  // INF-547, the captain's words: "the tasks were done but i never got any
  // update". Started work the first mate closes without their click leaves its
  // one sentence as the first mate's own note when nothing else of the task
  // is on their stack, and Activity's line for a drop says "Dropped:" and the
  // same sentence.
  describe("the first mate's closing note (INF-547)", () => {
    const SENTENCE = "Moved to the app project, where the notice fix belongs.";
    const left = (cards: Card[], taskId: string) =>
      cards
        .filter((card) => card.taskId === taskId)
        .map((card) => ({ author: card.author, title: card.title, actions: card.actions }));
    // The captain asked for the work: its close answers their message
    // (docs/task-capture.md "How a message ends").
    const askedFor = (tasks: TaskService, taskId: string, words: string) => {
      const ask = tasks.capture.openAsk({ id: `ask-${taskId}`, text: words });
      tasks.capture.attachAsk(ask.id, taskId, "tool:spawn_crewmate");
      tasks.capture.closeAsk(ask.id, "closed");
    };

    async function idleTask() {
      const crewmate = fakeCrewmate();
      const harness = setup(crewmate);
      const { taskId } = await harness.supervisor.intake.commission({
        title: "Rename the notice",
        intent: intentOf("rename the notice"),
      });
      askedFor(harness.tasks, taskId, "rename the notice");
      await tick();
      crewmate.finishPrompt();
      await tick();
      expect(legacyStateOf(harness.tasks.get(taskId))).toBe("idle");
      return { ...harness, crewmate, taskId, key: harness.tasks.get(taskId)?.key ?? "" };
    }

    it("puts up the first mate's sentence when it discards started work, and Activity says Dropped: and the same words", async () => {
      const h = await idleTask();
      await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
        h.supervisor.settling.settle.settleTask(h.taskId, "discard"),
      );
      await tick();
      expect(left(h.cards(), h.taskId)).toEqual([
        { author: "firstmate", title: closingNoteTitle(h.key, "dropped"), actions: [] },
      ]);
      expect(h.cards().find((card) => card.taskId === h.taskId)?.body).toContain(SENTENCE);
      const record = h.tasks.get(h.taskId);
      const close = h.tasks.timeline(h.taskId).find((event) => event.kind === "status");
      if (!record || !close) throw new Error("The discard left no close");
      expect(taskFeedLine(record, close)?.text).toBe(droppedLine(SENTENCE));
    });

    // INF-1467, the captain's words: "tasks the fleet decided to start that
    // the captain didn't ask for should not report to the captain". INF-1461
    // was a change step the first mate opened itself for INF-643's crewmate
    // and discarded with its sentence once its files were handed over.
    it("puts no note up when it drops or cancels work it marked its own, and Activity still says Dropped: (INF-1467)", async () => {
      const crewmate = fakeCrewmate();
      const h = setup(crewmate);
      const step = async (title: string) => {
        const { taskId } = await h.supervisor.intake.commission({
          title,
          intent: intentOf(title.toLowerCase()),
          shape: { internal_step: true },
        });
        await tick();
        crewmate.finishPrompt();
        await tick();
        expect(legacyStateOf(h.tasks.get(taskId))).toBe("idle");
        return taskId;
      };
      const discarded = await step("Bring INF-643's branch up to date on the Mac mini");
      const sentence =
        "INF-1461 handed INF-643's updated branch over as a bundle, so its own copy on the Mac mini is no longer needed.";
      await h.supervisor.settling.closing.withClosingSentence(discarded, sentence, () =>
        h.supervisor.settling.settle.settleTask(discarded, "discard"),
      );
      await tick();
      expect(h.tasks.get(discarded)?.status).toBe("dropped");
      expect(left(h.cards(), discarded)).toEqual([]);
      const record = h.tasks.get(discarded);
      const close = h.tasks.timeline(discarded).find((event) => event.kind === "status");
      if (!record || !close) throw new Error("The discard left no close");
      expect(taskFeedLine(record, close)?.text).toBe(droppedLine(sentence));

      const cancelled = await step("Rebuild the runner image");
      await h.supervisor.sessions.interruptCrewmate(cancelled, "cancel", undefined, SENTENCE);
      await tick();
      expect(legacyStateOf(h.tasks.get(cancelled))).toBe("cancelled");
      expect(left(h.cards(), cancelled)).toEqual([]);
    });

    // INF-1467, the captain's answer: "Also a note when it finds something
    // you should see" - the crewmate on a change the captain did not ask for
    // is told what it may still put in front of them.
    it("tells the crewmate on a change the first mate marked its own what it may show the captain (INF-1467)", async () => {
      for (const internalStep of [true, false]) {
        const crewmate = fakeCrewmate();
        const h = setup(crewmate);
        await h.supervisor.intake.commission({
          title: "Bring the branch up to date",
          intent: intentOf("bring the branch up to date"),
          ...(internalStep ? { shape: { internal_step: true } } : {}),
        });
        await tick();
        expect(crewmate.promptCalls[0]?.includes(FLEET_STARTED_CHANGE_WORDS)).toBe(internalStep);
      }
    });

    it("lets the first mate mark a filing its own before it starts, and refuses once it has (INF-1467)", async () => {
      const h = await idleTask();
      expect(() => h.tasks.updateFields(h.taskId, { internalStep: true }, "firstmate")).toThrow(
        "internal_step can only change on open work that has not started.",
      );
      h.tasks.create({ id: "t-filed", title: "A crewmate's filing", prompt: "p", repoId: null });
      h.tasks.updateFields("t-filed", { internalStep: true }, "firstmate");
      expect(h.tasks.get("t-filed")?.shape?.internal_step).toBe(true);
    });

    it("adds nothing when the captain's own click closes the work", async () => {
      const h = await idleTask();
      // Even with the first mate's sentence pending, their close carries none.
      await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
        h.supervisor.settling.settle.settleTask(h.taskId, "discard", undefined, "captain"),
      );
      await tick();
      expect(h.tasks.get(h.taskId)?.status).toBe("dropped");
      expect(left(h.cards(), h.taskId)).toEqual([]);
    });

    // INF-1137 friction 4: INF-1000, INI-10, DOP-56, DOP-58 and DOP-63 each
    // got a "released", "merged" or "dropped" note right after the captain
    // had closed the crewmate's own outcome card - the same news twice.
    it("adds nothing when the captain already closed the crewmate's outcome card and it reported finished (INF-1137)", async () => {
      const crewmate = fakeCrewmate();
      const h = setup(crewmate);
      const { taskId } = await h.supervisor.intake.commission({
        title: "Rebuild the runner image",
        intent: intentOf("rebuild the runner image"),
      });
      await tick();
      h.specs[0]?.onCard?.({
        title: "The rebuilt image passed its live proof",
        body: "<p>The rebuilt image passed its live proof.</p>",
        actions: [],
      });
      h.specs[0]?.onReport?.("The rebuilt image passed its live proof.");
      crewmate.finishPrompt();
      await tick();
      const note = h.cards().find((card) => card.taskId === taskId) as Card;
      h.supervisor.close(note.id);
      await h.supervisor.steer.steerCrewmate(taskId, "I read the outcome; report what is left.");
      await tick();
      h.specs[0]?.onReport?.("The captain read my note and nothing is left.", undefined, {
        finished: true,
      });
      crewmate.finishPrompt();
      await tick();
      expect(h.tasks.get(taskId)?.delivery?.finishedAt).toBeDefined();

      await h.supervisor.settling.closing.withClosingSentence(taskId, SENTENCE, () =>
        h.supervisor.settling.settle.settleTask(taskId, "discard"),
      );
      await tick();
      expect(h.tasks.get(taskId)?.status).toBe("dropped");
      expect(left(h.cards(), taskId)).toEqual([]);
    });

    // INF-1533, the plan's at-most-one rule (INF-1610 piece 2): the captain
    // closed the crewmate's answer note, then the first mate dropped the
    // work. No closing note goes up; the note they accepted comes back
    // revised with the drop and the first mate's sentence, once.
    it("brings the answer the captain accepted back revised with a later drop, and adds no note (INF-1533)", async () => {
      const h = await idleTask();
      await h.supervisor.steer.steerCrewmate(h.taskId, "Show the final outcome for my choice.");
      await tick();
      h.specs[0]?.onCard?.({
        title: "The notice is renamed",
        body: "<p>The notice now reads Your first mate has not answered your message.</p>",
        actions: [
          { id: "read", label: "I read the outcome", default: true },
          { id: "question", label: "Explain further" },
        ],
        answering: true,
      });
      await tick();
      h.crewmate.finishPrompt();
      await tick();
      const answer = h.cards().find((card) => card.taskId === h.taskId) as Card;
      h.supervisor.cardActions.act(answer.id, "read");
      await tick();
      // The explicit choice reaches the crewmate, whose turn ends idle.
      h.crewmate.finishPrompt();
      await tick();
      expect(left(h.cards(), h.taskId)).toEqual([]);

      await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
        h.supervisor.settling.settle.settleTask(h.taskId, "discard"),
      );
      await tick();
      const up = h.cards().filter((card) => card.taskId === h.taskId);
      expect(up.map((card) => ({ id: card.id, actions: card.actions }))).toEqual([
        { id: answer.id, actions: [] },
      ]);
      expect(up[0]?.body).toContain(closingNoteTitle(h.key, "dropped"));
      expect(up[0]?.body).toContain(SENTENCE);
      expect(up[0]?.body).toContain("The notice now reads");
    });

    // INF-2718, from the captain's pick "Refuse re-showing a closed note"
    // and DOP-201's note raised again with its "dropped" line: an ordinary
    // note read through the actual corner stays down on a later drop, and
    // no closing note goes up beside it. The decision case above still
    // comes back, since what it offered is gone.
    it("keeps a read note closed on a later drop, and adds no note (INF-2718)", async () => {
      const h = await idleTask();
      await h.supervisor.steer.steerCrewmate(h.taskId, "Show the final outcome for me to read.");
      await tick();
      const words = "The notice now reads Your first mate has not answered your message.";
      h.specs[0]?.onCard?.({
        title: "The notice is renamed",
        body: `<p>${words}</p>`,
        actions: [],
        answering: true,
      });
      await tick();
      h.crewmate.finishPrompt();
      await tick();
      const answer = h.cards().find((card) => card.taskId === h.taskId) as Card;
      const prompts = h.crewmate.promptCalls.length;
      h.supervisor.pressNote(answer.id);
      await tick();
      expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
      expect(h.tasks.get(h.taskId)?.status).toBe("active");
      h.crewmate.finishPrompt();
      await tick();
      expect(left(h.cards(), h.taskId)).toEqual([]);

      await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
        h.supervisor.settling.settle.settleTask(h.taskId, "discard"),
      );
      await tick();
      expect(h.tasks.get(h.taskId)?.status).toBe("dropped");
      expect(left(h.cards(), h.taskId)).toEqual([]);
      expect(h.supervisor.cards.stored(answer.id)?.body).not.toContain(SENTENCE);
    });

    it("puts up the sentence when the first mate cancels idle work", async () => {
      const h = await idleTask();
      await h.supervisor.sessions.interruptCrewmate(h.taskId, "cancel", undefined, SENTENCE);
      await tick();
      expect(legacyStateOf(h.tasks.get(h.taskId))).toBe("cancelled");
      expect(left(h.cards(), h.taskId)).toEqual([
        { author: "firstmate", title: closingNoteTitle(h.key, "dropped"), actions: [] },
      ]);
    });

    it("carries a running crewmate's cancel to the close its stopped turn brings", async () => {
      const crewmate = fakeCrewmate();
      const { supervisor, cards, tasks } = setup(crewmate);
      const { taskId } = await supervisor.intake.commission({
        title: "long",
        intent: intentOf("long running work"),
      });
      askedFor(tasks, taskId, "long running work");
      await tick();
      await supervisor.sessions.interruptCrewmate(taskId, "cancel", undefined, SENTENCE);
      crewmate.failPrompt("aborted");
      await tick();
      expect(legacyStateOf(tasks.get(taskId))).toBe("cancelled");
      expect(left(cards(), taskId)).toEqual([
        {
          author: "firstmate",
          title: closingNoteTitle(tasks.get(taskId)?.key ?? "", "dropped"),
          actions: [],
        },
      ]);
    });

    it("adds no note for work no crewmate started, though Activity still says what the drop was", async () => {
      const crewmate = fakeCrewmate();
      const { supervisor, cards, tasks } = setup(crewmate);
      tasks.create({ id: "t-open", title: "Never started", prompt: "p", repoId: null });
      await supervisor.settling.closing.withClosingSentence("t-open", SENTENCE, () =>
        supervisor.settling.settle.settleTask("t-open", "discard"),
      );
      await tick();
      const record = tasks.get("t-open");
      const close = tasks.timeline("t-open").find((event) => event.kind === "status");
      if (!record || !close) throw new Error("The discard left no close");
      expect(record.status).toBe("dropped");
      expect(taskFeedLine(record, close)?.text).toBe(droppedLine(SENTENCE));
      expect(left(cards(), "t-open")).toEqual([]);
    });
  });

  // INF-1825 (Finding 3 of INF-1810), the captain's words: "A task closes as
  // \"carried on by\" another task through its typed replaced-by link, its
  // record reads \"Done through INF-1737\", and no note is posted. The word
  // \"dropped\" is kept for work that was really abandoned." INF-1605's work
  // moved to INF-1737, and the first mate could only cancel it.
  describe("work another task carries on (INF-1825)", () => {
    const SENTENCE = "INF-1737 carries the notice fix on in its own pull request.";
    const left = (cards: Card[], taskId: string) =>
      cards.filter((card) => card.taskId === taskId).map((card) => card.title);

    async function carriedWork(extras: SetupExtras = {}) {
      const crewmate = fakeCrewmate();
      const harness = setup(crewmate, extras);
      const { taskId } = await harness.supervisor.intake.commission({
        title: "Fix the notice",
        intent: intentOf("fix the notice"),
      });
      const ask = harness.tasks.capture.openAsk({ id: `ask-${taskId}`, text: "fix the notice" });
      harness.tasks.capture.attachAsk(ask.id, taskId, "tool:spawn_crewmate");
      harness.tasks.capture.closeAsk(ask.id, "closed");
      await tick();
      crewmate.finishPrompt();
      await tick();
      expect(legacyStateOf(harness.tasks.get(taskId))).toBe("idle");
      const carrier = seedTask(harness.tasks, {
        id: "carrier",
        title: "Fix the notice in its own pull request",
        status: "running",
      });
      return { ...harness, crewmate, taskId, ask, carrier };
    }

    it("closes started work as done through the task carrying it: waits move, its own pull request closes, and no note goes up", async () => {
      const closePullRequest = vi.fn(async () => ({ ok: true, text: "Closed PR #9." }));
      const h = await carriedWork({ closePullRequest });
      vi.spyOn(h.supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
      seedDelivery(h.tasks, h.taskId, { prNumber: 9 });
      const waiter = seedTask(h.tasks, { id: "waiter", title: "Ship the notice", status: "idle" });
      h.tasks.graph.link(h.taskId, waiter.id, "blocks", "firstmate");

      const text = await h.supervisor.settling.closing.withClosingSentence(h.taskId, SENTENCE, () =>
        h.supervisor.intake.carryOnTask(h.taskId, h.carrier.key),
      );
      await tick();

      expect(text).toContain(`${h.carrier.key} carries on its work.`);
      expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "superseded" });
      expect(h.tasks.graph.replacementOf(h.taskId)).toBe(h.carrier.key);
      // Done clears a wait, so the wait moved before the close.
      expect(h.tasks.graph.linksTo(waiter.id)).toEqual([
        expect.objectContaining({ fromId: h.carrier.id, type: "blocks" }),
      ]);
      expect(closePullRequest).toHaveBeenCalledExactlyOnceWith(h.taskId);
      expect(h.workspace.removeTaskWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: h.taskId }),
      );
      expect(left(h.cards(), h.taskId)).toEqual([]);
      const record = h.tasks.get(h.taskId);
      const close = h.tasks.timeline(h.taskId).find((event) => event.kind === "status");
      if (!record || !close) throw new Error("The close left no event");
      expect(taskFeedLine(record, close)?.text).toBe(`Carried on by ${h.carrier.key}`);
    });

    it("keeps the pull request open when the task carrying the work carries that same pull request", async () => {
      const closePullRequest = vi.fn(async () => ({ ok: true, text: "Closed PR #9." }));
      const h = await carriedWork({ closePullRequest });
      vi.spyOn(h.supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
      const prUrl = "https://github.com/acme/app/pull/9";
      seedDelivery(h.tasks, h.taskId, { prNumber: 9, prUrl });
      seedDelivery(h.tasks, h.carrier.id, { prNumber: 9, prUrl });

      await h.supervisor.intake.carryOnTask(h.taskId, h.carrier.key);
      await tick();

      expect(h.tasks.get(h.taskId)?.status).toBe("done");
      expect(closePullRequest).not.toHaveBeenCalled();
    });

    it("refuses the task itself, a task under it, a dropped task and a task whose card waits on the captain, writing nothing", async () => {
      const h = await carriedWork();
      h.tasks.create({
        id: "part",
        title: "A part of it",
        prompt: "p",
        repoId: null,
        parentId: h.taskId,
      });
      h.tasks.close("part", { status: "dropped", reason: "cancelled", actor: "firstmate" });
      const gone = seedTask(h.tasks, { id: "gone", title: "Gone", status: "cancelled" });
      const key = h.tasks.get(h.taskId)?.key ?? "";
      expect(await h.supervisor.intake.carryOnTask(h.taskId, h.taskId)).toBe(
        `Refused: ${key} cannot be replaced by itself.`,
      );
      expect(await h.supervisor.intake.carryOnTask(h.taskId, "part")).toContain("is under");
      expect(await h.supervisor.intake.carryOnTask(h.taskId, gone.key)).toBe(
        `Refused: ${gone.key} is dropped itself, so it does not do ${key}'s work.`,
      );
      h.specs[0]?.onCard?.({
        title: "Which notice wording?",
        body: "<p>Pick one.</p>",
        actions: [
          { id: "a", label: "Short", default: true },
          { id: "b", label: "Long" },
        ],
      });
      await tick();
      expect(await h.supervisor.intake.carryOnTask(h.taskId, h.carrier.key)).toContain(
        'its card "Which notice wording?" still waits on the captain',
      );
      expect(h.tasks.get(h.taskId)?.status).toBe("active");
      expect(h.tasks.graph.allLinks().filter((link) => link.type === "replaced-by")).toEqual([]);
    });

    it("places the outcome of a carrier that closed first once, where it would have gone", async () => {
      const h = await carriedWork();
      // The carrier worked for the same message, so the old task held its outcome back.
      h.tasks.capture.attachAsk(h.ask.id, h.carrier.id, "tool:spawn_crewmate");
      const merged = "The notice fix merged in PR #12.";
      await h.supervisor.settling.closing.withClosingSentence(h.carrier.id, merged, () =>
        h.supervisor.settling.closing.closeTask(h.carrier.id, {
          status: "done",
          reason: "merged",
          actor: "firstmate",
        }),
      );
      await tick();
      expect(left(h.cards(), h.carrier.id)).toEqual([]);

      await h.supervisor.intake.carryOnTask(h.taskId, h.carrier.key);
      await tick();

      expect(left(h.cards(), h.taskId)).toEqual([]);
      expect(left(h.cards(), h.carrier.id)).toEqual([closingNoteTitle(h.carrier.key, "merged")]);
      expect(h.cards().find((card) => card.taskId === h.carrier.id)?.body).toContain(merged);
    });

    it("closes unstarted work named by update_task drop with replaced_by as done, not dropped", async () => {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks } = setup(crewmate);
      tasks.create({ id: "planned", title: "Planned fix", prompt: "p", repoId: null });
      const carrier = seedTask(tasks, { id: "carrier", title: "Carrier", status: "running" });
      expect(
        supervisor.intake.dropTask("planned", {
          reason: "moved to its carrier",
          replacedBy: carrier.key,
        }),
      ).toContain(`${carrier.key} carries on its work.`);
      expect(tasks.get("planned")).toMatchObject({ status: "done", closedReason: "superseded" });
      // A drop that names no replacement stays dropped.
      tasks.create({ id: "stopped", title: "Stopped fix", prompt: "p", repoId: null });
      supervisor.intake.dropTask("stopped", { reason: "not needed" });
      expect(tasks.get("stopped")).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    });
  });

  it("closes the task's open PR on GitHub when a direct-pr task is discarded", async () => {
    const crewmate = fakeCrewmate();
    const closePullRequest = vi.fn(async () => ({
      ok: true,
      text: "Closed PR #9 on GitHub. https://github.com/x/y/pull/9",
    }));
    const { supervisor, workspace, tasks } = setup(crewmate, { closePullRequest });
    const { taskId } = await supervisor.intake.commission({
      title: "Shipped elsewhere",
      intent: intentOf("open a PR"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");

    const result = await supervisor.settling.settle.settleTask(taskId, "discard");
    expect(closePullRequest).toHaveBeenCalledWith(taskId);
    expect(result).toBe("Discarded. Closed PR #9 on GitHub. https://github.com/x/y/pull/9");
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
    expect(workspace.removeTaskWorktree).toHaveBeenCalled();
  });

  it("does not revisit an already-closed attempt's leftover PR on rework", async () => {
    const crewmate = fakeCrewmate();
    const closePullRequest = vi.fn(async () => ({ ok: true, text: "Closed PR #9." }));
    const { supervisor, tasks } = setup(crewmate, { closePullRequest });
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    const previous = seedTask(tasks, {
      id: "closed-attempt",
      title: "Already cancelled",
      status: "cancelled",
      difficulty: "medium",
      branch: "fm/task-closed-attempt",
      worktreeDir: "/w/closed-attempt",
    });
    seedDelivery(tasks, previous.id, { prNumber: 9 });
    await supervisor.intake.commission({
      title: "Fresh attempt",
      intent: intentOf("try a stronger model"),
      shape: { escalate_from: previous.key },
    });
    await tick();
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(tasks.get(previous.id)?.closedReason).toBe("cancelled");
  });

  it.each(["rework", "cancel", "failed"] as const)(
    "keeps %s cleanup best effort and records a thrown PR close failure",
    async (path) => {
      const crewmate = fakeCrewmate();
      const closePullRequest = vi.fn(async () => {
        throw new Error("GitHub unavailable");
      });
      const { supervisor, tasks, workspace } = setup(crewmate, { closePullRequest });
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
      const { taskId } = await supervisor.intake.commission({
        title: "Abandoned",
        intent: intentOf("fix it"),
      });
      await tick();
      if (path === "failed") {
        crewmate.failPrompt("The client exited.");
      } else {
        crewmate.finishPrompt();
        await tick();
        if (path === "cancel") await supervisor.sessions.interruptCrewmate(taskId, "cancel");
        else
          await supervisor.intake.commission({
            title: "Fresh attempt",
            intent: intentOf("try a stronger model"),
            shape: { escalate_from: tasks.get(taskId)?.key },
          });
      }
      await tick();
      expect(tasks.get(taskId)?.status).toBe("dropped");
      expect(workspace.removeTaskWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
      );
      expect(tasks.timeline(taskId)).toContainEqual(
        expect.objectContaining({
          text: "Could not close its PR: GitHub unavailable",
          // News on the record's Activity, as its writer declared.
          data: { problem: "GitHub unavailable", news: true },
        }),
      );
    },
  );

  it.each(["cancel", "failed"] as const)("never closes a local-only PR on %s", async (path) => {
    const crewmate = fakeCrewmate();
    const closePullRequest = vi.fn(async () => ({ ok: true, text: "" }));
    const { supervisor } = setup(crewmate, { closePullRequest });
    const { taskId } = await supervisor.intake.commission({
      title: "Local",
      intent: intentOf("fix it"),
    });
    await tick();
    if (path === "failed") crewmate.failPrompt("The client exited.");
    else {
      crewmate.finishPrompt();
      await tick();
      await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    }
    await tick();
    expect(closePullRequest).not.toHaveBeenCalled();
  });

  it("never asks GitHub to close a PR for a local-only task's discard", async () => {
    const crewmate = fakeCrewmate();
    const closePullRequest = vi.fn(async () => ({ ok: true, text: "" }));
    const { supervisor, tasks } = setup(crewmate, { closePullRequest });
    const { taskId } = await supervisor.intake.commission({
      title: "Local only",
      intent: intentOf("no PR here"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();

    const result = await supervisor.settling.settle.settleTask(taskId, "discard");
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(result).toBe("Discarded.");
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
  });

  it("refuses a dirty discard without confirm and never mints a card", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks, cards } = setup(crewmate);
    (workspace.taskWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      dirty: true,
      unlandedCommits: 2,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Precious",
      intent: intentOf("real work"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();

    const refused = await supervisor.settling.settle.settleTask(taskId, "discard");
    expect(refused).toContain("without confirm");
    expect(refused).toContain("2 commits and uncommitted edits");
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
    expect(cards().find((card) => card.id === `card-discard-${taskId}`)).toBeUndefined();

    const confirmed = await supervisor.settling.settle.settleTask(taskId, "discard", true);
    expect(confirmed).toContain("Discarded");
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
    expect(workspace.removeTaskWorktree).toHaveBeenCalled();
  });

  it("lands through settle_task", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks } = setup(crewmate);
    (workspace.taskWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      dirty: false,
      unlandedCommits: 1,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Land it",
      intent: intentOf("work"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    const result = await supervisor.settling.settle.settleTask(
      taskId,
      "land",
      undefined,
      "captain",
    );
    expect(result).toContain("into main.");
    expect(workspace.landTaskWork).toHaveBeenCalled();
    expect(tasks.get(taskId)).toMatchObject({
      status: "done",
      closedReason: "landed",
      workspaceState: "removed",
    });
    // Settled work is history: it leaves crew_status, and a second land refuses.
    expect(supervisor.facts.crewStatus().find((entry) => entry.taskId === taskId)).toBeUndefined();
    expect(
      await supervisor.settling.settle.settleTask(taskId, "land", undefined, "captain"),
    ).toContain("already landed");
  });

  it("closes only explicitly verified external release work and keeps the evidence on its record", async () => {
    const { supervisor, tasks, workspace } = setup(fakeCrewmate());
    seedTask(tasks, {
      id: "release",
      title: "Publish version",
      status: "idle",
      outcome: "Published through release-please",
      worktreeDir: "/work",
    });
    expect(
      (await supervisor.settling.declared.closeExternallyReleased("release", "")).text,
    ).toContain("name the release");
    expect(tasks.get("release")?.status).toBe("active");
    vi.mocked(workspace.taskWorkStatus).mockResolvedValueOnce({ dirty: true, unlandedCommits: 0 });
    expect(
      (await supervisor.settling.declared.closeExternallyReleased("release", "v1.2.3 published"))
        .text,
    ).toContain("uncommitted edits");
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
    // INF-2628, the captain's "Release close accepts closed pull requests and
    // squash merges": commits only history calls unmerged no longer refuse,
    // since the close saves them before the working copy goes.
    vi.mocked(workspace.taskWorkStatus).mockResolvedValueOnce({ dirty: false, unlandedCommits: 2 });
    const settled = await supervisor.settling.declared.closeExternallyReleased(
      "release",
      "v1.2.3 published",
    );
    expect(settled.text).toContain("v1.2.3 published");
    expect(tasks.get("release")).toMatchObject({ status: "done", closedReason: "released" });
    expect(
      tasks.timeline("release").find((entry) => entry.text.includes("v1.2.3 published"))?.data,
    ).toMatchObject({ releaseEvidence: "v1.2.3 published" });
    expect(workspace.landTaskWork).not.toHaveBeenCalled();
    expect(workspace.removeTaskWorktree).toHaveBeenCalledOnce();
    expect(
      (await supervisor.settling.declared.closeExternallyReleased("release", "v1.2.3 published"))
        .text,
    ).toContain("wait for its crewmate");
  });

  it("refuses an external release for unreported work, a pull request that may still be open and failed inspection", async () => {
    // INF-2628: the task's own pull request refuses the release close only
    // while it reads open or cannot be read.
    const pulls = new Map<number, ForgePull | Error>();
    const { supervisor, tasks, workspace } = setup(fakeCrewmate(), {
      readPull: async (_id, number) => {
        const pull = pulls.get(number);
        if (pull instanceof Error) throw pull;
        return pull;
      },
    });
    seedTask(tasks, {
      id: "release",
      title: "Publish version",
      status: "idle",
      worktreeDir: "/work",
    });
    expect(
      (await supervisor.settling.declared.closeExternallyReleased("release", "v1.2.3 published"))
        .text,
    ).toContain("has not reported");
    tasks.turns.recordReport("release", { text: "Published externally" });
    seedDelivery(tasks, "release", { prUrl: "https://github.com/o/r/pull/1", prNumber: 1 });
    const pull: ForgePull = {
      number: 1,
      state: "open",
      merged: false,
      headSha: "abc",
      base: "main",
      readiness: "clean",
    };
    pulls.set(1, pull);
    expect(
      (await supervisor.settling.declared.closeExternallyReleased("release", "v1.2.3 published"))
        .text,
    ).toContain("is still open");
    pulls.set(1, new ForgeError("transient", "GitHub answered 502 to GET /repos/o/r/pulls/1"));
    expect(
      (await supervisor.settling.declared.closeExternallyReleased("release", "v1.2.3 published"))
        .text,
    ).toContain("could not be read, so it may still be open");
    expect(tasks.get("release")?.status).toBe("active");
    seedTask(tasks, {
      id: "other",
      title: "Second release",
      status: "idle",
      outcome: "Published",
      worktreeDir: "/other",
    });
    vi.mocked(workspace.taskWorkStatus).mockRejectedValueOnce(new Error("cannot inspect"));
    expect(
      (await supervisor.settling.declared.closeExternallyReleased("other", "v1.2.3 published"))
        .text,
    ).toContain("cannot inspect");
    expect(tasks.get("other")?.status).toBe("active");
  });

  it("lands an idle task through the workspace and cleans up (Q5)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks, events, cards } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Land me",
      intent: intentOf("do and land"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    expect(cards()).toEqual([]);

    const result = await supervisor.settling.settle.settleTask(
      taskId,
      "land",
      undefined,
      "captain",
    );
    expect(result).toContain("into main.");
    expect(workspace.landTaskWork).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, branch: `fm/task-${taskId}` }),
      expect.any(Function),
    );
    expect(events).toContainEqual({
      type: "task_landed",
      taskId,
      title: "Land me",
      mode: "fast-forward",
    });
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "landed" });
    expect(cards().filter((card) => card.taskId === taskId)).toEqual([]);
  });

  it("queues a streaming task's land intent instead of refusing it", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks, cards } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Busy",
      intent: intentOf("still going"),
    });
    await tick();
    const settling = supervisor.settling.settle.settleTask(taskId, "land", undefined, "captain");
    await tick();
    expect(workspace.landTaskWork).not.toHaveBeenCalled();
    expect(tasks.get(taskId)?.pendingSettle?.mode).toBe("land");

    crewmate.finishPrompt();
    expect(await settling).toContain("into main.");
    expect(workspace.landTaskWork).toHaveBeenCalledTimes(1);
    expect(cards().find((card) => card.title === "Cannot merge")).toBeUndefined();
  });

  it("keeps the task and returns the reason when landing is refused", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks, cards } = setup(crewmate);
    (workspace.landTaskWork as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("The repository has uncommitted changes; commit or stash them first."),
    );
    const { taskId } = await supervisor.intake.commission({
      title: "Refused",
      intent: intentOf("land later"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    const result = await supervisor.settling.settle.settleTask(
      taskId,
      "land",
      undefined,
      "captain",
    );
    expect(result).toContain("uncommitted changes");
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(cards().find((card) => card.title === "Cannot merge")).toBeUndefined();
  });
});

/**
 * settle_task mode `answered` (the captain's call C of 2026-09-24): whether
 * an answer task is the Firstmate's own internal step is its judgment,
 * declared when it creates the task (`internal_step`). The host infers
 * nothing: it stores the declaration and honours it - a declared step closes
 * done/answered on the Firstmate's word once a live task builds on it, and
 * anything else stays the captain's to close, whatever its kind.
 */
describe("closing an answer task another task builds on", () => {
  /** The classifier sorts by title: Plan -> plan, Reproduce -> reproduce, else implement. */
  const byTitle = {
    classify: async (input: KindInput) =>
      input.title.startsWith("Plan")
        ? ({ kind: "plan", source: "classifier:test", version: "kc1" } as const)
        : input.title.startsWith("Reproduce")
          ? ({ kind: "reproduce", source: "classifier:test", version: "kc1" } as const)
          : ({ kind: "implement", source: "classifier:test", version: "kc1" } as const),
  };

  /** A plan or reproduce step carries typed read-only, as the sequences document says. */
  const stepIntent = (text: string): SpawnIntent => ({
    ...intentOf(text),
    constraints: [{ kind: "read-only" }],
  });

  /** A crewmate that reports and goes idle. */
  async function reportAndIdle(crew: FakeCrewmate, taskId: string, text: string) {
    crew.emit({ type: "assistant_delta", taskId, text });
    crew.emit({ type: "turn_end", taskId });
    crew.finishPrompt();
    await tick();
  }

  /** An idle answer task, declared a step or not, and a planned task built on it. */
  async function answered(
    harness: ReturnType<typeof setup>,
    crew: FakeCrewmate,
    title: string,
    internalStep: boolean,
  ) {
    const { supervisor, tasks } = harness;
    const spawned = await supervisor.intake.commission({
      title,
      intent: /^(Plan|Reproduce)/.test(title)
        ? stepIntent(title.toLowerCase())
        : intentOf(title.toLowerCase()),
      ...(internalStep ? { shape: { internal_step: true } } : {}),
    });
    await tick();
    await reportAndIdle(crew, spawned.taskId, `${title}: done.`);
    const key = tasks.get(spawned.taskId)?.key ?? spawned.taskId;
    const next = supervisor.intake.plan({
      title: `Build on ${title}`,
      intent: intentOf("build on it"),
      shape: { basis: key },
    });
    return { taskId: spawned.taskId, key, next };
  }

  it("stores a direct-build skip declaration on the task without judging its text", async () => {
    const harness = setup(fakeCrewmate(), { classifier: byTitle });
    const reason = "One label; no rule changes; inspect the screen";
    const built = await harness.supervisor.intake.commission({
      title: "Rename a label",
      intent: intentOf("rename the label"),
      shape: { skipped_plan_because: reason },
    });
    expect(harness.tasks.get(built.taskId)?.shape?.skipped_plan_because).toBe(reason);
    expect(harness.events).toContainEqual({
      type: "firstmate_note",
      text: `Plan skipped for this work: ${reason}`,
    });
  });

  it("closes a declared step - plan or reproduce - as answered, with a feed line naming where it went", async () => {
    const planner = fakeCrewmate();
    const reproducer = fakeCrewmate();
    const harness = setup(planner, { crewmates: [reproducer], classifier: byTitle });
    const { supervisor, tasks, workspace } = harness;
    const plan = await answered(harness, planner, "Plan the settings", true);
    const reproduce = await answered(harness, reproducer, "Reproduce the meter reset", true);

    for (const step of [plan, reproduce]) {
      expect(tasks.get(step.taskId)?.shape).toMatchObject({
        deliverable: "answer",
        internal_step: true,
      });
      const result = await supervisor.settling.declared.closeAnswerUsedAsBasis(step.key);
      expect(result.ok).toBe(true);
      expect(tasks.get(step.taskId)).toMatchObject({ status: "done", closedReason: "answered" });
      const closed = tasks.get(step.taskId) as TaskRecord;
      const close = tasks
        .timeline(step.taskId)
        .find((event) => (event.data as { reason?: string } | null)?.reason === "answered");
      const line = taskFeedLine(closed, close as TaskEvent);
      expect(line?.kind).toBe("ok");
      expect(line?.text).toBe(
        `Answered: its answer carries on in ${step.next.key} "${step.next.title}"`,
      );
      expect(line?.text).not.toContain("discard");
      expect((await supervisor.settling.declared.closeAnswerUsedAsBasis(step.key)).text).toContain(
        "already",
      );
    }
    // Their scratch copies go with them, like any answer task's.
    expect(workspace.removeTaskWorktree).toHaveBeenCalledTimes(2);
  });

  it("closes a step a live task waits on through a blocks link into that task, clearing the wait", async () => {
    const checker = fakeCrewmate();
    const builder = fakeCrewmate();
    const lateChecker = fakeCrewmate();
    const harness = setup(checker, { crewmates: [builder, lateChecker], classifier: byTitle });
    const { supervisor, tasks } = harness;
    // FI3-417's shape: a check run for a build already under way, which
    // names no basis of the check, linked as a recorded wait.
    const check = await supervisor.intake.commission({
      title: "Reproduce the live cases on the meter",
      intent: stepIntent("run the live cases"),
      shape: { internal_step: true },
    });
    await tick();
    const build = await supervisor.intake.commission({
      title: "Implement the meter",
      intent: intentOf("build the meter"),
    });
    await tick();
    tasks.graph.link(check.taskId, build.taskId, "blocks", "firstmate");
    await reportAndIdle(checker, check.taskId, "checks: pass - ten of ten.");
    const checkKey = tasks.get(check.taskId)?.key ?? check.taskId;
    const buildKey = tasks.get(build.taskId)?.key ?? build.taskId;
    // A recorded wait holds the start, not the merge (INF-416 piece E).
    expect(tasks.graph.blocking(check.taskId).map((row) => row.id)).toEqual([build.taskId]);
    expect(tasks.graph.blockerRefusal(build.taskId)).toBeUndefined();

    const result = await supervisor.settling.declared.closeAnswerUsedAsBasis(checkKey);
    expect(result).toMatchObject({ ok: true });
    expect(result.text).toContain(`its answer carries on in ${buildKey} "Implement the meter"`);
    const closed = tasks.get(check.taskId) as TaskRecord;
    expect(closed).toMatchObject({ status: "done", closedReason: "answered" });
    const close = tasks
      .timeline(check.taskId)
      .find((event) => (event.data as { reason?: string } | null)?.reason === "answered");
    expect(close?.data).toMatchObject({ waitedOnBy: build.taskId });
    const line = taskFeedLine(closed, close as TaskEvent);
    expect(line?.kind).toBe("ok");
    expect(line?.text).toBe(`Answered: its answer carries on in ${buildKey} "Implement the meter"`);
    // Done is what clears a wait: the build carries on, and nothing holds its merge.
    expect(tasks.graph.blockerRefusal(build.taskId)).toBeUndefined();
    expect(tasks.graph.waitingOn(build.taskId)).toEqual([]);
    expect(tasks.get(build.taskId)?.status).toBe("active");

    // A link to work that already closed carries the answer nowhere: the
    // step closes on its own report, never into the dropped task.
    const late = await supervisor.intake.commission({
      title: "Reproduce the live cases on the dock",
      intent: stepIntent("run the dock's live cases"),
      shape: { internal_step: true },
    });
    await tick();
    const gone = supervisor.intake.plan({
      title: "Fix the dock",
      intent: intentOf("fix the dock"),
    });
    tasks.graph.link(late.taskId, gone.id, "blocks", "firstmate");
    tasks.close(gone.id, { status: "dropped", reason: "cancelled", actor: "host" });
    await reportAndIdle(lateChecker, late.taskId, "checks: pass - eight of eight.");
    const closedLate = await supervisor.settling.declared.closeAnswerUsedAsBasis(late.taskId);
    expect(closedLate).toMatchObject({ ok: true });
    expect(closedLate.text).toContain("its crewmate reported the answer");
    expect(closedLate.text).not.toContain("Fix the dock");
  });

  // INF-1137 friction 4: INF-1121 and DOP-60 reported their full answers,
  // which the first mate passed on by a steer to a task already under way.
  // No task named them as basis, so answered was refused and the first mate
  // discarded them, announcing two finished investigations as "dropped".
  it("closes a reported step nothing builds on as answered, never as a drop (INF-1137)", async () => {
    const checker = fakeCrewmate();
    const harness = setup(checker, { classifier: byTitle });
    const { supervisor, tasks, cards } = harness;
    const check = await supervisor.intake.commission({
      title: "Check the card-maximize journey on main",
      intent: stepIntent("run the card-maximize journey on untouched main"),
      shape: { internal_step: true },
    });
    await tick();
    await reportAndIdle(
      checker,
      check.taskId,
      "Answer: main does not fail the same way. All five runs passed.",
    );
    const key = tasks.get(check.taskId)?.key ?? check.taskId;

    const result = await supervisor.settling.declared.closeAnswerUsedAsBasis(key);
    expect(result).toMatchObject({ ok: true });
    const closed = tasks.get(check.taskId) as TaskRecord;
    expect(closed).toMatchObject({ status: "done", closedReason: "answered" });
    const close = tasks
      .timeline(check.taskId)
      .find((event) => (event.data as { reason?: string } | null)?.reason === "answered");
    const line = taskFeedLine(closed, close as TaskEvent);
    expect(line).toMatchObject({ kind: "ok", text: "Answered: its crewmate reported the answer" });
    // No first mate note announces it: an answer's close takes no sentence.
    expect(cards().filter((card) => card.taskId === check.taskId)).toEqual([]);
  });

  it("leaves an answer not declared a step - a repro or plan the captain asked for - to his click", async () => {
    const reproducer = fakeCrewmate();
    const planner = fakeCrewmate();
    const harness = setup(reproducer, { crewmates: [planner], classifier: byTitle });
    const { supervisor, tasks, cards, specs } = harness;
    const reproduce = await answered(harness, reproducer, "Reproduce the dock flicker", false);
    const plan = await answered(harness, planner, "Plan the dock", false);
    for (const asked of [reproduce, plan]) {
      expect(tasks.get(asked.taskId)?.shape?.internal_step).toBeUndefined();
      const refused = await supervisor.settling.declared.closeAnswerUsedAsBasis(asked.key);
      expect(refused).toMatchObject({ ok: false });
      expect(refused.text).toContain("it was not opened as an internal step of yours");
      expect(tasks.get(asked.taskId)?.status).toBe("active");
    }
    // His own close is unchanged: his choice on its card closes it answered.
    specs[0]?.onCard?.({
      title: "The dock flicker reproduces",
      body: "<p>The dock flickers on resize.</p><ul><li>Seen three times.</li></ul>",
      actions: [
        { id: "leave", label: "Leave it" },
        { id: "fix", label: "Fix it", default: true },
      ],
    });
    await tick();
    const card = cards().find((entry) => entry.taskId === reproduce.taskId) as Card;
    specs[0]?.onReport?.("The decision is ready.");
    supervisor.cardActions.act(card.id, "fix");
    await tick();
    expect(tasks.get(reproduce.taskId)).toMatchObject({ status: "done", closedReason: "answered" });
  });

  it("refuses a step still working, one with no report, a change, and one whose card is up", async () => {
    const working = fakeCrewmate();
    const unused = fakeCrewmate();
    const builder = fakeCrewmate();
    const carded = fakeCrewmate();
    const harness = setup(working, { crewmates: [unused, builder, carded], classifier: byTitle });
    const { supervisor, tasks, specs } = harness;
    const step = { shape: { internal_step: true } };

    const busy = await supervisor.intake.commission({
      title: "Reproduce the drift",
      intent: stepIntent("reproduce the drift"),
      ...step,
    });
    await tick();
    const busyKey = tasks.get(busy.taskId)?.key ?? busy.taskId;
    supervisor.intake.plan({
      title: "Fix the drift",
      intent: intentOf("fix"),
      shape: { basis: busyKey },
    });
    const stillWorking = await supervisor.settling.declared.closeAnswerUsedAsBasis(busyKey);
    expect(stillWorking).toMatchObject({ ok: false });
    expect(stillWorking.text).toContain("its crewmate is still working");

    // A step that went idle without a report has no answer to close on.
    const lone = await supervisor.intake.commission({
      title: "Plan the rename",
      intent: stepIntent("plan the rename"),
      ...step,
    });
    await tick();
    unused.emit({ type: "turn_end", taskId: lone.taskId });
    unused.finishPrompt();
    await tick();
    expect(tasks.get(lone.taskId)?.outcome).toBeNull();
    const nobody = await supervisor.settling.declared.closeAnswerUsedAsBasis(
      tasks.get(lone.taskId)?.key ?? lone.taskId,
    );
    expect(nobody).toMatchObject({ ok: false });
    expect(nobody.text).toContain("its crewmate has reported no answer yet");

    const change = await answered(harness, builder, "Implement the rename", true);
    const notAnswer = await supervisor.settling.declared.closeAnswerUsedAsBasis(change.key);
    expect(notAnswer).toMatchObject({ ok: false });
    expect(notAnswer.text).toContain("delivers a change, not an answer");

    const shown = await supervisor.intake.commission({
      title: "Reproduce the flash",
      intent: stepIntent("reproduce the flash"),
      ...step,
    });
    await tick();
    specs[3]?.onCard?.({
      title: "The flash reproduces",
      body: "<p>The screen flashes on wake.</p><ul><li>Seen twice.</li></ul>",
      actions: [
        { id: "leave", label: "Leave it" },
        { id: "fix", label: "Fix it", default: true },
      ],
    });
    await reportAndIdle(carded, shown.taskId, "reproduced: yes");
    const shownKey = tasks.get(shown.taskId)?.key ?? shown.taskId;
    supervisor.intake.plan({
      title: "Fix the flash",
      intent: intentOf("fix"),
      shape: { basis: shownKey },
    });
    const waiting = await supervisor.settling.declared.closeAnswerUsedAsBasis(shownKey);
    expect(waiting).toMatchObject({ ok: false });
    expect(waiting.text).toContain(
      'its answer card "The flash reproduces" is waiting on the captain',
    );

    // Every refusal left its task exactly as it was.
    for (const id of [busy.taskId, lone.taskId, change.taskId, shown.taskId]) {
      expect(tasks.get(id)?.status).toBe("active");
    }
  });
});
