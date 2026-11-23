/**
 * Classifying and routing a start (`CrewStarts`, docs/task-graph.md): a
 * named basis verified, a rejected attempt escalated one tier up, the
 * classifier's kinds and failures, premium asks nothing can serve, quota
 * reset gates, and background job results delivered to a started crewmate.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { RISK_DIMENSIONS } from "@shared/cards";
import { changePresentationSchema } from "@shared/changePresentation";
import type { WorkShape } from "@shared/routingPolicy";
import { taskHoldWords } from "@shared/taskHold";
import { describe, expect, it, vi } from "vitest";
import {
  catalogLessRouter,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { presentationContentHash } from "../forge/presentation";
import { packagedPlanStepLines } from "../personal/sequencesSkill";
import type { KindInput } from "../routing/kindClassifier";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { taskFeedLine } from "../tasks/taskFeed";
import { TaskProtocol } from "../tasks/taskProtocol";
import { JOB_BOUND_MS } from "./idleLadder";
import { FLEET_STARTED_ANSWER_WORDS, RETRIEVAL_BOUNDARY_WORDS } from "./intentBrief";

fakeCrewTimersEachTest();

describe("the task graph (R1)", () => {
  it("verifies a named basis and records the shape it routed from (S2)", async () => {
    const crewmate = fakeCrewmate();
    const decideCalls: { shape: WorkShape }[] = [];
    const { supervisor, tasks } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-5.5" },
      onRouteDecide: (args) => decideCalls.push(args),
    });
    // A task that really reported: the basis holds.
    seedTask(tasks, {
      id: "spec1",
      title: "Design the dock",
      status: "completed",
      worktreeDir: "/w",
      outcome: "The dock layout is settled: three rails, the stage between them.",
    });
    const spec = tasks.get("spec1");
    const { taskId } = await supervisor.intake.commission({
      title: "Build the dock",
      intent: intentOf("build what the design says"),
      shape: { basis: spec?.key ?? "spec1" },
    });
    await tick();
    expect(decideCalls.at(-1)?.shape).toMatchObject({
      kind: "unclear",
      basis: spec?.key,
      basis_verified: true,
    });
    // The shape is on the record, so the corpus and a later dispatch read
    // the same facts the turn routed from. The basis is stored as named;
    // its verdict is derived at every read and never stored.
    const record = tasks.get(taskId);
    expect(record?.shape).toMatchObject({ basis: spec?.key });
    expect(record?.shape).not.toHaveProperty("basis_verified");
    expect(record && tasks.graph.basisOf(record)).toEqual({ ref: spec?.key, verified: true });
  });

  it("treats an unknown or still-running basis as unverified, never as a cheaper tier (S2)", async () => {
    const crewmate = fakeCrewmate();
    const decideCalls: { shape: WorkShape }[] = [];
    const { supervisor, tasks } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-5.5" },
      onRouteDecide: (args) => decideCalls.push(args),
    });
    seedTask(tasks, { id: "wip1", title: "Still going", status: "running", worktreeDir: "/w" });
    await supervisor.intake.commission({
      title: "Build on nothing",
      intent: intentOf("build it"),
      shape: { basis: "wip1" },
    });
    await tick();
    // Named, recorded, and not believed: a claimed spec never buys a
    // cheaper tier by itself.
    expect(decideCalls.at(-1)?.shape).toMatchObject({ basis: "wip1", basis_verified: false });

    await supervisor.intake.commission({
      title: "Build on a ghost",
      intent: intentOf("build it"),
      shape: { basis: "FM3K-404" },
    });
    await tick();
    expect(decideCalls.at(-1)?.shape).toMatchObject({ basis: "FM3K-404", basis_verified: false });
  });

  // INF-4574 change 2, from INF-4558: the app filed an answer step when its
  // merge card's change merged, and briefed it as a question the captain
  // asked - "lands as one card", with Look deeper as its default.
  it("briefs an answer step the app filed at a merge as the crew's own, with no quick answer card", async () => {
    const crew = fakeCrewmate();
    const { supervisor, tasks } = setup(crew, {
      routedModel: { provider: "openai-codex", id: "gpt-5.5" },
      classifier: {
        classify: async () => ({
          kind: "retrieval" as const,
          source: "classifier:test/lookup",
          version: "kc2-test",
        }),
      },
    });
    const origin = seedTask(tasks, {
      id: "inf44910",
      title: "Run the merge batch check's test groups on the Windows PC",
      status: "idle",
      branch: "inf/batch-tests-on-pc",
    });
    const head = "4f1c0d2b9e8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d";
    const story = changePresentationSchema.parse({
      version: 1,
      taskId: origin.id,
      revision: 1,
      title: "feat(ci): run the batch check's test groups on the Windows PC",
      destination: { kind: "local", project: "infinitary" },
      base: head,
      head,
      why: ["The merge batch check is most of the month's hosted minutes."],
      whatChanged: ["The batch check's eight test groups run on the Windows PC."],
      before: ["Every test group ran on hosted machines."],
      after: ["The test groups run on the Windows PC."],
      views: [],
      noPicture: "This moves where checks run, not a screen.",
      verification: ["Read the placement of the next batch's test groups."],
      risk: Object.fromEntries(
        RISK_DIMENSIONS.map((dimension) => [dimension, { level: "low", why: "Placement only." }]),
      ),
      requiredActions: [],
      afterMerge: [
        {
          title: "Verify batch test placement and savings",
          goal: "The next batch's test groups ran on the Windows PC, and the hosted minutes they saved are known.",
          why: "Only the next batch shows whether the groups are placed there and what they save.",
        },
      ],
      unfinished: [],
      projectText: "",
      assets: [],
      pictures: [],
    });
    tasks.delivery.updateChangePresentation(origin.id, () => ({
      revisions: [story],
      receipts: [],
      completion: { revision: 1, head, contentHash: presentationContentHash(story) },
    }));
    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });
    await supervisor.watch.sweepGates(Date.now());
    await tick();

    const step = tasks.list().find((task) => task.title.startsWith("Continue: "));
    expect(step?.shape).toMatchObject({ internal_step: true, deliverable: "answer" });
    const brief = crew.promptCalls[0] ?? "";
    expect(brief).toContain(FLEET_STARTED_ANSWER_WORDS);
    expect(brief).not.toContain("it lands as one card");
    expect(brief).not.toContain(RETRIEVAL_BOUNDARY_WORDS);
  });

  it("dispatches a queued row from the shape it was commissioned with (S2)", async () => {
    const crewmate = fakeCrewmate();
    const decideCalls: { shape: WorkShape }[] = [];
    const { supervisor, tasks } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
      onRouteDecide: (args) => decideCalls.push(args),
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Later, on Astra",
      intent: intentOf("use gpt-6-astra when the gate clears"),
      shape: { override_model_id: "gpt-6-astra" },
      startAfter: { at: Date.now() - 1000 },
    });
    // Queued: nothing routed yet, but the row remembers what to route from.
    expect(decideCalls).toHaveLength(0);
    expect(tasks.get(taskId)?.shape).toMatchObject({ override_model_id: "gpt-6-astra" });
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    expect(decideCalls.at(-1)?.shape.override_model_id).toBe("gpt-6-astra");
  });

  it("escalates a rejected attempt one tier up as a fresh crewmate (S4)", async () => {
    const crewmate = fakeCrewmate();
    const decideCalls: { shape: WorkShape }[] = [];
    const { supervisor, tasks, workspace } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
      onRouteDecide: (args) => decideCalls.push(args),
    });
    // The failed attempt holds unlanded work: its worktree goes like every
    // closed task's, the work saved first on the kept ref the brief names.
    vi.mocked(workspace.retireTaskWorktree).mockResolvedValue({
      outcome: "removed",
      kept: { ref: "refs/infinitary/kept/attempt1", sha: "abc", dirty: true, unlandedCommits: 2 },
    });
    const previous = seedTask(tasks, {
      id: "attempt1",
      title: "Fix the flaky meter test",
      status: "completed",
      difficulty: "medium",
      worktreeDir: "/w/attempt1",
      branch: "fm/task-attempt1",
      shape: { kind: "fix", kind_source: "classifier:test", basis_verified: false },
      outcome: "I disabled the assertion; the test passes now.",
    });

    const { taskId } = await supervisor.intake.commission({
      title: "Fix the flaky meter test",
      intent: intentOf("that is not a fix, try again with something smarter"),
      shape: { escalate_from: previous.key },
    });
    await tick();

    // R1b: the next rung above the rejected attempt's own tier, with the
    // kind inherited rather than reclassified.
    expect(decideCalls.at(-1)?.shape).toMatchObject({
      kind: "fix",
      escalate_from: previous.key,
      escalation: { from: previous.key, attempt: 1, floor: "high" },
    });
    const fresh = tasks.get(taskId);
    expect(fresh?.shape?.escalation).toMatchObject({ attempt: 1, floor: "high" });

    // Q4 B: a fresh crewmate briefed with the failed attempt's report and
    // its kept branch - never a resume of that session.
    const brief = crewmate.promptCalls[0] ?? "";
    expect(brief).toContain("attempt 1 at the high tier");
    expect(brief).toContain(previous.key);
    expect(brief).toContain("I disabled the assertion");
    expect(brief).toContain("its work is saved in the repository at refs/infinitary/kept/attempt1");
    expect(brief).toContain("that is not a fix, try again with something smarter");

    // O1: closed superseded; the worktree goes, its work ALWAYS saved first
    // (whatever ancestry says) so the ref the brief names exists.
    const closed = tasks.get(previous.id);
    expect(closed).toMatchObject({ status: "dropped", closedReason: "superseded" });
    expect(closed?.workspaceState).toBe("removed");
    expect(workspace.retireTaskWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: previous.id, branch: "fm/task-attempt1" }),
      { keepAlways: true },
    );

    expect(tasks.graph.discoveredOrigins(taskId).map((row) => row.id)).toContain(previous.id);
    const timeline = tasks.timeline(previous.id);
    const escalated = timeline.find((event) => event.kind === "escalated");
    expect(escalated).toMatchObject({ feed: true, data: { escalated_to: fresh?.key } });
    // Exactly one feed line for the whole move: the supersede's own close
    // event is suppressed, so the `escalated` row is the only line the feed
    // gets.
    const superseded = timeline.find(
      (event) => event.kind === "status" && event.data?.reason === "superseded",
    );
    expect(superseded?.feed).toBe(false);
    expect(timeline.filter((event) => event.kind === "escalated")).toHaveLength(1);
    expect(taskFeedLine(closed as TaskRecord, escalated as TaskEvent)?.text).toBe(
      `Moved to a stronger model: Hard; continues as ${fresh?.key}`,
    );
    expect(tasks.timeline(taskId).find((event) => event.kind === "escalated")).toMatchObject({
      feed: false,
      data: { escalated_from: previous.key },
    });
  });

  it.each(["low", "medium"] as const)(
    "stamps a premium click from a %s attempt as premium in its brief, record and feed",
    async (difficulty) => {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks } = setup(crewmate);
      const previous = seedTask(tasks, {
        id: `attempt-${difficulty}`,
        title: "Fix the meter",
        status: "completed",
        difficulty,
        shape: { kind: "fix" },
        outcome: "The meter still fails.",
      });
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter",
        intent: intentOf("Try a premium model"),
        shape: { escalate_from: previous.key, premium_ask: true },
      });
      await tick();
      const fresh = tasks.get(taskId);
      expect(fresh?.shape?.escalation).toMatchObject({ attempt: 1, floor: "premium" });
      expect(crewmate.promptCalls[0]).toContain("attempt 1 at the premium tier");
      const escalated = tasks.timeline(previous.id).find((event) => event.kind === "escalated");
      expect(taskFeedLine(tasks.get(previous.id) as TaskRecord, escalated as TaskEvent)?.text).toBe(
        `Moved to a stronger model: Premium; continues as ${fresh?.key}`,
      );
    },
  );

  it("bounds a lineage at two escalations and refuses a rung above premium (S4)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
    });
    const first = seedTask(tasks, {
      id: "attempt1",
      title: "First go",
      status: "completed",
      outcome: "wrong",
    });
    const spent = seedTask(tasks, {
      id: "attempt3",
      title: "Third go",
      status: "completed",
      difficulty: "high",
      worktreeDir: "/w/attempt3",
      shape: {
        kind: "fix",
        escalate_from: first.key,
        escalation: { from: first.key, attempt: 2, floor: "high" },
      },
      outcome: "still wrong",
    });
    await expect(
      supervisor.intake.commission({
        title: "Fourth go",
        intent: intentOf("still not right"),
        shape: { escalate_from: spent.key },
      }),
    ).rejects.toThrow(/already used its 2 escalations/);

    const top = seedTask(tasks, {
      id: "attemptP",
      title: "Already premium",
      status: "completed",
      difficulty: "premium",
      worktreeDir: "/w/attemptP",
      outcome: "not good enough",
    });
    await expect(
      supervisor.intake.commission({
        title: "Above premium",
        intent: intentOf("do better"),
        shape: { escalate_from: top.key },
      }),
    ).rejects.toThrow(/nothing routes above premium/);
    // Nothing was created and nothing was closed by a refused escalation.
    expect(tasks.get(spent.id)?.status).toBe("active");
    expect(tasks.get(top.id)?.status).toBe("active");
  });

  it("never escalates a task that has not run (Q1: never on first dispatch)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
    });
    const planned = seedTask(tasks, { id: "planned1", title: "Not started", status: "queued" });
    await expect(
      supervisor.intake.commission({
        title: "Escalate a plan",
        intent: intentOf("make it better"),
        shape: { escalate_from: planned.key },
      }),
    ).rejects.toThrow(/has never run/);
    expect(tasks.get(planned.id)?.status).toBe("open");
  });

  it("queues an escalation rather than serving it from the tier that failed (S4)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops, sessions } = setup(crewmate, {
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-5.5-mini" },
        bucket: "high",
        servedBucket: "medium",
        rule: "R1b",
      },
    });
    const previous = seedTask(tasks, {
      id: "attempt9",
      title: "Nine",
      status: "completed",
      difficulty: "medium",
      worktreeDir: "/w/attempt9",
      outcome: "wrong answer",
    });
    const {
      taskId,
      crewmate: name,
      started,
    } = await supervisor.intake.commission({
      title: "Nine again",
      intent: intentOf("no, smarter please"),
      shape: { escalate_from: previous.key },
    });
    await tick();
    // The answer comes before the start (INF-3060), which then waits.
    expect(name).toBe("starting");
    await started;
    expect(sessions.open).not.toHaveBeenCalled();
    expect(tasks.get(taskId)?.gate).toMatchObject({ kind: "quota-reset", ref: "bucket:high" });
    expect(ops.some((line) => line.includes("needs a high model"))).toBe(true);
    // The rejected attempt still stops: the captain rejected it whether or
    // not the stronger model can start right now.
    expect(tasks.get(previous.id)).toMatchObject({
      status: "dropped",
      closedReason: "superseded",
    });
  });

  it("classifies an immediate spawn and routes from what the classifier said (S3)", async () => {
    const crewmate = fakeCrewmate();
    const decideCalls: { shape: WorkShape }[] = [];
    const asked: KindInput[] = [];
    const { supervisor, tasks } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-5.5" },
      onRouteDecide: (args) => decideCalls.push(args),
      classifier: {
        classify: async (input) => {
          asked.push(input);
          return { kind: "chore", source: "classifier:xai/grok-cheap", version: "kc1-abc" };
        },
      },
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Bump the linter",
      intent: intentOf("bump the linter please"),
    });
    await tick();
    // The classifier saw the work's own facts, and the router saw its verdict.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ taskId, title: "Bump the linter", deliverable: "change" });
    expect(decideCalls.at(-1)?.shape).toMatchObject({
      kind: "chore",
      kind_source: "classifier:xai/grok-cheap",
    });
    // The stamp is on the record, so the corpus can score the classification.
    expect(tasks.get(taskId)?.shape).toMatchObject({
      kind: "chore",
      kind_source: "classifier:xai/grok-cheap",
    });
  });

  it.each([false, true])(
    "retrieval with its read-only constraint is an answer, routed low (queued: %s)",
    async (queued) => {
      const crew = fakeCrewmate();
      const classify = vi.fn(async (_input: KindInput) => ({
        kind: "retrieval" as const,
        source: "classifier:test/lookup",
        version: "kc2-test",
      }));
      const routes: { shape: WorkShape }[] = [];
      const { supervisor, tasks } = setup(crew, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        classifier: { classify },
        onRouteDecide: (args) => routes.push(args),
      });
      const { taskId } = await supervisor.intake.commission({
        title: "Read the retry limit",
        intent: {
          ...intentOf("Quote the retry limit from the config"),
          constraints: [{ kind: "read-only" }],
        },
        ...(queued ? { startAfter: { at: Date.now() - 1000 } } : {}),
      });
      if (queued) {
        expect(classify).not.toHaveBeenCalled();
        await supervisor.watch.sweepGates(Date.now());
      }
      await tick();
      expect(classify).toHaveBeenCalledTimes(1);
      // INF-1430 piece 1: the read-only declaration offers the answer branch.
      expect(classify.mock.calls[0]?.[0]).toMatchObject({ deliverable: "answer" });
      expect(routes.at(-1)?.shape).toMatchObject({
        kind: "retrieval",
        kind_source: "classifier:test/lookup",
      });
      expect(tasks.get(taskId)?.shape).toMatchObject({
        kind: "retrieval",
        kind_source: "classifier:test/lookup",
        deliverable: "answer",
      });
      expect(crew.promptCalls[0]).toContain(
        "commit nothing, push nothing, and open no pull request",
      );
      // A quick answer's words (INF-4344): answer first, its closing line
      // with Look deeper, and straight to research when it cannot answer.
      expect(crew.promptCalls[0]).toContain(RETRIEVAL_BOUNDARY_WORDS);
      await supervisor.starts.dispatchQueuedTask(taskId);
      expect(classify).toHaveBeenCalledTimes(1);
    },
  );

  it("never asks when the table decides above the kind, and says why (S3)", async () => {
    const crewmate = fakeCrewmate();
    const decideCalls: { shape: WorkShape }[] = [];
    let calls = 0;
    const { supervisor } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
      onRouteDecide: (args) => decideCalls.push(args),
      classifier: {
        classify: async () => {
          calls += 1;
          return { kind: "chore", source: "classifier:xai/grok-cheap", version: "kc1-abc" };
        },
      },
    });
    await supervisor.intake.commission({
      title: "On Astra",
      intent: intentOf("use gpt-6-astra"),
      shape: { override_model_id: "gpt-6-astra" },
    });
    await tick();
    expect(calls).toBe(0);
    expect(decideCalls.at(-1)?.shape).toMatchObject({
      kind: "unclear",
      kind_source: "skipped:override",
    });
  });

  it("keeps a declared plan kind when a named model skips classification (INF-1177)", async () => {
    const crewmate = fakeCrewmate();
    let calls = 0;
    const { supervisor, tasks } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
      classifier: {
        classify: async () => {
          calls += 1;
          return { kind: "research", source: "classifier:xai/grok-cheap", version: "kc1-abc" };
        },
      },
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Plan safe recovery",
      intent: {
        goal: "Plan a safe recovery.",
        userWords: "Plan safe recovery",
        constraints: [
          { kind: "read-only" },
          { kind: "free", text: packagedPlanStepLines()[0] ?? "plan: missing" },
        ],
      },
      shape: { kind: "plan", override_model_id: "gpt-6-astra" },
    });
    await tick();
    expect(calls).toBe(0);
    expect(tasks.get(taskId)?.shape).toMatchObject({
      kind: "plan",
      kind_source: "firstmate:declared",
      deliverable: "answer",
    });
  });

  it("fails soft: a broken classifier costs quota, never a dispatch (S3)", async () => {
    const crewmate = fakeCrewmate();
    const decideCalls: { shape: WorkShape }[] = [];
    const { supervisor, tasks, sessions } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-5.5" },
      onRouteDecide: (args) => decideCalls.push(args),
      classifier: {
        classify: async () => ({
          kind: "unclear" as const,
          source: "classifier-failed:timeout",
          version: "kc1-abc",
        }),
      },
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Something",
      intent: intentOf("do the thing"),
    });
    await tick();
    expect(decideCalls.at(-1)?.shape).toMatchObject({
      kind: "unclear",
      kind_source: "classifier-failed:timeout",
    });
    // The work still started, on the R8 tier S2 already routed everything to.
    expect(sessions.open).toHaveBeenCalled();
    expect(tasks.get(taskId)?.status).toBe("active");
  });

  it("asks first when the user's premium ask cannot be served (P7 + R1)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards, sessions, ops } = setup(crewmate, {
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-5.5-mini" },
        bucket: "premium",
        servedBucket: "high",
        rule: "R1a",
      },
    });
    // Premium is the one class Firstmate may only relay, never judge, so a
    // downgrade of it is the captain's to answer.
    const {
      taskId,
      crewmate: name,
      started,
    } = await supervisor.intake.commission({
      title: "Deep design",
      intent: intentOf("design it properly"),
      shape: { premium_ask: true },
    });
    // The answer comes before the start (INF-3060), which then waits.
    expect(name).toBe("starting");
    await started;
    expect(sessions.open).not.toHaveBeenCalled();
    // The safe default is already on the record: it waits for the premium
    // reset. The Firstmate hears once, with the two other ways out, and no
    // card is raised (cards/tasks/agents P0, WI-3).
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      difficulty: "premium",
      gate: { kind: "quota-reset", ref: "bucket:premium" },
    });
    await tick();
    expect(cards()).toEqual([]);
    const wake = ops.find((line) => line.includes("needs a premium model"));
    expect(wake).toContain(`[fm-op] task ${taskId} "Deep design"`);
    expect(wake).toContain("waits on the premium quota reset");
    // Facts only (v2.0): what could serve it now, not which tool to call.
    expect(wake).toContain("a high model could serve it now");
    expect(wake).not.toContain("update_task");
    // That wake is the only one: the tile names the reset it waits on, so the
    // start behind the answer adds no second wake (INF-3075's review of INF-3060).
    expect(ops.filter((line) => line.includes(`task ${taskId}`))).toEqual([wake]);
  });

  it("starts a computed high on a lesser model with a feed line, never a card (P7)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards, sessions, events } = setup(crewmate, {
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-5.5-mini" },
        bucket: "high",
        servedBucket: "medium",
        rule: "R8",
      },
    });
    // High is what the table computed, not something the captain asked
    // for: its downgrade is a feed line, as it was under the heuristic.
    const {
      taskId,
      crewmate: name,
      started,
    } = await supervisor.intake.commission({
      title: "Ambiguous design",
      intent: intentOf("work out how the dock should behave"),
    });
    expect(name).toBe("starting");
    await started;
    expect(sessions.open).toHaveBeenCalled();
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(cards().find((card) => card.id === `card-highwait-${taskId}`)).toBeUndefined();
    expect(events.map((event) => ("text" in event ? event.text : "")).join(" ")).toContain(
      "is a hard task on a model for normal tasks",
    );
  });

  it("counts interrupted tasks as active on their repo, so removal refuses", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    seedTask(tasks, {
      id: "int1",
      title: "cut mid-turn",
      prompt: "p",
      repoId: "repo-1",
      repoDir: "/r",
      worktreeDir: "/w",
      branch: "fm/task-int1",
      sessionFile: null,
      accountId: null,
      status: "interrupted",
      createdAt: Date.now(),
    });
    seedTask(tasks, {
      id: "done1",
      title: "finished",
      prompt: "p",
      repoId: "repo-1",
      repoDir: "/r",
      worktreeDir: "/w2",
      branch: "fm/task-done1",
      sessionFile: null,
      accountId: null,
      status: "completed",
      createdAt: Date.now(),
    });
    seedTask(tasks, {
      id: "queued1",
      title: "waiting to start",
      repoId: "repo-1",
      status: "queued",
    });
    seedTask(tasks, {
      id: "landed1",
      title: "closed work",
      repoId: "repo-1",
      status: "cancelled",
    });
    seedTask(tasks, {
      id: "elsewhere1",
      title: "working elsewhere",
      repoId: "repo-2",
      status: "interrupted",
    });
    // Interrupted tasks resume after a restart; their repo is still in use.
    // A finished crewmate is idle and resumable too (WI-11 - no `delivered`),
    // so its repo is in use as well; both count.
    expect(supervisor.facts.activeTasksOnRepo("repo-1")).toEqual([
      { key: expect.any(String), title: "cut mid-turn", status: "working" },
      { key: expect.any(String), title: "finished", status: "working" },
      { key: expect.any(String), title: "waiting to start", status: "planned" },
    ]);
  });

  it("asks first when a premium ask finds nothing serveable at all, and start_now starts it (P7)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards, sessions, ops } = setup(crewmate, {
      routeResult: { bucket: "premium", unserveable: true, rule: "R1a" },
    });
    const {
      taskId,
      crewmate: name,
      started,
    } = await supervisor.intake.commission({
      title: "Deep design",
      intent: intentOf("design it properly"),
      shape: { premium_ask: true },
    });
    // The answer comes before the start (INF-3060), which then waits.
    expect(name).toBe("starting");
    await started;
    expect(sessions.open).not.toHaveBeenCalled();
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      gate: { kind: "quota-reset", ref: "bucket:premium" },
    });
    await tick();
    expect(cards()).toEqual([]);
    const wake = ops.find((line) => line.includes("needs a premium model"));
    expect(wake).toContain("the default model could serve it now");

    expect(await supervisor.starts.startQueuedNow(taskId)).toContain("is starting.");
    await tick();
    expect(sessions.open).toHaveBeenCalled();
    expect(tasks.get(taskId)?.status).toBe("active");
  });

  // A premium ask with no model placed at premium waits for one to be placed
  // there, which no allowance reset brings, and its record says so.
  it("says a premium ask waits for a model placed at premium when none is there", async () => {
    vi.useRealTimers();
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, sessions } = setup(crewmate, {
      realRouter: (db) =>
        catalogLessRouter(db, [{ provider: "openai-codex", id: "gpt-5.5" }], {
          slotsFor: () => ["high"],
        }),
    });
    const { taskId, started } = await supervisor.intake.commission({
      title: "Deep design",
      intent: intentOf("design it properly"),
      shape: { premium_ask: true },
    });
    await started;
    expect(sessions.open).not.toHaveBeenCalled();
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      gate: { kind: "quota-reset", ref: "bucket:premium", cause: "empty" },
    });
    expect(tasks.timeline(taskId).map((event) => event.text)).toContain(
      "held: no model is placed at premium",
    );
    const record = new TaskProtocol({
      tasks,
      repos: { get: () => undefined },
      cards: { listOpen: () => [], snapshot: () => [] },
      broadcastEvent: () => {},
      emit: () => {},
    }).detail(taskId);
    expect(record.hold).toEqual(taskHoldWords({ kind: "premium", cause: "empty" }));
    expect(record.hold?.text).toContain("you have no premium models");
    expect(
      [record.hold?.title, record.hold?.text, record.queueWait?.line]
        .concat(record.waits?.map((wait) => wait.label))
        .join(" "),
    ).not.toContain("allowance");
  });

  it("re-asks instead of silently downgrading when a queued premium ask dispatches (P7 + R1)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards, sessions, ops } = setup(crewmate, {
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-5.5-mini" },
        bucket: "premium",
        servedBucket: "high",
        rule: "R1a",
      },
      // Reproduce a stale quota reading that keeps declaring the replacement
      // gate clear on each watchdog sweep.
      quotaGateCleared: () => true,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Later big one",
      intent: intentOf("the big refactor"),
      shape: { premium_ask: true },
      startAfter: { at: Date.now() - 1000 },
    });
    await supervisor.watch.sweepGates(Date.now());
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    // The gate cleared but the ask still cannot be served: the row waits on
    // the premium reset instead, the Firstmate hears, nothing started. A
    // repeated sweep updates nothing rather than stacking the same status.
    expect(sessions.open).not.toHaveBeenCalled();
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      gate: { kind: "quota-reset", ref: "bucket:premium" },
    });
    expect(
      tasks
        .timeline(taskId)
        .filter((event) => event.text === "held: no premium model has allowance"),
    ).toHaveLength(1);
    expect(cards()).toEqual([]);
    expect(ops.filter((line) => line.includes("needs a premium model"))).toHaveLength(1);

    expect(await supervisor.starts.startQueuedNow(taskId)).toContain("is starting.");
    await tick();
    expect(sessions.open).toHaveBeenCalled();
  });

  it("refuses a quota-reset gate on a scope that can never clear (R1)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate, {
      quotaGateRefValid: (ref) => ref === "codex" || ref === "bucket:high",
    });
    await expect(
      supervisor.intake.commission({
        title: "x",
        intent: intentOf("y"),
        startAfter: { whenQuotaResets: "bucket:huge" },
      }),
    ).rejects.toThrow(/Unknown quota scope/);
    await expect(
      supervisor.intake.commission({
        title: "x",
        intent: intentOf("y"),
        startAfter: { whenQuotaResets: "grok-quota" },
      }),
    ).rejects.toThrow(/Unknown quota scope/);
    const { taskId } = await supervisor.intake.commission({
      title: "x",
      intent: intentOf("y"),
      startAfter: { whenQuotaResets: "bucket:high" },
    });
    expect(tasks.get(taskId)?.gate).toMatchObject({ kind: "quota-reset", ref: "bucket:high" });
  });

  it("clears a quota-reset gate through the injected evaluator", async () => {
    const crewmate = fakeCrewmate();
    let headroom = false;
    const { supervisor, tasks } = setup(crewmate, {
      quotaGateCleared: () => headroom,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Big one",
      intent: intentOf("the big refactor"),
      startAfter: { whenQuotaResets: "codex" },
    });
    await supervisor.watch.sweepGates(Date.now());
    expect(legacyStateOf(tasks.get(taskId))).toBe("queued");
    headroom = true;
    await supervisor.watch.sweepGates(Date.now());
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("running");
  });
});

describe("background job results (R2)", () => {
  it("counts evidenced work across idle turns without changing the turn activity or job bound", async () => {
    let running = true;
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, inbox } = setup(crewmate, {
      hasRunningJobs: () => running,
      oldestRunningJob: () => ({ jobId: "j", command: "build", startedAt: 0 }),
      now: () => JOB_BOUND_MS + 1,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Build",
      intent: intentOf("build"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    // The job running at that end earns its one check-back ask (INF-1244).
    crewmate.finishPrompt();
    await tick();
    const record = tasks.get(taskId);
    if (!record) throw new Error("missing task");
    expect(record.activity).toBe("idle");
    expect(supervisor.postures.workPosture(record)).toEqual({ state: "active", reason: "job" });
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 1, idle: 0 });
    running = false;
    tasks.placement.setGate(taskId, { kind: "captain" });
    expect(supervisor.postures.workPosture(tasks.get(taskId) ?? record)).toEqual({
      state: "idle",
      reason: "captain",
    });
    const row = inbox.enqueue(taskId, "Reply already captured");
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 1, idle: 0 });
    inbox.ack([row]);
    tasks.placement.setGate(taskId, null);
    crewmate.emit({ type: "background_work_changed", count: 1 });
    expect(supervisor.postures.workPosture(tasks.get(taskId) ?? record)).toEqual({
      state: "active",
      reason: "job",
    });
    crewmate.emit({ type: "background_work_changed", count: 0 });
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 0, idle: 1 });
    expect(tasks.get(taskId)?.activity).toBe("idle");
  });

  // INF-683: the captain saw keystrokes lag in the message box while crewmates
  // started and were messaged. Each crew event re-reads every live row's
  // posture, and recompiling those reads each time stalled the main process.
  it("re-reads an idle crewmate's posture without compiling its reads again", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, db } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Inspect",
      intent: intentOf("inspect the code and report findings"),
    });
    await tick();
    crewmate.emit({ type: "turn_end", taskId, usage: { input: 10, output: 2 } });
    crewmate.finishPrompt();
    await tick();
    const record = tasks.get(taskId);
    if (!record) throw new Error("missing task");
    const first = supervisor.postures.workPosture(record);
    expect(first.state).not.toBe("active");
    const compile = vi.spyOn(db, "prepare");
    try {
      expect(supervisor.postures.workPosture(record)).toEqual(first);
      expect(compile.mock.calls.map(([sql]) => sql)).toEqual([]);
    } finally {
      compile.mockRestore();
    }
  });

  // INF-405: a Claude client that ends while Infinitary runs on takes the
  // background tasks it still ran with it, and the crewmate must never wait
  // on them.
  it("tells the crewmate once, as its next turn, of each background task its Claude client still ran when the client ended (INF-405)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate);
    await supervisor.intake.commission({ title: "Suite", intent: intentOf("run the suite") });
    await tick();
    crewmate.finishPrompt();
    await tick();
    const suite = { id: "bybac1mss", description: "Run the long suite" };
    crewmate.emit({
      type: "background_work_changed",
      count: 2,
      tasks: [suite, { id: "b7rk2q0zt", description: "Lint the project" }],
    });
    // The lint finished: the client told its own model.
    crewmate.emit({ type: "background_work_changed", count: 1, tasks: [suite] });
    crewmate.emit({ type: "background_work_changed", count: undefined });
    await tick();
    expect(crewmate.promptCalls.slice(1)).toEqual([
      expect.stringContaining(
        '[job] background job bybac1mss did not finish: "Run the long suite" was stopped after',
      ),
    ]);
    // The next client's attach says it runs none yet: nothing is told again.
    crewmate.finishPrompt();
    await tick();
    crewmate.emit({ type: "background_work_changed", count: undefined });
    await tick();
    expect(crewmate.promptCalls).toHaveLength(2);
  });

  it("delivers a job result as the idle crewmate's next turn", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Build",
      intent: intentOf("start the build"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();

    supervisor.watch.deliverJobResult(taskId, '[job] background job j1 finished: "make" exited 0');
    await tick();
    expect(crewmate.promptCalls.at(-1)).toContain("exited 0");
  });

  it("queues a job result behind a streaming turn instead of interrupting it", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Busy",
      intent: intentOf("long turn"),
    });
    await tick();

    supervisor.watch.deliverJobResult(taskId, "[job] finished early");
    expect(crewmate.promptCalls).toHaveLength(1);
    expect(crewmate.promptCalls[0]).toContain("long turn");
    crewmate.finishPrompt();
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe("[job] finished early");
  });

  it("turns a job that outlived its task into one feed line, never a wake (WI-2)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops, events, inbox } = setup(crewmate);
    supervisor.watch.deliverJobResult("gone-task", "[job] result of a ghost");
    expect(ops).toHaveLength(0);
    expect(inbox.recipientsWithRows()).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "firstmate_note",
      text: "A background job finished after task gone-task ended; its output was set aside.",
      taskId: "gone-task",
    });
  });

  it("counts a running job as watchdog liveness", async () => {
    const crewmate = fakeCrewmate();
    let jobRunning = true;
    const { supervisor, cards, events, ops } = setup(crewmate, {
      hasRunningJobs: () => jobRunning,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Building",
      intent: intentOf("long build"),
    });
    await tick();
    supervisor.watch.checkQuietTasks(Date.now() + 21 * 60_000);
    await tick();
    expect(events.filter((e) => e.type === "firstmate_note")).toHaveLength(0);
    expect(ops.some((line) => line.includes("may be stuck"))).toBe(false);
    jobRunning = false;
    supervisor.watch.checkQuietTasks(Date.now() + 22 * 60_000);
    await tick();
    expect(ops.filter((line) => line.includes("may be stuck"))).toHaveLength(1);
    expect(ops.at(-1)).toContain(`on task ${taskId} "Building"`);
    expect(cards()).toEqual([]);
  });

  it("kills a task's jobs when the task is cancelled or deleted", async () => {
    const crewmate = fakeCrewmate();
    const killed: string[] = [];
    const { supervisor } = setup(crewmate, { killJobs: (taskId) => killed.push(taskId) });
    const { taskId } = await supervisor.intake.commission({
      title: "Doomed",
      intent: intentOf("work"),
    });
    await tick();
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    crewmate.failPrompt("aborted");
    await tick();
    expect(killed).toContain(taskId);
  });
});
