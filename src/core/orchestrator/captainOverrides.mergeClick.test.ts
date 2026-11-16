/**
 * INF-3284, accepted reach audit: an ordinary Merge click is scoped approval,
 * never general consent. Drive the real click/citation/declaration and merge
 * gate against the existing disposable project and forge fixture. No service
 * merge is sent. Scoped approval/repair execution stays owned by the kept-merge
 * tests; this file owns rejection of the duplicate override route, and the
 * merge refusal that must not invite it while the click's approval stands
 * (INF-4525).
 */
import { type HoldOverride, softHoldWords, standingOverride } from "@shared/holds";
import { describe, expect, it, vi } from "vitest";
import { fakeCrewTimersEachTest } from "../../../tests/helpers/crewHarness";
import { approved, REPAIRED } from "../../../tests/helpers/crewHarnessGit";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { KEPT_APPROVAL_WORDS } from "./mergeAuthorization";
import { mergeGate } from "./settleRefusals";

fakeCrewTimersEachTest();

describe("ordinary merge clicks are not general consent (INF-3284)", () => {
  async function clicked() {
    const h = await approved();
    // Keep the click waiting without ever sending a merge to the forge.
    h.forge.states = ["pending"];
    await h.declare({});
    h.supervisor.cardActions.act(h.card.id, "merge");
    await vi.waitFor(() => expect(h.authorization()?.waiting).toMatchObject({ on: "checks" }));
    const citation = h.supervisor.overrides.citedCaptainWords(h.taskId, h.card.id);
    if (!citation.ok || !citation.mergeClick) throw new Error("Expected a typed merge click");
    const legacy: HoldOverride = {
      words: citation.words,
      holds: ["asks-first"],
      until: "task",
      mergeClick: true,
      at: h.authorization()?.at ?? h.card.createdAt,
    };
    return { ...h, citation, legacy };
  }

  it("refuses new click overrides for any hold and scope without replacing separately spoken consent", async () => {
    const h = await clicked();
    const words = "Keep going without asking me again on this task.";
    expect(
      h.supervisor.overrides.declareOverride(h.taskId, {
        words,
        holds: ["asks-first"],
        until: "task",
      }).ok,
    ).toBe(true);
    const spoken = h.tasks.get(h.taskId)?.delivery?.override;
    for (const until of ["version", "task"] as const) {
      for (const holds of [["asks-first"], ["checks"], ["decisions", "waits"]] as const) {
        expect(
          h.supervisor.overrides.declareOverride(h.taskId, {
            ...h.citation,
            holds: [...holds],
            until,
          }).ok,
        ).toBe(false);
        expect(h.tasks.get(h.taskId)?.delivery?.override).toEqual(spoken);
      }
    }
    expect(standingOverride(h.tasks.get(h.taskId)?.delivery)).toEqual(spoken);
    expect(h.forge.sends).toBe(0);
  });

  // INF-4525, the captain's pick on the weekly reach audit ("fix its
  // refusal words now"): the first mate's own merge under autonomy off,
  // while the click's approval stands, hears that the host merges it, and
  // is invited to neither a merge card nor an override from the click.
  it("refuses the first mate's merge under the kept approval without asking for a card or a click override", async () => {
    const h = await clicked();
    expect(h.supervisor.facts.taskAutonomy(h.taskId)).toBe(false);
    const result = await h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr");
    expect(result.refusal).toMatchObject({ refused: "autonomy-off", ways: [] });
    expect(result.text).toContain("is not yours to do: autonomy is off for this task");
    expect(result.text).toContain(KEPT_APPROVAL_WORDS);
    expect(result.text).toContain(`waits on checks at ${h.authorization()?.waiting?.head}`);
    expect(result.text).not.toContain(softHoldWords("asks-first", "firstmate"));
    // The refusal moved nothing: the approval still stands and nothing was sent.
    expect(h.authorization()).toMatchObject({ status: "standing", issuer: "captain" });
    expect(h.forge.sends).toBe(0);
  });

  it("preserves separately chosen proof-gap consent", async () => {
    const h = await approved();
    const card = h.supervisor.cards.addFirstmateCard({
      taskId: h.taskId,
      title: "Continue without live proof?",
      body: "<p>The isolated check cannot reach the external service.</p>",
      actions: [
        { id: "accept-gap", label: "Accept with the gap", default: true },
        { id: "wait", label: "Keep waiting" },
      ],
    });
    h.supervisor.cardActions.act(card, "accept-gap");
    const citation = h.supervisor.overrides.citedCaptainWords(h.taskId, card);
    if (!citation.ok) throw new Error("Expected the captain's exception choice");
    expect(citation.mergeClick).toBeUndefined();
    expect(
      h.supervisor.overrides.declareOverride(h.taskId, {
        ...citation,
        holds: ["asks-first"],
        until: "task",
      }).ok,
    ).toBe(true);
    expect(standingOverride(h.tasks.get(h.taskId)?.delivery)?.words).toBe(citation.words);
    expect(h.forge.sends).toBe(0);
  });

  it("ignores saved click overrides after withdrawal, at another head, and for another pull request", async () => {
    const h = await clicked();
    h.supervisor.settling.approvals.endAuthorization(
      h.taskId,
      "revoked",
      "The captain withdrew approval",
    );
    seedDelivery(h.tasks, h.taskId, { override: h.legacy });
    const record = h.tasks.get(h.taskId);
    if (!record?.delivery) throw new Error("Expected the clicked task's delivery");
    const host: Parameters<typeof mergeGate>[0] = {
      tasks: h.tasks,
      cards: h.supervisor.cards,
      repos: h.repos,
      taskDelivery: () => "direct-pr",
      taskAutonomy: () => true,
    };
    const scenarios = [
      { ...record, delivery: { ...record.delivery } },
      {
        ...record,
        delivery: { ...record.delivery, headSha: REPAIRED, mergeAuthorization: undefined },
      },
      {
        ...record,
        delivery: {
          ...record.delivery,
          prNumber: (record.delivery?.prNumber ?? 0) + 1,
          mergeAuthorization: undefined,
        },
      },
    ];
    for (const candidate of scenarios) {
      expect(standingOverride(candidate.delivery, candidate.delivery.headSha)).toBeUndefined();
      // Neither a new asks-first reason with autonomy on, nor autonomy off,
      // can borrow the historical ordinary click.
      expect(
        mergeGate(host, candidate, "merge-pr", "firstmate", "The captain decides this new merge")
          ?.refused,
      ).toBe("autonomy-off");
      expect(
        mergeGate({ ...host, taskAutonomy: () => false }, candidate, "merge-pr", "firstmate")
          ?.refused,
      ).toBe("autonomy-off");
    }
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, "standing").ok).toBe(false);
    expect(h.tasks.get(h.taskId)?.delivery?.override).toEqual(h.legacy);
    expect(h.forge.sends).toBe(0);
  });
});
