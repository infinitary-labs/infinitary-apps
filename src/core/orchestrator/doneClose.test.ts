/**
 * The one close as done (INF-3169's plan, piece 2; docs/task-record.md,
 * "One close as done"). The captain chose the delivery proof as the hold
 * their words pass: "One hold your words pass: its crewmate has not
 * reported, or its own pull request is still open, or its commits are not
 * merged and the close names nowhere else the work went", and for the
 * task's own pull request: "Leave it open where the project lives, and say
 * so on the record".
 */
import { deliveryFactsOf } from "@shared/deliveryFacts";
import { describe, expect, it } from "vitest";
import {
  HEAD,
  PR,
  type SettleWorld,
  settleWorld,
  TASK,
} from "../../../tests/helpers/settleHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { ForgePull } from "../forge";
import { seedTask } from "../tasks/seedTask";

const EVIDENCE = "The meter reads on time on the bench.";
const WORDS = "Close the meter task, the pull request can stay.";

/** The facts the close recorded on its close event. */
function recorded(world: SettleWorld) {
  const close = world.tasks.timeline(TASK).find((event) => event.data?.deliveryFacts);
  return { data: close?.data ?? undefined, facts: deliveryFactsOf(close?.data ?? undefined) };
}

/** A reproduce step the first mate declared (`internal_step`), its answer reported. */
const STEP = "meter-step";
function answerStep(world: SettleWorld, status: "idle" | "queued" = "idle"): void {
  world.live.deliverable = "answer";
  seedTask(world.tasks, {
    id: STEP,
    title: "Reproduce the slow meter",
    status,
    repoId: "project",
    repoDir: "/not-mounted/project",
    ...(status === "idle"
      ? { worktreeDir: "/not-mounted/step", branch: "fm/task-step", outcome: "It reproduces." }
      : {}),
    shape: { kind: "research", deliverable: "answer", internal_step: true },
  });
}

function merged(number: number): ForgePull {
  return {
    number,
    state: "closed",
    merged: true,
    mergedSha: "b".repeat(40),
    headSha: "c".repeat(40),
    base: "main",
    readiness: "clean",
  };
}

describe("the task's own pull request", () => {
  it("holds the first mate's own close while it reads open, and the captain's words leave it open and say so", async () => {
    const world = settleWorld();
    const held = await world.done.close(TASK, { why: "finished", evidence: EVIDENCE });
    expect(held).toMatchObject({ ok: false });
    expect(held.text).toContain(`its own pull request #${PR} is still open`);
    expect(held.text).toContain("Soft hold proof");
    expect(world.tasks.get(TASK)?.status).toBe("active");

    const closed = await world.done.close(TASK, {
      why: "finished",
      evidence: EVIDENCE,
      captainWords: WORDS,
    });
    expect(closed).toMatchObject({ ok: true });
    expect(closed.text).toContain("as finished on the captain's word");
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "finished" });
    // Left open where the project lives: the close sends nothing to it.
    expect(world.log).not.toContain("close pull request: active/none");
    const { data, facts } = recorded(world);
    expect(data).toMatchObject({ captainWords: WORDS, onWord: true, why: "finished" });
    expect(facts).toContainEqual({
      kind: "pull-request",
      basis: "checked",
      text: `Its own pull request #${PR} is still open`,
    });
  });

  it("closes over one it cannot read, recording it unread", async () => {
    const world = settleWorld();
    world.live.pull = undefined;
    const closed = await world.done.close(TASK, { why: "finished", evidence: EVIDENCE });
    expect(closed).toMatchObject({ ok: true });
    expect(recorded(world).facts).toContainEqual({
      kind: "pull-request",
      basis: "unread",
      text: `Its own pull request #${PR} could not be read`,
    });
  });
});

describe("the captain's words pass every soft hold", () => {
  it.each([
    {
      hold: "decisions",
      arrange: (world: SettleWorld) =>
        world.cards.put({
          id: "card-meter-question",
          taskId: TASK,
          author: "crewmate",
          priority: 1,
          title: "Which meter reads first?",
          meta: TASK,
          body: "<p>Which meter reads first?</p>",
          actions: [
            { id: "left", label: "The left one", default: true },
            { id: "right", label: "The right one" },
          ],
          status: "ready",
          createdAt: 1_000,
        }),
    },
    {
      hold: "parts",
      arrange: (world: SettleWorld) =>
        seedTask(world.tasks, {
          id: "meter-part",
          title: "Label the meter",
          parentId: TASK,
          status: "queued",
        }),
    },
    {
      hold: "waits",
      arrange: (world: SettleWorld) => {
        seedTask(world.tasks, { id: "meter-check", title: "Check the meter", status: "idle" });
        world.tasks.graph.link("meter-check", TASK, "blocks", "firstmate", true);
      },
    },
    {
      hold: "proof",
      // Its crewmate has not reported.
      arrange: (world: SettleWorld) =>
        world.db.prepare("UPDATE tasks SET outcome = NULL WHERE id = ?").run(TASK),
    },
  ])("$hold", async ({ hold, arrange }) => {
    const world = settleWorld();
    world.live.pull = merged(PR);
    arrange(world);
    const held = await world.done.close(TASK, { why: "finished", evidence: EVIDENCE });
    expect(held).toMatchObject({ ok: false });
    expect(held.text).toContain(`Soft hold ${hold}`);
    expect(world.tasks.get(TASK)?.status).toBe("active");

    const closed = await world.done.close(TASK, {
      why: "finished",
      evidence: EVIDENCE,
      captainWords: WORDS,
    });
    expect(closed).toMatchObject({ ok: true });
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "finished" });
  });

  it("records an answer the captain's words closed with no report as reported none", async () => {
    // Review finding: the close's text and data must agree with its fact.
    const world = settleWorld();
    world.live.pull = merged(PR);
    world.db.prepare("UPDATE tasks SET outcome = NULL WHERE id = ?").run(TASK);
    const closed = await world.done.close(TASK, { why: "answered", captainWords: WORDS });
    expect(closed).toMatchObject({ ok: true });
    const close = world.tasks
      .timeline(TASK)
      .find((event) => event.data?.deliveryFacts && event.text?.startsWith("answered"));
    expect(close?.text).toBe("answered - its crewmate reported no answer");
    expect(close?.data).toMatchObject({ reported: false });
    expect(recorded(world).facts).toContainEqual(
      expect.objectContaining({ kind: "answer", text: "Its crewmate reported no answer" }),
    );
  });

  it("honours a recorded override on the parts hold, keeping the part planned", async () => {
    const world = settleWorld();
    world.live.pull = merged(PR);
    seedTask(world.tasks, {
      id: "meter-part",
      title: "Label the meter",
      parentId: TASK,
      status: "queued",
    });
    seedDelivery(world.tasks, TASK, {
      override: { words: WORDS, holds: ["parts"], until: "task", at: 1_000 },
    });
    const closed = await world.done.close(TASK, { why: "finished", evidence: EVIDENCE });
    expect(closed).toMatchObject({ ok: true });
    expect(world.tasks.get("meter-part")?.status).toBe("open");
    expect(recorded(world).facts.map((fact) => fact.kind)).toContain("parts");
  });
});

describe("why the work is done", () => {
  it("merged names any merged pull request in its project, and holds one that does not read merged", async () => {
    const world = settleWorld();
    seedDelivery(world.tasks, TASK, { prNumber: undefined, headSha: undefined });
    world.live.pull = { ...merged(65), state: "open", merged: false };
    const held = await world.done.close(TASK, {
      why: "merged",
      deliveredIn: "#65",
      evidence: EVIDENCE,
    });
    expect(held.text).toContain("does not read merged");
    expect(world.tasks.get(TASK)?.status).toBe("active");

    world.live.pull = merged(65);
    const closed = await world.done.close(TASK, { why: "merged", deliveredIn: "#65" });
    expect(closed).toMatchObject({ ok: true });
    expect(closed.text).toContain("Merged in pull request #65");
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "merged" });
    expect(recorded(world).facts).toContainEqual(
      expect.objectContaining({ kind: "pull-request", basis: "checked" }),
    );
  });

  it("merged names a commit on the main branch, and holds one that is not on it", async () => {
    // Proof read finding: a commit on main, not only a pull request, is where the work went.
    const world = settleWorld();
    const commit = "d".repeat(40);
    // Its own pull request closed unmerged; its commits went in another way.
    world.live.pull = { ...merged(PR), merged: false, headSha: HEAD };
    world.live.work = { dirty: false, unlandedCommits: 2 };
    world.live.onMain = false;
    const held = await world.done.close(TASK, { why: "merged", deliveredIn: commit });
    expect(held).toMatchObject({ ok: false });
    expect(held.text).toContain("does not read merged");
    expect(world.tasks.get(TASK)?.status).toBe("active");

    world.live.onMain = true;
    const closed = await world.done.close(TASK, { why: "merged", deliveredIn: commit });
    expect(closed).toMatchObject({ ok: true });
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "merged" });
    expect(recorded(world).facts).toContainEqual(
      expect.objectContaining({ kind: "commit", basis: "checked" }),
    );
  });

  it("refuses what no words change: missing evidence, a missing carrier and an unreadable name", async () => {
    const world = settleWorld();
    for (const [input, refusal] of [
      [{ why: "released" as const }, "released needs evidence"],
      [{ why: "finished" as const }, "finished needs evidence"],
      [{ why: "carried_on" as const }, "carried_on needs carried_by"],
    ] as const) {
      const answer = await world.done.close(TASK, { ...input, captainWords: WORDS });
      expect(answer).toMatchObject({ ok: false });
      expect(answer.text).toContain(refusal);
    }
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });

  it("carried_on by a part of its own closes it, keeps the part planned and closes its own pull request", async () => {
    const world = settleWorld();
    seedTask(world.tasks, {
      id: "meter-part",
      title: "Label the meter",
      parentId: TASK,
      status: "queued",
    });
    const closed = await world.done.close(TASK, { why: "carried_on", carriedBy: "meter-part" });
    expect(closed).toMatchObject({ ok: true });
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "superseded" });
    expect(world.tasks.get("meter-part")?.status).toBe("open");
    expect(world.tasks.graph.replacementOf(TASK)).toBe(world.tasks.get("meter-part")?.key);
    expect(world.log).toContain("close pull request: active/none");
    expect(recorded(world).facts).toContainEqual(
      expect.objectContaining({
        kind: "pull-request",
        text: `Its own pull request #${PR} was open`,
      }),
    );
  });

  it("carried_on by a part of its own still holds for an open sibling part, wherever the carrier sits under it", async () => {
    // Review finding on the plan's own part rule: the carrier holds nothing,
    // and every other open part still holds the first mate's own close.
    const world = settleWorld();
    seedTask(world.tasks, {
      id: "meter-group",
      title: "Meter parts",
      parentId: TASK,
      status: "queued",
    });
    seedTask(world.tasks, {
      id: "meter-part",
      title: "Label the meter",
      parentId: "meter-group",
      status: "queued",
    });
    seedTask(world.tasks, {
      id: "meter-box",
      title: "Box the meter",
      parentId: TASK,
      status: "queued",
    });
    const held = await world.done.close(TASK, { why: "carried_on", carriedBy: "meter-part" });
    expect(held).toMatchObject({ ok: false });
    expect(held.text).toContain("Box the meter");
    expect(held.text).not.toContain("Meter parts");
    expect(held.text).toContain("Soft hold parts");
    expect(world.tasks.get(TASK)?.status).toBe("active");

    world.tasks.dropWithChildren("meter-box", { reason: "superseded", actor: "captain" });
    const closed = await world.done.close(TASK, { why: "carried_on", carriedBy: "meter-part" });
    expect(closed).toMatchObject({ ok: true });
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "superseded" });
  });

  it("holds unmerged work the close names nowhere else, and closes it once a release names where it went", async () => {
    const world = settleWorld();
    // Its own pull request closed without merging, so the work went nowhere yet.
    world.live.pull = { ...merged(PR), merged: false, headSha: HEAD };
    world.live.work = { dirty: true, unlandedCommits: 2 };
    const held = await world.done.close(TASK, { why: "finished", evidence: EVIDENCE });
    expect(held.text).toContain("the close names nowhere else it went");
    const closed = await world.done.close(TASK, { why: "released", evidence: "Version 1.2.3" });
    expect(closed).toMatchObject({ ok: true });
    expect(recorded(world).facts).toContainEqual({
      kind: "work",
      basis: "checked",
      text: "2 commits not on the main branch and uncommitted edits, saved",
    });
  });

  // The captain on the review finding: "Yes: the task built on it counts as
  // where the work went" - a step that wrote its failing check closes answered.
  it.each([
    {
      to: "builds on it",
      arrange: (world: SettleWorld) =>
        seedTask(world.tasks, {
          id: "meter-fix",
          title: "Fix the meter",
          status: "queued",
          shape: { kind: "fix", basis: world.tasks.get(STEP)?.key ?? STEP },
        }),
    },
    {
      to: "waits on it",
      arrange: (world: SettleWorld) => {
        seedTask(world.tasks, { id: "meter-fix", title: "Fix the meter", status: "queued" });
        world.tasks.graph.link(STEP, "meter-fix", "blocks", "firstmate");
      },
    },
  ])(
    "closes an answer step whose working copy holds work when a live task $to, saving the copy",
    async ({ arrange }) => {
      const world = settleWorld();
      answerStep(world);
      // The step's copy holds the failing check it wrote.
      world.live.work = { dirty: true, unlandedCommits: 1 };
      const held = await world.done.close(STEP, { why: "answered" });
      expect(held.text).toContain("the close names nowhere else it went");

      arrange(world);
      const closed = await world.done.close(STEP, { why: "answered" });
      expect(closed).toMatchObject({ ok: true });
      expect(world.tasks.get(STEP)).toMatchObject({ status: "done", closedReason: "answered" });
      const close = world.tasks.timeline(STEP).find((event) => event.data?.deliveryFacts);
      expect(deliveryFactsOf(close?.data ?? undefined)).toContainEqual({
        kind: "work",
        basis: "checked",
        text: "1 commit not on the main branch and uncommitted edits, saved",
      });
    },
  );

  // Re-review finding: the ruling covers a started answer step only, never
  // an unstarted task or a change task that a live task waits on.
  it.each([
    {
      task: "an unstarted task",
      arrange: (world: SettleWorld) => {
        answerStep(world, "queued");
        return {
          id: STEP,
          words: "it has not started, and the close names nowhere else its work went",
        };
      },
    },
    {
      task: "a change task with unmerged commits and no open pull request",
      arrange: (world: SettleWorld) => {
        // Its own pull request closed unmerged, so it holds none open.
        world.live.pull = { ...merged(PR), merged: false, headSha: HEAD };
        world.live.work = { dirty: false, unlandedCommits: 2 };
        return {
          id: TASK,
          words:
            "its working copy holds work that is not merged, and the close names nowhere else it went",
        };
      },
    },
  ])("holds an answered close alone of $task a live task waits on", async ({ arrange }) => {
    const world = settleWorld();
    const { id, words } = arrange(world);
    seedTask(world.tasks, { id: "meter-fix", title: "Fix the meter", status: "queued" });
    world.tasks.graph.link(id, "meter-fix", "blocks", "firstmate");
    const held = await world.done.close(id, { why: "answered" });
    expect(held).toMatchObject({ ok: false });
    expect(held.text).toContain(words);
    expect(held.text).toContain("Soft hold proof");
    expect(world.tasks.get(id)?.status).not.toBe("done");
  });
});

describe("guidance its crewmate never took", () => {
  it("INF-3307 audit: a steer set aside after three refusals no longer holds the first mate's close", async () => {
    const world = settleWorld();
    world.live.pull = merged(PR);
    const id = world.inbox.enqueue(TASK, "Re-run the meter bench with the new clock.");
    // Three refused deliveries spend the ladder, and the crew watch sets it aside.
    for (let attempt = 0; attempt < 3; attempt++) {
      world.inbox.markDelivered([id]);
      world.inbox.release([id]);
    }
    world.inbox.markEscalated(id);
    const closed = await world.done.close(TASK, { why: "finished", evidence: EVIDENCE });
    expect(closed.text).not.toContain("guidance is still queued");
    expect(closed).toMatchObject({ ok: true });
    expect(world.tasks.get(TASK)).toMatchObject({ status: "done", closedReason: "finished" });
  });

  it("INF-3307 audit: guidance still waiting to be delivered holds the close", async () => {
    const world = settleWorld();
    world.live.pull = merged(PR);
    world.inbox.enqueue(TASK, "Re-run the meter bench with the new clock.");
    const held = await world.done.close(TASK, { why: "finished", evidence: EVIDENCE });
    expect(held).toMatchObject({ ok: false });
    expect(held.text).toContain("guidance is still queued for its crewmate");
    expect(world.tasks.get(TASK)?.status).toBe("active");
  });
});
