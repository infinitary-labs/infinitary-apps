/**
 * How the crew takes in work as `TaskIntake` does it
 * (docs/task-graph.md): an unknown project refused loudly, planned work,
 * parents and their children, cycles and drops, follow-ups and the settle
 * facts a card carries, and the model a task record names.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */

import { type Card, MERGE_CLOSES_MARK, MERGE_CLOSES_WORDS, SETTLE_FACTS_OPEN } from "@shared/cards";
import { softHoldWords } from "@shared/holds";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { DROP_REVIEW_STALE, dropReviewKeys, NO_LONGER_WANTED } from "@shared/recordDrop";
import type { WorkShape } from "@shared/routingPolicy";
import { changeLinesWords, DEFAULT_WORKSPACE_WORD } from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  handedCard,
  intentOf,
  SETTLE_DISCARD,
  SETTLE_MERGE,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { CrewMachines } from "../placed/crewMachines";
import type { KindInput } from "../routing/kindClassifier";
import { tierFor } from "../routing/policy";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { taskFeedLine } from "../tasks/taskFeed";
import { queryTasks } from "../tasks/taskQuery";
import type { CrewmateSpec } from "./crewSession";
import { FOLLOWUP_PROVENANCE_OPENING } from "./intentBrief";
import { FOLLOWUP_WORDS } from "./settleCardFacts";
import { discardedText } from "./settleWords";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it("rejects an unknown repo id loudly instead of defaulting", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate);
    await expect(
      supervisor.intake.commission({ title: "x", intent: intentOf("do x"), repoId: "nope" }),
    ).rejects.toThrow(/Unknown repo_id/);
  });
});

describe("the task graph (task-system P2)", () => {
  it("plans work without starting it; when-ready dispatches on the sweep, on-request never does", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, events, sessions } = setup(crewmate);
    const planned = supervisor.intake.plan({
      title: "Write the ADR",
      intent: intentOf("write it"),
    });
    expect(planned).toMatchObject({ status: "open", startPolicy: "on-request", key: "SCR-1" });
    expect(events.at(-2)).toMatchObject({
      type: "firstmate_note",
      // INF-2715 (folding INF-2601): filed work says it waits in the backlog.
      text: 'Planned "Write the ADR" (SCR-1) - waits in the backlog.',
    });
    expect(
      supervisor.facts.crewStatus().find((entry) => entry.taskId === planned.id),
    ).toMatchObject({
      status: "queued",
      gate: queryTasks(tasks, { key: planned.id }, () => undefined).rows[0]?.waiting,
    });
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    expect(sessions.open).not.toHaveBeenCalled();

    // Behind a blocker (by key) and when-ready: waits, then starts when it lands.
    const step = supervisor.intake.plan({
      title: "Implement the ADR",
      intent: intentOf("implement it"),
      blockedBy: ["scr-1"],
      startPolicy: "when-ready",
      priority: 1,
    });
    expect(tasks.graph.blockers(step.id).map((r) => r.id)).toEqual([planned.id]);
    // Queued work starts with its moment, never "filed" (INF-2715).
    expect(events.at(-2)).toMatchObject({
      type: "firstmate_note",
      text: 'Planned "Implement the ADR" (SCR-2) - starts when SCR-1 finishes.',
    });
    await supervisor.watch.sweepGates(Date.now());
    expect(sessions.open).not.toHaveBeenCalled();
    tasks.close(planned.id, { status: "done", reason: "landed", actor: "host" });
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    expect(sessions.open).toHaveBeenCalledTimes(1);
    expect(legacyStateOf(tasks.get(step.id))).toBe("running");
  });

  it("ends the quit after a running ready sweep, which starts nothing more (INF-1440)", async () => {
    // INF-1440: the account evaluation closed its database once the quit
    // returned, while a ready sweep it had not waited for still wrote to it.
    const classified = deferred<{ kind: "implement"; source: string; version: string }>();
    const { supervisor, tasks, sessions } = setup(fakeCrewmate(), {
      classifier: { classify: () => classified.promise },
    });
    const first = supervisor.intake.plan({
      title: "Correct the queue guidance",
      intent: intentOf("correct the queue guidance"),
      startPolicy: "when-ready",
      priority: 1,
    });
    const second = supervisor.intake.plan({
      title: "Restore the authorization limit",
      intent: intentOf("restore the authorization limit"),
      startPolicy: "when-ready",
    });
    const ended: string[] = [];
    // Waits on the first row's classification.
    const sweeping = supervisor.watch.sweepGates(Date.now()).then(() => ended.push("sweep"));
    const quitting = supervisor.disposeAll().then(() => ended.push("quit"));
    await tick();
    expect(ended).toEqual([]);
    classified.resolve({ kind: "implement", source: "classifier:test", version: "kc1" });
    await Promise.all([sweeping, quitting]);
    expect(ended).toEqual(["sweep", "quit"]);
    await supervisor.watch.sweepGates(Date.now());
    expect(sessions.open).not.toHaveBeenCalled();
    expect(tasks.get(first.id)?.status).toBe("open");
    expect(tasks.get(second.id)?.status).toBe("open");
  });

  it("spawns under a parent and behind blockers, resolving keys", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, sessions } = setup(crewmate);
    const parent = supervisor.intake.plan({ title: "Epic", intent: intentOf("the whole thing") });
    const first = await supervisor.intake.commission({
      title: "Step one",
      intent: intentOf("one"),
      parent: parent.key,
    });
    await tick();
    expect(tasks.get(first.taskId)).toMatchObject({ parentId: parent.id, status: "active" });
    const second = await supervisor.intake.commission({
      title: "Step two",
      intent: intentOf("two"),
      parent: parent.id,
      blockedBy: [first.taskId],
      priority: 0,
    });
    expect(second.crewmate).toBe("queued");
    expect(tasks.get(second.taskId)).toMatchObject({
      parentId: parent.id,
      status: "open",
      priority: 0,
      startPolicy: "when-ready",
    });
    expect(sessions.open).toHaveBeenCalledTimes(1);
    await expect(
      supervisor.intake.commission({ title: "x", intent: intentOf("y"), parent: "NOPE-9" }),
    ).rejects.toThrow(/Unknown task "NOPE-9" in parent/);
  });

  it("refuses a cycle as tool text and lifts a dead wait when its edge is removed", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards, ops } = setup(crewmate);
    const a = supervisor.intake.plan({ title: "A", intent: intentOf("a") });
    const b = supervisor.intake.plan({ title: "B", intent: intentOf("b"), blockedBy: [a.id] });
    expect(supervisor.intake.linkTasks(b.key, a.key, "blocks")).toMatch(/would close a cycle/);
    expect(tasks.graph.blockers(a.id)).toEqual([]);
    expect(supervisor.intake.linkTasks(a.key, b.key, "blocks")).toBe(
      "SCR-1 blocks SCR-2 (SCR-2 waits until SCR-1 closes) was already recorded.",
    );
    expect(supervisor.intake.linkTasks(a.key, b.key, "related")).toBe(
      "Recorded: SCR-1 is related to SCR-2.",
    );

    // A drops: B's wait is dead, so one wake, no card and no hold.
    tasks.close(a.id, { status: "dropped", reason: "cancelled", actor: "host" });
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    expect(cards()).toEqual([]);
    expect(ops.filter((line) => line.includes("can never end"))).toHaveLength(1);
    expect(tasks.get(b.id)?.gate).toBeNull();
    // Removing the dead edge is the way out the wake named.
    expect(supervisor.intake.unlinkTasks(a.key, b.key, "blocks")).toBe(
      "Removed: SCR-1 blocks SCR-2 (SCR-2 waits until SCR-1 closes).",
    );
    await tick();
    expect(tasks.get(b.id)?.gate).toBeNull();
    expect(tasks.graph.blockers(b.id)).toEqual([]);
    expect(supervisor.intake.unlinkTasks(a.key, b.key, "blocks")).toMatch(/^No such link/);
  });

  it("drops a parent only with confirm, cascading its open children as superseded", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, events } = setup(crewmate);
    const parent = supervisor.intake.plan({ title: "Epic", intent: intentOf("all") });
    const child = supervisor.intake.plan({
      title: "Part",
      intent: intentOf("part"),
      parent: parent.id,
    });
    expect(supervisor.intake.dropTask(parent.key, { reason: "changed course" })).toBe(
      'Cannot close SCR-1 while its child is still open: SCR-2 "Part". Start it so it can close, drop it as superseded, or settle SCR-1 keeping it planned.',
    );
    expect(tasks.get(parent.id)?.status).toBe("open");
    expect(
      supervisor.intake.dropTask(parent.key, { reason: "changed course", confirm: true }),
    ).toBe('Dropped SCR-1 "Epic" and SCR-2 as superseded.');
    expect(tasks.get(child.id)).toMatchObject({ status: "dropped", closedReason: "superseded" });
    expect(tasks.get(parent.id)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(events.at(-2)).toMatchObject({
      type: "firstmate_note",
      text: 'Dropped "Epic" (SCR-1) and 1 child under it - changed course.',
    });
    // Started work is settle_task's business.
    const running = await supervisor.intake.commission({ title: "Live", intent: intentOf("live") });
    await tick();
    expect(supervisor.intake.dropTask(running.taskId, { reason: "nah" })).toMatch(
      /a crewmate holds it. Use settle_task/,
    );
    const container = supervisor.intake.plan({ title: "Holder", intent: intentOf("hold") });
    tasks.setParent(running.taskId, container.id, "firstmate");
    expect(supervisor.intake.dropTask(container.id, { reason: "nah", confirm: true })).toMatch(
      /its child has started .*Settle them first/,
    );
  });

  it("drops never-started charted work for the captain, keeps its open parts planned, and refuses a start", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards, cardStore, ops } = setup(crewmate);
    const planned = supervisor.intake.plan({
      title: "Write the ADR",
      intent: intentOf("write it"),
    });
    const waiter = supervisor.intake.plan({ title: "Follow on", intent: intentOf("after") });
    supervisor.intake.linkTasks(planned.key, waiter.key, "blocks");
    const cardId = supervisor.addFirstmateCard({
      title: "Still open",
      body: "<p>Which way?</p>",
      taskId: planned.id,
      actions: [{ id: "go", label: "Go" }],
    });
    await tick();
    const review = dropReviewKeys(tasks.dropEffects(planned.id));
    expect(review.waiting).toEqual([waiter.key]);

    expect(supervisor.hostOps.runTaskOp(planned.id, "drop-task", { ...review, waiting: [] })).toBe(
      DROP_REVIEW_STALE,
    );
    expect(tasks.get(planned.id)?.status).toBe("open");
    expect(cards().some((card) => card.id === cardId)).toBe(true);

    expect(supervisor.hostOps.runTaskOp(planned.id, "drop-task", review)).toBeUndefined();
    await tick();
    expect(tasks.get(planned.id)).toMatchObject({
      status: "dropped",
      closedReason: "cancelled",
    });
    expect(tasks.timeline(planned.id).at(-1)).toMatchObject({
      actor: "captain",
      text: `dropped - ${NO_LONGER_WANTED}`,
    });
    expect(tasks.get(waiter.id)?.status).toBe("open");
    expect(tasks.graph.blockers(waiter.id).map((row) => row.id)).toEqual([planned.id]);
    expect(cards().some((card) => card.id === cardId)).toBe(false);
    expect(cardStore.chosenAction(cardId)).toBe("obsolete");
    expect(tasks.timeline(planned.id).some((event) => event.kind === "card_resolved")).toBe(false);
    expect(supervisor.hostOps.runTaskOp(planned.id, "drop-task", review)).toMatch(
      /not unstarted work/,
    );

    await supervisor.watch.sweepGates(Date.now());
    await tick();
    expect(ops.some((line) => line.includes("can never end"))).toBe(true);

    const parent = supervisor.intake.plan({ title: "Epic", intent: intentOf("all") });
    const part = supervisor.intake.plan({
      title: "Part",
      intent: intentOf("part"),
      parent: parent.id,
    });
    // The one drop (INF-3169's piece 4, the captain's pick "Also fold the
    // three into one drop"): the parent drops and its open part stays planned.
    expect(
      supervisor.hostOps.runTaskOp(
        parent.id,
        "drop-task",
        dropReviewKeys(tasks.dropEffects(parent.id)),
      ),
    ).toBeUndefined();
    expect(tasks.get(parent.id)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(tasks.get(part.id)?.status).toBe("open");

    const racing = supervisor.intake.plan({ title: "Race", intent: intentOf("race") });
    supervisor.hostOps.runTaskOp(racing.id, "start-task");
    expect(
      supervisor.hostOps.runTaskOp(
        racing.id,
        "drop-task",
        dropReviewKeys(tasks.dropEffects(racing.id)),
      ),
    ).toMatch(/just started/);
    expect(tasks.get(racing.id)?.status).toBe("open");
  });

  it("a parent cannot be settled while a child is open", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const parent = await supervisor.intake.commission({ title: "Parent", intent: intentOf("p") });
    await tick();
    supervisor.intake.plan({ title: "Child", intent: intentOf("c"), parent: parent.taskId });
    crewmate.finishPrompt();
    await tick();
    expect(await supervisor.settling.settle.settleTask(parent.taskId, "discard")).toMatch(
      /^Cannot close SCR-1 while its child is still open: SCR-2 "Child"/,
    );
    expect(await supervisor.settling.settle.settleTask(parent.taskId, "land")).toMatch(
      /^Cannot merge: Cannot close/,
    );
    expect(tasks.get(parent.taskId)?.status).toBe("active");
  });

  it("lands the work the captain asked for even with follow-ups filed under way", async () => {
    // The regression (captain, 2026-09-14): "i asked for the keychain thing
    // to be fixed, and all these sub task blockers were auto filed - i don't
    // even know they existed. and they automatically blocked what i asked
    // from landing." Filing is not choosing; only blocks_me holds a merge.
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the keychain prompt",
      intent: intentOf("fix the keychain thing"),
    });
    await tick();
    const spec = specs[0] as CrewmateSpec;
    for (const title of ["Flaky meter test", "Stale keychain docs", "Untyped helper"]) {
      spec.onFollowup?.({ title, goal: "g", why: "w" });
    }
    crewmate.finishPrompt();
    await tick();
    expect(tasks.graph.discoveredFrom(taskId)).toHaveLength(3);
    expect(await supervisor.settling.settle.settleTask(taskId, "land", undefined, "captain")).toBe(
      'Merged "Fix the keychain prompt" into main.',
    );
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "landed" });
    // The follow-ups outlive their origin as planned work of their own,
    // still traceable to where they were found.
    expect(tasks.byKey("SCR-2")).toMatchObject({ status: "open", parentId: null });
    expect(tasks.graph.discoveredOrigins(tasks.byKey("SCR-2")?.id ?? "").map((r) => r.id)).toEqual([
      taskId,
    ]);
  });

  it("a recorded wait holds the merge until the work it names closes", async () => {
    // INF-3167, the captain's choice A: a wait the first mate records holds
    // the start, draws the arrow and holds the merge like a blocks_me
    // filing; the waited-on task's close, or dropping it, clears the way.
    // (INF-416 piece E had landTask merge past it.)
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the keychain prompt",
      intent: intentOf("fix the keychain thing"),
    });
    await tick();
    const waiter = supervisor.intake.plan({
      title: "Wait for the fixture",
      intent: intentOf("the fixture"),
      startPolicy: "on-request",
    });
    expect(
      supervisor.intake.linkTasks(
        waiter.key ?? waiter.id,
        tasks.get(taskId)?.key ?? taskId,
        "blocks",
      ),
    ).toMatch(/^Recorded:/);
    expect(tasks.graph.blockers(taskId).map((row) => row.id)).toEqual([waiter.id]);
    expect(tasks.graph.linksTo(taskId).find((link) => link.type === "blocks")?.holdsMerge).toBe(
      false,
    );
    crewmate.finishPrompt();
    await tick();
    expect(await supervisor.settling.settle.settleTask(taskId, "land", undefined, "captain")).toBe(
      `Cannot merge: Cannot close SCR-1 while it waits on: ${waiter.key} "Wait for the fixture". The wait ends when that task closes: merge it, close it with settle_task done, why answered, when it is a step whose report was all SCR-1 needed, or drop it if the work is not wanted; remove the wait with link_tasks remove only when it names the wrong task. ${softHoldWords("waits", "firstmate")}`,
    );
    expect(tasks.get(taskId)).toMatchObject({ status: "active" });
    expect(supervisor.intake.dropTask(waiter.key ?? waiter.id, { reason: "not needed" })).toMatch(
      /^Dropped/,
    );
    await tick();
    crewmate.finishPrompt();
    await tick();
    expect(await supervisor.settling.settle.settleTask(taskId, "land", undefined, "captain")).toBe(
      'Merged "Fix the keychain prompt" into main.',
    );
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "landed" });
  });

  it("a blocks_me follow-up does hold the merge, and says which task and how to clear it", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the keychain prompt",
      intent: intentOf("fix the keychain thing"),
    });
    await tick();
    const spec = specs[0] as CrewmateSpec;
    spec.onFollowup?.({ title: "Rotate the signing key", goal: "g", why: "w", blocksMe: true });
    crewmate.finishPrompt();
    await tick();
    expect(await supervisor.settling.settle.settleTask(taskId, "land", undefined, "captain")).toBe(
      `Cannot merge: Cannot close SCR-1 while it waits on: SCR-2 "Rotate the signing key". The wait ends when that task closes: merge it, close it with settle_task done, why answered, when it is a step whose report was all SCR-1 needed, or drop it if the work is not wanted; remove the wait with link_tasks remove only when it names the wrong task. ${softHoldWords("waits", "firstmate")}`,
    );
    expect(tasks.get(taskId)?.status).toBe("active");
    // Dropping the blocker is one of the ways out the refusal names: work
    // that is not happening cannot hold a merge hostage. The crewmate that
    // waited on it hears so (FI3-250), and its turn ends before the merge.
    expect(supervisor.intake.dropTask("SCR-2", { reason: "handled upstream" })).toMatch(/^Dropped/);
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe(
      'SCR-2 "Rotate the signing key", which your task could not merge before, was dropped and no longer holds it. Carry on from where you stopped.',
    );
    crewmate.finishPrompt();
    await tick();
    expect(
      await supervisor.settling.settle.settleTask(taskId, "land", undefined, "captain"),
    ).toContain("into main.");
  });

  it("a wait never forbids a discard - only containment does", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the keychain prompt",
      intent: intentOf("fix the keychain thing"),
    });
    await tick();
    (specs[0] as CrewmateSpec).onFollowup?.({
      title: "Rotate the signing key",
      goal: "g",
      why: "w",
      blocksMe: true,
    });
    crewmate.finishPrompt();
    await tick();
    expect(await supervisor.settling.settle.settleTask(taskId, "discard")).toBe(discardedText());
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
  });

  it("a settle card names the follow-ups filed under its task", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the keychain prompt",
      intent: intentOf("fix the keychain thing"),
    });
    await tick();
    const spec = specs[0] as CrewmateSpec;
    spec.onFollowup?.({ title: "Flaky meter test", goal: "g", why: "w" });
    spec.onFollowup?.({ title: "Rotate the signing key", goal: "g", why: "w", blocksMe: true });
    spec.onFollowup?.({ title: "Continue: show it in Settings", goal: "g", why: "w" });
    spec.onFollowup?.({ title: "Retry the upload later", goal: "g", why: "w" });
    const filed = (prefix: string) =>
      tasks.graph.discoveredFrom(taskId).find((t) => t.title.startsWith(prefix))?.id ?? "";
    tasks.graph.link(taskId, filed("Continue"), "blocks", "host");
    // Queued by its start policy, held so nothing starts it during the test.
    tasks.placement.setGate(filed("Retry"), { kind: "at-time", until: Date.now() + 60_000 });
    tasks.updateFields(filed("Retry"), { startPolicy: "when-ready" }, "host");
    crewmate.finishPrompt();
    await tick();
    supervisor.addFirstmateCard({
      requiredActions: [],
      taskId,
      title: "Settle",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [{ id: "land", label: "Land locally", default: true, effect: SETTLE_MERGE }],
    });
    await tick();
    const body = cards().find((card) => card.taskId === taskId && card.actions.length > 0)?.body;
    expect(body).toContain("Filed while working on this");
    const rows = [...(body ?? "").matchAll(/data-followup="(\w+)"[^>]*><span[^>]*>([^<]*)</g)];
    // Must close first leads, whatever the filing order.
    // Then the Tasks panel's own words: queued before backlog.
    expect(rows.map((row) => [row[1], row[2]])).toEqual([
      ["hold", "SCR-3"],
      ["after", "SCR-4"],
      ["queued", "SCR-5"],
      ["backlog", "SCR-2"],
    ]);
    expect(body).toContain("Flaky meter test");
    expect(body).toContain(FOLLOWUP_WORDS.hold.word);
    // A card with no settle action says nothing: this is a landing decision.
    supervisor.addFirstmateCard({
      taskId,
      title: "Something else",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [{ id: "keep-going", label: "Keep going", default: true }],
    });
    await tick();
    expect(cards().find((card) => card.title === "Something else")?.body).not.toContain(
      "Filed while working on this",
    );
  });

  it("a settle card reads a filed wait the captain's words passed as free, as the close gate does", async () => {
    // INF-3203: the row reads the wait the way the close gate, the board's
    // flag and Blocked by do, so once the captain's recorded override passes
    // it, the card stops saying the follow-up must close before this merge.
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the keychain prompt",
      intent: intentOf("fix the keychain thing"),
    });
    await tick();
    (specs[0] as CrewmateSpec).onFollowup?.({
      title: "Rotate the signing key",
      goal: "g",
      why: "w",
      blocksMe: true,
    });
    crewmate.finishPrompt();
    await tick();
    const offer = async () => {
      supervisor.addFirstmateCard({
        id: "settle",
        requiredActions: [],
        taskId,
        title: "Settle",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [{ id: "land", label: "Land locally", default: true, effect: SETTLE_MERGE }],
      });
      await tick();
      const body =
        cards().find((card) => card.taskId === taskId && card.actions.length > 0)?.body ?? "";
      return [...body.matchAll(/data-followup="(\w+)"/g)].map((row) => row[1]);
    };
    expect(await offer()).toEqual(["hold"]);
    expect(tasks.graph.blockerRefusal(taskId)).toBeDefined();
    seedDelivery(tasks, taskId, {
      override: { words: "merge it, the key can wait", holds: ["waits"], until: "task", at: 1 },
    });
    // The close gate lets it through, and the revised card says the same.
    expect(tasks.graph.blockerRefusal(taskId)).toBeUndefined();
    expect(await offer()).toEqual(["backlog"]);
  });

  it("appends the settle facts to any card carrying a settle effect (v2.0, ruling D4)", async () => {
    // The Sep 15 completion cards led with the repo, PR and CI state and
    // were refused for it; those facts are the host's to render now, from
    // the task record, so the body cannot contradict them.
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards } = setup(crewmate);
    await supervisor.intake.commission({
      title: "Fix the keychain prompt",
      intent: intentOf("fix the keychain thing"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    // INF-2744: autonomy off, so the merge card stays up with its buttons
    // instead of the app merging from it as it goes up.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    (specs[0] as CrewmateSpec).onCard?.({
      requiredActions: [],
      title: "The keychain prompt is fixed",
      body: completionBody(
        "<p>The prompt no longer fires on every rebuild.</p><ul><li>Verified on a packaged build.</li></ul>",
      ),
      actions: [
        { id: "merge", label: "Land locally", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    await tick();
    const completion = cards().find((card) => card.title === "The keychain prompt is fixed");
    expect(completion?.body).toBe(
      completionBody(
        "<p>The prompt no longer fires on every rebuild.</p><ul><li>Verified on a packaged build.</li></ul>",
      ) +
        SETTLE_FACTS_OPEN +
        `<span class="inf-fact" data-fact="project"><span class="inf-fact-k">Project</span><span class="inf-fact-v">${DEFAULT_WORKSPACE_WORD}</span></span>` +
        '<span class="inf-fact" data-fact="crewmate"><span class="inf-fact-k">Model</span><span class="inf-fact-v">mock-1</span></span>' +
        '<span class="inf-fact" data-fact="care"><span class="inf-fact-k">Care</span><span class="inf-fact-v">Quick</span></span>' +
        // The app's line says the merge closes the task (INF-2490).
        `<p class="inf-merge-closes" ${MERGE_CLOSES_MARK}>${MERGE_CLOSES_WORDS.closes}</p>` +
        "</div>",
    );
    // A card with no settle effect carries no facts line.
    (specs[0] as CrewmateSpec).onCard?.({
      title: "Two ways to silence it",
      body: "<p>Pick the course to take.</p><ul><li>Both work.</li></ul>",
      actions: [
        { id: "cache", label: "Cache the grant", default: true },
        { id: "sign", label: "Sign with a stable identity" },
      ],
    });
    await tick();
    expect(cards().find((card) => card.title === "Two ways to silence it")?.body).not.toContain(
      "inf-facts",
    );
  });

  it.each([false, true])(
    "shows version-bound measured lines, never unread zero counts (remote=%s, INF-820, INF-1235)",
    async (remote) => {
      // INF-820, the captain's words: "add line added/deleted stats to merge
      // completion card". The host reads the counts from git (the git side is
      // workspaceService.test.ts's); this owns what the strip shows of them.
      const revision = vi.fn(async (_device: string, _task: string, head?: string) => ({
        headSha: head ?? "1".repeat(40),
        changedFiles: ["src/meter.ts"],
        ...(head === "1".repeat(40)
          ? { changeLines: { base: "0".repeat(40), added: 128, deleted: 42 } }
          : head === "2".repeat(40)
            ? { changeLines: { base: "0".repeat(40), added: 1204, deleted: 7 } }
            : {}),
      }));
      const { supervisor, specs, cards, tasks, workspace } = setup(fakeCrewmate(), {
        machines: {
          revision,
          computers: () => [],
          placeOf: () => ({ where: "on Studio Mac", name: "Studio Mac" }),
        } as unknown as CrewMachines,
      });
      const base = "0".repeat(40);
      const first = "1".repeat(40);
      const revised = "2".repeat(40);
      vi.mocked(workspace.changeLines).mockImplementation(async (_dir, head) =>
        head === first
          ? { base, added: 128, deleted: 42 }
          : head === revised
            ? { base, added: 1204, deleted: 7 }
            : null,
      );
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter",
        intent: intentOf("Fix the meter."),
        shape: { rigor_ask: "quick" },
      });
      await tick();
      // INF-2744: autonomy off, so the merge card stays up with its buttons
      // instead of the app merging from it as it goes up.
      vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
      const lines = () =>
        cards()
          .find((card) => card.taskId === taskId && card.actions.length > 0)
          ?.body.match(
            /<span class="inf-fact" data-fact="lines">[\s\S]*?<\/span><\/span><\/span>/,
          )?.[0];
      const emit = () =>
        (specs[0] as CrewmateSpec).onCard?.({
          requiredActions: [],
          id: "done",
          title: "The meter is fixed",
          body: completionBody("<p>The meter reads on time.</p><ul><li>Checked by hand.</li></ul>"),
          actions: [
            { id: "merge", label: "Land locally", default: true, effect: SETTLE_MERGE },
            { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
          ],
        });

      // INF-1235: remote work uses the computer's host reading, never the home branch.
      if (remote) tasks.placement.setDevice(taskId, "computer");
      // The offered version cannot be read here: no cell, never a zero.
      seedDelivery(tasks, taskId, { headSha: "9".repeat(40), ci: "green", ciAt: Date.now() });
      emit();
      await tick();
      if (remote) {
        expect(revision).toHaveBeenCalledWith("computer", taskId, "9".repeat(40));
        expect(workspace.changeLines).not.toHaveBeenCalled();
      } else expect(workspace.changeLines).toHaveBeenCalled();
      expect(lines()).toBeUndefined();
      expect(cards().find((card) => card.taskId === taskId)?.body).not.toContain("+0");

      // A readable version: the counts, labeled apart, in mono.
      seedDelivery(tasks, taskId, { headSha: first, ci: "green", ciAt: Date.now() });
      await tick();
      expect(lines()).toBe(
        `<span class="inf-fact" data-fact="lines"><span class="inf-fact-k">Lines</span><span class="inf-fact-v"><span class="inf-mono">${changeLinesWords(128, 42)}</span></span></span>`,
      );
      expect(tasks.get(taskId)?.delivery?.changeLines).toMatchObject({
        base,
        head: first,
        added: 128,
        deleted: 42,
      });
      // It sits after the change and before the checks.
      const body = cards().find((card) => card.taskId === taskId)?.body ?? "";
      expect(body.indexOf('data-fact="lines"')).toBeLessThan(body.indexOf('data-fact="checks"'));

      // The change is revised: the strip shows the new version's counts.
      seedDelivery(tasks, taskId, { headSha: revised, ci: "green", ciAt: Date.now() });
      await tick();
      expect(lines()).toContain(changeLinesWords(1204, 7));

      // No old count is substituted for an unavailable newer version.
      seedDelivery(tasks, taskId, { headSha: "9".repeat(40) });
      await tick();
      expect(lines()).toBeUndefined();

      if (remote) {
        // A computer returning another version is not proof of the offered version.
        revision.mockResolvedValue({
          headSha: first,
          changedFiles: ["src/meter.ts"],
          changeLines: { base, added: 128, deleted: 42 },
        });
        seedDelivery(tasks, taskId, { headSha: "8".repeat(40) });
        await tick();
        expect(lines()).toBeUndefined();
        expect(tasks.get(taskId)?.delivery?.changeLines?.head).toBe(revised);

        let finish!: (reading: Awaited<ReturnType<typeof revision>>) => void;
        revision.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        seedDelivery(tasks, taskId, { headSha: "7".repeat(40) });
        await tick();
        seedDelivery(tasks, taskId, { headSha: first });
        finish({
          headSha: "7".repeat(40),
          changedFiles: ["src/meter.ts"],
          changeLines: { base, added: 999, deleted: 999 },
        });
        await tick();
        expect(tasks.get(taskId)?.delivery?.changeLines?.head).toBe(first);
        expect(lines()).toContain(changeLinesWords(128, 42));
        expect(lines()).not.toContain("999");
      }
    },
  );

  it("names the DISPATCHED model right after the project, never the routing choice (review F1)", async () => {
    const crewmate = fakeCrewmate();
    // The router chose one model, but the transport actually served
    // another (fm-mock/mock-1, fakeCrewmate's modelRef): the strip names
    // what served, off the task record's dispatched model.
    const { supervisor, specs, cards } = setup(crewmate, {
      routedModel: { provider: "anthropic", id: "claude-fable-5" },
    });
    // The captain's word on care keeps this at the quick tier, so the
    // completion card publishes bare and the strip is what is under test.
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the keychain prompt",
      intent: intentOf("fix the keychain thing"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    // INF-2744: autonomy off, so the merge card stays up with its buttons
    // instead of the app merging from it as it goes up.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    (specs[0] as CrewmateSpec).onCard?.({
      requiredActions: [],
      title: "The keychain prompt is fixed",
      body: completionBody(
        "<p>The prompt no longer fires.</p><ul><li>Verified on a packaged build.</li></ul>",
      ),
      actions: [
        { id: "merge", label: "Land locally", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    await tick();
    const body = cards().find((card) => card.taskId === taskId && card.actions.length > 0)?.body;
    expect(body).toContain(
      '<span class="inf-fact" data-fact="crewmate"><span class="inf-fact-k">Model</span><span class="inf-fact-v">mock-1</span></span>',
    );
    expect(body).not.toContain("claude-fable-5");
    const project = body?.indexOf(">Project<") ?? -1;
    const crewmateAt = body?.indexOf(">Model<") ?? -1;
    const care = body?.indexOf(">Care<") ?? -1;
    expect(project).toBeGreaterThanOrEqual(0);
    expect(crewmateAt).toBeGreaterThan(project);
    expect(care).toBeGreaterThan(crewmateAt);
  });

  it("keeps the task record on the model that answers, says what moved it, and names it on the strip (FI3-967)", async () => {
    const opus55 = { provider: CLAUDE_PROVIDER_ID, id: "claude-opus-5-5" };
    const opus48 = { provider: CLAUDE_PROVIDER_ID, id: "claude-opus-4-8" };
    const served = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
    const crewmate = fakeCrewmate({ model: opus55, modelLabel: "Claude Opus 5.5" });
    const { supervisor, specs, cards, tasks, events } = setup(crewmate, { routedModel: opus55 });
    const { taskId } = await supervisor.intake.commission({
      title: "Read the Mac mini's network logs",
      intent: intentOf("find why adding the computer by address fails"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    // INF-2744: autonomy off, so the merge card stays up with its buttons
    // instead of the app merging from it as it goes up.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    const moves = () =>
      tasks.timeline(taskId).filter((event) => event.kind === "note" && event.data?.servedModel);
    expect(tasks.get(taskId)?.model).toBe(served(opus55));

    // The client's first word on its model is the routed one: nothing moved.
    crewmate.emit({ type: "model_served", model: opus55 });
    expect(moves()).toEqual([]);

    // Claude Code moved the session after Opus 5.5's safeguards stopped a reply.
    crewmate.emit({
      type: "model_served",
      model: opus48,
      fallback: { from: opus55, category: "cyber" },
    });
    expect(tasks.get(taskId)?.model).toBe(served(opus48));
    const [moved] = moves();
    expect(moved?.data).toEqual({
      servedModel: served(opus48),
      from: served(opus55),
      fallback: { from: served(opus55), category: "cyber" },
      news: true,
    });
    const record = tasks.get(taskId);
    if (!record || !moved) throw new Error("the move was not recorded");
    expect(taskFeedLine(record, moved)).toMatchObject({
      kind: "warn",
      text: "Moved from claude-opus-5-5 to claude-opus-4-8 after claude-opus-5-5's safeguards stopped a reply",
      event: "note",
    });
    // Owner-only: the session's word never reaches the feed as its own event.
    expect(events.some((event) => (event as { type: string }).type === "model_served")).toBe(false);

    // The completion card's strip names the model doing the work now.
    (specs[0] as CrewmateSpec).onCard?.({
      requiredActions: [],
      title: "Adding a computer by its address works",
      body: completionBody(
        "<p>The relay now answers.</p><ul><li>Verified on the Mac mini.</li></ul>",
      ),
      actions: [
        { id: "merge", label: "Land locally", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    await tick();
    const body = cards().find((card) => card.taskId === taskId && card.actions.length > 0)?.body;
    expect(body).toContain(
      '<span class="inf-fact" data-fact="crewmate"><span class="inf-fact-k">Model</span><span class="inf-fact-v">claude-opus-4-8</span></span>',
    );

    // A reattach asked for the routed model again, and the client honored it.
    crewmate.emit({ type: "model_served", model: opus55 });
    expect(tasks.get(taskId)?.model).toBe(served(opus55));
    const back = moves().at(-1);
    expect(back?.data).toEqual({
      servedModel: served(opus55),
      from: served(opus48),
      news: true,
    });
    const now = tasks.get(taskId);
    if (!now || !back) throw new Error("the move back was not recorded");
    expect(taskFeedLine(now, back)).toMatchObject({
      kind: "info",
      text: "Moved from claude-opus-4-8 to claude-opus-5-5",
    });
  });

  it("turns a merge card back while a wait would refuse the click, and takes it once the wait is gone", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs, cards } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("fix it"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    // INF-2744: autonomy off, so the merge card stays up with its buttons
    // instead of the app merging from it as it goes up.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    const spec = specs[0] as CrewmateSpec;
    spec.onFollowup?.({ title: "Live checks", goal: "g", why: "w", blocksMe: true });
    const blocker = tasks.graph.blockers(taskId)[0];
    const card = () => ({
      requiredActions: [],
      title: "The meter is fixed",
      body: completionBody("<p>Fixed.</p><ul><li>Verified.</li></ul>"),
      actions: [
        { id: "merge", label: "Merge PR", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    expect(() => spec.onCard?.(card())).toThrow(
      /Card refused: this task still waits on open work.*Live checks/,
    );
    expect(cards().some((c) => c.taskId === taskId && c.actions.length > 0)).toBe(false);

    tasks.graph.unlink(blocker?.id ?? "", taskId, "blocks", "firstmate");
    spec.onCard?.(card());
    await tick();
    expect(cards().some((c) => c.taskId === taskId && c.actions.length > 0)).toBe(true);
  });

  it("a crewmate's follow-up is its own task, not a child, and notes progress on its timeline", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs, ops, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("fix it"),
    });
    await tick();
    const spec = specs[0] as CrewmateSpec;
    const text = spec.onFollowup?.({
      title: "Flaky meter test",
      goal: "The meter test passes ten runs in a row",
      why: "it failed twice in the suite while I was working",
    });
    expect(text).toBe(
      'Filed follow-up SCR-2 "Flaky meter test", discovered from your task and not holding it up. The first mate hears about it with your report and decides when it runs; keep going on your own task.',
    );
    const followup = tasks.byKey("SCR-2");
    expect(followup).toMatchObject({
      parentId: null,
      projectId: tasks.get(taskId)?.projectId,
      status: "open",
      startPolicy: "on-request",
      goal: "The meter test passes ten runs in a row",
    });
    expect(followup?.prompt).toContain(
      `${FOLLOWUP_PROVENANCE_OPENING} crewmate 1 while working on "Fix the meter" (SCR-1)`,
    );
    expect(tasks.graph.discoveredFrom(taskId).map((r) => r.id)).toEqual([followup?.id]);
    expect(tasks.graph.blockers(taskId)).toEqual([]);
    expect(events).toContainEqual({
      type: "firstmate_note",
      text: "Task Fix the meter follow-up filed: SCR-2 Flaky meter test",
    });
    // Filing is cheap (cards/tasks/agents P0, WI-4): a row, a link and a
    // feed line, never a wake of its own.
    expect(ops).toEqual([]);
    // Filing must never gate the work the captain actually asked for.
    expect(tasks.graph.openChildren(taskId)).toEqual([]);
    expect(tasks.graph.closeRefusal(taskId)).toBeUndefined();
    expect(tasks.graph.blockerRefusal(taskId)).toBeUndefined();

    // blocks_me records that the origin waits on it - the one thing that does.
    expect(spec.onFollowup?.({ title: "Unblock", goal: "g", why: "w", blocksMe: true })).toContain(
      "and blocking it: your task cannot land until this one closes",
    );
    expect(tasks.graph.blockers(taskId).map((r) => r.key)).toEqual(["SCR-3"]);
    expect(ops).toEqual([]);
    expect(tasks.graph.blockerRefusal(taskId)?.text).toMatch(/while it waits on: SCR-3 "Unblock"/);

    // The Firstmate hears about both with the report, in one wake.
    crewmate.emit({ type: "assistant_delta", taskId, text: "Meter fixed; two follow-ups filed." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toContain(`[fm-op] crewmate 1 reported on task ${taskId} "Fix the meter"`);
    expect(ops[0]).toContain(
      'Filed this turn: SCR-2 "Flaky meter test" (not blocking), SCR-3 "Unblock" (blocks this task).',
    );
    // Facts only (v2.0): the wake says what waits and on what, not which tool starts it.
    expect(ops[0]).toContain("Each waits on request, discovered from this task.");
    expect(ops[0]).not.toContain("update_task");
    // The next turn's report names nothing filed: the list is per turn.
    await supervisor.steer.steerCrewmate(taskId, "carry on");
    crewmate.emit({ type: "assistant_delta", taskId, text: "Nothing more to file today." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(ops).toHaveLength(2);
    expect(ops[1]).toContain("Nothing more to file today.");
    expect(ops[1]).not.toContain("Filed this turn");

    // A plan rides the note as declared (FI3-734); one no surface could draw is refused in words, writing nothing.
    const plan = [{ label: "Fix the meter", short: "Fix", state: "current" }];
    expect(spec.onProgress?.("briefed", plan)).toBe(
      "Noted on your task's timeline, with your plan.",
    );
    expect(tasks.timeline(taskId).at(-1)).toMatchObject({ kind: "progress", data: { plan } });
    const before = tasks.timeline(taskId).length;
    expect(spec.onProgress?.("odd", [{ label: "x", short: "x", state: "soon" }])).toMatch(
      /^plan was refused at plan\[0\]\[state\]/,
    );
    expect(tasks.timeline(taskId)).toHaveLength(before);
    // A note that omits the list keeps the last one (INF-484 move 5).
    expect(spec.onProgress?.("tests pass; opening the PR")).toBe(
      "Noted on your task's timeline; your last plan stands.",
    );
    expect(tasks.timeline(taskId)).toHaveLength(before + 1);
    expect(spec.onProgress?.("tests pass; opening the PR", plan)).toBe(
      "Noted on your task's timeline, with your plan.",
    );
    expect(tasks.timeline(taskId).at(-1)).toMatchObject({
      kind: "progress",
      actor: "crewmate",
      text: "tests pass; opening the PR",
      feed: false,
    });
    expect(() => spec.onFollowup?.({ title: "", goal: "g", why: "w" })).toThrow(/title/);
    expect(() => spec.onProgress?.("   ")).toThrow(/text is required/);
  });
});

/**
 * The generic graph pieces a parent task with child steps runs on
 * (docs/sequences.md): a planned step names its basis and is judged on it
 * when it starts, a parent no crewmate holds completes with its children,
 * and the basis section hands the next step the working copy and what the
 * captain said under the card. None of it knows what a sequence is.
 */
describe("parent tasks with planned children", () => {
  const byTitle = {
    classify: async (input: KindInput) =>
      input.title.startsWith("Plan")
        ? ({ kind: "plan", source: "classifier:test", version: "kc1" } as const)
        : ({ kind: "implement", source: "classifier:test", version: "kc1" } as const),
  };

  /** A plan step under a container, its card up, and an implement step planned behind it. */
  async function plannedBehindAPlan() {
    const planner = fakeCrewmate();
    const builder = fakeCrewmate();
    const decideCalls: { shape: WorkShape }[] = [];
    // Serve the policy's requested slot, rather than hardcoding high for every shape.
    const routeResult: import("../routing/router").RouteResult = {
      choice: { provider: "openai-codex", id: "gpt-6-sol" },
      bucket: "high",
      servedBucket: "high",
      rule: "R2",
    };
    const harness = setup(planner, {
      crewmates: [builder],
      classifier: byTitle,
      routeResult,
      onRouteDecide: (args) => {
        decideCalls.push(args);
        const tier = tierFor(args.shape);
        Object.assign(routeResult, tier, { servedBucket: tier.bucket });
      },
    });
    const { supervisor, tasks, specs, cards } = harness;
    const parent = supervisor.intake.plan({
      title: "Declutter the settings page",
      intent: intentOf("the settings page feels cluttered"),
    });
    const plan = await supervisor.intake.commission({
      title: "Plan: ways to declutter settings",
      intent: {
        goal: "propose two or three directions as one card",
        userWords: "the settings page feels cluttered",
        constraints: [{ kind: "read-only" }],
      },
      parent: parent.key,
    });
    await tick();
    const planKey = tasks.get(plan.taskId)?.key ?? plan.taskId;
    const implement = supervisor.intake.plan({
      title: "Implement the accepted direction",
      intent: intentOf("implement the accepted direction"),
      parent: parent.key,
      shape: { basis: planKey },
    });
    specs[0]?.onCard?.({
      title: "Two ways to declutter settings",
      body: "<p>Two directions.</p><ul><li>A: hide rare rows.</li><li>B: group into sections.</li></ul>",
      asking: true,
      actions: [
        { id: "a", label: "Hide rare rows" },
        { id: "b", label: "Group into sections", default: true },
      ],
    });
    await tick();
    const card = cards().find((entry) => entry.taskId === plan.taskId) as Card;
    return { ...harness, planner, builder, decideCalls, parent, plan, planKey, implement, card };
  }

  it("verifies a planned child's basis when it starts, not when it was planned", async () => {
    const {
      supervisor,
      tasks,
      planner,
      builder,
      decideCalls,
      sessionSpecs,
      plan,
      planKey,
      implement,
      card,
    } = await plannedBehindAPlan();
    // Planned while the plan was still running: recorded, not believed yet.
    expect(tasks.get(implement.id)?.shape).toMatchObject({ basis: planKey });
    expect(tasks.graph.basisOf(implement)).toEqual({ ref: planKey, verified: false });

    const asked = supervisor.cards.addMessage(
      card.id,
      "captain",
      "B, but keep the gear icon where it is",
    );
    planner.emit({
      type: "assistant_delta",
      taskId: plan.taskId,
      text: "Two directions; B groups the rows into sections.",
    });
    supervisor.cards.addMessage(
      card.id,
      "crewmate",
      "B groups the rows into sections and keeps the gear icon in place.",
      undefined,
      undefined,
      undefined,
      false,
      { answersMessage: asked.id },
    );
    planner.emit({ type: "turn_end", taskId: plan.taskId });
    planner.finishPrompt();
    await tick();
    supervisor.cardActions.act(card.id, "b");
    await tick();
    expect(tasks.get(plan.taskId)).toMatchObject({ status: "done", closedReason: "answered" });

    expect(await supervisor.starts.startQueuedNow(implement.key)).toContain(
      `${implement.key} "Implement the accepted direction" is starting.`,
    );
    await tick();
    expect(tasks.get(implement.id)?.status).toBe("active");
    const shape = decideCalls.at(-1)?.shape as WorkShape;
    expect(shape).toMatchObject({ kind: "implement", basis: planKey, basis_verified: true });
    expect(tierFor(shape)).toMatchObject({ rule: "R4", bucket: "medium" });
    // The verdict is read, never written back: the record keeps the basis
    // as named, and the row's tier follows the grounded route.
    const started = tasks.get(implement.id);
    expect(started?.shape).not.toHaveProperty("basis_verified");
    expect(started && tasks.graph.basisOf(started)).toEqual({ ref: planKey, verified: true });
    expect(started?.difficulty).toBe("medium");
    expect(sessionSpecs[0]?.thinking.level).toBe("xhigh");
    expect(sessionSpecs[1]?.thinking.level).toBe("medium");
    console.log(
      "Finished-plan dispatch",
      JSON.stringify({
        planner: { shape: decideCalls[0]?.shape, thinkingLevel: sessionSpecs[0]?.thinking.level },
        builder: {
          shape,
          difficulty: started?.difficulty,
          thinkingLevel: sessionSpecs[1]?.thinking.level,
        },
      }),
    );
    const brief = builder.promptCalls[0] ?? "";
    expect(brief).toContain(`grounded in ${planKey}`);
    expect(brief).toContain("Two directions; B groups the rows into sections.");
    expect(handedCard(brief).body).toContain("<li>B: group into sections.</li>");
    expect(brief).toContain("- captain: B, but keep the gear icon where it is");
    // The choice that closed the plan is on the record, and the builder is told it.
    expect(brief).toContain('The captain closed it by choosing "Group into sections".');
  });

  it("hands accepted task-card selections to exactly one existing successor, including recovery reads", async () => {
    const {
      supervisor,
      tasks,
      planner,
      builder,
      specs,
      sessions,
      cardStore,
      parent,
      plan,
      planKey,
      implement,
      card,
    } = await plannedBehindAPlan();
    specs[0]?.onCard?.({
      id: card.id,
      title: "Task cards",
      body: "<p>Make task popovers normal cards.</p><p>Proposal default: one record.</p>",
      actions: [
        { id: "abandon", label: "Abandon" },
        { id: "defer", label: "Save and defer" },
        { id: "agree", label: "Approve and build", default: true },
      ],
    });
    planner.finishPrompt();
    await tick();
    tasks.turns.recordReport(plan.taskId, {
      text: "Task cards: one record proposed; count still unresolved.",
    });
    const answers = [
      { name: "q2_count", values: ["many"], labels: ["One per task"], changed: true },
    ];
    supervisor.cardActions.act(card.id, "agree", "chrome", { answers });
    await tick();
    const saved = supervisor.cards.newestResolutionForTask(plan.taskId);
    expect(saved).toMatchObject({ action: "agree", answers });
    expect(saved?.offer?.body).toContain("Proposal default: one record");
    cardStore.upsert({ ...card, id: `${card.id}-retired`, createdAt: card.createdAt + 1 });
    await vi.advanceTimersByTimeAsync(1);
    cardStore.resolve(`${card.id}-retired`, "task-retired");
    expect(cardStore.resolvedSince(0, 1, () => true, plan.taskId)[0]?.action).toBe("task-retired");
    expect(supervisor.cards.newestResolutionForTask(plan.taskId)?.answers).toEqual(answers);
    // A plan that also shipped ends on a merge card: it never replaces the answered card (FI3-658).
    cardStore.upsert({
      ...card,
      id: `${card.id}-merge`,
      createdAt: card.createdAt + 2,
      body: "<p>Completion card body.</p>",
      actions: [
        {
          id: "merge",
          label: "Merge",
          variant: "primary",
          effect: { kind: "merge", after: "close" },
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(1);
    cardStore.resolve(`${card.id}-merge`, "merge");

    // The Firstmate decides to start on acceptance; the generic host never parses "Agree".
    expect(await supervisor.starts.startQueuedNow(implement.key)).toContain("is starting.");
    await tick();
    expect(builder.promptCalls[0]).toContain(`grounded in ${planKey}`);
    expect(builder.promptCalls[0]).toContain('q2_count: "One per task" (many), changed');
    expect(handedCard(builder.promptCalls[0] ?? "").body).toContain("Proposal default: one record");
    expect(handedCard(builder.promptCalls[0] ?? "").body).not.toContain("Completion card body.");
    expect(builder.promptCalls[0]).not.toContain("Completion card body.");
    expect(builder.promptCalls[0]).toContain("The captain's latest submitted settings/answers");
    const starts = sessions.open.mock.calls.length;
    supervisor.cardActions.act(card.id, "agree", "chrome", { answers });
    expect(await supervisor.starts.startQueuedNow(implement.key)).toContain("not queued work");
    await tick();
    expect(sessions.open.mock.calls).toHaveLength(starts);
    expect(
      tasks.graph.children(parent.id).filter((child) => child.shape?.basis === planKey),
    ).toHaveLength(1);
    expect(tasks.get(parent.id)).toMatchObject({
      status: "open",
      startPolicy: "on-request",
      assignee: null,
    });
  });

  for (const label of [
    "This chooses a plan, not permission to implement",
    "Use these settings",
    "Hold until welcome merges",
  ]) {
    it(`records ${label} without the host granting a build`, async () => {
      const { supervisor, tasks, planner, specs, plan, implement, card } =
        await plannedBehindAPlan();
      specs[0]?.onCard?.({
        id: card.id,
        title: "Design choice",
        body: `<p>${label}</p><p>This records the choice without a build.</p>`,
        ...(label === "Hold until welcome merges" ? { asking: true } : { designOnly: true }),
        actions: [
          { id: "select", label, default: true },
          { id: "keep-looking", label: "Keep looking" },
        ],
      });
      planner.finishPrompt();
      await tick();
      supervisor.cardActions.act(card.id, "select");
      await tick();
      expect(tasks.get(plan.taskId)?.status).toBe("done");
      expect(tasks.get(implement.id)).toMatchObject({ status: "open", startPolicy: "on-request" });
    });
  }

  it("starts a planned child ungrounded when its basis never answered", async () => {
    const { supervisor, tasks, builder, decideCalls, planKey, implement } =
      await plannedBehindAPlan();
    await supervisor.starts.startQueuedNow(implement.key);
    await tick();
    const shape = decideCalls.at(-1)?.shape as WorkShape;
    expect(shape).toMatchObject({ kind: "implement", basis: planKey, basis_verified: false });
    expect(tierFor(shape)).toMatchObject({ rule: "R3", bucket: "high" });
    const started = tasks.get(implement.id);
    expect(started && tasks.graph.basisOf(started)).toEqual({ ref: planKey, verified: false });
    expect(builder.promptCalls[0] ?? "").not.toContain("grounded in");
  });

  it("closes a parent no crewmate holds once every child is closed", async () => {
    const { supervisor, tasks } = setup(fakeCrewmate());
    const planOf = (title: string, parent?: string) =>
      supervisor.intake.plan({ title, intent: intentOf(title), ...(parent ? { parent } : {}) });
    const closeAs = (id: string, status: "done" | "dropped") =>
      tasks.close(id, {
        status,
        reason: status === "done" ? "merged" : "cancelled",
        actor: "host",
      });
    const lineFor = (id: string) => {
      const record = tasks.get(id) as TaskRecord;
      const event = tasks.timeline(id).at(-1) as TaskEvent;
      return taskFeedLine(record, event)?.text;
    };

    // Both children done: done, with its one feed line.
    const both = planOf("Declutter the settings page");
    const a = planOf("Plan it", both.id);
    const b = planOf("Build it", both.id);
    closeAs(a.id, "done");
    await supervisor.watch.sweepGates(Date.now());
    expect(tasks.get(both.id)?.status).toBe("open");
    closeAs(b.id, "done");
    await supervisor.watch.sweepGates(Date.now());
    expect(tasks.get(both.id)).toMatchObject({ status: "done", closedReason: "finished" });
    expect(lineFor(both.id)).toBe("Done: everything under it is finished");

    // One dropped, one done: still done.
    const mixed = planOf("Fix the meter");
    closeAs(planOf("Reproduce it", mixed.id).id, "dropped");
    closeAs(planOf("Fix it", mixed.id).id, "done");
    await supervisor.watch.sweepGates(Date.now());
    expect(tasks.get(mixed.id)).toMatchObject({ status: "done", closedReason: "finished" });

    // Every child dropped: dropped.
    const none = planOf("Rename the dock");
    closeAs(planOf("Plan the rename", none.id).id, "dropped");
    await supervisor.watch.sweepGates(Date.now());
    expect(tasks.get(none.id)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(lineFor(none.id)).toBe("Stopped: nothing under it went ahead");

    // An open child holds it.
    const waiting = planOf("Tidy the feed");
    closeAs(planOf("Plan the tidy", waiting.id).id, "done");
    planOf("Do the tidy", waiting.id);
    await supervisor.watch.sweepGates(Date.now());
    expect(tasks.get(waiting.id)?.status).toBe("open");

    // A parent that carries a crewmate is its crewmate's to settle.
    const held = seedTask(tasks, {
      id: "held1",
      title: "Own work",
      status: "completed",
      worktreeDir: "/w/held1",
    });
    closeAs(planOf("A part of it", held.id).id, "done");
    await supervisor.watch.sweepGates(Date.now());
    expect(tasks.get(held.id)?.status).toBe("active");

    // A parent with no children is just a planned row.
    const alone = planOf("Someday");
    await supervisor.watch.sweepGates(Date.now());
    expect(tasks.get(alone.id)?.status).toBe("open");
  });

  it("names the basis's branch, or its kept work, and quotes its card's thread", async () => {
    const builder = fakeCrewmate();
    const { supervisor, tasks, cardStore } = setup(builder);
    // A live working copy: the branch, which the builder's worktree can read.
    seedTask(tasks, {
      id: "rep1",
      title: "Reproduce the meter bug",
      status: "completed",
      worktreeDir: "/w/rep1",
      branch: "fm/task-rep1",
      outcome: "reproduced: yes - the failing check is saved on the working copy.",
    });
    await supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("fix it"),
      shape: { basis: tasks.get("rep1")?.key ?? "rep1" },
    });
    await tick();
    const onBranch = builder.promptCalls.at(-1) ?? "";
    expect(onBranch).toContain(
      "Its work is on branch fm/task-rep1 in this repository (worktrees share refs: git log fm/task-rep1)",
    );
    expect(onBranch).not.toContain("What was said under its card");

    // An answer's working copy holds nothing of its answer (it commits
    // nothing, and the copy goes when it closes): no branch is named, the
    // report and card carry it.
    seedTask(tasks, {
      id: "rep0",
      title: "Reproduce the clock drift",
      status: "completed",
      worktreeDir: "/w/rep0",
      branch: "fm/task-rep0",
      shape: { kind: "reproduce", kind_source: "classifier:test", deliverable: "answer" },
      outcome: "reproduced: yes - the clock drifts a second a minute.",
    });
    await supervisor.intake.commission({
      title: "Fix the clock drift",
      intent: intentOf("fix it"),
      shape: { basis: tasks.get("rep0")?.key ?? "rep0" },
    });
    await tick();
    const onAnswer = builder.promptCalls.at(-1) ?? "";
    expect(onAnswer).toContain("reproduced: yes - the clock drifts a second a minute.");
    expect(onAnswer).not.toContain("fm/task-rep0");

    // Closed with its work saved: the kept ref.
    seedTask(tasks, {
      id: "rep2",
      title: "Reproduce the dock bug",
      status: "completed",
      worktreeDir: "/w/rep2",
      branch: "fm/task-rep2",
      outcome: "reproduced: yes",
    });
    tasks.close("rep2", { status: "dropped", reason: "superseded", actor: "firstmate" });
    tasks.placement.markWorkspaceRemoved("rep2");
    tasks.note("rep2", "working copy removed - 1 commit not in yet saved first", {
      news: false,
      data: {
        saved: { ref: "refs/infinitary/kept/rep2", sha: "abc", dirty: false, unlandedCommits: 1 },
      },
    });
    await supervisor.intake.commission({
      title: "Fix the dock",
      intent: intentOf("fix it"),
      shape: { basis: tasks.get("rep2")?.key ?? "rep2" },
    });
    await tick();
    const kept = builder.promptCalls.at(-1) ?? "";
    expect(kept).toContain("its work is saved in the repository at refs/infinitary/kept/rep2");
    expect(kept).not.toContain("Its work is on branch");

    // Neither: no working-copy sentence at all, and a card's thread quoted.
    seedTask(tasks, {
      id: "ans1",
      title: "Why the meter idles",
      status: "completed",
      outcome: "The claim query filters on repo_id.",
    });
    cardStore.upsert({
      id: "card-ans1-1",
      taskId: "ans1",
      author: "crewmate",
      priority: 1,
      title: "The claim query filters on repo_id",
      meta: "",
      body: "<p>The claim query filters on repo_id.</p>",
      actions: [],
      status: "ready",
      createdAt: Date.now(),
    });
    supervisor.cards.addMessage("card-ans1-1", "captain", "and the dock too?");
    supervisor.cards.addMessage("card-ans1-1", "crewmate", "Yes,\n the dock reads the same query.");
    await supervisor.intake.commission({
      title: "Fix the claim query",
      intent: intentOf("fix it"),
      shape: { basis: tasks.get("ans1")?.key ?? "ans1" },
    });
    await tick();
    const threaded = builder.promptCalls.at(-1) ?? "";
    expect(threaded).not.toContain("Its work is on branch");
    expect(threaded).not.toContain("its work is saved");
    expect(threaded).toContain(
      "What was said under its card, newest last:\n- captain: and the dock too?\n- crewmate: Yes,\n the dock reads the same query.",
    );
  });
});
