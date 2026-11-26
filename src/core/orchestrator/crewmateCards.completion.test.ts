/**
 * A crewmate's completion card as `CrewmateCards` finishes it
 * (docs/card-authoring.md): the standing checks gate cleared first, a
 * refused completion card the first mate reads, the completion buttons the
 * host attaches from the posture, and the actions a crewmate decision holds.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type Card, splitSettleFacts } from "@shared/cards";
import type { ChangePresentation } from "@shared/changePresentation";
import { softHoldWords } from "@shared/holds";
import { CHECK_WORDS } from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import {
  askedOn,
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  METER_RISK,
  reportTurn,
  SETTLE_DISCARD,
  SETTLE_MERGE,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { presentationCardBody, presentationMarkdown } from "../forge";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import { bindTool } from "../session/tools";
import type { CrewmateSpec } from "./crewSession";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it("attaches the merge card's buttons itself from the posture (contract v3.6, captain lock 3, INF-2744)", async () => {
    // The audit's 4.4b row 2: every completion card in the window carried
    // the same pair, the host already resolved the merge by posture, and a
    // crewmate was transcribing labels it could not see - the Claude ones,
    // which never received the text at all, got the label right 4 times in
    // 8. So the crewmate declares the merge and the host writes the pair.
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    // INF-2744: autonomy off, so the merge card keeps the host's buttons
    // instead of the app merging from it as it goes up.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    await specs[0]?.onCard?.({
      requiredActions: [],
      title: "The meter test is steady",
      body: completionBody(
        "<p>The meter test passes ten runs in a row.</p><p>It awaits the flush now.</p>",
      ),
      actions: [
        { id: "ship", label: "Ship it to main", default: true, effect: SETTLE_MERGE },
        { id: "ask", label: "Ask me something" },
      ],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title === "The meter test is steady") as Card;

    // The invented label is gone; the pair is the host's, labeled for the
    // task's posture (the default workspace is local-only).
    expect(settle.actions.map((action) => ({ id: action.id, label: action.label }))).toEqual([
      { id: "ask", label: "Ask me something" },
      { id: "discard", label: "Discard" },
      { id: "merge", label: "Merge the branch" },
    ]);
    expect(settle.actions.find((action) => action.id === "merge")?.default).toBe(true);
    expect(settle.actions.find((action) => action.id === "discard")?.danger).toBe(true);
    // `confirm` is never host-set: it is a claim about the body, and
    // auto-confirming would destroy unlanded work without the captain.
    expect(settle.actions.find((action) => action.id === "discard")?.effect).toEqual(
      SETTLE_DISCARD,
    );
    // And the window on a Firstmate merge card closed with that card.
    expect(supervisor.crewmateCards.crewmateOwesCompletion(taskId)).toBe(false);
  });

  it("words a merge its crewmate declared without a label, as the crewmate is told (FI3-249)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards } = setup(crewmate);
    await supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    // INF-2744: autonomy off, so the merge card keeps the host's buttons
    // instead of the app merging from it as it goes up.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    await specs[0]?.onCard?.({
      requiredActions: [],
      title: "The meter reads true",
      body: completionBody("<p>The meter reads true now.</p><p>It awaits the merge.</p>"),
      actions: [{ id: "merge", default: true, effect: SETTLE_MERGE }],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title === "The meter reads true") as Card;

    expect(settle.actions.map((action) => ({ id: action.id, label: action.label }))).toEqual([
      { id: "discard", label: "Discard" },
      { id: "merge", label: "Merge the branch" },
    ]);
    expect(settle.actions.find((action) => action.id === "merge")?.effect).toEqual(SETTLE_MERGE);
  });

  it("refuses a card with an action of the crewmate's own that has no words (FI3-249)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards } = setup(crewmate);
    await supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    const body = completionBody("<p>The meter reads true now.</p><p>It awaits the merge.</p>");
    expect(() =>
      specs[0]?.onCard?.({
        requiredActions: [],
        title: "The meter reads true",
        body,
        actions: [{ id: "merge", default: true, effect: SETTLE_MERGE }, { id: "ask" }],
      }),
    ).toThrow(/Card refused: action "ask" has no label/);
    expect(() =>
      specs[0]?.onCard?.({
        title: "Which meter?",
        body: "<p>Two meters read the line.</p><p>Pick the one to keep.</p>",
        actions: [
          { id: "left", label: "  ", default: true },
          { id: "right", label: "Right" },
        ],
      }),
    ).toThrow(/Card refused: action "left" has no label/);
    expect(() =>
      specs[0]?.onCard?.({
        title: "Drop the meter",
        body: "<p>The meter is not needed.</p><p>Drop the work.</p>",
        actions: [{ id: "discard", default: true, effect: SETTLE_DISCARD }],
      }),
    ).toThrow(/Card refused: action "discard" has no label/);
    crewmate.finishPrompt();
    await tick();
    expect(cards()).toEqual([]);
  });

  it("holds a crewmate decision to 2 or 3 actions, counting the host's completion pair (FI3-411)", async () => {
    // FI3-409's live check: a radio question under a lone "Save this answer"
    // went up because nothing counted. The lint reads the card the captain
    // gets, so a completion decision that declares only its merge gives two.
    const crewmate = fakeCrewmate();
    const { supervisor, specs, cards } = setup(crewmate);
    await supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    // INF-2744: autonomy off, so the merge card keeps the host's buttons
    // instead of the app merging from it as it goes up.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    expect(() =>
      specs[0]?.onCard?.({
        title: "Reduced motion needs an answer",
        body: '<p>Pick how the reveal behaves when motion is reduced.</p><fieldset><legend>When motion is reduced</legend><label><input type="radio" name="motion" value="instant" required data-inf-recommended> Instant reveal</label><label><input type="radio" name="motion" value="fade" required> Short fade</label></fieldset>',
        actions: [{ id: "save-answer", label: "Save this answer", default: true }],
      }),
    ).toThrow(
      /^Card refused: a decision gives 2 or 3 actions, and this one gives 1 \(save-answer\)/,
    );
    const body = completionBody(
      "<p>The meter test passes ten runs in a row.</p><p>It awaits the flush now.</p>",
    );
    expect(() =>
      specs[0]?.onCard?.({
        requiredActions: [],
        title: "The meter test is steady",
        body,
        actions: [
          { id: "ask", label: "Ask me something" },
          { id: "later", label: "Ask me tomorrow" },
          { id: "ship", label: "Ship it", default: true, effect: SETTLE_MERGE },
        ],
      }),
    ).toThrow(/this one gives 4 \(ask, later, merge, discard\)/);
    expect(cards()).toEqual([]);

    await specs[0]?.onCard?.({
      requiredActions: [],
      title: "The meter test is steady",
      body,
      actions: [{ id: "merge", default: true, effect: SETTLE_MERGE }],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title === "The meter test is steady") as Card;
    expect(settle.actions.map((action) => action.id)).toEqual(["discard", "merge"]);
  });

  it("holds the merge decision for the crewmate until it has emitted one (4.4b row 9)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    // While the crewmate is live and has carded nothing, the merge decision
    // is still its own to make: on 2026-09-19 the Firstmate emitted one
    // beside it four times and closed three of its own as duplicates.
    expect(supervisor.crewmateCards.crewmateOwesCompletion(taskId)).toBe(true);
    expect(supervisor.crewmateCards.crewmateOwesCompletion("no-such-task")).toBe(false);
    await specs[0]?.onCard?.({
      title: "One thing I noticed",
      body: "<p>The flush is racy.</p>",
      actions: [],
    });
    crewmate.finishPrompt();
    await tick();
    expect(supervisor.crewmateCards.crewmateOwesCompletion(taskId)).toBe(true);
  });

  it("a deferral a crewmate declares itself is an ordinary reply, never a park (P0, WI-1)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, specs, cards } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Wait",
      intent: intentOf("done work"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    // INF-2744: autonomy off, so the merge card keeps the host's buttons
    // instead of the app merging from it as it goes up.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "firstmate-3000 fm/task-ready is done",
      body: completionBody(
        "<p>The work is ready to land.</p><p>Keep leaves the worktree; discard drops it.</p>",
      ),
      actions: [
        { id: "later", label: "Ask me tomorrow" },
        { id: "land", label: "Land locally", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    crewmate.finishPrompt();
    await tick();
    const settle = cards().find((card) => card.title.includes("is done")) as Card;
    // The author's own non-settle action survives the host's attachment:
    // a card carries exactly the actions its author declares beside the
    // completion pair (cards/tasks/agents P0).
    expect(settle.actions.map((action) => action.id)).toEqual(["later", "discard", "merge"]);

    supervisor.cardActions.act(settle.id, "later");
    await tick();

    expect(cards()).toEqual([]);
    expect(crewmate.promptCalls.at(-1)).toBe(
      'Card "firstmate-3000 fm/task-ready is done": the user chose "Ask me tomorrow" (later).',
    );
    expect(tasks.list().filter((record) => record.id.startsWith("park-"))).toEqual([]);
    expect(tasks.list().filter((record) => record.kind === "decision")).toEqual([]);
    expect(tasks.get(taskId)?.status).toBe("active");
  });
});

describe("a crewmate's own completion card clears the standing CI gate first", () => {
  it.each(["cancelled", "failed"] as const)(
    "does not publish a late checked card after the task is %s",
    async (reason) => {
      const check = deferred<"green">();
      const crewmate = fakeCrewmate();
      const { supervisor, specs, cards, cardStore } = setup(crewmate, {
        checkCi: () => check.promise,
      });
      const { taskId } = await supervisor.intake.commission({
        title: "Ship the fix",
        intent: intentOf("finish the PR"),
        shape: { rigor_ask: "quick" },
      });
      await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
      const result = specs[0]?.onCard?.({
        requiredActions: [],
        title: "Ready to merge",
        body: completionBody("<p>The change is ready.</p>"),
        actions: [{ id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE }],
      });
      if (reason === "cancelled") await supervisor.sessions.interruptCrewmate(taskId, "cancel");
      crewmate.failPrompt(reason === "cancelled" ? "aborted" : "The client exited.");
      await tick();
      check.resolve("green");
      await expect(result).rejects.toThrow("this task has closed");
      await tick();
      expect(cards()).toEqual([]);
      expect(cardStore.listOpen()).toEqual([]);
    },
  );

  // INF-1891: the checks hold a new merge card until the pull request's own
  // checks pass; a revision of the card already up goes up while they run
  // (INF-834 friction 4). The offer stays the crew's judgment (INF-1555 F12).
  it("holds a new offer while the checks run and lets a revision of the card up (INF-1891)", async () => {
    const crewmate = fakeCrewmate();
    let overall: "green" | "pending" = "pending";
    const checkCi = vi.fn(async () => overall);
    const { supervisor, specs, cards } = setup(crewmate, { checkCi });
    await supervisor.intake.commission({
      title: "Ship the fix",
      intent: intentOf("finish the PR"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    // INF-2744: autonomy off, so the merge card waits for the captain's click.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    const completion = (after: string) => ({
      requiredActions: [],
      id: "ready",
      title: "Ready to merge",
      body: completionBody(after),
      actions: [
        { id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });

    const held = specs[0]?.onCard?.(
      completion("<p>The PR is open.</p><p>All changes are pushed and the worktree is clean.</p>"),
    );
    await expect(held).rejects.toThrow(`the checks read ${CHECK_WORDS.pending}, not passed`);
    await expect(held).rejects.toThrow(softHoldWords("checks", "crewmate"));
    await tick();
    expect(cards().map((card) => card.title)).not.toContain("Ready to merge");

    overall = "green";
    await specs[0]?.onCard?.(
      completion("<p>The PR is open.</p><p>All changes are pushed and the worktree is clean.</p>"),
    );
    await tick();
    overall = "pending";
    await expect(
      specs[0]?.onCard?.(completion("<p>The flag is renamed.</p><p>Pushed.</p>")),
    ).resolves.toContain("The card is shown; its merge waits on the checks.");
    expect(checkCi).toHaveBeenCalledTimes(3);
    await tick();
    expect(cards().filter((card) => card.title === "Ready to merge")).toHaveLength(1);
  });

  it("asks for the thread answer now when a missing change holds an offer back while the captain's reply waits", async () => {
    const crewmate = fakeCrewmate();
    let overall: "green" | "no-pr" = "green";
    const { supervisor, specs, cards } = setup(crewmate, { checkCi: async () => overall });
    await supervisor.intake.commission({
      title: "Ship the fix",
      intent: intentOf("finish the PR"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    const completion = (body: string, id = "ready") => ({
      requiredActions: [],
      id,
      title: "Ready to merge",
      body: completionBody(body),
      actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
    });
    await specs[0]?.onCard?.(completion("<p>The PR is open.</p><p>The checks passed.</p>"));
    await tick();
    const card = cards().find((entry) => entry.title === "Ready to merge") as Card;
    // The captain asks for a change, which restarts the checks.
    supervisor.cardActions.replyToCard(card.id, "rename the flag first");
    overall = "no-pr";
    // A revision of that card goes up while they run (INF-834 friction 4);
    // a new completion card still waits for them.
    const refused = specs[0]?.onCard?.(
      completion("<p>The flag is renamed.</p><p>Pushed.</p>", "renamed"),
    );
    await expect(refused).rejects.toThrow(/no open pull request was found/);
    await expect(refused).rejects.toThrow(
      "The captain's reply in your card's thread is still unanswered: answer it now with reply",
    );
    specs[0]?.onReply?.({
      cardId: card.id,
      text: "Renamed; the checks are running again.",
      answersMessage: askedOn(supervisor, card.id),
    });
    await expect(
      specs[0]?.onCard?.(completion("<p>The flag is renamed.</p><p>Pushed.</p>", "renamed")),
    ).rejects.not.toThrow(/still unanswered/);
  });

  it("holds an offer with failed checks until each carries a diagnosis or main fails them too (INF-1891, INF-1915 fix 1)", async () => {
    const crewmate = fakeCrewmate();
    const checkCi = vi.fn(async () => "red" as const);
    const { supervisor, specs, cards } = setup(crewmate, { checkCi });
    await supervisor.intake.commission({
      title: "Ship the fix",
      intent: intentOf("finish the PR"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");

    const result = specs[0]?.onCard?.({
      requiredActions: [],
      title: "Ready to merge",
      body: completionBody(
        "<p>The PR is open.</p><p>All changes are pushed and the worktree is clean.</p>",
      ),
      actions: [
        { id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });

    await expect(result).rejects.toThrow(`the checks read ${CHECK_WORDS.red}, not passed`);
    await expect(result).rejects.toThrow("carries your diagnosis");
    await expect(result).rejects.toThrow("spend no rerun on it");
    await expect(result).rejects.toThrow(softHoldWords("checks", "crewmate"));
    expect(checkCi).toHaveBeenCalledTimes(1);
    await tick();
    expect(cards().map((card) => card.title)).not.toContain("Ready to merge");
  });

  // INF-1965: no request number is invented, and a later story still invalidates the click.
  it.each(["hosted", "branch", "local"] as const)(
    "renders the %s story and refuses a click after a newer revision is prepared (INF-92, INF-1965)",
    async (destination) => {
      const crewmate = fakeCrewmate();
      let story: ChangePresentation;
      const head = "5ca2d466ee21f9733827383f23df81f3874e0d10";
      const completionPresentation = vi.fn(async () => ({
        title: story.title,
        body: presentationCardBody(story),
        riskDeclaration: story.risk,
        requiredActions: story.requiredActions,
        pictures: story.pictures,
      }));
      const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Merged" }));
      const { supervisor, tasks, specs, cards } = setup(crewmate, {
        checkCi: async () => "green",
        completionPresentation,
        mergePullRequest,
      });
      const { taskId } = await supervisor.intake.commission({
        title: "Share the completed change",
        intent: intentOf("share the same story"),
        shape: { rigor_ask: "quick" },
      });
      await tick();
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue(
        destination === "local" ? "local-only" : "direct-pr",
      );
      // INF-2744: the click is the captain's only with autonomy off; with it
      // on, the app merges from the card as it goes up.
      vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
      story = {
        version: 1,
        taskId,
        revision: 1,
        destination:
          destination === "hosted"
            ? {
                host: "github.com",
                projectId: 1,
                fullName: "octo/meter",
                visibility: "private",
              }
            : destination === "branch"
              ? { kind: "branch", origin: "https://git.example.test/octo/meter.git" }
              : { kind: "local", project: "repo-meter" },
        title: "The upload survives restart",
        base: head,
        head,
        why: ["Confirmed uploads must not be sent twice."],
        whatChanged: ["The task keeps each confirmed receipt."],
        before: ["Restart lost the receipt."],
        after: ["Restart reuses the receipt."],
        views: [],
        noPicture: "This changes upload recovery, not a visible view.",
        verification: ["Restart recovery passed."],
        risk: METER_RISK,
        requiredActions: [],
        unfinished: [],
        projectText: "",
        assets: [],
        pictures: [],
      };
      const region =
        destination === "hosted" ? presentationMarkdown(story, new Map(), "passed") : "";
      const publication = {
        revision: 1,
        head,
        state: "confirmed" as const,
        region,
        regionHash: createHash("sha256").update(region).digest("hex"),
        number: 1,
      };
      tasks.delivery.updateChangePresentation(taskId, () => ({
        revisions: [story],
        receipts: [],
        ...(destination === "hosted"
          ? { publication, published: publication }
          : { completion: { revision: 1, head, contentHash: "fixture-story-content" } }),
      }));
      seedDelivery(tasks, taskId, {
        ...(destination === "local" ? {} : { headSha: head }),
        ...(destination === "hosted" ? { prNumber: 1 } : {}),
        ci: "green",
      });
      expect(() =>
        specs[0]?.onCard?.({
          title: "A second account",
          body: completionBody("<p>Different.</p>"),
          actions: [{ id: "merge", effect: SETTLE_MERGE }],
        }),
      ).toThrow(
        // INF-961: the refusal names the way to a story at the pushed version,
        // which a pull request's host republishes on its own (INF-2509); INF-2744 calls it the merge card.
        destination === "local"
          ? "Use presentation on the merge card so it shows the current committed story, not a second account of the change. This task's newest story is revision 1. After another commit, prepare a new story with prepare_change, then show its revision as presentation; local-only work skips open_change."
          : destination === "hosted"
            ? "Use presentation on the merge card so it shows the current published story, not a second account of the change. This task's newest story is revision 1. After a push since the story was published, show the same revision as presentation: the app republishes it at the pushed version. Prepare and publish a new revision only when what the story says changed."
            : "Use presentation on the merge card so it shows the current published story, not a second account of the change. This task's newest story is revision 1. After a push since the story was published, prepare a new story revision at the pushed version with prepare_change and publish it with open_change, then show the merge card with the revision prepare_change returns as presentation.",
      );
      const id = await specs[0]?.onCard?.({
        title: "Ignored duplicate title",
        body: "",
        presentationRevision: 1,
        actions: [{ id: "merge", effect: SETTLE_MERGE }],
      });
      await tick();
      const card = cards().find((entry) => entry.id === id);
      expect(card?.title).toBe(story.title);
      expect(splitSettleFacts(card?.body ?? "")?.body).toBe(presentationCardBody(story));
      expect(tasks.get(taskId)?.delivery?.completionOffers?.at(-1)?.presentationRevision).toBe(1);
      if (destination !== "hosted")
        expect(tasks.get(taskId)?.delivery?.completionOffers?.at(-1)?.prNumber).toBeUndefined();
      tasks.delivery.updateChangePresentation(taskId, (record) => {
        if (!record) throw new Error("Missing story");
        return { ...record, revisions: [...record.revisions, { ...story, revision: 2 }] };
      });
      if (!card) throw new Error("Missing completion card");
      expect(() => supervisor.cardActions.act(card.id, "merge")).toThrow();
      expect(mergePullRequest).not.toHaveBeenCalled();
    },
  );

  // INF-2509, INF-1868's answer 5, the captain: "The host republishes the declared story at the
  // new head itself and refuses nothing; the merge still carries the story you saw." The card
  // the author named by its own revision offers the republished one, so the click merges.
  it("offers the story the host republished at the pushed version, and its click merges (INF-2509)", async () => {
    const crewmate = fakeCrewmate();
    const pushed = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
    let story: ChangePresentation;
    const completionPresentation = vi.fn(async () => ({
      title: story.title,
      body: presentationCardBody(story),
      riskDeclaration: story.risk,
      requiredActions: story.requiredActions,
      pictures: story.pictures,
      revision: 2,
    }));
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Merged" }));
    const { supervisor, tasks, specs, cards } = setup(crewmate, {
      checkCi: async () => "green",
      completionPresentation,
      mergePullRequest,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Share the completed change",
      intent: intentOf("share the same story"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    // INF-2744: autonomy off, so the merge card waits for the captain's click.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    story = {
      version: 1,
      taskId,
      revision: 2,
      destination: {
        host: "github.com",
        projectId: 1,
        fullName: "octo/meter",
        visibility: "private",
      },
      title: "The upload survives restart",
      base: "5ca2d466ee21f9733827383f23df81f3874e0d10",
      head: pushed,
      why: ["Confirmed uploads must not be sent twice."],
      whatChanged: ["The task keeps each confirmed receipt."],
      before: ["Restart lost the receipt."],
      after: ["Restart reuses the receipt."],
      views: [],
      noPicture: "This changes upload recovery, not a visible view.",
      verification: ["Restart recovery passed."],
      risk: METER_RISK,
      requiredActions: [],
      unfinished: [],
      projectText: "",
      assets: [],
      pictures: [],
    };
    const region = presentationMarkdown(story, new Map(), "passed");
    // What the host left after republishing the author's revision 1 at the pushed version.
    const publication = {
      revision: 2,
      head: pushed,
      state: "confirmed" as const,
      region,
      regionHash: createHash("sha256").update(region).digest("hex"),
      contentHash: "approved-story-content",
      refreshOf: 1,
      number: 1,
    };
    tasks.delivery.updateChangePresentation(taskId, () => ({
      revisions: [story],
      receipts: [],
      publication,
      published: publication,
    }));
    seedDelivery(tasks, taskId, { headSha: pushed, prNumber: 1, ci: "green" });
    const id = await specs[0]?.onCard?.({
      title: "Ignored duplicate title",
      body: "",
      presentationRevision: 1,
      actions: [{ id: "merge", effect: SETTLE_MERGE }],
    });
    await tick();
    expect(completionPresentation).toHaveBeenCalledWith(taskId, 1);
    expect(tasks.get(taskId)?.delivery?.completionOffers?.at(-1)).toMatchObject({
      presentationRevision: 2,
      headSha: pushed,
      presentationContentHash: "approved-story-content",
    });
    const card = cards().find((entry) => entry.id === id);
    if (!card) throw new Error("Missing completion card");
    expect(card.title).toBe(story.title);
    crewmate.finishPrompt();
    await tick();
    supervisor.cardActions.act(card.id, "merge");
    await vi.waitFor(() => expect(mergePullRequest).toHaveBeenCalledTimes(1));
  });

  it("publishes the merge card, with a fresh CI reading, once CI is green", async () => {
    const crewmate = fakeCrewmate();
    const checkCi = vi.fn(async () => "green" as const);
    const { supervisor, specs, cards } = setup(crewmate, { checkCi });
    await supervisor.intake.commission({
      title: "Ship the fix",
      intent: intentOf("finish the PR"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    // INF-2744: autonomy off, so the merge card waits for the captain's click.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);

    const result = specs[0]?.onCard?.({
      requiredActions: [],
      title: "Ready to merge",
      body: completionBody(
        "<p>The PR is open.</p><p>All changes are pushed and the worktree is clean.</p>",
      ),
      actions: [
        { id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });
    const id = await result;
    await tick();

    expect(checkCi).toHaveBeenCalledTimes(1);
    const card = cards().find((entry) => entry.id === id);
    expect(card?.title).toBe("Ready to merge");
    expect(card?.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "merge", default: true })]),
    );
  });

  it("never calls checkCi for a card without a merge decision", async () => {
    const crewmate = fakeCrewmate();
    const checkCi = vi.fn(async () => "pending" as const);
    const { supervisor, specs, cards } = setup(crewmate, { checkCi });
    await supervisor.intake.commission({ title: "Investigate", intent: intentOf("look into it") });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");

    const result = specs[0]?.onCard?.({
      title: "Here is what I found",
      body: "<p>Just a note.</p>",
      actions: [],
    });

    expect(result).not.toBeInstanceOf(Promise);
    expect(checkCi).not.toHaveBeenCalled();
    await tick();
    expect(cards().map((card) => card.title)).toContain("Here is what I found");
  });

  it("never calls checkCi for a local-only task's Land decision", async () => {
    const crewmate = fakeCrewmate();
    const checkCi = vi.fn(async () => "pending" as const);
    const { supervisor, specs, cards } = setup(crewmate, { checkCi });
    await supervisor.intake.commission({
      title: "Fix locally",
      intent: intentOf("fix it"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("local-only");

    const result = specs[0]?.onCard?.({
      requiredActions: [],
      title: "Ready to land",
      body: completionBody(
        "<p>Local work is done.</p><p>The branch is committed and the tests pass.</p>",
      ),
      actions: [
        { id: "land", label: "Land locally", default: true, effect: SETTLE_MERGE },
        { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
      ],
    });

    expect(result).not.toBeInstanceOf(Promise);
    expect(checkCi).not.toHaveBeenCalled();
    await tick();
    expect(cards().map((card) => card.title)).toContain("Ready to land");
  });
});

/**
 * FI3-401: PR #549's crewmate had its completion card refused by the CI
 * gate a second after asking, then reported "Completion card emitted", and
 * the Firstmate relayed that card to the captain. The refusal is a fact the
 * host holds; the report wake and crew_status carry it beside the report.
 * Every emit below goes through the crewmate's real emit_card tool.
 */
describe("a refused completion card is a fact the Firstmate reads (FI3-401)", () => {
  const merge = [{ id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE }];

  async function shipping(checks: { overall: import("./changeChecks").PrCiOverall }) {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate, { checkCi: async () => checks.overall });
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Ship the fix",
      intent: intentOf("finish the PR"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(harness.supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    const emitCard = bindTool(EMIT_CARD_TOOL, harness.specs[0] as CrewmateSpec);
    return { ...harness, crewmate, taskId, emitCard };
  }

  it("records a missing-target refusal, names it beside a report that says the card went up, and clears it once the card goes up (INF-2744)", async () => {
    const checks: { overall: import("./changeChecks").PrCiOverall } = { overall: "no-pr" };
    const { supervisor, tasks, ops, ledger, ledgerFacts, cards, crewmate, taskId, emitCard } =
      await shipping(checks);

    await expect(
      emitCard.run({
        required_actions: [],
        title: "Ready to merge",
        body: completionBody("<p>The PR is open.</p>"),
        actions: merge,
        risk: METER_RISK,
      }),
    ).rejects.toThrow(/no open pull request was found/);
    await tick();
    expect(cards()).toEqual([]);

    const refusal = tasks.get(taskId)?.delivery?.cardRefusal;
    expect(refusal).toEqual({
      at: expect.any(Number),
      title: "Ready to merge",
      reason: "checks",
      why: "no open pull request was found for its branch",
    });
    const at = new Date(refusal?.at ?? 0).toISOString();
    expect(
      tasks.timeline(taskId).find((event) => event.data?.cardRefusal !== undefined),
    ).toMatchObject({
      kind: "note",
      actor: "host",
      // INF-2744: the completion card is the merge card.
      text: 'merge card "Ready to merge" refused: no open pull request was found for its branch',
    });

    await reportTurn(crewmate, taskId, "Completion card emitted.");
    expect(ops).toEqual([
      `[fm-op] crewmate 1 reported on task ${taskId} "Ship the fix": Completion card emitted. The host refused its merge card "Ready to merge" at ${at}: no open pull request was found for its branch. That card did not reach the captain, and no card of its is on the captain's screen.`,
    ]);
    expect(ledgerFacts.at(-1)).toMatchObject({
      kind: "report",
      cards: [],
      refused: { title: "Ready to merge", reason: "checks", at: refusal?.at },
    });
    expect(supervisor.facts.crewStatus(taskId)[0]?.cardRefused).toEqual({
      title: "Ready to merge",
      at,
      reason: "checks",
      why: "no open pull request was found for its branch",
    });

    checks.overall = "green";
    await supervisor.steer.steerCrewmate(taskId, "the checks passed; emit the completion card");
    await tick();
    const shown = await emitCard.run({
      required_actions: [],
      title: "Ready to merge",
      body: completionBody("<p>The PR is open and its checks passed.</p>"),
      actions: merge,
      risk: METER_RISK,
    });
    expect(shown.text).toMatch(/^Card shown: Ready to merge/);
    expect(tasks.get(taskId)?.delivery?.cardRefusal).toBeUndefined();
    expect(supervisor.facts.crewStatus(taskId)[0]?.cardRefused).toBeUndefined();
    await reportTurn(crewmate, taskId, "Completion card emitted.");
    expect(ledger.at(-1)).not.toContain("refused");
    expect(ledger.at(-1)).toContain("Its card on the captain's screen:");
  });

  it("records a picture refusal before the host sees the card", async () => {
    const { tasks, taskId, emitCard, specs } = await shipping({ overall: "green" });
    // The working copy the picture is looked for in, without the picture.
    mkdirSync(specs[0]?.cwd ?? "", { recursive: true });
    await expect(
      emitCard.run({
        required_actions: [],
        title: "Ready to merge",
        body: completionBody('<p><img src="missing.png" alt="the meter after"></p>'),
        actions: merge,
        risk: METER_RISK,
      }),
    ).rejects.toThrow(/Card picture refused/);
    expect(tasks.get(taskId)?.delivery?.cardRefusal).toMatchObject({
      reason: "other",
      why: expect.stringMatching(/^Card picture refused: /),
    });
  });

  it("records nothing for a refused card that is no completion card, or on a task that has none", async () => {
    const { supervisor, tasks, taskId, emitCard } = await shipping({ overall: "pending" });
    await expect(
      emitCard.run({ id: "Not Kebab", title: "A note", body: "<p>Found it.</p>", actions: [] }),
    ).rejects.toThrow(/Card id must be kebab-case/);
    expect(tasks.get(taskId)?.delivery?.cardRefusal).toBeUndefined();
    expect(supervisor.facts.crewStatus(taskId)[0]).not.toHaveProperty("cardRefused");

    const reader = fakeCrewmate();
    const answer = setup(reader);
    const { taskId: answerId } = await answer.supervisor.intake.commission({
      title: "Read the router",
      intent: {
        goal: "explain the ladder",
        userWords: "how does routing pick a model?",
        constraints: [{ kind: "read-only" }],
      },
    });
    await tick();
    await expect(
      bindTool(EMIT_CARD_TOOL, answer.specs[0] as CrewmateSpec).run({
        required_actions: [],
        title: "Ready to merge",
        body: completionBody("<p>Nothing to merge.</p>"),
        actions: merge,
        risk: METER_RISK,
      }),
    ).rejects.toThrow(/deliverable is an answer/);
    expect(answer.tasks.get(answerId)?.delivery?.cardRefusal).toBeUndefined();
  });
});
