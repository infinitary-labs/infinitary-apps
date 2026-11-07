/**
 * The captain's card actions on merge, settle and decision cards
 * (docs/card-threads.md): a git or GitHub failure said plainly, merges and
 * discards from a crewmate's settle card, a refused pull request merge, the
 * first mate's decisions and their declared actions, and the admission of a
 * ready card's choice.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import {
  CARD_ANSWERS_BOUND_REFUSAL,
  type Card,
  type CardEffect,
  cardPresentation,
  opensSettings,
} from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import {
  answersPastBound,
  completionBody,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  SETTLE_DISCARD,
  SETTLE_MERGE,
  served,
  settleLines,
  settleWakes,
  setup,
  syncCardId,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { isCardClosedSteer } from "./captainWakes";
import type { CardService } from "./cardService";
import type { PrOutcome } from "./changeMerge";
import type { CrewSupervisor } from "./crewSupervisor";
import { UNSEEN_STOP_WORDS } from "./deliveryWakes";
import { PROVIDER_SIGN_IN_TITLE } from "./hostCards";
import { MERGE_CHECKS_HOLD_REASON } from "./mergeAuthorization";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it("says a git or GitHub failure plainly in the feed and hands the Firstmate the raw words", async () => {
    const signedOut =
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    const mergePullRequest = vi.fn(
      async (): Promise<PrOutcome> => ({
        ok: false,
        text: `PR merge blocked: ${signedOut}`,
        problem: signedOut,
      }),
    );
    const closePullRequest = vi.fn(async () => ({
      ok: false,
      text: "Could not close PR: Could not resolve host: github.com",
      problem: "Could not resolve host: github.com",
    }));
    const { supervisor, tasks, events, ops } = setup(fakeCrewmate(), {
      mergePullRequest,
      closePullRequest,
    });
    seedTask(tasks, { id: "merge", title: "Ship the fix", status: "idle", worktreeDir: "/pr" });
    seedTask(tasks, { id: "gone", title: "Old idea", status: "idle", worktreeDir: "/old" });
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    const id = supervisor.addFirstmateCard({
      requiredActions: [],
      taskId: "merge",
      title: "Settle",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [{ id: "merge-pr", label: "Put it in", default: true, effect: SETTLE_MERGE }],
    });
    supervisor.cardActions.act(id, "merge-pr");
    await vi.waitFor(() =>
      expect(settleLines(tasks, "merge")).toContain(
        "Cannot merge: the project's host did not accept the sign-in on this computer",
      ),
    );
    await supervisor.settling.settle.requestDiscard("gone");
    expect(settleLines(tasks, "gone")).toContain(
      "Discarded. Its pull request is still open where the project lives: could not reach the project's host - try again",
    );
    const feed = [...settleLines(tasks, "merge"), ...settleLines(tasks, "gone")].join("\n");
    expect(feed).not.toMatch(/fatal:|Could not resolve host|PR merge blocked/);
    // The Firstmate still reads exactly what git said, and so does the record.
    await vi.waitFor(() => expect(settleWakes(ops)).toHaveLength(2));
    expect(settleWakes(ops).join("\n")).toContain(signedOut);
    expect(settleWakes(ops).join("\n")).toContain("Could not resolve host: github.com");
    expect(tasks.timeline("merge").find((event) => event.data?.problem)).toMatchObject({
      kind: "note",
      text: `PR merge blocked: ${signedOut}`,
    });

    // A refusal on the checks themselves names no check in the feed.
    mergePullRequest.mockResolvedValueOnce({
      ok: false,
      text: `Cannot merge yet - ${MERGE_CHECKS_HOLD_REASON}. overall: red\n- linux-checks: completed / failure`,
      plain: "the checks failed",
    });
    const again = supervisor.addFirstmateCard({
      requiredActions: [],
      taskId: "merge",
      title: "Settle",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [{ id: "merge-pr", label: "Put it in", default: true, effect: SETTLE_MERGE }],
    });
    supervisor.cardActions.act(again, "merge-pr");
    await vi.waitFor(() =>
      expect(settleLines(tasks, "merge")).toContain("Cannot merge: the checks failed"),
    );
    await vi.waitFor(() => expect(settleWakes(ops)).toHaveLength(3));
    expect(settleWakes(ops).at(-1)).toContain("linux-checks: completed / failure");
  });

  it("lands from a crewmate settle card without steering", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks, specs, cards, ops } = setup(crewmate);
    (workspace.taskWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      dirty: false,
      unlandedCommits: 1,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "firstmate-3000 fm/task-ready is done",
      body: completionBody(
        "<p>The work is ready to land.</p><p>Keep leaves the worktree; discard drops it.</p>",
      ),
      actions: [
        { id: "land", label: "Land locally", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title.includes("is done")) as Card;
    expect(settle.taskId).toBe(taskId);

    supervisor.cardActions.act(settle.id, "merge");
    await tick();

    expect(workspace.landTaskWork).toHaveBeenCalled();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "landed" });
    expect(crewmate.steer).not.toHaveBeenCalled();
    expect(crewmate.promptCalls.some((text) => text.includes("the user chose"))).toBe(false);
    expect(ops.some((line) => line.includes("the user chose"))).toBe(false);
  });

  it("merges a direct-PR card on GitHub without locally landing or steering", async () => {
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi.fn(async () => ({
      ok: true,
      text: "Merged #23 on GitHub.",
    }));
    const { supervisor, workspace, tasks, specs, cards, ops } = setup(crewmate, {
      mergePullRequest,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Ship the PR",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "The PR is ready",
      body: completionBody(
        "<p>The PR is ready to merge.</p><p>CI is green on the head commit.</p>",
      ),
      actions: [
        { id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard worktree", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title === "The PR is ready") as Card;

    supervisor.cardActions.act(settle.id, "merge");
    await tick();

    expect(mergePullRequest).toHaveBeenCalledWith(
      taskId,
      undefined,
      expect.objectContaining({ beforeDispatch: expect.any(Function) }),
    );
    expect(workspace.landTaskWork).not.toHaveBeenCalled();
    expect(tasks.get(taskId)).toMatchObject({
      status: "done",
      closedReason: "merged",
      delivery: { landedMode: "pr" },
    });
    expect(tasks.timeline(taskId).find((event) => event.kind === "merged")).toMatchObject({
      actor: "captain",
      text: "Merged #23 on GitHub.",
    });
    expect(crewmate.steer).not.toHaveBeenCalled();
    expect(ops.some((line) => line.includes("the user chose"))).toBe(false);
  });

  it("refuses a settle card whose action id only looks like merge-pr", async () => {
    // The live regression: cards offered "merge-pr55", which act() cannot
    // dispatch, so the click degraded to a steer and the PR stayed open.
    const crewmate = fakeCrewmate();
    const { supervisor, specs } = setup(crewmate);
    await supervisor.intake.commission({ title: "Ship the PR", intent: intentOf("done work") });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");

    expect(() =>
      specs[0]?.onCard?.({
        title: "The PR is ready",
        body: "<p>The PR is ready to merge.</p><p>CI is green on the head commit.</p>",
        actions: [
          { id: "merge-pr55", label: "Merge PR 55", default: true },
          { id: "leave-pr55", label: "Leave it open" },
        ],
      }),
    ).toThrow(/reads like a merge but carries no settle effect/);
  });

  it("refuses a merge offer that names no task", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate);

    expect(() =>
      supervisor.addFirstmateCard({
        requiredActions: [],
        title: "The PR is ready",
        body: "Merge the GitHub PR. https://github.com/x/y/pull/55",
        actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
      }),
    ).toThrow(/must pass task_id/);
  });

  it("reports a blocked PR merge to the feed instead of failing silently", async () => {
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi.fn(async () => ({
      ok: false,
      text: "PR merge blocked: CI is not fully green.",
    }));
    const { supervisor, tasks, specs, cards, events } = setup(crewmate, {
      mergePullRequest,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Ship the PR",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "The PR is ready",
      body: completionBody(
        "<p>The PR is ready to merge.</p><p>CI is green on the head commit.</p>",
      ),
      actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title === "The PR is ready") as Card;

    supervisor.cardActions.act(settle.id, "merge");
    expect(supervisor.cards.snapshot().some((card) => card.id === settle.id)).toBe(false);
    await tick();

    expect(mergePullRequest).toHaveBeenCalledWith(
      taskId,
      undefined,
      expect.objectContaining({ beforeDispatch: expect.any(Function) }),
    );
    // The task survives a refused merge, and the captain is told why.
    expect(tasks.get(taskId)).toBeDefined();
    expect(settleLines(tasks, taskId).some((line) => /not fully green/.test(line))).toBe(true);
  });

  it("wakes with the refusal on a refused PR merge and raises no retry card; the Firstmate re-settles", async () => {
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, text: "PR merge blocked: CI is not fully green." })
      .mockResolvedValueOnce({ ok: true, text: "Merged #23 on GitHub." });
    const { supervisor, tasks, specs, cards, ops } = setup(crewmate, { mergePullRequest });
    const { taskId } = await supervisor.intake.commission({
      title: "Ship the PR",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "The PR is ready",
      body: completionBody(
        "<p>The PR is ready to merge.</p><p>CI is green on the head commit.</p>",
      ),
      actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title === "The PR is ready") as Card;

    supervisor.cardActions.act(settle.id, "merge");
    await tick();

    // The host raises no retry card (cards/tasks/agents P0, WI-3) and no note
    // of its own (INF-2913, the captain: "only show a card if the merge went
    // wrong and needs the user's decision"): the refusal is one feed line and
    // one wake carrying it, which tells the Firstmate the captain saw no card.
    expect(cards()).toEqual([]);
    expect(settleWakes(ops)).toHaveLength(1);
    expect(settleWakes(ops)[0]).toContain("not fully green");
    expect(settleWakes(ops)[0]).toContain(UNSEEN_STOP_WORDS);
    expect(tasks.get(taskId)?.status).toBe("active");

    // A retry is the Firstmate settling again.
    expect(
      await supervisor.settling.settle.settleTask(taskId, "merge-pr", undefined, "captain"),
    ).toContain("Merged #23");
    expect(mergePullRequest).toHaveBeenCalledTimes(2);
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" });
    expect(tasks.timeline(taskId).some((event) => /Merged #23/.test(event.text))).toBe(true);
    await vi.waitFor(() => expect(cards()).toEqual([]));
  });

  // INF-2913 beside the host's sign-in card: a click refused because the
  // sign-in no longer works leaves that card as the one thing to do.
  it("raises no card of its own beside the sign-in when a clicked merge is refused for it", async () => {
    const mergePullRequest = vi.fn(async () => ({
      ok: false,
      text: "Cannot merge yet - the checks could not be read.",
      problem: "Not signed in to GitHub (github.com)",
      signIn: { host: "github.com", name: "GitHub", repoId: "repo-1" },
    }));
    const { supervisor, tasks, cards } = setup(fakeCrewmate(), { mergePullRequest });
    seedTask(tasks, {
      id: "signin",
      title: "Ship the fix",
      status: "idle",
      worktreeDir: "/signin",
    });
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    const offer = supervisor.addFirstmateCard({
      requiredActions: [],
      taskId: "signin",
      title: "Settle",
      body: "Choose.",
      actions: [{ id: "merge-pr", label: "Merge PR", effect: SETTLE_MERGE }],
    });
    supervisor.cardActions.act(offer, "merge-pr");
    await vi.waitFor(() => expect(mergePullRequest).toHaveBeenCalledTimes(1));
    await tick();
    expect(cards().filter((card) => card.author === "host")).toEqual([]);
    expect(tasks.get("signin")?.status).not.toBe("done");
  });

  it("a contention refusal (another settle already in flight) wakes nobody; the real attempt does", async () => {
    const operation = deferred<{ ok: boolean; text: string }>();
    const mergePullRequest = vi.fn(() => operation.promise);
    const { supervisor, tasks, cards, ops } = setup(fakeCrewmate(), { mergePullRequest });
    seedTask(tasks, { id: "merge", title: "PR", status: "idle", worktreeDir: "/pr" });
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    const first = supervisor.addFirstmateCard({
      requiredActions: [],
      taskId: "merge",
      title: "Settle",
      body: "Choose.",
      actions: [{ id: "merge-pr", label: "Merge PR", effect: SETTLE_MERGE }],
    });
    const second = supervisor.addFirstmateCard({
      requiredActions: [],
      taskId: "merge",
      title: "Settle again",
      body: "Choose.",
      actions: [{ id: "merge-pr", label: "Merge PR", effect: SETTLE_MERGE }],
    });
    supervisor.cardActions.act(first, "merge-pr");
    supervisor.cardActions.act(second, "merge-pr"); // races the first; refused as contention.
    await tick();

    expect(settleWakes(ops)).toEqual([]);
    operation.resolve({ ok: false, text: "PR merge blocked: CI is not fully green." });
    await tick();
    // Only the real (first) attempt's refusal reaches the Firstmate, and no
    // card reaches the captain (INF-2913).
    expect(settleWakes(ops)).toHaveLength(1);
    expect(settleWakes(ops)[0]).toContain("not fully green");
    expect(cards()).toEqual([]);
  });

  it("discards from a crewmate settle card without steering", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks, specs, cards, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Drop it",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "firstmate-3000 fm/task-ready is done",
      body: completionBody(
        "<p>The work is ready to land.</p><p>Keep leaves the worktree; discard drops it.</p>",
      ),
      actions: [
        { id: "land", label: "Land locally", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title.includes("is done")) as Card;

    supervisor.cardActions.act(settle.id, "discard");
    await tick();

    expect(workspace.removeTaskWorktree).toHaveBeenCalled();
    expect(workspace.landTaskWork).not.toHaveBeenCalled();
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
    expect(crewmate.steer).not.toHaveBeenCalled();
    expect(crewmate.promptCalls.some((text) => text.includes("the user chose"))).toBe(false);
    expect(ops.some((line) => line.includes("the user chose"))).toBe(false);
  });

  it("closing a settle card reaches its crewmate, lands nothing, and wakes no Firstmate", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, workspace, tasks, specs, cards, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Stay",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "firstmate-3000 fm/task-ready is done",
      body: completionBody(
        "<p>The work is ready to land.</p><p>Keep leaves the worktree; discard drops it.</p>",
      ),
      actions: [
        { id: "land", label: "Land locally", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title.includes("is done")) as Card;

    // There is no keep button (cards/tasks/agents P1): the close control is
    // the keep, and it changes nothing about the task.
    // The host attaches the completion pair itself (contract v3.6): the
    // merge labeled for the posture and the discard beside it, under its
    // own ids. There is still no keep button (cards/tasks/agents P1): the
    // close control is the keep, and it changes nothing about the task.
    expect(settle.actions.map((action) => action.id)).toEqual(["discard", "merge"]);
    expect(settle.actions.find((action) => action.id === "merge")?.label).toBe("Merge the branch");
    supervisor.close(settle.id);
    await tick();

    expect(cards().find((card) => card.id === settle.id)).toMatchObject({ minimized: true });
    // INF-1879: putting away is not a choice, turn or end.
    expect(crewmate.promptCalls.some(isCardClosedSteer)).toBe(false);
    crewmate.finishPrompt();
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(workspace.landTaskWork).not.toHaveBeenCalled();
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
    expect(crewmate.dispose).not.toHaveBeenCalled();
    expect(crewmate.promptCalls.some((text) => text.includes("the user chose"))).toBe(false);
    expect(ops.some((line) => line.includes("the user chose"))).toBe(false);
  });

  it("routes firstmate card answers back through the hooks", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, ops } = setup(crewmate);
    supervisor.addFirstmateCard({
      title: "Which project?",
      body: "Two match.",
      actions: [
        { id: "quota-axi", label: "quota-axi" },
        { id: "gh-axi", label: "gh-axi" },
      ],
    });
    await tick();
    const card = cards().find((entry) => entry.meta === "firstmate") as Card;
    expect(cardPresentation(card)).toBe("decision");
    supervisor.cardActions.act(card.id, "quota-axi");
    await tick();
    expect(ops.at(-1)).toContain('[user]\nquota-axi\nChoice on card "Which project?"');
  });

  // INF-2794: the minus only puts the note aside; its Got it reads it.
  it("INF-1879: reads a note on its Got it without ending work, a feed line or a wake", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, ops, cardStore, specs, events } = setup(crewmate);
    supervisor.addFirstmateCard({
      title: "Quota note",
      body: "All steady.",
      actions: [],
    });
    await tick();
    const note = cards().find((entry) => entry.title === "Quota note") as Card;
    expect(note.actions).toEqual([]);

    const opsBefore = ops.length;
    supervisor.close(note.id);
    await tick();
    expect(cards().find((entry) => entry.id === note.id)).toMatchObject({ minimized: true });
    expect(cardStore.chosenAction(note.id)).toBeUndefined();
    supervisor.pressNote(note.id);
    await tick();
    expect(cards().find((entry) => entry.id === note.id)).toBeUndefined();
    expect(cardStore.chosenAction(note.id)).toBe("close");
    expect(ops).toHaveLength(opsBefore);
    expect(events.filter((event) => event.type === "firstmate_note")).toEqual([]);
    expect(supervisor.cards.captainResolutionsSince(0, 8)).toEqual([
      expect.objectContaining({ action: "close", card: expect.objectContaining({ id: note.id }) }),
    ]);
    expect(crewmate.steer).not.toHaveBeenCalled();
    expect(specs).toEqual([]);
  });

  it("INF-1879: putting a decision away preserves it and sends no turn", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, ops, cardStore, specs, tasks, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "cards",
      intent: intentOf("show a decision"),
    });
    await tick();
    specs[0]?.onCard?.({
      title: "Pick a course",
      body: "<p>Plotting a new course is the faster route.</p><p>Holding course waits out the storm.</p>",
      actions: [
        { id: "hold", label: "Hold course" },
        { id: "change", label: "Plot new course", default: true },
      ],
    });
    await tick();
    const decision = cards().find((entry) => entry.actions.length > 0) as Card;
    expect(decision.actions.map((action) => action.id)).toEqual(["hold", "change"]);

    const opsBefore = ops.length;
    supervisor.close(decision.id);
    await tick();
    expect(cards().find((entry) => entry.id === decision.id)).toMatchObject({ minimized: true });
    expect(cardStore.chosenAction(decision.id)).toBeUndefined();
    expect(ops).toHaveLength(opsBefore);
    expect(
      events.filter(
        (event) => event.type === "firstmate_note" && /closed|dismissed/.test(event.text),
      ),
    ).toEqual([]);
    expect(crewmate.steer).not.toHaveBeenCalled();
    expect(tasks.get(taskId)?.status).toBe("active");
  });
});

describe("the task graph (R1)", () => {
  it("a Firstmate decision carries exactly its declared actions and nothing parks (P0, WI-1)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards, ops, events } = setup(crewmate);
    supervisor.addFirstmateCard({
      title: "Which course?",
      body: "<p>Plotting a new course is the faster route.</p><p>Holding course waits out the storm.</p>",
      actions: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    await tick();
    const card = cards().find((entry) => entry.meta === "firstmate") as Card;
    expect(card.actions.map((action) => action.id)).toEqual(["a", "b"]);

    // Every click returns to its author: the card leaves the stack, no row
    // parks, no wake says "deferred", and the strip counts no one waiting.
    supervisor.cardActions.act(card.id, "a");
    await tick();
    expect(cards().find((entry) => entry.id === card.id)).toBeUndefined();
    expect(tasks.list().filter((record) => record.kind === "decision")).toEqual([]);
    expect(tasks.list().filter((record) => record.id.startsWith("park-"))).toEqual([]);
    expect(ops.some((line) => line.includes("deferred your card"))).toBe(false);
    expect(supervisor.facts.crewCounts()).toEqual({ working: 0, idle: 0, queued: 0 });
    expect(events.filter((e) => e.type === "crew_counts").every((e) => !("waiting" in e))).toBe(
      true,
    );
  });

  it("sends a blocked task's premium choice to Firstmate as the captain's words without escalating on the report", async () => {
    const { supervisor, tasks, cards, ops, specs } = setup(fakeCrewmate());
    const { taskId } = await supervisor.intake.commission({
      title: "Finish the build",
      intent: intentOf("finish the build"),
    });
    await tick();
    specs[0]?.onReport?.("Could not finish the build; the test run failed.");
    await tick();
    const id = supervisor.addFirstmateCard({
      taskId,
      title: "The build is blocked",
      body: "<p>The first attempt could not finish.</p>",
      actions: [
        { id: "retry", label: "Try again", default: true },
        { id: "premium", label: "Try a premium model" },
      ],
    });
    await tick();
    expect(cards().find((card) => card.id === id)?.actions).toMatchObject([
      { label: "Try a premium model" },
      { label: "Try again", default: true },
    ]);
    expect(
      cards()
        .find((card) => card.id === id)
        ?.actions.filter((a) => a.default),
    ).toHaveLength(1);
    expect(
      cards()
        .find((card) => card.id === id)
        ?.actions.find((a) => a.id === "premium")?.default,
    ).toBeFalsy();
    expect(tasks.list().filter((task) => task.shape?.escalate_from)).toEqual([]);
    const clicks: { origin: string; ref?: string }[] = [];
    supervisor.setFirstmateHooks({
      notifyOp: (wake, origin, ref) => {
        ops.push(served(wake));
        clicks.push({ origin, ...(ref ? { ref } : {}) });
      },
      notifyCaptainChoice: (wake, ref) => {
        ops.push(served(wake));
        clicks.push({ origin: "captain", ...(ref ? { ref } : {}) });
      },
      retryConverse: vi.fn(),
    });
    const before = ops.length;
    expect(supervisor.cardActions.act(id, "premium")).toEqual({});
    await tick();
    expect(cards().find((card) => card.id === id)).toBeUndefined();
    expect(ops.slice(before)).toEqual([
      expect.stringContaining(
        `[user]\nTry a premium model\nChoice on card "The build is blocked" (${id}) on task ${taskId}.`,
      ),
    ]);
    expect(clicks).toContainEqual({ origin: "captain", ref: taskId });
    expect(tasks.list().filter((task) => task.shape?.escalate_from)).toEqual([]);
    const scripted = supervisor.addFirstmateCard({
      title: "The build is still blocked",
      body: "<p>Retry?</p>",
      taskId,
      actions: [{ id: "premium", label: "Try a premium model", default: true }],
    });
    supervisor.cardActions.act(scripted, "premium", "frame");
    await tick();
    expect(clicks.at(-1)).toEqual({ origin: "agent", ref: taskId });
    expect(ops.at(-1)).toContain('[fm-op] a script chose "Try a premium model"');
  });

  it("the sweep closes a decision row whose card is off the stack, and brings nothing back", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards, cardStore, ops } = setup(crewmate);
    // A row a park from before P0 left behind: open, gated on a card id
    // that is no longer on the stack.
    tasks.create({
      id: "park-card-fm-old",
      kind: "decision",
      title: "Which course?",
      prompt: "",
      repoId: null,
      difficulty: null,
      gate: { kind: "captain", ref: "card-fm-old" },
      status: "open",
      actor: "host",
    });
    await supervisor.watch.sweepGates(Date.now() + 25 * 60 * 60 * 1000);
    await tick();

    expect(tasks.get("park-card-fm-old")).toMatchObject({
      status: "dropped",
      closedReason: "superseded",
    });
    expect(cards()).toEqual([]);
    expect(cardStore.listOpen()).toEqual([]);
    expect(ops).toEqual([]);
  });

  it("opens Settings on exactly the clicks `opensSettings` names, so a Mac controlling this one can tell before it asks (docs/view.md)", async () => {
    const { supervisor, cards } = setup(fakeCrewmate());
    // The host's own cards, as it builds them.
    supervisor.cards.addAuthDecisionCard(
      "auth-restore",
      "Codex",
      "Codex (Work) needs you to sign in again.",
      {
        restoreAccountId: "acct_codex",
      },
    );
    supervisor.cards.addAuthDecisionCard("auth-any", "Codex", `${PROVIDER_SIGN_IN_TITLE}.`);
    supervisor.cards.addFirstmateMoveBackCard({
      providerId: "openai-codex",
      providerName: "Codex",
      body: "Codex serves again.",
    });
    // A Firstmate decision per effect it may declare, and a plain choice.
    const effects: (CardEffect | undefined)[] = [
      { kind: "open", target: "settings" },
      { kind: "open", target: "projects", signIn: "github.com" },
      { kind: "open", target: "devices", make: "link" },
      undefined,
    ];
    for (const effect of effects) {
      supervisor.addFirstmateCard({
        title: "Choose",
        body: "<p>Choose one.</p>",
        actions: [
          { id: "go", label: "Go", default: true, ...(effect ? { effect } : {}) },
          { id: "no", label: "Not now" },
        ],
      });
    }
    await tick();
    const decisions = cards().filter((card) => card.actions.length > 0);
    expect(decisions).toHaveLength(7);
    const clicks = decisions.map((card) => {
      const action = card.actions.find((candidate) => candidate.id === "go") ?? card.actions[0];
      if (!action) throw new Error(`${card.id} has no action`);
      const effect = supervisor.cardActions.act(card.id, action.id).effect;
      return {
        named: opensSettings(action),
        opened: effect?.kind === "open" && effect.target !== "browser",
      };
    });
    expect(clicks.filter((click) => click.named)).toHaveLength(5);
    for (const click of clicks) expect(click.opened).toBe(click.named);
  });

  it("the agent-down singletons keep their host card, with only their own way out", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards } = setup(crewmate);
    supervisor.cards.addFirstmatePauseCard({
      pause: "no_headroom",
      body: "No headroom anywhere.",
      providerName: "Codex",
    });
    await tick();
    const benched = cards().find((entry) => entry.id === "card-fm-no-headroom") as Card;
    expect(benched.actions.map((action) => action.id)).toEqual(["open-settings"]);

    expect(supervisor.cardActions.act("card-fm-no-headroom", "open-settings").effect).toEqual({
      kind: "open",
      target: "settings",
    });
    await tick();
    expect(cards().find((entry) => entry.id === "card-fm-no-headroom")).toBeUndefined();
    expect(tasks.list().filter((record) => record.kind === "decision")).toEqual([]);
  });
});

describe("decision actions", () => {
  const BODY =
    "<p>Awaiting the job queue removes the race.</p><ul><li>Mocking the clock is faster.</li></ul>";

  async function decisionOnScreen(crewmate: FakeCrewmate) {
    const harness = setup(crewmate);
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Fix the flaky test",
      intent: intentOf("fix the flaky test"),
    });
    await tick();
    const onCard = harness.specs[0]?.onCard;
    const cardId = syncCardId(
      onCard?.({
        title: "Two ways to fix the flaky test",
        body: BODY,
        actions: [
          { id: "await-queue", label: "Await the queue", default: true },
          { id: "mock-clock", label: "Mock the clock" },
        ],
      }),
    );
    crewmate.finishPrompt();
    await tick();
    return { ...harness, taskId, cardId: cardId ?? "", onCard };
  }

  it("marks the default primary and orders the footer: the choices, then the default", async () => {
    const crewmate = fakeCrewmate();
    const { cards, cardId } = await decisionOnScreen(crewmate);
    const card = cards().find((entry) => entry.id === cardId) as Card;
    expect(card.actions).toEqual([
      { id: "mock-clock", label: "Mock the clock", variant: "secondary" },
      { id: "await-queue", label: "Await the queue", variant: "primary", default: true },
    ]);
  });

  it("captures frame settings once in the author turn and durable task history", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cardStore, cardId, tasks, taskId } = await decisionOnScreen(crewmate);
    const value = { planes: [{ name: "inner", speed: 0.5, tiltDeg: 42 }], paused: false };
    const json = JSON.stringify(value);
    supervisor.cardActions.act(cardId, "mock-clock", "frame", value);
    // The choice closed the card: a second dispatch finds nothing to choose.
    expect(supervisor.cardActions.act(cardId, "mock-clock", "frame", value)).toEqual({});
    await tick();
    expect(crewmate.promptCalls.filter((text) => text.includes(json))).toHaveLength(1);
    expect(
      tasks
        .timeline(taskId)
        .filter((event) => event.kind === "steered" && event.text.includes(json)),
    ).toHaveLength(1);
    // A script's choice is recorded as the script's, never as the captain's.
    expect(cardStore.chosenAction(cardId)).toBe("script:mock-clock");
  });

  it.each([null, false, 0, ""])("preserves a falsy frame value %j", async (value) => {
    const crewmate = fakeCrewmate();
    const { supervisor, cardId } = await decisionOnScreen(crewmate);
    supervisor.cardActions.act(cardId, "mock-clock", "frame", value);
    await tick();
    expect(crewmate.promptCalls.at(-1)).toContain(
      `Card action value (JSON): ${JSON.stringify(value)}`,
    );
  });

  it("rejects oversized frame values before changing the card and ignores chrome values", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, cardId } = await decisionOnScreen(crewmate);
    expect(() =>
      supervisor.cardActions.act(cardId, "mock-clock", "frame", "界".repeat(1400)),
    ).toThrow("4,096 bytes");
    expect(cards().find((card) => card.id === cardId)?.status).toBe("ready");
    supervisor.cardActions.act(cardId, "mock-clock", "chrome", { ignored: true });
    await tick();
    expect(crewmate.promptCalls.at(-1)).toContain('the user chose "Mock the clock"');
    expect(crewmate.promptCalls.at(-1)).not.toContain("Card action value");
  });

  it("carries a footer click's answers to the author in words, and records them on the close (contract 4.22)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cardStore, cardId, tasks, taskId } = await decisionOnScreen(crewmate);
    const answers = [
      { name: "runner", values: ["ci"], labels: ["On the checks only"], changed: true },
      { name: "notes", values: [], changed: false },
    ];

    supervisor.cardActions.act(cardId, "mock-clock", "chrome", { answers });
    await tick();
    expect(crewmate.promptCalls.at(-1)).toContain(
      `Card "Two ways to fix the flaky test": the user chose "Mock the clock" (mock-clock).\nThe user's answers to the card's questions:\n- runner: "On the checks only" (ci), changed\n- notes: no answer, as proposed`,
    );
    const resolved = tasks.timeline(taskId).find((event) => event.kind === "card_resolved");
    // INF-1296: the event names the card evidence's record of the same choice.
    const choice = cardStore.observations(cardId).find((entry) => entry.kind === "action");
    expect(resolved?.data).toEqual({
      cardId,
      action: "mock-clock",
      answers,
      observation: choice?.id,
    });
  });

  it("refuses a footer click whose answers do not parse or pass the value bound, leaving the card up", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, cardId } = await decisionOnScreen(crewmate);
    expect(() =>
      supervisor.cardActions.act(cardId, "mock-clock", "chrome", { answers: [{ name: "x" }] }),
    ).toThrow("could not be read");
    expect(() =>
      supervisor.cardActions.act(cardId, "mock-clock", "chrome", {
        answers: answersPastBound(),
      }),
    ).toThrow(CARD_ANSWERS_BOUND_REFUSAL);
    expect(cards().find((card) => card.id === cardId)?.status).toBe("ready");
  });

  it("closes a flagged duplicate with resolution duplicate and one feed line (WI-14)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards, cardStore, events } = setup(crewmate);
    await supervisor.intake.commission({ title: "Explain", intent: intentOf("explain delivered") });
    await tick();
    const first = syncCardId(
      specs[0]?.onCard?.({
        title: "Delivered means the crewmate stopped",
        body: "<p>closeRecord sets it.</p>",
        actions: [],
      }),
    );
    const second = syncCardId(
      specs[0]?.onCard?.({
        title: "What delivered means",
        body: "<p>closeRecord sets it when the crewmate stops.</p>",
        actions: [],
      }),
    );
    await tick();
    const result = supervisor.flagDuplicate({
      cardId: second ?? "",
      duplicateOf: first ?? "",
      note: "same as the card before it",
    });
    await tick();
    expect(result.status).toBe("flagged");
    expect(cards().some((card) => card.id === second)).toBe(false);
    expect(cardStore.chosenAction(second ?? "")).toBe("duplicate");
    expect(events).toContainEqual({
      type: "firstmate_note",
      text: 'Closed "What delivered means" as a duplicate of "Delivered means the crewmate stopped".',
    });
    // A refusal changes nothing and says nothing.
    const eventsBefore = events.length;
    expect(
      supervisor.flagDuplicate({ cardId: second ?? "", duplicateOf: first ?? "", note: "again" })
        .status,
    ).toBe("already-flagged");
    expect(events).toHaveLength(eventsBefore);
  });
});

/** Choice admission is about the shown offer, not the durable head or id prefix. */
describe("ready-card choice admission", () => {
  for (const source of ["chrome", "frame"] as const)
    for (const deliverable of ["answer", "change"] as const)
      it(`refuses an undeclared ${source} choice without changing its ${deliverable} task or running an effect`, async () => {
        const crewmate = fakeCrewmate();
        const { supervisor, specs, tasks, cardStore, workspace, ops } = setup(crewmate);
        const { taskId } = await supervisor.intake.commission({
          title: "Validate the choice",
          intent: {
            ...intentOf("Validate the choice"),
            ...(deliverable === "answer" ? { constraints: [{ kind: "read-only" as const }] } : {}),
          },
        });
        await tick();
        const id =
          syncCardId(
            specs[0]?.onCard?.({
              title: "Choose a route",
              body: "<p>Choose a route.</p><p>Both routes work.</p>",
              actions: [
                {
                  id: "open",
                  label: "Open settings",
                  default: true,
                  effect: { kind: "open", target: "settings" },
                },
                { id: "later", label: "Not now" },
              ],
            }),
          ) ?? "";
        specs[0]?.onReport?.("The decision is ready.");
        const card = supervisor.cards.snapshot().find((entry) => entry.id === id);
        const record = tasks.get(taskId);
        const timeline = tasks.timeline(taskId);
        const observations = cardStore.observations(id);
        const wakes = [...ops];
        expect(record?.shape?.deliverable).toBe(deliverable);
        for (const action of ["not-offered", "", "Open settings"])
          expect(() => supervisor.cardActions.act(id, action, source)).toThrow(
            "This choice is not offered on this card",
          );
        await tick();
        expect(supervisor.cards.snapshot().find((entry) => entry.id === id)).toEqual(card);
        expect(cardStore.chosenAction(id)).toBeUndefined();
        expect(cardStore.observations(id)).toEqual(observations);
        expect(tasks.get(taskId)).toEqual(record);
        expect(tasks.timeline(taskId)).toEqual(timeline);
        expect(crewmate.steer).not.toHaveBeenCalled();
        expect(workspace.landTaskWork).not.toHaveBeenCalled();
        expect(workspace.retireTaskWorktree).not.toHaveBeenCalled();
        expect(ops).toEqual(wakes);
        // Refusal must not consume the offer: the captain can still choose it.
        expect(supervisor.cardActions.act(id, "open")).toEqual({
          effect: { kind: "open", target: "settings" },
        });
        expect(cardStore.chosenAction(id)).toBe("open");
        crewmate.finishPrompt();
        await tick();
      });

  it("refuses hidden choices before resolution, steer or an effect, then uses the shown revision", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cardStore, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Choice safety",
      intent: intentOf("choose"),
    });
    await tick();
    const id =
      syncCardId(
        specs[0]?.onCard?.({
          id: "safe",
          title: "Choose a route",
          body: "<p>Choose a route.</p><p>Both routes work.</p>",
          actions: [
            {
              id: "open",
              label: "Open settings",
              default: true,
              effect: { kind: "open", target: "settings" },
            },
            { id: "later", label: "Not now" },
          ],
        }),
      ) ?? "";
    const before = tasks.timeline(taskId);
    expect(() => supervisor.cardActions.act(id, "open")).toThrow("This choice is not ready");
    expect(cardStore.chosenAction(id)).toBeUndefined();
    expect(tasks.timeline(taskId)).toEqual(before);
    expect(crewmate.steer).not.toHaveBeenCalled();
    specs[0]?.onCard?.({
      id,
      title: "Choose a route",
      body: "<p>Full answer.</p><p>Both routes work.</p>",
      actions: [
        {
          id: "open",
          label: "Open settings",
          default: true,
          effect: { kind: "open", target: "settings" },
        },
        { id: "later", label: "Not now" },
      ],
    });
    specs[0]?.onReport?.("The decision is ready.");
    // A pending revision must neither remove a shown choice nor admit an
    // unseen one, and a later report does not show it while the crewmate
    // works on (INF-926).
    specs[0]?.onCard?.({
      id,
      title: "A new route",
      body: "<p>A new route.</p><p>The subscriptions are available there.</p>",
      actions: [
        {
          id: "subscriptions",
          label: "Open subscriptions",
          default: true,
          effect: { kind: "open", target: "subscriptions" },
        },
        { id: "later", label: "Not now" },
      ],
    });
    specs[0]?.onReport?.("The answer is ready.");
    expect(() => supervisor.cardActions.act(id, "subscriptions")).toThrow(
      "This choice is not offered on this card",
    );
    expect(cardStore.chosenAction(id)).toBeUndefined();
    // A decision-to-note revision also leaves the old shown choice usable.
    specs[0]?.onCard?.({
      id,
      title: "Now a note",
      body: "<p>A note.</p><p>Nothing to choose.</p>",
      actions: [],
    });
    // The action observation is written after the row resolution in one transaction.
    // Advance logical time on each clock read so equality cannot hide that ordering.
    let time = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ++time);
    let result: ReturnType<CrewSupervisor["cardActions"]["act"]>;
    let saved: ReturnType<CardService["newestResolutionForTask"]>;
    try {
      result = supervisor.cardActions.act(id, "open");
      saved = supervisor.cards.newestResolutionForTask(taskId);
    } finally {
      clock.mockRestore();
    }
    expect(result).toEqual({ effect: { kind: "open", target: "settings" } });
    expect(cardStore.chosenAction(id)).toBe("open");
    expect(saved?.offer).toMatchObject({
      title: "Choose a route",
      body: "<p>Full answer.</p><p>Both routes work.</p>",
    });
    // The stored newest revision is a note; recovery must use the dispatched offer.
    expect(saved?.card.title).toBe("Now a note");

    crewmate.finishPrompt();
    await tick();
  });

  for (const byGate of [false, true])
    it(`refuses choices associated with a closed task (${byGate ? "gate-backed" : "direct"})`, () => {
      const { supervisor, tasks, cardStore, ops } = setup(fakeCrewmate());
      const id = supervisor.addFirstmateCard({
        ...(byGate ? {} : { taskId: "closed" }),
        title: "Choose a route",
        body: "Choose a route.",
        actions: [
          { id: "open", label: "Open settings", effect: { kind: "open", target: "settings" } },
        ],
      });
      if (byGate) tasks.capture.fileDecision({ id: "closed", title: "Route", cardId: id });
      else seedTask(tasks, { id: "closed", title: "Route", status: "idle" });
      tasks.close("closed", { status: "done", reason: "answered", actor: "captain" });
      const timeline = tasks.timeline("closed");
      expect(() => supervisor.cardActions.act(id, "open")).toThrow("Its task is no longer open");
      expect(supervisor.cards.snapshot().some((card) => card.id === id)).toBe(true);
      expect(cardStore.chosenAction(id)).toBeUndefined();
      expect(tasks.timeline("closed")).toEqual(timeline);
      expect(ops).toEqual([]);
    });
});
