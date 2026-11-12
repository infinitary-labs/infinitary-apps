/**
 * show_merge_card's last three steps as `CrewmateCards` takes them
 * (INF-3717 piece 2, the captain's direction A: "One call that shows the
 * merge card or names the one thing missing"): the checks passed, no open
 * waits, then the card - today's saved-story merge card, under its id, or a
 * new id once the captain answered the last one. Each case drives a real
 * CrewSupervisor through the crew harness (tests/helpers/crewHarness.ts).
 */

import { createHash } from "node:crypto";
import type { Card } from "@shared/cards";
import type { ChangePresentation, MergeCardRequest } from "@shared/changePresentation";
import { describe, expect, it, vi } from "vitest";
import {
  askedOn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  METER_RISK,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { presentationCardBody, presentationContentHash, presentationMarkdown } from "../forge";
import type { MergeCardWalk } from "./mergeCardSteps";

fakeCrewTimersEachTest();

const HEAD = "5ca2d466ee21f9733827383f23df81f3874e0d10";

/** A queue-pr task whose story revision 1 is ready for its merge card. */
async function ready(checks: "green" | "pending" | "red" = "green") {
  const crewmate = fakeCrewmate();
  let story: ChangePresentation | undefined;
  const completionPresentation = vi.fn(async (_taskId: string, revision: number) => {
    if (!story) throw new Error("No story yet");
    return {
      title: story.title,
      body: presentationCardBody(story),
      riskDeclaration: story.risk,
      requiredActions: story.requiredActions,
      pictures: story.pictures,
      revision,
    };
  });
  let next: MergeCardWalk = {
    did: ["Published the story on #7 and read it back."],
    ready: { revision: 1, title: "The meter reads true" },
  };
  const mergeCardSteps = vi.fn(async () => structuredClone(next));
  const at = setup(crewmate, {
    checkCi: async () => checks,
    completionPresentation,
    prepareChange: async () => "Prepared presentation 1.",
    openChange: async () => "Opened #7.",
    checkChange: async () => "Checks passed.",
    mergeCardSteps,
  });
  const { taskId } = await at.supervisor.intake.commission({
    title: "Share the meter fix",
    intent: intentOf("share the meter fix"),
    shape: { rigor_ask: "quick" },
  });
  await tick();
  vi.spyOn(at.supervisor.facts, "taskDelivery").mockReturnValue("queue-pr");
  vi.spyOn(at.supervisor.facts, "taskAutonomy").mockReturnValue(false);
  story = {
    version: 1,
    taskId,
    revision: 1,
    destination: {
      host: "github.com",
      projectId: 1,
      fullName: "octo/meter",
      visibility: "private",
    },
    title: "The meter reads true",
    base: HEAD,
    head: HEAD,
    why: ["The meter read high."],
    whatChanged: ["The meter reads the true value."],
    before: ["The meter read high."],
    after: ["The meter reads true."],
    views: [],
    noPicture: "This changes a reading, not a view.",
    verification: ["The meter test passed."],
    risk: METER_RISK,
    requiredActions: [],
    unfinished: [],
    projectText: "",
    assets: [],
    pictures: [],
  };
  // Published and read back at this version, as the walk left it.
  const region = presentationMarkdown(story, new Map(), "passed");
  const publication = {
    revision: 1,
    head: HEAD,
    state: "confirmed" as const,
    region,
    regionHash: createHash("sha256").update(region).digest("hex"),
    contentHash: presentationContentHash(story),
    number: 7,
  };
  at.tasks.delivery.updateChangePresentation(taskId, () => ({
    revisions: [story as ChangePresentation],
    receipts: [],
    publication,
    published: publication,
  }));
  seedDelivery(at.tasks, taskId, { headSha: HEAD, prNumber: 7, ci: checks });
  const call = (card: MergeCardRequest, walk?: MergeCardWalk) => {
    if (walk) next = walk;
    const show = at.specs[0]?.onShowMergeCard;
    if (!show) throw new Error("show_merge_card is not served");
    return show({ card });
  };
  return { ...at, crewmate, taskId, call, completionPresentation, mergeCardSteps };
}

describe("show_merge_card's card steps (INF-3717 piece 2)", () => {
  it("names the step the walk stopped at and who supplies it, showing no card", async () => {
    const at = await ready();
    const before = at.cards().length;
    const answer = await at.call(
      { id: "merge-meter" },
      {
        did: ["Prepared story revision 1 at the committed version."],
        stop: { step: "proof", missing: "No independent review at this version.", by: "reviewer" },
      },
    );
    expect(answer).toContain("Did: Prepared story revision 1 at the committed version.");
    expect(answer).toContain("Missing (proof): No independent review at this version.");
    expect(answer).toContain("Supplied by: the independent reviewer, through the first mate");
    expect(at.cards()).toHaveLength(before);
  });

  it("shows today's saved-story merge card with the one merge action it builds itself", async () => {
    const at = await ready();
    const answer = await at.call({ id: "merge-meter" });
    await tick();
    expect(answer).toContain("Did: Published the story on #7 and read it back.");
    expect(answer).toContain("Showed the merge card from story revision 1");
    expect(at.completionPresentation).toHaveBeenCalledWith(at.taskId, 1);
    const card = at.cards().find((entry) => entry.title === "The meter reads true") as Card;
    expect(card.id).toContain("merge-meter");
    expect(card.actions.filter((action) => action.effect?.kind === "merge")).toHaveLength(1);
    expect(at.tasks.get(at.taskId)?.delivery?.completionOffers?.at(-1)).toMatchObject({
      presentationRevision: 1,
    });
  });

  it("stops at the checks while they run, recording no refused card", async () => {
    const at = await ready("pending");
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain("Missing (checks):");
    expect(answer).toContain("Supplied by: the checks: end your turn");
    expect(at.cards().some((entry) => entry.title === "The meter reads true")).toBe(false);
    expect(at.tasks.get(at.taskId)?.delivery?.cardRefusal).toBeUndefined();
  });

  // INF-3824's review: only registered checks still running wake the
  // crewmate; failed checks and an empty reading are the crewmate's, with
  // the card refusal's whole guidance, recorded as emit_card records it.
  it("names you, with the refusal's diagnosis and Merge anyway guidance, when the checks failed", async () => {
    const at = await ready("red");
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain("Missing (checks): Card refused: the checks read");
    expect(answer).toContain("check_change diagnosis");
    expect(answer).toContain("Merge anyway");
    expect(answer).toContain("Supplied by: you.");
    expect(answer).not.toContain("the app wakes you when they finish");
    expect(at.tasks.get(at.taskId)?.delivery?.cardRefusal).toMatchObject({ reason: "checks" });
  });

  it("names you and the absent-checks declaration when no check registered at this version", async () => {
    const at = await ready("pending");
    seedDelivery(at.tasks, at.taskId, {
      checks: { headSha: HEAD, prNumber: 7, items: [], absenceDeclared: false },
    });
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain("check_change absentChecks");
    expect(answer).toContain("Supplied by: you.");
    expect(answer).not.toContain("the app wakes you when they finish");
  });

  // INF-3824's review (INF-2884): a reply answering the captain's waiting
  // message under the open merge card names it, and the call passes it on.
  it("answers the captain's message under the open merge card when the reply names it", async () => {
    const at = await ready();
    await at.call({ id: "merge-meter" });
    await tick();
    const card = at.cards().find((entry) => entry.title === "The meter reads true") as Card;
    at.supervisor.cardActions.replyToCard(card.id, "does the meter still read high at night?");
    await tick();
    const answer = await at.call({
      id: "merge-meter",
      reply: "It reads true at night too; the story says so.",
      answersMessage: askedOn(at.supervisor, card.id),
    });
    expect(answer).toContain("Showed the merge card from story revision 1");
  });

  it("stops at an open wait, naming the first mate, once the checks passed", async () => {
    const at = await ready();
    vi.spyOn(at.tasks.graph, "blockerRefusal").mockReturnValue({
      text: "This task waits on INF-12, which is still open.",
    } as ReturnType<typeof at.tasks.graph.blockerRefusal>);
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain("Missing (waits): This task waits on INF-12, which is still open.");
    expect(answer).toContain("Supplied by: the first mate");
    expect(at.cards().some((entry) => entry.title === "The meter reads true")).toBe(false);
  });

  it("names the checks, not the wait, while the checks run and a wait holds", async () => {
    const at = await ready("pending");
    vi.spyOn(at.tasks.graph, "blockerRefusal").mockReturnValue({
      text: "This task waits on INF-12, which is still open.",
    } as ReturnType<typeof at.tasks.graph.blockerRefusal>);
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain("Missing (checks):");
  });

  it("revises the open card under its id when called again", async () => {
    const at = await ready();
    await at.call({ id: "merge-meter" });
    await tick();
    await at.call({ id: "merge-meter" });
    await tick();
    const shown = at.cards().filter((entry) => entry.title === "The meter reads true");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.id).toMatch(/merge-meter$/);
    expect(at.mergeCardSteps).toHaveBeenCalledTimes(2);
  });

  it("uses a new id once the captain answered the card under the one given", async () => {
    const at = await ready();
    // An earlier decision under the same id, which the captain answered.
    await at.specs[0]?.onCard?.({
      requiredActions: [],
      title: "Which meter goes first?",
      body: "<p>Two meters read high.</p>",
      actions: [
        { id: "kitchen", label: "The kitchen meter", default: true },
        { id: "garage", label: "The garage meter" },
      ],
      id: "merge-meter",
    });
    at.crewmate.finishPrompt();
    await tick();
    const asked = at.cards().find((entry) => entry.title === "Which meter goes first?") as Card;
    at.supervisor.cardActions.act(asked.id, "kitchen");
    await tick();
    at.crewmate.finishPrompt();
    await tick();
    const answer = await at.call({ id: "merge-meter" });
    await tick();
    expect(answer).toContain(
      "You answered card merge-meter already, so the merge card goes up as merge-meter-2.",
    );
    expect(answer).toContain("Showed the merge card from story revision 1");
    const card = at.cards().find((entry) => entry.title === "The meter reads true") as Card;
    expect(card.id).toMatch(/merge-meter-2$/);
  });
});
