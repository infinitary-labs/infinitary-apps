/**
 * A crewmate's own cards as `CrewmateCards` takes them
 * (docs/card-authoring.md): emit_card's stable id and revisions, close_card,
 * the card stack's uniform chrome, the captain gate a card places, and a
 * card reaching the stage at its author's close-out.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */

import { DECLINE_ACTION_ID } from "@shared/cardLeave";
import { type Card, cardPresentation, onStage } from "@shared/cards";
import type { DecisionAnswer } from "@shared/decisions";
import { describe, expect, it, vi } from "vitest";
import {
  askedOn,
  completionBody,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  METER_RISK,
  SETTLE_DISCARD,
  SETTLE_MERGE,
  settleLines,
  setup,
  syncCardId,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { cardReader } from "../decisions/cardReader";
import { seedTask } from "../tasks/seedTask";
import type { TaskService } from "../tasks/taskService";
import { FIRSTMATE_FAILURE_CARD_ID } from "./hostCards";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it("tells a crewmate how its revision of a seen card compares, and never refuses a rewrite", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, specs } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "cards",
      intent: intentOf("revise a card"),
    });
    await tick();
    const onCard = specs[0]?.onCard;
    const note = (body: string) => ({ id: "plan", title: "The plan", body, actions: [] });
    const first = await onCard?.(note("<p>One.</p><p>Two.</p><p>Three.</p>"));
    // Never seen: no counts.
    expect(first).toBe(`card-${taskId}-plan`);
    crewmate.finishPrompt();
    await tick();
    const stage = cards().find((card) => card.id === first) as Card;
    supervisor.cards.seen(stage.id, stage.offerId as string);

    const small = await onCard?.(note("<p>One.</p><p>Two.</p><p>Three again.</p>"));
    expect(small).toContain("1 part new and 1 removed");
    const rewrite = await onCard?.(note("<p>A.</p><p>B.</p><p>C.</p>"));
    expect(rewrite).toContain("3 parts new and 3 removed");
    expect(rewrite).toContain('"Rewritten"');
  });

  it("turns crewmate-emitted cards into the card stack with uniform chrome", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, specs, cardStore } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "cards",
      intent: intentOf("show every card kind"),
    });
    await tick();
    const onCard = specs[0]?.onCard;
    expect(onCard).toBeTypeOf("function");

    onCard?.({
      title: "Pick a course",
      body: "<p>Plotting a new course is the faster route.</p><p>Holding course waits out the storm.</p>",
      actions: [
        { id: "hold", label: "Hold course" },
        { id: "change", label: "Plot new course", default: true },
      ],
    });
    onCard?.({ title: "Quota note", body: "All steady.", actions: [] });
    // A preview is a decision whose body is interactive: same chrome, and
    // the choice sits on the card that shows the thing.
    onCard?.({
      title: "Preview",
      body: "<button data-inf-action='hold'>Hold</button><script>wire();</script>",
      actions: [
        { id: "turn", label: "Turn back" },
        { id: "hold", label: "Hold", default: true },
      ],
    });
    crewmate.finishPrompt();
    await tick();

    const snapshot = cards();
    expect(snapshot.map(cardPresentation)).toEqual(["decision", "decision", "note"]);
    // A card carries exactly the actions its author declared (P0, WI-1), and
    // a decision with no way to say no of its own the app's Decline (INF-3108).
    const preview = snapshot.find((card) => card.title === "Preview") as Card;
    expect(preview.actions.map((action) => action.id)).toEqual(["turn", "hold", DECLINE_ACTION_ID]);
    const decision = snapshot.find((card) => card.title === "Pick a course") as Card;
    expect(decision.actions.map((action) => action.id)).toEqual([
      "hold",
      "change",
      DECLINE_ACTION_ID,
    ]);
    expect(decision.actions[0]).toMatchObject({ id: "hold", variant: "secondary" });
    expect(decision.actions[1]).toMatchObject({ id: "change", variant: "primary" });
    expect(decision.actions[2]).toMatchObject({ id: DECLINE_ACTION_ID, variant: "ghost" });
    const note = snapshot[2] as Card;
    expect(note.actions).toEqual([]);
    // The chrome meta line names the task, and the catalog model rides
    // beside it as its own field (the chrome's chip) - never the task key,
    // provider, crewmate index, or branch name.
    expect(snapshot.every((card) => card.meta === "cards" && card.model === "Claude Fable 5")).toBe(
      true,
    );

    // The action round-trip: a declared choice steers the idle session as a
    // new turn and the resolution is recorded.
    supervisor.cardActions.act(decision.id, "change");
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe(
      'Card "Pick a course": the user chose "Plot new course" (change).',
    );
    expect(cardStore.chosenAction(decision.id)).toBe("change");
    expect(cards().find((card) => card.id === decision.id)).toBeUndefined();
    expect(taskId).toBeTruthy();
  });

  it("reports when a resolved crewmate card choice cannot be delivered", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, specs } = setup(crewmate);
    await supervisor.intake.commission({
      title: "cards",
      intent: intentOf("ask for a choice"),
    });
    await tick();
    specs[0]?.onCard?.({
      title: "Pick a course",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [
        { id: "hold", label: "Hold course" },
        { id: "change", label: "Plot new course", default: true },
      ],
    });
    await tick();
    const card = supervisor.cards.snapshot().find((entry) => entry.title === "Pick a course");
    vi.spyOn(supervisor.steer, "steerCrewmate").mockRejectedValue(new Error("session unreachable"));
    specs[0]?.onReport?.("The decision is ready.");
    supervisor.cardActions.act(card?.id ?? "", "change");
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "firstmate_note",
        text: expect.stringMatching(
          /^Could not deliver the card choice for "cards":.*session unreachable/,
        ),
        // It names its task, whose record keeps it (docs/task-record.md).
        taskId: expect.any(String),
      }),
    );
    expect(supervisor.cards.snapshot()).toEqual([]);
  });

  it("close_card removes a card from the snapshot and fails loudly on a second close", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, cardStore } = setup(crewmate);
    const id = supervisor.addFirstmateCard({
      title: "Stale preview",
      body: "Superseded.",
      actions: [],
    });
    await tick();
    expect(cards().find((card) => card.id === id)).toBeDefined();

    const closed = supervisor.closeCard(id, { kind: "firstmate" }, "prototype superseded");
    await tick();
    expect(closed).toContain("Closed card");
    expect(cards().find((card) => card.id === id)).toBeUndefined();
    expect(cardStore.chosenAction(id)).toBe("prototype superseded");

    expect(() => supervisor.closeCard(id, { kind: "firstmate" })).toThrow(/already closed/);
    expect(() => supervisor.closeCard("card-fm-missing", { kind: "firstmate" })).toThrow(
      /Unknown card/,
    );
  });

  it("close_card refuses a card the crewmate did not emit", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, specs } = setup(crewmate);
    const { taskId: ownerId } = await supervisor.intake.commission({
      title: "Owner",
      intent: intentOf("emit a note"),
    });
    await tick();
    const { taskId: otherId } = await supervisor.intake.commission({
      title: "Other",
      intent: intentOf("do not touch that card"),
    });
    await tick();

    specs[0]?.onCard?.({ title: "Owner note", body: "mine", actions: [] });
    await tick();
    const owned = cards().find((card) => card.title === "Owner note") as Card;
    expect(owned.taskId).toBe(ownerId);

    const firstmateId = supervisor.addFirstmateCard({
      title: "Firstmate note",
      body: "not yours",
      actions: [],
    });
    await tick();

    expect(() => supervisor.closeCard(owned.id, { kind: "crewmate", taskId: otherId })).toThrow(
      /not emitted by this task/,
    );
    expect(() => supervisor.closeCard(firstmateId, { kind: "crewmate", taskId: ownerId })).toThrow(
      /not emitted by this task/,
    );
    expect(cards().find((card) => card.id === owned.id)).toBeDefined();
    expect(cards().find((card) => card.id === firstmateId)).toBeDefined();

    supervisor.closeCard(owned.id, { kind: "crewmate", taskId: ownerId });
    await tick();
    expect(cards().find((card) => card.id === owned.id)).toBeUndefined();
    expect(supervisor.facts.crewStatus(ownerId)[0]?.status).not.toBe("completed");
  });

  /**
   * Retired with the close rule (cards-as-threads phase 1, the captain's Q3
   * A): the Firstmate used to dismiss any card on the captain's behalf, and
   * the record then said the captain had closed something he never touched.
   * Words about a crewmate's card now reach that crewmate as a thread reply
   * or a steer, so only the card's author withdraws it.
   */
  it("close_card refuses Firstmate a crewmate's card and names the door", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, cardStore, specs } = setup(crewmate);
    const { taskId: ownerId } = await supervisor.intake.commission({
      title: "Owner",
      intent: intentOf("emit a note"),
    });
    await tick();

    specs[0]?.onCard?.({ title: "Owner note", body: "mine", actions: [] });
    await tick();
    const owned = cards().find((card) => card.title === "Owner note") as Card;

    expect(() =>
      supervisor.closeCard(owned.id, { kind: "firstmate" }, "answered by the captain"),
    ).toThrow(/not yours to close/);
    await tick();
    // The card is untouched: still on the stack, still unresolved.
    expect(cards().find((card) => card.id === owned.id)).toBeDefined();
    expect(cardStore.chosenAction(owned.id)).toBeUndefined();
    expect(supervisor.facts.crewStatus(ownerId)[0]?.status).not.toBe("completed");
  });

  it.each(["land", "merge-pr", "discard"] as const)(
    "%s: the settle effect receipts the card before work, excludes duplicate settles through cleanup, and reports completion",
    async (action) => {
      const operation = deferred<void>();
      const cleanup = deferred<void>();
      const mergePullRequest = vi.fn(() =>
        operation.promise.then(() => ({ ok: true, text: "Change #9 is in on GitHub." })),
      );
      const { supervisor, tasks, workspace, cardStore, events, cards } = setup(fakeCrewmate(), {
        mergePullRequest,
      });
      seedTask(tasks, { id: "receipt", title: "Ship it", status: "idle", worktreeDir: "/work" });
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue(
        action === "merge-pr" ? "direct-pr" : "local-only",
      );
      vi.mocked(workspace.landTaskWork).mockImplementation(() =>
        operation.promise.then(() => ({ mode: "fast-forward" })),
      );
      vi.mocked(workspace.taskWorkStatus).mockImplementation(() =>
        operation.promise.then(() => ({ dirty: false, unlandedCommits: 0 })),
      );
      vi.mocked(workspace.removeTaskWorktree).mockReturnValue(cleanup.promise);
      const offer = () =>
        supervisor.addFirstmateCard({
          requiredActions: [],
          taskId: "receipt",
          title: "Ready to settle",
          body: "Choose what happens to this work.",
          // The action id is a name; what the click does is its effect. A
          // merge on the local-only task lands, on the direct-pr task merges.
          actions: [
            {
              id: action,
              label: action,
              effect: action === "discard" ? SETTLE_DISCARD : SETTLE_MERGE,
            },
          ],
        });
      const first = offer();
      const second = offer();
      supervisor.cardActions.act(first, action);
      // INF-1845: one keyed line on the task's record, which its outcome replaces.
      expect(settleLines(tasks, "receipt")).toEqual([
        action === "discard" ? "Discarding" : "Merging",
      ]);
      expect(supervisor.cards.snapshot().map((card) => card.id)).not.toContain(first);
      expect(cardStore.chosenAction(first)).toBe(action);
      expect(cardStore.listOpen().map((card) => card.id)).not.toContain(first);
      expect(tasks.get("receipt")?.status).toBe("active");
      expect(
        tasks.timeline("receipt").find((event) => event.kind === "card_resolved"),
      ).toMatchObject({
        kind: "card_resolved",
        actor: "captain",
      });
      supervisor.cardActions.act(first, action); // Same-card double click is a no-op.
      supervisor.cardActions.act(second, action); // Another card cannot race this task.
      expect(await supervisor.settling.settle.settleTask("receipt", "merge-pr")).toContain(
        "already in progress",
      );
      await tick();
      // Coalesced push is independent of the operation. A click raises no
      // card of the host's own while it runs (INF-2913).
      expect(cards().map((card) => card.id)).toEqual([]);
      // The second card's attempt settled nothing: the attempt that owns the task says what happened.
      expect(settleLines(tasks, "receipt")).toHaveLength(1);
      expect(events.filter((event) => event.type === "firstmate_note")).toEqual([]);
      expect(mergePullRequest).toHaveBeenCalledTimes(action === "merge-pr" ? 1 : 0);
      expect(workspace.landTaskWork).toHaveBeenCalledTimes(action === "land" ? 1 : 0);
      // The captain's Discard click is the one drop (INF-3169's piece 4), which
      // passes the work holds, so it reads no work status before it closes.
      expect(workspace.taskWorkStatus).not.toHaveBeenCalled();
      operation.resolve();
      await vi.waitFor(() => expect(workspace.removeTaskWorktree).toHaveBeenCalledTimes(1));
      expect(await supervisor.settling.settle.settleTask("receipt", "discard")).toContain(
        "already in progress",
      );
      cleanup.resolve();
      await vi.waitFor(() =>
        expect(tasks.timeline("receipt").at(-1)).toMatchObject(
          action === "discard"
            ? { kind: "status", data: { reason: "discarded" } }
            : { kind: action === "land" ? "landed" : "merged" },
        ),
      );
      expect(cardStore.chosenAction(first)).toBe(action); // Receipt is never rewritten as success.
      // A merge writes its line as it closes the task, a moment before the settle lets the task go.
      await vi.waitFor(async () =>
        expect(await supervisor.settling.settle.settleTask("receipt", "discard")).not.toContain(
          "in progress",
        ),
      );
      // The merge went in and left no card behind (INF-2913).
      await vi.waitFor(() => expect(cards()).toEqual([]));
    },
  );

  it("keeps only the crewmate's declared risk on the completion card and the task", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs, cardStore } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("fix the meter"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    seedDelivery(tasks, taskId, { mode: "local-only", ci: "green", ciAt: Date.now() });
    const pictures = [{ id: "p1", alt: "The meter after", width: 640, height: 320, group: 0 }];
    const answer = await specs[0]?.onCard?.({
      requiredActions: [],
      title: "The meter reads true",
      body: completionBody("<p>It reads true.</p>"),
      actions: [{ id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE }],
      pictures,
      riskDeclaration: METER_RISK,
    });
    expect(answer).toMatch(/^card-/);
    const record = tasks.get(taskId);
    const risk = {
      declared: METER_RISK,
    };
    expect(cardStore.newestForTask(taskId)?.risk).toEqual(risk);
    expect(record?.delivery?.risk).toEqual(risk);
  });
});

describe("emit_card stable id revision", () => {
  it("revises an open Firstmate card in place and still adds a new topic", async () => {
    const { supervisor, cards } = setup(fakeCrewmate());
    supervisor.addFirstmateCard({
      id: "fm-feed-scroll",
      title: "Feed scroll v1",
      body: "<p>v1</p>",
      actions: [],
    });
    await tick();
    const first = cards();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: "card-fm-feed-scroll",
      title: "Feed scroll v1",
      body: "<p>v1</p>",
    });
    const createdAt = first[0]?.createdAt;

    supervisor.addFirstmateCard({
      id: "fm-feed-scroll",
      title: "Feed scroll v2",
      body: "<p>v2</p>",
      actions: [{ id: "go", label: "Go", default: true }],
    });
    await tick();
    const revised = cards();
    expect(revised).toHaveLength(1);
    expect(revised[0]).toMatchObject({
      id: "card-fm-feed-scroll",
      title: "Feed scroll v2",
      body: "<p>v2</p>",
      createdAt,
    });
    expect(revised[0]?.actions.map((action) => action.id)).toEqual(["go", DECLINE_ACTION_ID]);

    supervisor.addFirstmateCard({
      id: "fm-other-topic",
      title: "Other",
      body: "A different fact.",
      actions: [],
    });
    await tick();
    expect(cards()).toHaveLength(2);
    expect(
      cards()
        .map((card) => card.id)
        .sort(),
    ).toEqual(["card-fm-feed-scroll", "card-fm-other-topic"]);
  });

  it("does not overwrite an app-raised singleton unless the id matches", async () => {
    const { supervisor, cards } = setup(fakeCrewmate());
    supervisor.cards.hostCards.addFirstmatePauseCard({
      pause: "no_headroom",
      body: "Move the flagship.",
      providerName: "Grok",
      move: { providerId: "openai-codex", providerName: "Codex" },
    });
    await tick();
    supervisor.addFirstmateCard({
      id: "fm-feed-scroll",
      title: "Unrelated",
      body: "Not the ladder.",
      actions: [],
    });
    await tick();
    expect(cards()).toHaveLength(2);
    expect(cards().find((card) => card.id === "card-fm-flagship-move")?.body).toBe(
      "Move the flagship.",
    );

    supervisor.addFirstmateCard({
      id: "fm-flagship-move",
      title: "Firstmate has used up its allowance",
      body: "Revised ladder copy.",
      actions: [
        {
          id: "open-settings",
          label: "Open settings",
          default: true,
          effect: { kind: "open", target: "settings" },
        },
      ],
    });
    await tick();
    const flagship = cards().find((card) => card.id === "card-fm-flagship-move");
    expect(flagship?.body).toBe("Revised ladder copy.");
    expect(cards().filter((card) => card.id === "card-fm-flagship-move")).toHaveLength(1);
  });

  it("revises an open crewmate card in place without stacking", async () => {
    const { supervisor, cards, specs } = setup(fakeCrewmate());
    const { taskId } = await supervisor.intake.commission({
      title: "proto",
      intent: intentOf("show a preview"),
    });
    await tick();
    const onCard = specs[0]?.onCard;
    onCard?.({
      id: "feed-scroll",
      title: "Scroll v1",
      body: "<p>v1</p>",
      actions: [],
    });
    onCard?.({
      id: "feed-scroll",
      title: "Scroll v2",
      body: "<p>v2</p>",
      actions: [],
    });
    onCard?.({
      id: "other-topic",
      title: "Aside",
      body: "Another fact.",
      actions: [],
    });
    await tick();
    const snapshot = cards();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.find((card) => card.id === `card-${taskId}-feed-scroll`)).toMatchObject({
      title: "Scroll v2",
      body: "<p>v2</p>",
    });
    expect(snapshot.find((card) => card.id === `card-${taskId}-other-topic`)?.title).toBe("Aside");
  });

  // A named id resolves to the card it names before a new card is filed, so
  // the crewmate's write on the app's card is refused, never filed beside it
  // (INF-2225's approved "canonical ids resolve before creation prefixes";
  // docs/card-threads.md "Shared cards").
  it("does not let a crewmate clobber an app-raised singleton", async () => {
    const { supervisor, cards, specs } = setup(fakeCrewmate());
    supervisor.cards.hostCards.addAuthDecisionCard("card-fm-auth", "firstmate", "Sign in needed.");
    await supervisor.intake.commission({ title: "proto", intent: intentOf("work") });
    await tick();
    const result = await specs[0]?.onCard?.({
      id: "card-fm-auth",
      title: "Not auth",
      body: "Crewmate copy.",
      actions: [],
    });
    await tick();
    expect(result).toMatchObject({ effect: "refused", cardId: "card-fm-auth" });
    expect(cards().find((card) => card.id === "card-fm-auth")?.body).toBe("Sign in needed.");
    expect(cards().some((card) => card.body === "Crewmate copy.")).toBe(false);
    expect(cards()).toHaveLength(1);
  });
});

/**
 * The owner's call 3 on the primitives review ("every card with actions
 * places the captain gate on its task; host cards file an operation task"):
 * a card is on the record the way every captain decision is, so "waiting on
 * you" is one query over the gate.
 */
describe("a card places the captain gate (cards as tasks)", () => {
  const hostRows = (tasks: TaskService, cardId: string) =>
    tasks.list().filter((record) => record.kind === "operation" && record.gate?.ref === cardId);

  it("a host card with actions and no task files an open operation row that its answer closes", () => {
    const { supervisor, tasks } = setup(fakeCrewmate());
    supervisor.cards.hostCards.addFirstmatePauseCard({
      pause: "no_headroom",
      body: "<p>Move Firstmate?</p>",
      providerName: "Grok",
      move: { providerId: "openai-codex", providerName: "Codex" },
    });
    const [row] = hostRows(tasks, "card-fm-flagship-move");
    expect(row).toMatchObject({
      kind: "operation",
      status: "open",
      title: "Your first mate has used up its allowance",
      gate: { kind: "captain", ref: "card-fm-flagship-move" },
    });
    // A revision or a second raise files nothing more.
    supervisor.cards.hostCards.addFirstmatePauseCard({
      pause: "no_headroom",
      body: "<p>Move Firstmate?</p>",
      providerName: "Grok",
      move: { providerId: "openai-codex", providerName: "Codex" },
    });
    expect(hostRows(tasks, "card-fm-flagship-move")).toHaveLength(1);
    // The row is its card, not crew work.
    expect(supervisor.facts.crewStatus()).toEqual([]);

    supervisor.cardActions.act("card-fm-flagship-move", "move-flagship");
    expect(tasks.get(row?.id ?? "")).toMatchObject({ status: "done", closedReason: "answered" });
    // The host's bookkeeping is not news: no feed line for its close.
    expect(tasks.timeline(row?.id ?? "").at(-1)).toMatchObject({ feed: false });
  });

  it("a host withdrawal drops its row; INF-1879 putting it away keeps it open", () => {
    const { supervisor, tasks } = setup(fakeCrewmate());
    supervisor.cards.hostCards.addAuthDecisionCard(
      "card-auth-account-acct_cl1",
      "Claude",
      "Claude (Personal) needs you to sign in again.",
      { restoreAccountId: "acct_cl1" },
    );
    const [recovered] = hostRows(tasks, "card-auth-account-acct_cl1");
    supervisor.cards.hostCards.clearAuthDecisionCard("card-auth-account-acct_cl1");
    expect(tasks.get(recovered?.id ?? "")).toMatchObject({
      status: "dropped",
      closedReason: "superseded",
    });

    supervisor.cards.hostCards.addFirstmateFailureCard("<p>The turn failed.</p>");
    const [failure] = hostRows(tasks, FIRSTMATE_FAILURE_CARD_ID);
    expect(failure?.status).toBe("open");
    supervisor.close(FIRSTMATE_FAILURE_CARD_ID);
    expect(tasks.get(failure?.id ?? "")).toMatchObject({ status: "open", closedReason: null });
    // A note asks nothing, so it files nothing.
    supervisor.cards.hostCards.addSystemNoteCard("card-note", "A note", "<p>FYI.</p>");
    expect(hostRows(tasks, "card-note")).toEqual([]);
  });

  it("the sweep heals both sides: a host card with no row files one, a row whose card is gone closes", async () => {
    const { supervisor, tasks } = setup(fakeCrewmate());
    // A card from a version that filed no row, or a crash between the two
    // writes: the card is up and nothing gates it.
    supervisor.cards.hostCards.addFirstmatePauseCard({
      pause: "no_headroom",
      body: "<p>Nothing has headroom.</p>",
      providerName: "Codex",
    });
    const [filed] = hostRows(tasks, "card-fm-no-headroom");
    tasks.close(filed?.id ?? "", { status: "dropped", reason: "superseded", actor: "host" });
    await supervisor.watch.sweepGates(Date.now());
    const open = hostRows(tasks, "card-fm-no-headroom").filter((row) => row.status === "open");
    expect(open).toHaveLength(1);
    // And the other way: a row whose card never made it to the stack.
    const orphan = tasks.capture.fileHostCardTask({
      id: "orphan-1",
      title: "Gone",
      cardId: "card-gone",
    });
    await supervisor.watch.sweepGates(Date.now());
    expect(tasks.get(orphan.id)).toMatchObject({ status: "dropped", closedReason: "superseded" });
    expect(tasks.timeline(orphan.id).at(-1)).toMatchObject({
      text: "its card is gone",
      feed: false,
    });
  });

  it("the crewmate's sign-in card gates its task, and its departure releases it", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    crewmate.emit({ type: "turn_failed", taskId, error: "401 unauthorized: sign in again" });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const card = supervisor.cards.snapshot().find((entry) => entry.id === `card-auth-${taskId}`);
    expect(card?.taskId).toBe(taskId);
    expect(tasks.get(taskId)?.gate).toEqual({ kind: "captain", ref: `card-auth-${taskId}` });
    expect(tasks.list().filter((record) => record.kind === "operation")).toEqual([]);
    supervisor.cards.hostCards.clearAuthDecisionCard(`card-auth-${taskId}`);
    expect(tasks.get(taskId)?.gate).toBeNull();
  });

  it("with two cards up the gate keeps the one it names, and moves to the other when it goes", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    specs[0]?.onCard?.({
      title: "Pick a course",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [
        { id: "hold", label: "Hold course" },
        { id: "change", label: "Plot new course", default: true },
      ],
    });
    await tick();
    const first = tasks.get(taskId)?.gate?.ref as string;
    const second = supervisor.addFirstmateCard({
      taskId,
      title: "Also pick a port",
      body: "<p>Pick the port.</p><ul><li>North or south.</li></ul>",
      actions: [{ id: "north", label: "North", default: true }],
    });
    expect(tasks.get(taskId)?.gate?.ref).toBe(first);
    specs[0]?.onReport?.("The decision is ready.");
    supervisor.cardActions.act(first, "change");
    await tick();
    expect(tasks.get(taskId)?.gate).toEqual({ kind: "captain", ref: second });
    supervisor.cardActions.act(second, "north");
    expect(tasks.get(taskId)?.gate).toBeNull();
  });
});

/**
 * A card reaches the stage at its author's close-out (the captain's "ship
 * it" of 2026-09-27; docs/card-threads.md "When a card reaches the stage").
 * The regression cases are the recorded exchanges of the design's section
 * 3.3, replayed tool call by tool call at their recorded offsets through
 * the real card, thread and report paths: the acknowledgement must not
 * bring the card back, and neither must a report while its author works on
 * - the captain's INF-797: "it should come back when the crewmate's turn is
 * finished" - so case C comes back once, at its turn's end. A new card
 * still goes up at the report. The stage is what the window draws: the
 * snapshot's cards that are not awaiting their author. A card the captain
 * replied under stays on it at the back (`sentBackAt`) while it waits,
 * showing what it showed.
 */
describe("CrewSupervisor: a card reaches the stage at its author's close-out", () => {
  const S = 1_000;

  /** The card as the window draws it once its author has answered: on the stage, not waiting. */
  function staged(harness: ReturnType<typeof setup>, cardId: string): Card | undefined {
    return harness.cards().find((card) => card.id === cardId && onStage(card) && !card.awaiting);
  }

  /** The recorded clock: `ms` after the captain's reply at `from`. */
  async function at(from: number, ms: number) {
    await vi.advanceTimersByTimeAsync(from + ms - Date.now());
  }

  /**
   * A crewmate whose first turn emitted a card and reported it: the card is
   * on the stage, the crewmate idle.
   */
  async function onTheStage(
    harness: ReturnType<typeof setup>,
    crewmate: FakeCrewmate,
    card: { title: string; body: string; actions: Card["actions"] },
  ) {
    const { taskId } = await harness.supervisor.intake.commission({
      title: card.title,
      intent: intentOf("investigate and ask"),
    });
    await tick();
    const cardId = syncCardId(harness.specs[0]?.onCard?.(card)) ?? "";
    harness.specs[0]?.onReport?.("Intent: the card is up for the captain.");
    crewmate.finishPrompt();
    await tick();
    expect(staged(harness, cardId)?.title).toBe(card.title);
    return { taskId, cardId, stable: cardId.replace(`card-${taskId}-`, "") };
  }

  /** The task's `card_raised` rows for a card, as the timeline records its stage moments. */
  function stageMoments(harness: ReturnType<typeof setup>, taskId: string, cardId: string) {
    return harness.tasks
      .timeline(taskId)
      .filter((event) => event.kind === "card_raised" && event.ref === cardId)
      .map((event) => ({ at: event.at, data: event.data }));
  }

  it("A: an acknowledgement in the thread does not bring the card back, nor does the report at +185 s; the turn's end does", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId, cardId, stable } = await onTheStage(harness, crewmate, {
      title: "Idle crew recovery",
      body: "<p>Three separate fixes for three idle cases.</p><p>Each case idles for a different reason.</p>",
      actions: [
        { id: "fix-each", label: "Fix each case", default: true },
        { id: "heartbeat", label: "Add a heartbeat" },
        { id: "wait", label: "Wait" },
      ],
    });

    const replied = Date.now();
    harness.supervisor.cardActions.replyToCard(
      cardId,
      "one general catch-all for every idle crewmate - what about a heartbeat?",
    );
    await tick();
    expect(staged(harness, cardId)).toBeUndefined();
    const waiting = harness.cards().find((card) => card.id === cardId);
    expect(waiting?.awaiting).toBe("answer");
    // Still on the stage, at the back, showing what it showed at the reply.
    expect(waiting && onStage(waiting)).toBe(true);
    expect(waiting?.sentBackAt).toBeDefined();
    expect(waiting?.title).toBe("Idle crew recovery");
    expect(harness.cards().at(-1)?.id).toBe(cardId);
    // One feed line while the author works: nothing on the stage.
    expect(harness.events).toContainEqual({
      type: "firstmate_note",
      text: 'You asked crewmate 1 under "Idle crew recovery"',
    });
    const spec = harness.specs[0];

    await at(replied, 6 * S);
    spec?.onReply?.({
      cardId,
      text: "I'll assess a general recovery mechanism rather than assume separate fixes are the answer. Your heartbeat proposal is a useful candidate: I'll compare it.",
    });
    await tick();
    // The acknowledgement paints the thread and nothing else.
    expect(harness.threads.at(-1)?.messages.at(-1)?.who).toBe("crewmate");
    expect(staged(harness, cardId)).toBeUndefined();

    await at(replied, 10 * S);
    spec?.onProgress?.("Captain redirected the investigation toward one general catch-all.");
    await at(replied, 167 * S);
    syncCardId(
      spec?.onCard?.({
        id: stable,
        // The acknowledgement left their question open; the revision's reply
        // answers it by naming it.
        reply: "I rewrote the card around one reconciler; the choices now lead with building it.",
        answersMessage: askedOn(harness.supervisor, cardId),
        title: "General idle crew recovery · round 2",
        body: "<p>One reconciler reads every idle crewmate on a durable clock.</p><p>Every idle case in the record is one missing witness.</p>",
        actions: [
          { id: "one-reconciler", label: "Build the reconciler", default: true },
          { id: "heartbeat", label: "Add a heartbeat" },
          { id: "wait", label: "Wait" },
        ],
      }),
    );
    await tick();
    expect(staged(harness, cardId)).toBeUndefined();

    await at(replied, 185 * S);
    spec?.onReport?.("Intent: assess a general catch-all for all idle crewmates.");
    await tick();
    // The crewmate works on: the card waits at the back, as it was.
    expect(staged(harness, cardId)).toBeUndefined();
    expect(harness.cards().find((card) => card.id === cardId)).toMatchObject({
      title: "Idle crew recovery",
      awaiting: "close-out",
    });
    const raised = stageMoments(harness, taskId, cardId).length;
    crewmate.finishPrompt();
    await tick();
    expect(staged(harness, cardId)?.title).toBe("General idle crew recovery · round 2");
    expect(stageMoments(harness, taskId, cardId)).toHaveLength(raised + 1);
    const back = stageMoments(harness, taskId, cardId).at(-1);
    expect(back?.data).toEqual(expect.objectContaining({ closeOut: "idle", returned: true }));
    expect(back?.at).toBeGreaterThan(replied + 185 * S);
  });

  it("a click on a card waiting at the back chooses from the version it showed", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { cardId, stable } = await onTheStage(harness, crewmate, {
      title: "Pick one",
      body: "<p>Left is the safer way.</p><p>Right costs a day and buys little.</p>",
      actions: [
        { id: "left", label: "Left", default: true },
        { id: "right", label: "Right" },
      ],
    });
    harness.supervisor.cardActions.replyToCard(cardId, "why not left?");
    await tick();
    // The author revised it meanwhile: the stage still shows the old offer.
    harness.specs[0]?.onCard?.({
      id: stable,
      reply: "Middle is safer; I changed the offer.",
      answersMessage: askedOn(harness.supervisor, cardId),
      title: "Pick one, revised",
      body: "<p>Middle is the safer way.</p><p>Left and right both cost a day.</p>",
      actions: [
        { id: "middle", label: "Middle", default: true },
        { id: "left", label: "Left" },
      ],
    });
    await tick();
    expect(() => harness.supervisor.cardActions.act(cardId, "middle")).toThrow();
    // The chosen offer is the shown one's: "right" resolves the card.
    expect(() => harness.supervisor.cardActions.act(cardId, "right")).not.toThrow();
    await tick();
    expect(harness.cards().some((card) => card.id === cardId)).toBe(false);
  });

  it("B: the answer lands at the turn's end, not the report", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { cardId, stable } = await onTheStage(harness, crewmate, {
      title: "Choose how crewmates use GitHub",
      body: "<p>Three questions decide how crewmates reach GitHub.</p><p>The cautious plan answers all three the safe way.</p>",
      actions: [
        { id: "lock-cautious-plan", label: "Use the cautious plan", default: true },
        { id: "answer-in-thread", label: "Answer in the thread" },
      ],
    });

    const replied = Date.now();
    harness.supervisor.cardActions.replyToCard(
      cardId,
      "do you have the ability to give me choices per question i can just click in the card",
    );
    await tick();
    const spec = harness.specs[0];
    await at(replied, 33 * S);
    spec?.onReply?.({
      cardId,
      text: "Yes. I can put a separate set of clickable choices beside each question in the card. I'll keep your first three answers marked as recorded.",
      answersMessage: askedOn(harness.supervisor, cardId),
    });
    await tick();
    expect(staged(harness, cardId)).toBeUndefined();

    const oneAtATime = {
      id: stable,
      // Every revision after the turn's answer says what it changed (INF-1623).
      reply: "I changed the card to ask question 4 of 6 on its own.",
      title: "Choose GitHub access one question at a time",
      body: "<p>Question 4 of 6: may a crewmate open a proposed change on its own?</p><p>Your first three answers are recorded.</p>",
      actions: [
        { id: "lock-cautious-plan", label: "Use the cautious plan", default: true },
        { id: "answer-in-thread", label: "Answer in the thread" },
      ],
    };
    await at(replied, 70 * S);
    syncCardId(spec?.onCard?.(oneAtATime));
    await tick();
    expect(staged(harness, cardId)).toBeUndefined();

    await at(replied, 79 * S);
    spec?.onReport?.(
      "Captain asked for clickable choices; I answered yes in the thread and revised the card.",
    );
    await tick();
    expect(staged(harness, cardId)).toBeUndefined();
    crewmate.finishPrompt();
    await tick();
    expect(staged(harness, cardId)?.title).toBe(oneAtATime.title);
  });

  it("C: two revisions, an answer and five reports come back once, settled, at the turn's end", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId, cardId, stable } = await onTheStage(harness, crewmate, {
      title: "The saved Claude sign-in blocks this app",
      body: "<p>The saved sign-in only lets Apple's own tools read it.</p><p>Always Allow did not stick across a restart.</p>",
      actions: [
        { id: "edit-access", label: "Change who can read it", default: true },
        { id: "leave-it", label: "Leave it" },
      ],
    });

    const replied = Date.now();
    harness.supervisor.cardActions.replyToCard(
      cardId,
      "but i don't want you to fix it one-off. i need fm3000 to 'just work' for all users. what's the gap?",
    );
    await tick();
    // Each recorded step, then what the stage shows after it.
    const shownAfter: number[] = [];
    const sample = (offset: number) => {
      if (staged(harness, cardId)) shownAfter.push(offset);
    };
    const spec = harness.specs[0];

    await at(replied, 13 * S);
    syncCardId(
      spec?.onCard?.({
        id: stable,
        reply: "That is the gap; the card now says so.",
        answersMessage: askedOn(harness.supervisor, cardId),
        title: "Claude's saved sign-in needs a product fix",
        body: "<p>A fix for every install, not an edit to your saved item.</p><p>The saved item's own rule is the gap.</p>",
        actions: [
          { id: "continue-product-fix", label: "Continue the product fix", default: true },
          { id: "pause-investigation", label: "Pause" },
        ],
      }),
    );
    await tick();
    sample(13 * S);
    await at(replied, 24 * S);
    syncCardId(
      spec?.onCard?.({
        id: stable,
        // Every revision after the turn's answer says what it changed (INF-1623).
        reply: "I turned the card into a note on why Always Allow did not survive.",
        title: "Why Always Allow did not survive",
        body: "<p>The saved item's own rule still grants only Apple's tools.</p>",
        actions: [],
      }),
    );
    await tick();
    sample(24 * S);
    await at(replied, 49 * S);
    spec?.onReply?.({
      cardId,
      text: "You are right. The gap is not a missing app signature or a one-time edit: the saved item's own rule still grants only Apple's tools.",
    });
    await tick();
    sample(49 * S);
    await at(replied, 110 * S);
    spec?.onReport?.("Intent: find a fix that works for users, not an edit to your saved item.");
    await tick();
    sample(110 * S);
    // Still working: more reports on the same turn, and the crewmate never
    // writes on the card again.
    for (const offset of [186, 576, 793, 819]) {
      await at(replied, offset * S);
      spec?.onReport?.("Still testing the product-level path against a throwaway sign-in.");
      await tick();
      sample(offset * S);
    }

    // No report brought it back while the crewmate worked on.
    expect(shownAfter).toEqual([]);
    crewmate.finishPrompt();
    await tick();
    // Never the half-drawn decision: the card came back once, as the note
    // its last write made it, when its turn ended.
    expect(staged(harness, cardId)).toMatchObject({
      title: "Why Always Allow did not survive",
      actions: [],
    });
    const returns = stageMoments(harness, taskId, cardId).filter(
      (moment) => moment.data?.returned === true,
    );
    expect(returns).toEqual([
      { at: expect.any(Number), data: expect.objectContaining({ closeOut: "idle" }) },
    ]);
    expect(returns[0]?.at).toBeGreaterThan(replied + 819 * S);
  });

  // INF-1623: INF-1595's exchange. The captain asked under the card, the
  // crewmate's "Checking..." line ended the wait, and the revision a minute
  // later carried its answer, which the app dropped because nothing waited.
  // Now a line naming no message leaves the wait open (the captain's "Only
  // a line that says it answers it; a handoff stays open"), and the
  // revision's reply naming it ends it.
  it("keeps the wait open through a still-working line, and puts the revision's answer right after its revised line", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const body =
      "<h2>What changed</h2><p>A closed task's working copy is deleted.</p><h2>Checked</h2><p>The copy is deleted.</p>";
    const { cardId, stable } = await onTheStage(harness, crewmate, {
      title: "fix(work): retire a closed task's working copy",
      body,
      actions: [],
    });
    harness.supervisor.cardActions.replyToCard(
      cardId,
      "wait - do you mean worktrees? aren't we supposed to keep warm worktrees?",
    );
    await tick();
    const spec = harness.specs[0];
    // What an older computer that runs work sent: the line without its interim mark.
    spec?.onReply?.({
      cardId,
      text: "Checking how this change meets the warm pool of ready working copies before I answer.",
    });
    const awaiting = () => harness.cards().find((card) => card.id === cardId)?.awaiting;
    expect(awaiting()).toBe("answer");
    const answer =
      "Yes, these are the tasks' worktrees; retiring one resets it into the warm pool. I added a bullet under What changed.";
    syncCardId(
      spec?.onCard?.({
        id: stable,
        reply: answer,
        answersMessage: askedOn(harness.supervisor, cardId),
        title: "fix(work): retire a closed task's working copy",
        body: `${body.replace("is deleted", "is retired")}<p>A retired copy goes to the pool of ready working copies.</p>`,
        actions: [],
      }),
    );
    await tick();
    expect(
      harness.supervisor.cards
        .thread(cardId)
        .messages.map((message) => [message.who, message.text]),
    ).toEqual([
      ["captain", "wait - do you mean worktrees? aren't we supposed to keep warm worktrees?"],
      [
        "crewmate",
        "Checking how this change meets the warm pool of ready working copies before I answer.",
      ],
      ["host", "revised: fix(work): retire a closed task's working copy"],
      ["crewmate", answer],
    ]);
    expect(awaiting()).toBe("close-out");
  });

  // INF-1623, the captain's "every": each revision made while answering
  // carries its own answer, right after the app's revised line.
  it("refuses a revision without its own answer after the turn's answer, and takes one once the turn has ended", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { cardId, stable } = await onTheStage(harness, crewmate, {
      title: "Retire closed working copies",
      body: "<h2>What changed</h2><p>A closed task's copy is deleted.</p>",
      actions: [],
    });
    harness.supervisor.cardActions.replyToCard(cardId, "do you mean worktrees?");
    await tick();
    const spec = harness.specs[0];
    spec?.onReply?.({
      cardId,
      text: "Yes; retiring one puts it back in the warm pool.",
      answersMessage: askedOn(harness.supervisor, cardId),
    });
    const revision = {
      id: stable,
      title: "Retire closed working copies",
      body: "<h2>What changed</h2><p>A closed task's copy is retired into the warm pool.</p>",
      actions: [],
    };
    const before = harness.supervisor.cards.thread(cardId).messages.map((m) => m.who);
    expect(() => spec?.onCard?.(revision)).toThrow(/under which heading/);
    expect(harness.supervisor.cards.thread(cardId).messages.map((m) => m.who)).toEqual(before);
    expect(harness.cardStore.get(cardId)?.body).toBe(
      "<h2>What changed</h2><p>A closed task's copy is deleted.</p>",
    );
    syncCardId(spec?.onCard?.({ ...revision, reply: "I reworded the bullet under What changed." }));
    await tick();
    expect(harness.supervisor.cards.thread(cardId).messages.map((m) => m.who)).toEqual([
      "captain",
      "crewmate",
      "host",
      "crewmate",
    ]);
    crewmate.finishPrompt();
    await tick();
    // A later turn that nobody asked anything in revises as it always did.
    expect(() =>
      spec?.onCard?.({ ...revision, body: "<h2>What changed</h2><p>Retired, and reset.</p>" }),
    ).not.toThrow();
  });

  // INF-2884, the captain's pick: "Keep the mark; name it in the steer's
  // do-this sentence, and refuse a revision whose answer neither names your
  // message nor is marked as a progress note". INF-2883's crewmate revised
  // with a reply naming no message, so its card kept the old body beside
  // "has not answered yet" after the crewmate had answered.
  it("refuses a revision whose answer neither names the captain's message nor is marked a progress note, so the shown card never lags its answer", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const old = "<h2>Gaps</h2><p>Offer a small starter queue workflow.</p>";
    const { taskId, cardId, stable } = await onTheStage(harness, crewmate, {
      title: "Merging through the swept batch",
      body: old,
      actions: [],
    });
    harness.supervisor.cardActions.replyToCard(cardId, "wake the first mate instead?");
    await tick();
    const asked = askedOn(harness.supervisor, cardId);
    const spec = harness.specs[0];
    const revision = {
      id: stable,
      title: "Merging through the swept batch",
      body: "<h2>Gaps</h2><p>Wake the first mate to plan a queue workflow.</p>",
      actions: [],
      reply: "Under Gaps the starter workflow is now waking the first mate.",
    };
    const before = harness.supervisor.cards.thread(cardId).messages.map((m) => m.who);
    expect(() => spec?.onCard?.(revision)).toThrow(`answers_message ${asked}`);
    expect(harness.supervisor.cards.thread(cardId).messages.map((m) => m.who)).toEqual(before);
    expect(harness.cardStore.get(cardId)?.body).toBe(old);

    // A progress note is taken and keeps their question waiting.
    syncCardId(
      spec?.onCard?.({ ...revision, reply: "Checking the queue settings first.", interim: true }),
    );
    crewmate.finishPrompt();
    await tick();
    expect(harness.cards().find((card) => card.id === cardId)).toMatchObject({
      body: old,
      awaiting: "answer",
    });

    // The answer naming their message shows the revision at the turn's end.
    await harness.supervisor.steer.steerCrewmate(taskId, "Go on.");
    await tick();
    syncCardId(spec?.onCard?.({ ...revision, answersMessage: asked }));
    crewmate.finishPrompt();
    await tick();
    expect(staged(harness, cardId)?.body).toBe(revision.body);
  });

  // INF-1623, the captain's "make sure if the card is hidden/minimized etc,
  // it only gets brought back after the final reply is in place".
  it("keeps a card put aside away through a still-working line and its turn's end, and brings it back with the final answer", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId, cardId, stable } = await onTheStage(harness, crewmate, {
      title: "Retire closed working copies",
      body: "<h2>What changed</h2><p>A closed task's copy is deleted.</p>",
      actions: [],
    });
    const aside = () => harness.cards().find((card) => card.id === cardId)?.minimized;
    harness.supervisor.cardActions.replyToCard(cardId, "do you mean worktrees?");
    await tick();
    harness.supervisor.cards.setMinimized(cardId, true);
    const spec = harness.specs[0];
    expect(
      spec?.onReply?.({ cardId, text: "Checking the warm pool first.", interim: true }),
    ).toContain("still waits for your answer");
    crewmate.finishPrompt();
    await tick();
    expect(aside()).toBe(true);

    await harness.supervisor.steer.steerCrewmate(taskId, "Go on.");
    await tick();
    const answer = "Yes; retiring one resets it into the warm pool. I reworded What changed.";
    syncCardId(
      spec?.onCard?.({
        id: stable,
        reply: answer,
        answersMessage: askedOn(harness.supervisor, cardId),
        title: "Retire closed working copies",
        body: "<h2>What changed</h2><p>A closed task's copy is retired into the warm pool.</p>",
        actions: [],
      }),
    );
    await tick();
    expect(aside()).toBe(true);
    crewmate.finishPrompt();
    await tick();
    expect(aside()).toBeUndefined();
    expect(harness.supervisor.cards.thread(cardId).messages.at(-1)).toMatchObject({
      who: "crewmate",
      text: answer,
    });
  });

  // The captain's "Only a line that says it answers it; a handoff stays
  // open", with INF-1623's "it only gets brought back after the final reply
  // is in place": a handoff line, or a revision whose reply is marked a
  // progress note (INF-2884), leaves their question waiting and the card aside.
  it("keeps a card put aside away through a handoff line and a progress-note revision, and brings it back with the named answer", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId, cardId, stable } = await onTheStage(harness, crewmate, {
      title: "Retire closed working copies",
      body: "<h2>What changed</h2><p>A closed task's copy is deleted.</p>",
      actions: [],
    });
    const shown = () => harness.cards().find((card) => card.id === cardId);
    harness.supervisor.cardActions.replyToCard(cardId, "do you mean worktrees?");
    await tick();
    harness.supervisor.cards.setMinimized(cardId, true);
    const spec = harness.specs[0];
    spec?.onReply?.({ cardId, text: "I'm asking the first mate which copies count as warm." });
    syncCardId(
      spec?.onCard?.({
        id: stable,
        reply: "I added a note that the warm pool question is still open.",
        interim: true,
        title: "Retire closed working copies",
        body: "<h2>What changed</h2><p>A closed task's copy is deleted.</p><p>Warm pool: open.</p>",
        actions: [],
      }),
    );
    crewmate.finishPrompt();
    await tick();
    expect(shown()).toMatchObject({ minimized: true, awaiting: "answer" });

    await harness.supervisor.steer.steerCrewmate(taskId, "Go on.");
    await tick();
    spec?.onReply?.({
      cardId,
      text: "Yes; retiring one resets it into the warm pool.",
      answersMessage: askedOn(harness.supervisor, cardId),
    });
    await tick();
    expect(shown()?.minimized).toBe(true);
    crewmate.finishPrompt();
    await tick();
    expect(shown()?.minimized).toBeUndefined();
    expect(shown()?.awaiting).toBeUndefined();
  });

  // INF-797: a card the captain put aside must not come back "while the
  // crewmate is still working and hasn't finished updating the card content".
  it("a card put aside that its crewmate answers and revises mid-turn comes back at its turn's end, with the last write", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const actions = [
      { id: "ship", label: "Ship it", default: true },
      { id: "wait", label: "Wait" },
    ];
    const { cardId, stable } = await onTheStage(harness, crewmate, {
      title: "Ship the release on Friday",
      body: "<p>Everything is ready for Friday.</p><p>Ship it then.</p>",
      actions,
    });
    const aside = () => harness.cards().find((card) => card.id === cardId)?.minimized;
    harness.supervisor.cardActions.replyToCard(cardId, "what about the windows build?");
    await tick();
    harness.supervisor.cards.setMinimized(cardId, true);
    expect(aside()).toBe(true);

    const spec = harness.specs[0];
    spec?.onReply?.({
      cardId,
      text: "Windows builds on Saturday, so I am moving the plan.",
      answersMessage: askedOn(harness.supervisor, cardId),
    });
    syncCardId(
      spec?.onCard?.({
        id: stable,
        // Every revision after the turn's answer says what it changed (INF-1623).
        reply: "I moved the draft plan to Saturday.",
        title: "Ship the release on Saturday (draft)",
        body: "<p>Draft: moving to Saturday.</p><p>Still checking the Windows build.</p>",
        actions,
      }),
    );
    spec?.onReport?.("Moving the release plan to Saturday.");
    await tick();
    // The crewmate works on: the card stays aside through its answer,
    // its revision and its report.
    expect(aside()).toBe(true);
    syncCardId(
      spec?.onCard?.({
        id: stable,
        reply: "The Windows build passed, so the card now ships Saturday afternoon.",
        title: "Ship the release on Saturday after the Windows build",
        body: "<p>The Windows build passed.</p><p>Ship Saturday afternoon.</p>",
        actions,
      }),
    );
    await tick();
    expect(aside()).toBe(true);

    crewmate.finishPrompt();
    await tick();
    expect(aside()).toBeUndefined();
    expect(staged(harness, cardId)).toMatchObject({
      title: "Ship the release on Saturday after the Windows build",
      body: "<p>The Windows build passed.</p><p>Ship Saturday afternoon.</p>",
    });
  });

  it("puts a new card up at the close-out, never at the emit, and a revision before it arrives settled", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Flaky test",
      intent: intentOf("fix the flaky test"),
    });
    await tick();
    const spec = harness.specs[0];
    const cardId =
      syncCardId(
        spec?.onCard?.({
          id: "choice",
          title: "Two ways to fix the flaky test",
          body: "<p>Await the queue, or mock the clock.</p><p>Mocking the clock leaves write order uncertain.</p>",
          actions: [
            { id: "await-queue", label: "Await the queue", default: true },
            { id: "mock-clock", label: "Mock the clock" },
          ],
        }),
      ) ?? "";
    await tick();
    expect(harness.cards().find((card) => card.id === cardId)?.awaiting).toBe("close-out");
    expect(staged(harness, cardId)).toBeUndefined();
    // Nothing on the timeline says it went up: it has not.
    expect(stageMoments(harness, taskId, cardId)).toEqual([]);

    syncCardId(
      spec?.onCard?.({
        id: "choice",
        title: "Await the queue, not the clock",
        body: "<p>Awaiting the queue removes the race.</p><p>Ten runs in a row passed.</p>",
        actions: [
          { id: "await-queue", label: "Await the queue", default: true },
          { id: "mock-clock", label: "Mock the clock" },
        ],
      }),
    );
    await tick();
    expect(staged(harness, cardId)).toBeUndefined();

    // Its idle is the close-out when it never reports.
    crewmate.finishPrompt();
    await tick();
    expect(staged(harness, cardId)?.title).toBe("Await the queue, not the clock");
    expect(stageMoments(harness, taskId, cardId)).toEqual([
      { at: expect.any(Number), data: expect.objectContaining({ closeOut: "idle" }) },
    ]);
  });

  it("reads a crewmate's card once it is up and tells its author which readings did not pass", async () => {
    // Intent: the captain approved building INF-4000's reader check - the
    // decision model reads each card and its author learns which reading
    // failed, as facts, while the card is never held for it.
    const asked = deferred<Record<string, DecisionAnswer>>();
    const seen: { caller: unknown; state: unknown }[] = [];
    let on = true;
    const models = {
      allowsUse: (id: string) => on && id === "card-reader",
      decide: (caller: unknown, state: unknown) => {
        seen.push({ caller, state });
        return asked.promise;
      },
    };
    const crewmate = fakeCrewmate();
    const { supervisor, cards, specs } = setup(crewmate, { readerCheck: cardReader(models) });
    const { taskId } = await supervisor.intake.commission({
      title: "reader",
      intent: intentOf("show a card the captain reads"),
    });
    await tick();
    const onCard = specs[0]?.onCard;
    const body =
      "<p>I moved the rebase hook into the IPC seam.</p><details><summary>How I checked</summary><p>pnpm vitest</p></details>";
    const shown = onCard?.({ id: "done", title: "Hook moved", body, actions: [] });
    await tick();
    // The card is up while the readings are still being asked.
    expect(cards().map((card) => card.id)).toContain(`card-${taskId}-done`);
    expect(seen).toEqual([
      {
        caller: { purpose: "card-reader", taskId, use: "card-reader" },
        state: {
          facts: {
            card_title: "Hook moved",
            card_text: "I moved the rebase hook into the IPC seam.",
          },
        },
      },
    ]);
    const answer = (value: string, outcome: DecisionAnswer["outcome"] = "answered") => ({
      value,
      outcome,
      version: "cr1",
    });
    asked.resolve({
      "plain-words": answer("fails"),
      "clear-sentences": answer("passes"),
      "terms-explained": answer("fails"),
      // A reading no model could answer says nothing.
      "effect-stated": answer("unclear", "failed"),
    });
    expect(await shown).toBe(
      `card-${taskId}-done Reader check: the card is up; the decision model read it as not passing plain words and terms explained. If you agree, revise it once under the same id; if not, leave it as it is.`,
    );

    // Switched off, the card's answer is as it was, and nothing is asked.
    on = false;
    expect(onCard?.({ id: "next", title: "Next", body: "<p>Done.</p>", actions: [] })).toBe(
      `card-${taskId}-next`,
    );
    expect(seen).toHaveLength(1);
  });
});
