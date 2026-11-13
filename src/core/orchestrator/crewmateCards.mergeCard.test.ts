/**
 * show_merge_card's last three steps as `CrewmateCards` takes them
 * (INF-3717 piece 2, the captain's direction A: "One call that shows the
 * merge card or names the one thing missing"): the checks passed, no open
 * waits, then the card - today's saved-story merge card, under its id, or a
 * new id once the captain answered the last one. Each case drives a real
 * CrewSupervisor through the crew harness (tests/helpers/crewHarness.ts).
 */

import { createHash } from "node:crypto";
import { DECLINE_ACTION_ID } from "@shared/cardLeave";
import { type Card, MERGE_HELD_MARK, mergeEffectOf } from "@shared/cards";
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
import {
  presentationCardBody,
  presentationContentHash,
  presentationMarkdown,
  QUEUE_STATUS,
} from "../forge";
import type { MergeCardWalk } from "./mergeCardSteps";
import { heldLine } from "./settleCardFacts";

fakeCrewTimersEachTest();

const HEAD = "5ca2d466ee21f9733827383f23df81f3874e0d10";
/** The version a later push moves the pull request to. */
const PUSHED = "732a709e5b1c48d2a9f03e6c7d1b84a2f5e90c13";

/** A queue-pr task whose story revision 1 is ready for its merge card. */
async function ready(checks: "green" | "pending" | "red" = "green") {
  const crewmate = fakeCrewmate();
  let story: ChangePresentation | undefined;
  /** The pull request's checks as the next read finds them. */
  let reading = checks;
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
    ready: { revision: 1, title: "The meter reads true", head: HEAD },
  };
  const mergeCardSteps = vi.fn(async () => structuredClone(next));
  const openChange = vi.fn(async () => "Opened #7.");
  const prepareChange = vi.fn(async () => "Prepared presentation 1.");
  const at = setup(crewmate, {
    checkCi: async () => reading,
    completionPresentation,
    prepareChange,
    openChange,
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
  /**
   * The crewmate's next story revision at `head`, published and read back as
   * the walk leaves it: saved and confirmed in one write, or, `inTwo`, saved
   * while its publication is sent, returning the later write that confirms
   * it, as a hosted project's walk does.
   */
  const publish = (revision: number, head: string, inTwo = false) => {
    const next = { ...(story as ChangePresentation), revision, head };
    story = next;
    const region = presentationMarkdown(next, new Map(), "passed");
    const published = {
      revision,
      head,
      state: "confirmed" as const,
      region,
      regionHash: createHash("sha256").update(region).digest("hex"),
      contentHash: presentationContentHash(next),
      number: 7,
    };
    const confirm = () =>
      at.tasks.delivery.updateChangePresentation(taskId, (current) => ({
        revisions: inTwo ? (current?.revisions ?? []) : [...(current?.revisions ?? []), next],
        receipts: [],
        publication: published,
        published,
      }));
    if (!inTwo) return confirm();
    at.tasks.delivery.updateChangePresentation(taskId, (current) => ({
      ...(current as NonNullable<typeof current>),
      revisions: [...(current?.revisions ?? []), next],
      publication: { ...published, state: "sending" },
    }));
    return confirm;
  };
  const call = (card: MergeCardRequest, walk?: MergeCardWalk) => {
    if (walk) next = walk;
    const show = at.specs[0]?.onShowMergeCard;
    if (!show) throw new Error("show_merge_card is not served");
    return show({ card });
  };
  const setChecks = (now: typeof checks) => {
    reading = now;
  };
  return {
    ...at,
    crewmate,
    taskId,
    call,
    publish,
    setChecks,
    completionPresentation,
    openChange,
    prepareChange,
    mergeCardSteps,
  };
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
      'You answered card merge-meter already (the captain chose "The kitchen meter"), so the merge card goes up as merge-meter-2.',
    );
    expect(answer).toContain("Showed the merge card from story revision 1");
    const card = at.cards().find((entry) => entry.title === "The meter reads true") as Card;
    expect(card.id).toMatch(/merge-meter-2$/);
  });
});

/**
 * INF-4018, the captain's "was this a bug? how can we prevent hiccups like
 * this?": after the captain clicked Merge, the crewmate's show_merge_card
 * at the same version raised a repeat card that ended the click. A version
 * the standing approval covers takes no new card.
 */
describe("a merge card for a version the captain already approved (INF-4018)", () => {
  /**
   * The task after the captain's Merge click on its merge card at HEAD: the
   * approval the click keeps on the record, in the shape INF-4003's record
   * held it (the click itself is driven in settleOwners.keptMerge.test.ts).
   */
  async function clicked() {
    const at = await ready();
    await at.call({ id: "merge-meter" });
    await tick();
    const card = at.cards().find((entry) => entry.title === "The meter reads true") as Card;
    at.crewmate.finishPrompt();
    await tick();
    seedDelivery(at.tasks, at.taskId, {
      mergeAuthorization: {
        version: 1,
        id: "90c79f39-4ec4-4587-80ec-1176e5ca282c",
        generation: 1,
        issuer: "captain",
        at: 1,
        card: { id: card.id, offerId: card.offerId ?? "", actionId: "merge" },
        target: {
          repoId: "meter",
          host: "github.com",
          owner: "octo",
          name: "meter",
          prNumber: 7,
          branch: at.tasks.get(at.taskId)?.branch ?? "",
          delivery: "direct-pr",
          method: "squash",
        },
        after: "close",
        approvedHead: HEAD,
        lineage: [],
        proceedWithOpen: false,
        status: "standing",
        waiting: { on: "queue", head: HEAD, at: 1 },
      },
    });
    const approval = () => at.tasks.get(at.taskId)?.delivery?.mergeAuthorization;
    expect(approval()).toMatchObject({ status: "standing", approvedHead: HEAD });
    return { ...at, card, approval };
  }

  it("refuses show_merge_card at that version, keeping the approval and writing no card", async () => {
    const at = await clicked();
    const before = at.approval();
    const cards = at.cards().length;
    const answer = await at.call({ id: "merge-meter" });
    await tick();
    expect(answer).toContain(`The captain's merge approval is kept and covers ${HEAD}`);
    expect(answer).toContain("Put up no merge card and end your turn");
    expect(answer).not.toContain("merge-meter-2");
    expect(at.approval()).toMatchObject({
      status: "standing",
      id: before?.id,
      generation: before?.generation,
    });
    expect(at.approval()?.queueRemovals).toBeUndefined();
    expect(at.cards()).toHaveLength(cards);
    expect(at.tasks.get(at.taskId)?.delivery?.cardRefusal).toBeUndefined();
  });

  it("refuses emit_card with a merge action at that version the same way", async () => {
    const at = await clicked();
    const before = at.approval();
    await expect(
      Promise.resolve().then(() =>
        at.specs[0]?.onCard?.({
          presentationRevision: 1,
          requiredActions: [],
          title: "The meter reads true",
          body: "",
          actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
          id: "merge-meter-again",
        }),
      ),
    ).rejects.toThrow(`The captain's merge approval is kept and covers ${HEAD}`);
    expect(at.approval()).toMatchObject({ status: "standing", id: before?.id });
    expect(at.cards().some((entry) => entry.id.endsWith("merge-meter-again"))).toBe(false);
  });

  it("points to declaring the impact while the captain's newer words hold the approval", async () => {
    const at = await clicked();
    const approval = at.approval();
    if (!approval) throw new Error("No approval");
    seedDelivery(at.tasks, at.taskId, {
      mergeAuthorization: { ...approval, guidance: { latest: 1, declared: 0, at: 1 } },
    });
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain("Their guidance through mark 1 holds the merge");
    expect(answer).toContain("check_change captainGuidance instead");
    expect(at.approval()?.status).toBe("standing");
  });

  // PR #1653's case: the approval carried over to a declared repair, so the
  // repaired version is the one it covers.
  it("refuses a card at the repaired version the approval carries over to", async () => {
    const at = await clicked();
    const repaired = "1ec2709f0c5b8f4e7a3d2b1c0e9f8a7b6c5d4e3f";
    const approval = at.approval();
    if (!approval) throw new Error("No approval");
    seedDelivery(at.tasks, at.taskId, {
      headSha: repaired,
      mergeAuthorization: {
        ...approval,
        lineage: [
          {
            fromHead: HEAD,
            toHead: repaired,
            newBase: "acd0b92e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c",
            impact: "none",
            changedPaths: [],
            evidence: "Brought up to date with main; no file the change touches moved.",
            validation: "The meter test passed at the repaired version.",
            generation: approval.generation,
            at: 2,
          },
        ],
      },
    });
    const answer = await at.call(
      { id: "merge-meter" },
      { did: [], ready: { revision: 1, title: "The meter reads true", head: repaired } },
    );
    expect(answer).toContain(`The captain's merge approval is kept and covers ${repaired}`);
    expect(at.approval()?.status).toBe("standing");
  });

  // The reviewer's finding on PR #1673: right after a push, the record still
  // names the earlier version until a check reading lands, and the card is
  // for the pushed one the walk verified.
  it("does not take a card at a version just pushed for the earlier version the record still names", async () => {
    const at = await clicked();
    const pushed = "4d3c2b1a0f9e8d7c6b5a49382716f5e4d3c2b1a0";
    // The walk republished the story at the pushed version, as it does.
    at.tasks.delivery.updateChangePresentation(at.taskId, (current) => {
      if (!current?.published) throw new Error("No published story");
      const published = { ...current.published, head: pushed };
      return { ...current, publication: published, published };
    });
    const answer = await at.call(
      { id: "merge-meter" },
      { did: [], ready: { revision: 1, title: "The meter reads true", head: pushed } },
    );
    expect(at.tasks.get(at.taskId)?.delivery?.headSha).toBe(HEAD);
    expect(answer).not.toContain("merge approval is kept");
    expect(answer).not.toContain("end your turn");
  });

  // The reviewer's finding on PR #1673: a covered version whose checks
  // failed says what clears them, never that the app merges it.
  it("says what clears failed checks at that version instead of claiming the app merges it", async () => {
    const at = await clicked();
    seedDelivery(at.tasks, at.taskId, { ci: "red" });
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain(`The captain's merge approval is kept and covers ${HEAD}`);
    expect(answer).toContain("check_change conflictRepair");
    expect(answer).toContain("check_change rerun");
    expect(answer).toContain("Merge anyway case");
    expect(answer).not.toContain("the app runs the merge");
    expect(at.approval()?.status).toBe("standing");
  });

  // The reviewer's finding on PR #1673 (INF-3208): the project's queue
  // failed or sent back the approved version, which no checks override
  // passes, so the refusal gives the queue's route, never Merge anyway.
  it("gives the queue's route when the batch check failed at that version", async () => {
    const at = await clicked();
    seedDelivery(at.tasks, at.taskId, {
      ci: "red",
      checks: {
        headSha: HEAD,
        prNumber: 7,
        items: [
          { name: "typecheck-lint-build", state: "success" },
          { name: QUEUE_STATUS, state: "failure" },
        ],
        absenceDeclared: false,
      },
    });
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain(`The captain's merge approval is kept and covers ${HEAD}`);
    expect(answer).toContain("no checks override passes the queue");
    expect(answer).toContain("check_change's answered verdict");
    expect(answer).not.toContain("Merge anyway case");
    expect(answer).not.toContain("check_change rerun");
    expect(at.approval()?.status).toBe("standing");
  });

  // INF-2746: an approval waiting behind another one still covers its version.
  it("refuses a card at a version an approval waiting its turn covers", async () => {
    const at = await clicked();
    const own = at.approval();
    if (!own) throw new Error("No approval");
    const front = {
      ...own,
      id: "0b6c1f0e-3a5d-4e8b-9c2f-7d1a6e4b5c3d",
      approvedHead: "2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
      target: { ...own.target, prNumber: 8, branch: "fm/task-earlier" },
      waiting: undefined,
    };
    seedDelivery(at.tasks, at.taskId, { mergeAuthorization: { ...front, queued: [own] } });
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain(`The captain's merge approval is kept and covers ${HEAD}`);
    expect(at.tasks.get(at.taskId)?.delivery?.mergeAuthorization).toMatchObject({
      id: front.id,
      status: "standing",
      queued: [expect.objectContaining({ id: own.id, status: "standing" })],
    });
  });

  it("still puts up a card at a newer version the approval does not cover, ending it", async () => {
    const at = await clicked();
    // The approval covers an earlier version; the story and the pull request are at HEAD.
    const approval = at.approval();
    if (!approval) throw new Error("No approval");
    seedDelivery(at.tasks, at.taskId, {
      mergeAuthorization: { ...approval, approvedHead: "9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6" },
    });
    const answer = await at.call({ id: "merge-meter" });
    expect(answer).toContain("Showed the merge card from story revision 1");
    expect(at.approval()).toMatchObject({ status: "superseded" });
  });

  it("leaves the approval standing when another of the task's cards closes", async () => {
    const at = await clicked();
    await at.specs[0]?.onCard?.({
      title: "Keep the old readings?",
      body: "<p>Old readings are kept for a month.</p>",
      actions: [
        { id: "keep", label: "Keep them", default: true },
        { id: "drop", label: "Drop them" },
      ],
      id: "old-readings",
    });
    await tick();
    const other = at.cards().find((entry) => entry.title === "Keep the old readings?") as Card;
    await at.specs[0]?.onCloseCard?.({
      cardId: other.id,
      reason: "The readings question is settled.",
    });
    await tick();
    expect(at.approval()?.status).toBe("standing");
  });
});

/** The merges a card offers, and its Merge anyway. */
const merges = (card: Card | undefined) =>
  (card?.actions ?? []).filter((action) => mergeEffectOf(action) !== undefined);

/** Every wake the crewmate's session was handed, in the words it read. */
const heard = (crewmate: ReturnType<typeof fakeCrewmate>) =>
  [...crewmate.promptCalls, ...crewmate.steer.mock.calls.map((call) => String(call[0]))].join("\n");

// INF-4031 (captain: "ideally, i should never be able to see an outdated card
// at all. if a newer version is up, the card should be showing the newer
// version"): the replay of INF-3930, whose card stayed at its first story
// for nine minutes after a push and refused every click.
describe("a merge card behind its change (INF-4031)", () => {
  /** The merge card up at HEAD from story revision 1, then a push to PUSHED. */
  async function pushedPast() {
    const at = await ready();
    await at.call({ id: "merge-meter" });
    await tick();
    const shown = at.cards().find((entry) => entry.title === "The meter reads true") as Card;
    seedDelivery(at.tasks, at.taskId, { headSha: PUSHED, prNumber: 7, ci: "pending" });
    await tick();
    return { ...at, cardId: shown.id, choices: shown.actions.map((action) => action.id) };
  }

  it("removes the Merge button on a push, says why, and wakes the crewmate once", async () => {
    const at = await pushedPast();
    const held = at.cards().find((entry) => entry.id === at.cardId);
    expect(merges(held)).toEqual([]);
    expect(held?.body).toContain(MERGE_HELD_MARK);
    expect(held?.body).toContain("A newer version was pushed after this card went up.");
    // Every other choice stays, with the app's Decline now that no merge is
    // the card's own way out, and the strip still follows the record.
    expect(held?.actions.map((action) => action.id)).toEqual([
      ...at.choices.filter((id) => id !== "merge"),
      DECLINE_ACTION_ID,
    ]);
    expect(held?.body).toContain("data-facts");
    expect(heard(at.crewmate)).toContain(
      `Your merge card ${at.cardId} shows ${HEAD.slice(0, 7)}, and the pull request is at ${PUSHED.slice(0, 7)} now.`,
    );
    // Another task change at the same version wakes no one again.
    seedDelivery(at.tasks, at.taskId, { ci: "green" });
    await tick();
    expect(heard(at.crewmate).split("Your merge card").length - 1).toBe(1);
  });

  it("redraws the same card once a story is published at the new version, and keeps the click", async () => {
    const at = await pushedPast();
    at.publish(2, PUSHED);
    await tick();
    await tick();
    const redrawn = at.cards().filter((entry) => entry.title === "The meter reads true");
    expect(redrawn.map((entry) => entry.id)).toEqual([at.cardId]);
    expect(merges(redrawn[0])).toHaveLength(1);
    expect(redrawn[0]?.body).not.toContain(MERGE_HELD_MARK);
    expect(at.completionPresentation).toHaveBeenLastCalledWith(at.taskId, 2);
    expect(at.tasks.get(at.taskId)?.delivery?.completionOffers?.at(-1)).toMatchObject({
      cardId: at.cardId,
      headSha: PUSHED,
      presentationRevision: 2,
    });
    at.crewmate.finishPrompt();
    await tick();
    expect(() => at.supervisor.cardActions.act(at.cardId, "merge")).not.toThrow();
    expect(at.cardStore.chosenAction(at.cardId)).toBe("merge");
  });

  it("redraws only once a story saved at the new version is confirmed published in a later write", async () => {
    const at = await pushedPast();
    at.crewmate.finishPrompt();
    await tick();
    const wakes = () => heard(at.crewmate).split("Your merge card").length - 1;
    const before = wakes();
    const confirm = at.publish(2, PUSHED, true);
    await tick();
    await tick();
    // The first write saves the revision while its publication is still
    // being sent: the card stays held, and no one is woken again.
    expect(merges(at.cards().find((entry) => entry.id === at.cardId))).toEqual([]);
    expect(at.completionPresentation).not.toHaveBeenCalledWith(at.taskId, 2);
    expect(wakes()).toBe(before);
    confirm?.();
    await tick();
    await tick();
    const redrawn = at.cards().find((entry) => entry.id === at.cardId);
    expect(merges(redrawn)).toHaveLength(1);
    expect(redrawn?.body).not.toContain(MERGE_HELD_MARK);
    expect(at.completionPresentation).toHaveBeenLastCalledWith(at.taskId, 2);
  });

  it("revises the held card in place while the checks at the new version still run", async () => {
    // The crewmate works in the turn the held card woke it for.
    const at = await pushedPast();
    at.setChecks("pending");
    // The app's own redraw is not what brings the card current here.
    const redraw = vi.spyOn(at.supervisor.crewmateCards, "redrawBehind").mockReturnValue(true);
    at.publish(2, PUSHED);
    await tick();
    redraw.mockRestore();
    expect(merges(at.cards().find((entry) => entry.id === at.cardId))).toEqual([]);
    // The crewmate's emit_card at the new version: while the checks run,
    // only a revision of the open merge card goes up, and the held card is
    // that card.
    await at.specs[0]?.onCard?.({
      id: "merge-meter",
      title: "The meter reads true",
      body: "",
      presentationRevision: 2,
      actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
      requiredActions: [],
    });
    await tick();
    at.crewmate.finishPrompt();
    await tick();
    const shown = at.cards().filter((entry) => entry.title === "The meter reads true");
    expect(shown.map((entry) => entry.id)).toEqual([at.cardId]);
    expect(merges(shown[0])).toHaveLength(1);
    expect(shown[0]?.body).not.toContain(MERGE_HELD_MARK);
    expect(at.tasks.get(at.taskId)?.delivery?.completionOffers?.at(-1)).toMatchObject({
      cardId: at.cardId,
      headSha: PUSHED,
      presentationRevision: 2,
    });
  });

  it("refuses a merge click on a card with no offer while the change has a story", async () => {
    const at = await ready();
    await at.call({ id: "merge-meter" });
    await tick();
    at.crewmate.finishPrompt();
    await tick();
    const shown = at.cards().find((entry) => entry.title === "The meter reads true") as Card;
    // The card's offer is gone from the record, so it shows no version.
    seedDelivery(at.tasks, at.taskId, { completionOffers: [] });
    expect(() => at.supervisor.cardActions.act(shown.id, "merge")).toThrow(
      "This action changed or still waits for other work.",
    );
    expect(at.cardStore.chosenAction(shown.id)).toBeUndefined();
  });

  it("strips the held line and mark from words an author wrote, restoring no action", async () => {
    const at = await ready();
    const merge = {
      id: "merge",
      label: "Merge",
      default: true,
      effect: { kind: "merge" as const, after: "close" as const },
    };
    // The host's own line, copied whole, and the bare mark elsewhere.
    await at.specs[0]?.onCard?.({
      title: "A note",
      body: `${heldLine("pushed", [merge])}<p ${MERGE_HELD_MARK}="x">The meter reads true.</p>`,
      actions: [],
      requiredActions: [],
    });
    await tick();
    const note = at.cards().find((entry) => entry.title === "A note");
    expect(note?.body).not.toContain(MERGE_HELD_MARK);
    expect(note?.body).not.toContain("A newer version was pushed after this card went up.");
    expect(note?.body).toContain("The meter reads true.");
    seedDelivery(at.tasks, at.taskId, { ci: "pending" });
    await tick();
    expect(merges(at.cards().find((entry) => entry.title === "A note"))).toEqual([]);
  });

  // `at.cards()` is what the captain sees: the stage's broadcast.
  it("brings the redraw to the captain at once while its crewmate is idle", async () => {
    const at = await pushedPast();
    at.crewmate.finishPrompt();
    await tick();
    at.publish(2, PUSHED);
    await tick();
    await tick();
    const shown = at.cards().find((entry) => entry.id === at.cardId);
    expect(merges(shown)).toHaveLength(1);
    expect(shown?.body).not.toContain(MERGE_HELD_MARK);
  });

  it("wakes the crewmate when the story's publication at the new version is uncertain", async () => {
    const at = await pushedPast();
    at.crewmate.finishPrompt();
    await tick();
    const wakes = () => heard(at.crewmate).split("Your merge card").length - 1;
    const before = wakes();
    at.publish(2, PUSHED, true);
    await tick();
    expect(wakes()).toBe(before);
    at.tasks.delivery.updateChangePresentation(at.taskId, (current) => {
      const saved = current as NonNullable<typeof current>;
      const sent = saved.publication as NonNullable<typeof saved.publication>;
      return { ...saved, publication: { ...sent, state: "uncertain" } };
    });
    await tick();
    await tick();
    expect(wakes()).toBe(before + 1);
    expect(merges(at.cards().find((entry) => entry.id === at.cardId))).toEqual([]);
  });

  it("leaves the card to the crewmate's own show_merge_card while it runs", async () => {
    const at = await pushedPast();
    // The walk publishes the story at the new version, then the call writes the card.
    at.mergeCardSteps.mockImplementationOnce(async () => {
      at.publish(2, PUSHED);
      await tick();
      await tick();
      return {
        did: ["Published the story on #7 and read it back."],
        ready: { revision: 2, title: "The meter reads true", head: PUSHED },
      };
    });
    const write = vi.spyOn(at.supervisor.crewmateCards, "crewmateCardWrite");
    const answer = await at.call({
      id: "merge-meter",
      reply: "This shows the pushed version now.",
    });
    await tick();
    expect(answer).toContain("Showed the merge card from story revision 2");
    // One write, the call's own with its reply: the app's redraw kept out of it.
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[1]).toMatchObject({ reply: "This shows the pushed version now." });
    at.crewmate.finishPrompt();
    await tick();
    const shown = at.cards().find((entry) => entry.id === at.cardId);
    expect(merges(shown)).toHaveLength(1);
  });

  it("lets its crewmate's story calls wait for the app's redraw instead of refusing them", async () => {
    const at = await pushedPast();
    // The redraw holds the task's story operation, which refuses a second
    // one as ChangePresentations does, until the test lets it finish.
    const busy = "A story operation is already in progress for this task.";
    let holding = false;
    let release = () => {};
    const presented = at.completionPresentation.getMockImplementation();
    at.completionPresentation.mockImplementationOnce(async (taskId, revision) => {
      holding = true;
      await new Promise<void>((done) => {
        release = done;
      });
      holding = false;
      return (presented as NonNullable<typeof presented>)(taskId, revision);
    });
    const refusing = async () => {
      if (holding) throw new Error(busy);
      return "Opened #7.";
    };
    at.openChange.mockImplementation(refusing);
    at.prepareChange.mockImplementation(async () => {
      if (holding) throw new Error(busy);
      return "Prepared presentation 2.";
    });
    at.mergeCardSteps.mockImplementationOnce(async () => {
      if (holding) throw new Error(busy);
      return {
        did: ["Published the story on #7 and read it back."],
        ready: { revision: 2, title: "The meter reads true", head: PUSHED },
      };
    });
    at.publish(2, PUSHED);
    await tick();
    await tick();
    expect(holding).toBe(true);
    const presentedSoFar = at.completionPresentation.mock.calls.length;
    // The crewmate's prepare_change, open_change, emit_card with its story
    // and show_merge_card all arrive mid-redraw.
    const prepared = at.specs[0]?.onPrepareChange?.(
      {} as Parameters<NonNullable<(typeof at.specs)[0]["onPrepareChange"]>>[0],
    );
    const opened = at.specs[0]?.onOpenChange?.({ title: "The meter reads true", presentation: 2 });
    const emitted = at.specs[0]?.onCard?.({
      id: "merge-meter",
      title: "The meter reads true",
      body: "",
      presentationRevision: 2,
      actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
    });
    const shown = at.call({ id: "merge-meter" });
    await tick();
    expect(at.prepareChange).not.toHaveBeenCalled();
    expect(at.openChange).not.toHaveBeenCalled();
    expect(at.completionPresentation).toHaveBeenCalledTimes(presentedSoFar);
    expect(at.mergeCardSteps).toHaveBeenCalledTimes(1);
    release();
    await expect(prepared).resolves.toBe("Prepared presentation 2.");
    await expect(opened).resolves.toBe("Opened #7.");
    expect(JSON.stringify(await emitted)).not.toContain(busy);
    const answer = await shown;
    expect(at.completionPresentation).toHaveBeenCalledTimes(presentedSoFar + 2);
    expect(answer).not.toContain(busy);
    expect(answer).toContain("story revision 2");
    at.crewmate.finishPrompt();
    await tick();
    const current = at.cards().filter((entry) => entry.title === "The meter reads true");
    expect(current.map((entry) => entry.id)).toEqual([at.cardId]);
    expect(merges(current[0])).toHaveLength(1);
  });

  it("revises the open card when show_merge_card names a new id", async () => {
    const at = await pushedPast();
    at.publish(2, PUSHED);
    const answer = await at.call({ id: "merge-meter-4" });
    await tick();
    expect(answer).toContain(
      "Your open merge card is merge-meter, so this revises it instead of putting up merge-meter-4.",
    );
    const shown = at.cards().filter((entry) => entry.title === "The meter reads true");
    expect(shown.map((entry) => entry.id)).toEqual([at.cardId]);
  });

  it("names the new version when a click comes before the card is held", async () => {
    const at = await ready();
    await at.call({ id: "merge-meter" });
    await tick();
    at.crewmate.finishPrompt();
    await tick();
    const shown = at.cards().find((entry) => entry.title === "The meter reads true") as Card;
    // The click lands between the push and the pass that holds the card.
    const pass = vi.spyOn(at.supervisor.cards, "refreshSettleFacts").mockImplementation(() => {});
    seedDelivery(at.tasks, at.taskId, { headSha: PUSHED, prNumber: 7, ci: "pending" });
    pass.mockRestore();
    expect(() => at.supervisor.cardActions.act(shown.id, "merge")).toThrow(
      `A newer version, ${PUSHED.slice(0, 7)}, was pushed after this card went up, so I did not merge. The card now shows it.`,
    );
    expect(merges(at.cards().find((entry) => entry.id === shown.id))).toEqual([]);
  });

  it("drops a follow-up row from the open card once that task closes", async () => {
    const at = await ready();
    at.specs[0]?.onFollowup?.({ title: "Flaky meter test", goal: "g", why: "w" });
    await at.call({ id: "merge-meter" });
    await tick();
    const shown = () => at.cards().find((entry) => entry.title === "The meter reads true");
    expect(shown()?.body).toContain("Flaky meter test");
    const filed = at.tasks.graph.discoveredFrom(at.taskId)[0];
    at.tasks.close(filed?.id ?? "", { status: "done", reason: "finished", actor: "host" });
    await tick();
    expect(shown()?.body).not.toContain("Filed while working on this");
    expect(merges(shown())).toHaveLength(1);
  });
});
