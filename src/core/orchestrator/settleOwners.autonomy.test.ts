/**
 * Task-level autonomy and the host's merge hold (contract v3.9) as the settle
 * owners hold it: an answer task's deliverable before the hold, what a task
 * inherits and stamps, the first mate's refused merge and the captain's own
 * click, and merge approvals standing side by side under autonomy.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The kept merge fixture (tests/helpers/crewHarnessGit.ts) is a real project
 * folder.
 */

import type { Card } from "@shared/cards";
import type { MergeReview } from "@shared/mergeReview";
import { describe, expect, it, vi } from "vitest";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  SETTLE_MERGE,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import {
  APPROVED,
  approved,
  editPolicies,
  gitRepo,
  REPAIRED,
} from "../../../tests/helpers/crewHarnessGit";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { ForgeChange, ForgePull } from "../forge";
import { seedTask } from "../tasks/seedTask";
import type { TaskService } from "../tasks/taskService";
import type { CrewmateSpec } from "./crewSession";
import type { CrewSupervisor } from "./crewSupervisor";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("task-level autonomy and the host's merge hold (contract v3.9)", () => {
  async function onRepo(
    autonomy: boolean,
    shape?: { autonomy_ask?: boolean },
  ): Promise<{
    dispose: () => void;
    taskId: string;
    supervisor: CrewSupervisor;
    tasks: TaskService;
    specs: CrewmateSpec[];
    cards: () => Card[];
    mergePullRequest: ReturnType<typeof vi.fn>;
  }> {
    const repo = gitRepo("meterlab");
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Change #7 is in on GitHub." }));
    const { supervisor, tasks, repos, specs, cards } = setup(crewmate, { mergePullRequest });
    const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
    repos.configure(view.id, { delivery: "direct-pr", autonomy });
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("fix the meter"),
      repoId: view.id,
      ...(shape ? { shape } : {}),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    return { dispose: repo.dispose, taskId, supervisor, tasks, specs, cards, mergePullRequest };
  }

  function completionCard(specs: CrewmateSpec[]): void {
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "The meter test is steady",
      body: completionBody(
        "<p>The meter test passes ten runs in a row.</p>" +
          "<ul><li>Reran the suite ten times on the final commit.</li></ul>",
      ),
      actions: [{ id: "ship", label: "Ship it", default: true, effect: SETTLE_MERGE }],
    });
  }

  /**
   * The two host holds on the same two settle modes (v3.8's answer task and
   * v3.9's autonomy) compose in one order: the DELIVERABLE speaks first,
   * because a task that commits nothing has no merge for autonomy to be
   * about. So an answer task on an ask-first repository is refused for what
   * it delivers, never for who may merge it, and carries no autonomy at all.
   */
  it("lets the deliverable speak before the autonomy hold, and stamps no autonomy on an answer task", async () => {
    const repo = gitRepo("meterlab");
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Change #7 is in on GitHub." }));
    const { supervisor, tasks, repos } = setup(crewmate, {
      mergePullRequest,
      classifier: {
        classify: async () =>
          ({ kind: "research", source: "classifier:xai/grok-cheap", version: "kc1" }) as const,
      },
    });
    try {
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      // Ask-first, so the autonomy hold WOULD fire on a change here.
      repos.configure(view.id, { delivery: "direct-pr", autonomy: false });
      const { taskId } = await supervisor.intake.commission({
        title: "Why is the meter idle",
        intent: { ...intentOf("why is nothing running?"), constraints: [{ kind: "read-only" }] },
        repoId: view.id,
      });
      await tick();
      crewmate.finishPrompt();
      await tick();
      expect(tasks.get(taskId)?.shape).toMatchObject({ deliverable: "answer" });
      // No autonomy is stamped, and crew_status carries none: there is no
      // merge, so there is nobody to say who merges it.
      expect(tasks.get(taskId)?.shape?.autonomy).toBeUndefined();
      expect(
        supervisor.facts.crewStatus().find((row) => row.taskId === taskId)?.autonomy,
      ).toBeUndefined();
      const result = await supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr");
      expect(result.text).toContain("delivers an answer, not a change");
      expect(result.refusal?.refused).not.toBe("autonomy-off");
      expect(mergePullRequest).not.toHaveBeenCalled();
    } finally {
      repo.dispose();
    }
  });

  it("inherits the repository and stamps what it was commissioned under without showing autonomy on the card", async () => {
    const h = await onRepo(false);
    try {
      expect(h.supervisor.facts.taskAutonomy(h.taskId)).toBe(false);
      expect(h.tasks.get(h.taskId)?.shape).toMatchObject({ autonomy: false });
      expect(h.supervisor.facts.crewStatus(h.taskId)[0]?.autonomy).toBe(false);
      completionCard(h.specs);
      await tick();
      const card = h.cards().find((entry) => entry.taskId === h.taskId);
      expect(card?.body).not.toContain(">On its own<");
      // Default care is not written on the card (INF-3709's plan): only a
      // rigor level that is not Default shows in the strip's reference.
      expect(card?.body).not.toContain('data-fact="care"');
    } finally {
      h.dispose();
    }
  });

  it("refuses the Firstmate's own merge, merges nothing, and points at the captain's button", async () => {
    const h = await onRepo(false);
    try {
      completionCard(h.specs);
      await tick();
      const card = h.cards().find((entry) => entry.taskId === h.taskId);
      const merge = card?.actions.find((action) => action.effect?.kind === "merge");
      // The host attached the pair from the posture; the crewmate's own
      // invented label never reaches the captain, so the way names the
      // button he is actually reading.
      expect([merge?.id, merge?.label]).toEqual(["merge", "Merge the pull request"]);
      const result = await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
      expect(result.refusal).toMatchObject({
        refused: "autonomy-off",
        task: { id: h.taskId },
        ways: [{ label: merge?.label, card: { id: card?.id, action: merge?.id } }],
      });
      expect(result.text).toContain("is not yours to do: autonomy is off for this task");
      expect(result.text).toContain("meterlab asks before merging");
      expect(h.mergePullRequest).not.toHaveBeenCalled();
      expect(h.tasks.get(h.taskId)).toMatchObject({ status: "active", closedReason: null });
      expect(h.cards().some((entry) => entry.id === card?.id)).toBe(true);
      // A land is held the same way: the hold is on merging, not on GitHub.
      expect(
        (await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "land")).refusal?.refused,
      ).toBe("autonomy-off");
    } finally {
      h.dispose();
    }
  });

  it("merges on the captain's own click, on the very task it held", async () => {
    const held = await onRepo(false);
    try {
      // The same autonomy-off task the Firstmate was just refused on. The
      // card's settle effect arrives as actor captain, which this rule does
      // not read: his click IS the way out the refusal named.
      expect(
        (await held.supervisor.settling.settle.settleTaskDetailed(held.taskId, "merge-pr")).refusal
          ?.refused,
      ).toBe("autonomy-off");
      expect(held.mergePullRequest).not.toHaveBeenCalled();
      expect(
        await held.supervisor.settling.settle.settleTask(
          held.taskId,
          "merge-pr",
          undefined,
          "captain",
        ),
      ).toBe("Change #7 is in on GitHub.");
      expect(held.mergePullRequest).toHaveBeenCalledTimes(1);
      expect(held.tasks.get(held.taskId)).toMatchObject({ status: "done" });
    } finally {
      held.dispose();
    }
  });

  it("lets one task merge itself on an ask-first repository, and holds one on an autonomous one", async () => {
    const asked = await onRepo(false, { autonomy_ask: true });
    try {
      expect(asked.supervisor.facts.taskAutonomy(asked.taskId)).toBe(true);
      expect(asked.tasks.get(asked.taskId)?.shape).toMatchObject({
        autonomy_ask: true,
        autonomy: true,
      });
      expect(await asked.supervisor.settling.settle.settleTask(asked.taskId, "merge-pr")).toBe(
        "Change #7 is in on GitHub.",
      );
      expect(asked.mergePullRequest).toHaveBeenCalledTimes(1);
    } finally {
      asked.dispose();
    }

    const held = await onRepo(true, { autonomy_ask: false });
    try {
      expect(held.supervisor.facts.taskAutonomy(held.taskId)).toBe(false);
      expect(
        (await held.supervisor.settling.settle.settleTaskDetailed(held.taskId, "merge-pr")).refusal,
      ).toMatchObject({ refused: "autonomy-off", ways: [] });
      expect(held.mergePullRequest).not.toHaveBeenCalled();
    } finally {
      held.dispose();
    }
  });

  // Review INF-2926's F4: a merge the app sends at once from its card -
  // here a project with no host it keeps approvals on - gives the card the
  // captain's buttons back when it is refused.
  it("gives a card the app merged from its buttons back when that merge is refused", async () => {
    const h = await onRepo(true);
    try {
      h.mergePullRequest.mockResolvedValue({
        ok: false,
        text: "Cannot merge: the branch cannot be merged.",
      });
      completionCard(h.specs);
      await vi.waitFor(() => expect(h.mergePullRequest).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => {
        const card = h.cards().find((entry) => entry.taskId === h.taskId);
        expect(card?.actions.some((action) => action.effect?.kind === "merge")).toBe(true);
      });
      expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
    } finally {
      h.dispose();
    }
  });

  // The autonomy journey's click (INF-2744): the captain clicked the merge
  // card while the first mate's own merge call still held the task, so the
  // click met another settle. His approval runs as soon as that settle
  // ends, not at the next minute's look.
  it("runs the captain's merge click once the settle that held the task ends", async () => {
    const h = await approved();
    const held = h.supervisor.settling.locks.claim(h.taskId, "merge-pr");
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.retryAt).toBeDefined());
    await tick();
    expect(h.forge.merges).toEqual([]);
    held.release();
    await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
    await vi.waitFor(() =>
      expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "merged" }),
    );
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's F1, under the captain's "a single task can request
  // many merges": two merge cards for two pull requests, each approval
  // standing on its own until its pull request merges.
  async function twoPullRequests() {
    const h = await approved({ referenced: true });
    const heads: Record<number, string> = { 7: APPROVED, 8: REPAIRED };
    const merged = new Set<number>();
    h.forge.pull = async (number: number): Promise<ForgePull> => ({
      number,
      state: merged.has(number) ? "closed" : "open",
      merged: merged.has(number),
      ...(merged.has(number) ? { mergedSha: `squash-${heads[number]}` } : {}),
      headSha: heads[number] ?? APPROVED,
      base: "main",
      readiness: "clean",
      branch: number === 8 ? "fm/task-next" : "fm/task-earlier",
      headRepo: "o/r",
      title: number === 8 ? "fix: label the meter" : "fix: ship the meter",
    });
    h.forge.putIn = async (change: ForgeChange, headSha: string) => {
      h.forge.merges.push(headSha);
      if (change.number !== undefined) merged.add(change.number);
      return { sha: `squash-${headSha}` };
    };
    const first = h.tasks.get(h.taskId)?.delivery?.mergeReviews?.[0] as MergeReview;
    const next: MergeReview = {
      ...first,
      id: "review-next",
      number: 8,
      headSha: REPAIRED,
      branch: "fm/task-next",
      title: "fix: label the meter",
    };
    seedDelivery(h.tasks, h.taskId, { mergeReviews: [first, next] });
    const emitNext = async (asksFirst?: string) => {
      await h.specs[0]?.onCard?.({
        requiredActions: [],
        title: "Ready to merge the label",
        body: completionBody("<p>The label PR is ready.</p><p>CI is green on the tested head.</p>"),
        actions: [
          {
            id: "merge",
            default: true,
            effect: {
              kind: "merge",
              review: next.id,
              after: "continue",
              ...(asksFirst ? { asksFirst } : {}),
            },
          },
          { id: "not-now", label: "Not now" },
        ],
      });
      await tick();
    };
    /** Both pull requests merged, each once, the crewmate going idle after each continue. */
    const bothMerge = async () => {
      await vi.waitFor(() => expect(h.forge.merges).toContain(APPROVED));
      h.crewmate.finishPrompt();
      await tick();
      await vi.waitFor(() => expect([...h.forge.merges].sort()).toEqual([APPROVED, REPAIRED]));
    };
    return { ...h, emitNext, bothMerge };
  }

  it("merges both pull requests when a second merge card goes up under autonomy while the first one's approval stands", async () => {
    const h = await twoPullRequests();
    // The first card's approval stands while another settle holds the task.
    const held = h.supervisor.settling.locks.claim(h.taskId, "merge-pr");
    await editPolicies(h, { autonomy: true });
    expect(h.authorization()).toMatchObject({
      status: "standing",
      issuer: "autonomy",
      target: { prNumber: 7 },
    });
    await h.emitNext();
    expect(h.authorization()).toMatchObject({ status: "standing", target: { prNumber: 7 } });
    expect(h.authorization()?.queued?.map((item) => item.target.prNumber)).toEqual([8]);
    expect(h.forge.merges).toEqual([]);
    held.release();
    await h.bothMerge();
    expect(h.forge.merges).toEqual([APPROVED, REPAIRED]);
    expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
    await h.supervisor.disposeAll();
  });

  it("merges both pull requests when autonomy turns on while both merge cards are up", async () => {
    const h = await twoPullRequests();
    await h.emitNext();
    expect(
      h.cards().filter((card) => card.taskId === h.taskId && card.actions.length > 0),
    ).toHaveLength(2);
    expect(h.authorization()).toBeUndefined();
    await editPolicies(h, { autonomy: true });
    await h.bothMerge();
    expect(h.forge.merges).toEqual([APPROVED, REPAIRED]);
    expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's F2: the merge gate reads the card for the pull
  // request being merged, so another pull request's asks-first card does
  // not take back the app's approval of this one.
  it("merges the pull request whose card the app took while another pull request's card asks the captain first", async () => {
    const h = await twoPullRequests();
    await h.emitNext("The captain decides label changes himself.");
    await editPolicies(h, { autonomy: true });
    await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
    h.crewmate.finishPrompt();
    await tick();
    expect(h.forge.merges).toEqual([APPROVED]);
    const asking = h.cards().find((card) => card.title === "Ready to merge the label");
    expect(asking?.actions.some((action) => action.effect?.kind === "merge")).toBe(true);
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's R2, the captain's "Let each go ahead on its own": an
  // approval whose pull request waits for its checks does not hold another
  // approved pull request of the task, which merges first; the waiting one
  // merges once its checks pass.
  it("merges an approved pull request whose checks passed while another approval on the task waits for its checks", async () => {
    const h = await twoPullRequests();
    let firstReady = false;
    h.forge.checks = async (change?: ForgeChange) => ({
      items: [
        {
          name: "linux-checks",
          state: change?.number === 7 && !firstReady ? ("pending" as const) : ("success" as const),
        },
      ],
    });
    await h.supervisor.steer.steerCrewmate(h.taskId, "put up the label fix too");
    await h.emitNext();
    h.crewmate.finishPrompt();
    await tick();
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() =>
      expect(h.authorization()).toMatchObject({
        status: "standing",
        target: { prNumber: 7 },
        waiting: { on: "checks" },
      }),
    );
    const next = h.cards().find((card) => card.title === "Ready to merge the label") as Card;
    h.supervisor.cardActions.act(next.id, "merge");
    // The captain's first click told the crewmate its merge waits; once its
    // turn ends, the second approval goes ahead without waiting for the first.
    h.crewmate.finishPrompt();
    await tick();
    await vi.waitFor(() => expect(h.forge.merges).toEqual([REPAIRED]));
    expect(h.authorization()).toMatchObject({ status: "standing", target: { prNumber: 7 } });
    firstReady = true;
    h.crewmate.finishPrompt();
    await tick();
    await vi.waitFor(() => expect(h.forge.merges).toEqual([REPAIRED, APPROVED]));
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's R1 and R4, under the captain's "a single task can
  // request many merges": the task's own pull request and another one its
  // crewmate asked for with check_change pull, which made that one the
  // current change. Each approval is kept to its own pull request, so both
  // merge, whether the captain clicks both cards or the app merges from
  // them under autonomy.
  it.each(["captain", "autonomy"] as const)(
    "merges the task's own pull request and one asked for with check_change pull when the %s approves both",
    async (who) => {
      const h = await approved();
      const merged = new Set<number>();
      const own = h.forge.pull.bind(h.forge);
      h.forge.pull = async (number: number): Promise<ForgePull> =>
        number === 8
          ? {
              number,
              state: merged.has(8) ? "closed" : "open",
              merged: merged.has(8),
              ...(merged.has(8) ? { mergedSha: `squash-${REPAIRED}` } : {}),
              headSha: REPAIRED,
              base: "main",
              readiness: "clean",
              branch: "fm/task-next",
              headRepo: "o/r",
              title: "fix: label the meter",
            }
          : own(number);
      h.forge.putIn = async (change: ForgeChange, headSha: string) => {
        h.forge.sends += 1;
        h.forge.merges.push(headSha);
        if (change.number === 8) merged.add(8);
        else h.forge.merged = true;
        return { sha: `squash-${headSha}` };
      };
      await h.supervisor.steer.steerCrewmate(h.taskId, "merge the label fix too");
      await h.declare({ pull: 8 });
      const review = h.tasks
        .get(h.taskId)
        ?.delivery?.mergeReviews?.find((item) => item.number === 8) as MergeReview;
      expect(h.tasks.get(h.taskId)?.delivery?.checkTarget).toMatchObject({ number: 8 });
      await h.specs[0]?.onCard?.({
        requiredActions: [],
        title: "Ready to merge the label",
        body: completionBody("<p>The label PR is ready.</p><p>CI is green on the tested head.</p>"),
        actions: [
          {
            id: "merge",
            default: true,
            effect: { kind: "merge", review: review.id, after: "continue" },
          },
          { id: "not-now", label: "Not now" },
        ],
      });
      h.crewmate.finishPrompt();
      await tick();
      const next = h.cards().find((card) => card.title === "Ready to merge the label") as Card;
      if (who === "captain") {
        h.supervisor.cardActions.act(h.card.id, "merge");
        h.supervisor.cardActions.act(next.id, "merge");
      } else await editPolicies(h, { autonomy: true });
      await vi.waitFor(() => expect(h.forge.merges.length).toBeGreaterThan(0));
      h.crewmate.finishPrompt();
      await tick();
      await vi.waitFor(() => expect([...h.forge.merges].sort()).toEqual([APPROVED, REPAIRED]));
      await h.supervisor.disposeAll();
    },
  );

  // Review INF-2926's R3: an end that takes the task's merges back for the
  // captain ends its other approvals at once, and its crewmate hears which
  // merges will not run, so it puts their merge cards up again.
  it("tells the crewmate which merges will not run when the captain withdraws the approval in front", async () => {
    const h = await twoPullRequests();
    const held = h.supervisor.settling.locks.claim(h.taskId, "merge-pr");
    await editPolicies(h, { autonomy: true });
    await h.emitNext();
    expect(h.authorization()?.queued?.map((item) => item.target.prNumber)).toEqual([8]);
    expect(h.supervisor.withdrawMergeApproval(h.taskId).ok).toBe(true);
    expect(h.authorization()).toMatchObject({ status: "revoked" });
    expect(h.authorization()?.queued).toBeUndefined();
    await vi.waitFor(() =>
      expect(h.crewmate.promptCalls.join("\n")).toContain(
        "your merge card's merge of #8 did not happen",
      ),
    );
    held.release();
    await tick();
    expect(h.forge.merges).toEqual([]);
    await h.supervisor.disposeAll();
  });

  // The first mate's ruling on INF-2746's autonomy revoke end: once the
  // task no longer merges on its own, only approvals the app took under
  // autonomy end; an approval the captain clicked still goes ahead.
  it("merges the pull request the captain approved when the project's autonomy turns off under the app's approval in front", async () => {
    const h = await twoPullRequests();
    const repoId = h.tasks.get(h.taskId)?.repoId;
    if (!repoId) throw new Error("Missing project");
    const held = h.supervisor.settling.locks.claim(h.taskId, "merge-pr");
    await h.supervisor.steer.steerCrewmate(h.taskId, "put both merge cards up again");
    h.repos.configure(repoId, { autonomy: true });
    await h.emit("Ready to merge again");
    await h.emitNext("The captain decides label changes himself.");
    h.crewmate.finishPrompt();
    await tick();
    expect(h.authorization()).toMatchObject({
      status: "standing",
      issuer: "autonomy",
      target: { prNumber: 7 },
    });
    const next = h.cards().find((card) => card.title === "Ready to merge the label") as Card;
    h.supervisor.cardActions.act(next.id, "merge");
    await vi.waitFor(() =>
      expect(h.authorization()?.queued).toEqual([
        expect.objectContaining({
          issuer: "captain",
          target: expect.objectContaining({ prNumber: 8 }),
        }),
      ]),
    );
    h.repos.configure(repoId, { autonomy: false });
    held.release();
    await vi.waitFor(() => expect(h.forge.merges).toEqual([REPAIRED]));
    expect(h.crewmate.promptCalls.join("\n")).not.toContain("merge of #8 did not happen");
    await tick();
    expect(h.forge.merges).toEqual([REPAIRED]);
    await h.supervisor.disposeAll();
  });

  // Review INF-2926's F3: a reviewed pull request's merge that declared it
  // closes the task passes the same close rules as the task's own merge.
  it("keeps the task open when a reviewed pull request's merge closes it while one of its parts is open", async () => {
    const h = await approved({ referenced: true });
    const review = h.tasks.get(h.taskId)?.delivery?.mergeReviews?.[0] as MergeReview;
    seedTask(h.tasks, {
      id: "part0001",
      title: "Label the meter",
      parentId: h.taskId,
      status: "queued",
    });
    await h.supervisor.steer.steerCrewmate(h.taskId, "merge it and close the task");
    await h.specs[0]?.onCard?.({
      requiredActions: [],
      title: "Ready to merge and close",
      body: completionBody("<p>The PR is ready.</p><p>CI is green on the tested head.</p>"),
      actions: [
        {
          id: "merge",
          default: true,
          effect: { kind: "merge", review: review.id, after: "close" },
        },
        { id: "not-now", label: "Not now" },
      ],
    });
    h.crewmate.finishPrompt();
    await tick();
    const card = h.cards().find((entry) => entry.title === "Ready to merge and close") as Card;
    h.supervisor.cardActions.act(card.id, "merge");
    await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
    await vi.waitFor(() =>
      expect(h.crewmate.promptCalls.join("\n")).toContain("parts of it are still open"),
    );
    expect(h.tasks.get(h.taskId)?.status).not.toBe("done");
    await h.supervisor.disposeAll();
  });

  // INF-5396's audit, finding 2: a review passed with two questions still
  // waiting on the captain, its builder's merge card named neither, and the
  // captain's click merged before they were answered. The merge card names
  // the review's open question, and the click waits for its answer.
  it("names the review's open question on the merge card and holds the captain's merge until it is answered", async () => {
    const h = await approved();
    seedTask(h.tasks, {
      id: "review01",
      title: "Review: Ship the meter",
      parentId: h.taskId,
      status: "idle",
      shape: { kind: "review", kind_source: "host:review", basis: h.taskId },
    });
    const question = h.supervisor.cards.emitCrewmateCard(
      "review01",
      {
        title: "Review of the meter: keep the Later copy?",
        body: "<p>The empty meter says Later.</p>",
        asking: true,
        actions: [
          { id: "keep", label: "Keep the copy", default: true },
          { id: "change", label: "Change it" },
        ],
      },
      "m",
    );
    // The reviewer's turn ended, and the review passed; its question
    // outlives it (INF-4338's direction D).
    h.supervisor.cards.closeOut({ kind: "crewmate", taskId: "review01" }, "idle");
    h.tasks.close("review01", { status: "done", reason: "finished", actor: "host" });
    await tick();
    const merge = () => h.cards().find((entry) => entry.id === h.card.id);
    expect(merge()?.body).toContain("Review of the meter: keep the Later copy?");

    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting?.on).toBe("questions"));
    expect(h.forge.merges).toEqual([]);

    // The answer reaches the builder, which says it leaves the approved
    // work as it was; the kept merge then goes through.
    h.supervisor.cardActions.act(question, "keep");
    await tick();
    expect(h.cards().map((card) => card.id)).not.toContain(question);
    expect(h.forge.merges).toEqual([]);
    await h.declare({
      captainGuidance: { mark: 1, impact: "none", evidence: "The captain kept the copy." },
    });
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.forge.merges).toEqual([APPROVED]));
    expect(h.authorization()?.status).toBe("consumed");
    await h.supervisor.disposeAll();
  });
});
