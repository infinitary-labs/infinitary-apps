/**
 * The story a crewmate published as it shows on a self-merging task's note and
 * as the captain's click on the first mate's merge card merges it
 * (docs/card-authoring.md). Each case drives a real CrewSupervisor through the
 * crew harness (tests/helpers/crewHarness.ts) and reads the cards and the record.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Card,
  isStoryNote,
  MERGE_CLOSES_WORDS,
  onStage,
  splitSettleFacts,
} from "@shared/cards";
import type { ChangePresentation } from "@shared/changePresentation";
import { SAID_MARK } from "@shared/i18n/said";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  METER_ACTION,
  METER_RISK,
  reboot,
  SETTLE_MERGE,
  type SetupExtras,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { type ForgePull, presentationCardBody, presentationMarkdown } from "../forge";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import { bindTool } from "../session/tools";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { MergeBoundary, MergeGuard } from "./changeMerge";
import { CrewFacts } from "./crewFacts";
import type { CrewmateSpec } from "./crewSession";
import { MERGES_NEXT_WORDS, mergedWords, pendingMergeLine } from "./settleWords";

fakeCrewTimersEachTest();

/** The one merge action a crewmate declares on its merge card (INF-2744). */
const MERGE_ACTION = { id: "merge", effect: SETTLE_MERGE };

describe("a crewmate's published story shows on a note and merges from its card", () => {
  // INF-547, the captain's direction C: a task that merges on its own shows
  // the crewmate's same story before the merge, on a note with no button.
  it("shows the published story on a note only when the task merges on its own (INF-547, INF-2744)", async () => {
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
    const { supervisor, tasks, specs, cards, db } = setup(crewmate, {
      checkCi: async () => "green",
      completionPresentation,
    });
    // INF-2744: the app keeps its own merge approval from the merge card,
    // which needs a project where the pull request lives.
    db.prepare(
      "INSERT INTO repos (id, path, name, added_at, origin, delivery, autonomy) VALUES (?, ?, ?, ?, ?, 'direct-pr', 1)",
    ).run(
      "meter",
      scratchDir("story-note-project"),
      "Meter",
      1,
      "https://github.com/octo/meter.git",
    );
    const { taskId } = await supervisor.intake.commission({
      title: "Share the completed change",
      intent: intentOf("share the same story"),
      shape: { rigor_ask: "quick" },
      repoId: "meter",
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
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
    const region = presentationMarkdown(story, new Map(), "passed");
    const publication = {
      revision: 1,
      head,
      state: "confirmed" as const,
      region,
      regionHash: createHash("sha256").update(region).digest("hex"),
      number: 1,
    };
    tasks.delivery.updateChangePresentation(taskId, () => ({ revisions: [story], receipts: [] }));
    seedDelivery(tasks, taskId, { headSha: head, prNumber: 1, ci: "green" });
    // INF-2490, the captain's q8: the first mate may offer the merge on any
    // change card. While the story is not published at its newest revision,
    // the offer is refused before it shows, also when revising a note.
    const firstmateNote = {
      taskId,
      title: "The change waits for its completion card",
      body: "<p>The crewmate owns the merge offer.</p>",
      actions: [],
    };
    const firstmateId = supervisor.addFirstmateCard(firstmateNote);
    const unchangedCard = supervisor.cards.snapshot().find((card) => card.id === firstmateId);
    const unchangedDelivery = tasks.get(taskId)?.delivery;
    const refusals: string[] = [];
    const mergeOffer = {
      ...firstmateNote,
      requiredActions: [],
      actions: [
        { id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE },
        { id: "wait", label: "Wait" },
      ],
    };
    for (const id of [undefined, firstmateId]) {
      expect(() => {
        try {
          supervisor.addFirstmateCard({ ...mergeOffer, id });
        } catch (error) {
          refusals.push(String(error));
          throw error;
        }
      }).toThrow("is not published at its newest revision");
      expect(supervisor.cards.snapshot()).toEqual([unchangedCard]);
      expect(tasks.get(taskId)?.delivery).toEqual(unchangedDelivery);
    }
    tasks.delivery.updateChangePresentation(taskId, () => ({
      revisions: [story],
      receipts: [],
      publication,
      published: publication,
    }));
    supervisor.addFirstmateCard({ ...mergeOffer, id: firstmateId });
    const offered = supervisor.cards.snapshot().find((card) => card.id === firstmateId);
    expect(offered?.actions.map((action) => action.id)).toContain("merge");
    expect(splitSettleFacts(offered?.body ?? "")?.facts).toContain(MERGE_CLOSES_WORDS.closes);
    const firstmateOffer = tasks.get(taskId)?.delivery?.completionOffers?.at(-1);
    expect(firstmateOffer).toMatchObject({
      cardId: firstmateId,
      headSha: head,
      presentationRevision: 1,
    });
    expect(firstmateOffer?.prNumber).toBeUndefined();
    const evidence = process.env.INFINITARY_MERGE_OFFER_EVIDENCE;
    if (evidence)
      writeFileSync(
        join(evidence, "emit-refusals.json"),
        JSON.stringify(
          {
            refusals,
            cards: supervisor.cards.snapshot(),
            deliveryUnchanged:
              JSON.stringify(tasks.get(taskId)?.delivery) === JSON.stringify(unchangedDelivery),
            completionOffers: tasks.get(taskId)?.delivery?.completionOffers ?? [],
          },
          null,
          2,
        ),
      );
    supervisor.closeCard(firstmateId, { kind: "firstmate" });
    // INF-968: reach the supervisor through the same tool Pi and Claude bind,
    // not onCard directly, which missed the tool's refusal of every story note.
    const emitCard = bindTool(EMIT_CARD_TOOL, specs[0] as CrewmateSpec);
    // INF-2744: a story with no merge action is refused whatever the
    // autonomy; a task that merges on its own shows its merge card too.
    const autonomy = vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    await expect(emitCard.run({ title: "Ignored", presentation: 1, actions: [] })).rejects.toThrow(
      /one merge action/,
    );
    autonomy.mockReturnValue(true);
    await expect(emitCard.run({ title: "Ignored", presentation: 1, actions: [] })).rejects.toThrow(
      /one merge action/,
    );
    expect(cards()).toHaveLength(0);
    expect(completionPresentation).not.toHaveBeenCalled();
    // With autonomy on, the app approves the merge from the merge card as it
    // goes up and shows it without buttons, as the story note.
    // INF-3060, "we should not take any guesses here": a copy that differs
    // from the saved story is refused, and an exact repeat is left out.
    // Each refusal names the field it refused (INF-3717 piece 1).
    for (const [differing, named] of [
      [{ body: "<p>My own account of the change.</p>" }, "Refused: body."],
      [
        { risk: { ...METER_RISK, blast: { level: "sometimes" } } },
        "Refused: risk (does not read as a risk declaration).",
      ],
      [
        { risk: { ...METER_RISK, blast: { level: "high", why: "Every upload path" } } },
        "Refused: risk (differs from the saved revision's).",
      ],
      [
        {
          required_actions: [] as unknown[],
          risk: { ...METER_RISK, deps: { level: "high", why: "A new package" } },
        },
        "Refused: risk (differs from the saved revision's).",
      ],
      [
        { required_actions: [METER_ACTION] },
        "Refused: required_actions (differ from the saved revision's).",
      ],
    ] as const) {
      const call = () =>
        emitCard.run({ title: "Ignored", presentation: 1, actions: [MERGE_ACTION], ...differing });
      await expect(call()).rejects.toThrow(/those facts come from its saved revision/);
      await expect(call()).rejects.toThrow(named);
    }
    expect(cards()).toHaveLength(0);
    const note = {
      title: "Ignored",
      presentation: 1,
      actions: [MERGE_ACTION],
      risk: METER_RISK,
      required_actions: [],
    };
    const result = await emitCard.run(note);
    await tick();
    const card = cards().find((entry) => entry.taskId === taskId);
    expect(result.text).toBe(
      `Card shown from presentation 1 (${card?.id}). The risk, required_actions you passed repeats the saved revision exactly, so the copy was left out.`,
    );
    expect(completionPresentation).toHaveBeenCalledWith(taskId, note.presentation);
    expect(card).toMatchObject({ author: "crewmate", title: story.title, actions: [] });
    expect(card?.body).toContain(presentationCardBody(story));
    // INF-1219, the captain's words: "it misses the radar chart, and also
    // it's not clear that this was a change merged by itself". The note
    // keeps the story's risk, on the card and the task, opens with the line
    // that says it merges on its own, and carries the merge card's facts.
    expect(card?.risk).toEqual({ declared: METER_RISK });
    expect(tasks.get(taskId)?.delivery?.risk).toEqual({ declared: METER_RISK });
    expect(card?.body.startsWith(pendingMergeLine("project"))).toBe(true);
    expect(card && splitSettleFacts(card.body)?.facts).toContain('data-fact="change"');
    // INF-2744: it is the merge card, so it carries the story's required
    // actions, none here.
    expect(card?.requiredActions).toEqual([]);
    // INF-2744: the crewmate's merge card records its own offer beside the
    // first mate's, the one the app's approval merges.
    expect(tasks.get(taskId)?.delivery?.completionOffers?.at(-1)).toMatchObject({
      cardId: card?.id,
      presentationRevision: 1,
    });
    expect(tasks.get(taskId)?.delivery?.mergeAuthorization).toMatchObject({
      issuer: "autonomy",
      status: "standing",
    });
  });

  /**
   * A task that merges on its own, its story note held for the merge. With
   * `ask`, the captain's message was first answered on the first mate's own
   * decision card, and the first mate started the work under that message:
   * INF-2677's case, where the note kept "Merges on its own" (INF-2678).
   */
  async function heldStoryNote(
    ask?: { pick: boolean },
    extras: Pick<SetupExtras, "readPull"> = {},
  ) {
    const crewmate = fakeCrewmate();
    const head = "5ca2d466ee21f9733827383f23df81f3874e0d10";
    let story: ChangePresentation;
    const completionPresentation = vi.fn(async () => ({
      title: story.title,
      body: presentationCardBody(story),
      riskDeclaration: story.risk,
      requiredActions: story.requiredActions,
      pictures: story.pictures,
    }));
    // INF-2744: a check still runs when the turn ends, so the app's approval
    // from the merge card waits for it; each case decides how it merges.
    let checks: "green" | "pending" = "green";
    // The merge takes the settle's last look right before it sends, as the
    // forge's merge does (`ChangeMerges.merge`), and waits on a running
    // check as its guard does.
    const mergePullRequest = vi.fn(
      async (_taskId: string, _guard?: MergeGuard, boundary?: MergeBoundary) => {
        if (checks === "pending")
          return {
            ok: false,
            text: "Cannot merge yet - a check is still running.",
            notGreen: true,
            stop: "checks" as const,
          };
        const withdrawn = boundary?.beforeDispatch(head);
        return withdrawn
          ? { ok: false, text: `Cannot merge: ${withdrawn}` }
          : // A real merge answers with the version it merged, which the
            // change's receipt keeps (INF-2744: the app's own merge reads
            // "on its own" from that receipt).
            { ok: true, text: "Merged #1 on GitHub.", receipt: { head } };
      },
    );
    const harness = setup(crewmate, {
      checkCi: async () => checks,
      completionPresentation,
      mergePullRequest,
      ...extras,
    });
    const { supervisor, tasks, specs } = harness;
    let answerCard: string | undefined;
    let askId: string | undefined;
    if (ask) {
      const message = tasks.capture.openAsk({
        id: "ask-release-watch",
        text: "did the release workflow watch catch the last main failure?",
      });
      askId = message.id;
      seedTask(tasks, {
        id: "answer-decision",
        title: "No: it watches only releases",
        kind: "decision",
        status: "running",
      });
      tasks.capture.attachAsk(message.id, "answer-decision", "tool:emit_card");
      answerCard = supervisor.addFirstmateCard({
        title: "No: it watches only releases",
        body: "<p>No. Pick what to do.</p>",
        actions: [{ id: "picked", label: "Do what I picked", default: true }],
        taskId: "answer-decision",
      });
      tasks.capture.closeAsk(message.id, "closed");
      await tick();
      if (ask.pick) {
        supervisor.cardActions.act(answerCard, "picked");
        await tick();
      }
    }
    // INF-2744: the app keeps its own merge approval from the merge card,
    // which needs a project where the pull request lives.
    harness.db
      .prepare(
        "INSERT INTO repos (id, path, name, added_at, origin, delivery, autonomy) VALUES (?, ?, ?, ?, ?, 'direct-pr', 1)",
      )
      .run(
        "meter",
        scratchDir("held-note-project"),
        "Meter",
        1,
        "https://github.com/octo/meter.git",
      );
    const { taskId } = await supervisor.intake.commission({
      title: "Share the completed change",
      intent: intentOf("share the same story"),
      shape: { rigor_ask: "quick" },
      repoId: "meter",
    });
    // The first mate names the same message on the work it starts.
    if (askId) tasks.capture.attachAsk(askId, taskId, "tool:spawn_crewmate");
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(true);
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
    const region = presentationMarkdown(story, new Map(), "passed");
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
      publication,
      published: publication,
    }));
    seedDelivery(tasks, taskId, { headSha: head, prNumber: 1, ci: "green" });
    const emitCard = bindTool(EMIT_CARD_TOOL, specs[0] as CrewmateSpec);
    // INF-2744: the crewmate shows its merge card as any task does; with
    // autonomy on the app authorizes the merge from it as it goes up, and
    // the card keeps no buttons, so it reads as the held story note.
    await emitCard.run({ title: "Ignored", presentation: 1, actions: [MERGE_ACTION] });
    checks = "pending";
    seedDelivery(tasks, taskId, { ci: "pending" });
    crewmate.finishPrompt();
    await tick();
    /** The checks pass again: the app's approval may merge, and so may the first mate. */
    // The merge attempts that waited on the running check are forgotten, so
    // each case counts only the merges sent once the checks pass.
    const checksPass = () => {
      mergePullRequest.mockClear();
      checks = "green";
      seedDelivery(tasks, taskId, { ci: "green" });
    };
    const note = () =>
      supervisor.cards.snapshot().find((card) => card.taskId === taskId && isStoryNote(card));
    expect(note()?.body).toContain(MERGES_NEXT_WORDS);
    expect(note()?.awaiting).toBe("close-out");
    expect(onStage(note() as Card)).toBe(false);
    return {
      ...harness,
      crewmate,
      emitCard,
      mergePullRequest,
      taskId,
      note,
      answerCard,
      checksPass,
    };
  }

  const mergeLineOf = (card: Card | undefined) =>
    card?.body.slice(0, card.body.indexOf("</p>") + 4) ?? "";

  // INF-2533, the captain's words: "we should probably not show the note
  // card and wait for the final update with "merged on its own" already
  // present". The story note waits off the stack through its crewmate's
  // close-out, and the first mate's merge shows it once, already merged.
  // INF-2744: the merge is the app's own, from the merge card, with no
  // first mate turn.
  it("keeps a self-merging task's story note off the stack until the app's merge from its card, then shows it once saying it merged (INF-2533, INF-2744)", async () => {
    const { supervisor, tasks, taskId, note, mergePullRequest, checksPass } = await heldStoryNote();
    expect(tasks.get(taskId)?.delivery?.mergeAuthorization).toMatchObject({
      issuer: "autonomy",
      status: "standing",
    });
    checksPass();
    await supervisor.settling.kept.runMergeAuthorization(taskId);
    await tick();
    expect(mergePullRequest).toHaveBeenCalledOnce();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" });
    const shown = note() as Card;
    expect(onStage(shown)).toBe(true);
    expect(shown.body).toContain(mergedWords("", true).trim());
    expect(shown.body).not.toContain(MERGES_NEXT_WORDS);
    expect(supervisor.cards.snapshot()).toHaveLength(1);
    expect(
      tasks
        .timeline(taskId)
        .filter((event) => event.kind === "card_raised" && event.ref === shown.id),
    ).toHaveLength(1);
  });

  // INF-2761, from INF-2695's crewmate: its reports waited on the captain to
  // read its story note, and every first mate merge was refused as "another
  // decision or hold still needs attention". The note stays off the stack
  // until the merge has a result, so a wait on it can only end after the
  // merge: it holds the merge no more than a wait on a merge offer does.
  it("merges a self-merging task whose crewmate waits on the captain to read its held story note (INF-2761, INF-2744)", async () => {
    const { supervisor, tasks, taskId, note, mergePullRequest, specs, crewmate, checksPass } =
      await heldStoryNote();
    const held = note() as Card;
    await supervisor.steer.steerCrewmate(taskId, "the checks passed; report");
    await tick();
    await specs[0]?.onReport?.(
      "PR #1 is green and its story note is up; it merges on its own.",
      undefined,
      {
        wait: { reason: "read the completion note", cardId: held.id },
        needsFirstmate: "merge pull request #1",
      },
    );
    await endTurn(crewmate, taskId);
    const waiting = tasks.get(taskId);
    expect(waiting?.delivery?.captainWait).toMatchObject({ cardId: held.id });
    // INF-2744: the app's approval from the merge card merges once the checks
    // pass; the wait on the held note holds nothing, and no first mate turn runs.
    checksPass();
    await supervisor.settling.kept.runMergeAuthorization(taskId);
    await tick();
    expect(mergePullRequest).toHaveBeenCalledOnce();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" });
    expect(onStage(note() as Card)).toBe(true);
  });

  // INF-2678, the captain's screenshot of INF-2677's note: "these cards now
  // doesn't update to "merged"? it still says "merges"". The captain's
  // message was answered on the first mate's card and their pick started
  // the fix under the same message; the merge closed the task with the
  // first mate's sentence. The change's receipt draws the note's merged
  // line whichever card answered the message, and the sentence goes on the
  // note's merged line only (the captain's pick on INF-2678's plan).
  it.each([
    ["the captain picked on the first mate's card", true],
    ["the first mate's card still up", false],
  ])(
    "shows a self-merging note merged with the first mate's sentence when the message was answered on another card: %s (INF-2678)",
    async (_label, pick) => {
      const SENTENCE =
        "I merged PR #1, which keeps each confirmed upload, under your rule for main fixes.";
      const { supervisor, tasks, taskId, note, answerCard, checksPass } = await heldStoryNote({
        pick,
      });
      // The first mate's own merge, for the captain's spoken words.
      checksPass();
      await supervisor.settling.closing.withClosingSentence(taskId, SENTENCE, () =>
        supervisor.settling.settle.settleTaskDetailed(taskId, "merge-pr"),
      );
      await tick();
      expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" });
      const shown = note() as Card;
      expect(onStage(shown)).toBe(true);
      const line = mergeLineOf(shown);
      expect(line).toContain(mergedWords("", true).trim());
      expect(line).toContain("PR #1");
      expect(line).toContain(SENTENCE);
      expect(shown.body).not.toContain(MERGES_NEXT_WORDS);
      expect(
        tasks
          .timeline(taskId)
          .filter((event) => event.kind === "card_raised" && event.ref === shown.id),
      ).toHaveLength(1);
      const others = supervisor.cards.snapshot().filter((card) => card.id !== shown.id);
      expect(others.map((card) => card.id)).toEqual(pick ? [] : [answerCard]);
      for (const card of others) expect(card.body).not.toContain(SENTENCE);
    },
  );

  // INF-2678's re-review: a release close counts as merging, so its
  // sentence goes on the note's merged line once: the close does not also
  // write a close line with it on the note that answers the message.
  it("puts a release close's sentence on the note's merged line only (INF-2678)", async () => {
    const SENTENCE = "I closed this once version 1.2.3 shipped it.";
    const pull: ForgePull = {
      number: 1,
      state: "closed",
      merged: true,
      headSha: "5ca2d466ee21f9733827383f23df81f3874e0d10",
      branch: "fm/task-x",
      base: "main",
      readiness: "clean",
    };
    const { supervisor, tasks, taskId, note } = await heldStoryNote(undefined, {
      readPull: async (_id, number) => (number === 1 ? pull : undefined),
    });
    const message = tasks.capture.openAsk({ id: "ask-release", text: "did the upload fix ship?" });
    tasks.capture.attachAsk(message.id, taskId, "tool:spawn_crewmate");
    tasks.turns.recordReport(taskId, { text: "Version 1.2.3 shipped the change." });
    await supervisor.settling.closing.withClosingSentence(taskId, SENTENCE, () =>
      supervisor.settling.done.close(taskId, { why: "released", evidence: "v1.2.3 published" }),
    );
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "released" });
    const shown = note() as Card;
    expect(onStage(shown)).toBe(true);
    expect(mergeLineOf(shown)).toContain(SENTENCE);
    // Once in the words the card shows; the merged line's fact on its mark
    // also carries the sentence, as what the line is worded from (docs/i18n.md, "Saved facts").
    const shownWords = shown.body.replace(new RegExp(` ${SAID_MARK}="[^"]*"`, "g"), "");
    expect(shownWords.split(SENTENCE)).toHaveLength(2);
    expect(supervisor.cards.snapshot().filter((card) => card.id !== shown.id)).toEqual([]);
  });

  // INF-2533 and INF-2678: a merge made where the project lives while a
  // question of its crewmate is still up keeps the task open. The held
  // note shows once that settle ends, with when it merged and that the task
  // continues, read from the change's receipt alone.
  //
  // INF-2678's re-review: a pull request merged outside the app after a
  // later push merges past its story's version; the note still tells that
  // merge, since a later story of a pull request needs a change of its own.
  it.each([
    ["at its story's version", "5ca2d466ee21f9733827383f23df81f3874e0d10"],
    ["after a later push", "7d0c3e1fa2b94c5d8e6f7a1b2c3d4e5f60718293"],
  ])(
    "shows a held story note with its merge time when a merge outside the app keeps the task open, %s (INF-2533, INF-2678)",
    async (_label, head) => {
      const pull: ForgePull = {
        number: 1,
        state: "closed",
        merged: true,
        headSha: head,
        branch: "fm/task-x",
        base: "main",
        readiness: "clean",
      };
      const { supervisor, tasks, taskId, note, specs } = await heldStoryNote(undefined, {
        readPull: async (_id, number) => (number === 1 ? pull : undefined),
      });
      await specs[0]?.onCard?.({
        title: "Keep the old receipts?",
        body: "<p>Should old receipts stay?</p>",
        actions: [
          { id: "keep", label: "Keep them", default: true },
          { id: "drop", label: "Drop them" },
        ],
      });
      await tick();
      expect(await supervisor.settling.settle.reconcileExternalMerge(taskId)).toBe(true);
      await tick();
      expect(tasks.get(taskId)).toMatchObject({ status: "active", delivery: { ci: "merged" } });
      const shown = note() as Card;
      expect(onStage(shown)).toBe(true);
      const at = new Date(tasks.get(taskId)?.delivery?.ciAt ?? Number.NaN).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      const line = mergeLineOf(shown);
      expect(line).toContain(mergedWords(at, true));
      expect(line).toContain(MERGE_CLOSES_WORDS.continues);
      expect(shown.body).not.toContain(MERGES_NEXT_WORDS);
      expect(
        tasks
          .timeline(taskId)
          .filter((event) => event.kind === "card_raised" && event.ref === shown.id),
      ).toHaveLength(1);
    },
  );

  // INF-2678's review: the app quit after a merge was recorded and before
  // the held note was shown. The next start draws the line from the
  // receipt and shows the note once, without a settle to end.
  it("shows a held story note merged at the next start when the app quit after recording its merge (INF-2678)", async () => {
    const { supervisor, tasks, taskId, note, db, paths, workspace } = await heldStoryNote();
    const held = note() as Card;
    // The settle that read the merge recorded it, then the app quit before it ended.
    supervisor.settling.locks.claim(taskId, "merge-pr");
    tasks.delivery.recordChangeEvidence(taskId, { ci: "merged", ciAt: Date.now() });
    expect(note()?.awaiting).toBe("close-out");
    supervisor.disposeAll();
    const autonomy = vi.spyOn(CrewFacts.prototype, "taskAutonomy").mockReturnValue(true);
    const restartedTasks = new TaskService({ db, strict: true });
    const restarted = reboot(
      { paths, db, workspace },
      vi.fn(async () => fakeCrewmate()),
      { tasks: restartedTasks },
    );
    try {
      const shown = restarted.cards.snapshot().find((card) => card.id === held.id) as Card;
      expect(onStage(shown)).toBe(true);
      expect(mergeLineOf(shown)).toContain(MERGE_CLOSES_WORDS.continues);
      expect(shown.body).not.toContain(MERGES_NEXT_WORDS);
      expect(
        restartedTasks
          .timeline(taskId)
          .filter((event) => event.kind === "card_raised" && event.ref === held.id),
      ).toHaveLength(1);
    } finally {
      restarted.disposeAll();
      autonomy.mockRestore();
    }
  });

  // INF-2678's review: a story note made after an earlier merge of the same
  // change kept the task open is a new story: it waits for its own merge,
  // with its pending line, rather than borrowing the earlier merge's.
  it("holds a story note made after a merge that kept the task open for its own merge (INF-2678)", async () => {
    const head = "5ca2d466ee21f9733827383f23df81f3874e0d10";
    const pull: ForgePull = {
      number: 1,
      state: "closed",
      merged: true,
      headSha: head,
      branch: "fm/task-x",
      base: "main",
      readiness: "clean",
    };
    const { supervisor, crewmate, tasks, taskId, note, specs, emitCard, checksPass } =
      await heldStoryNote(undefined, {
        readPull: async (_id, number) => (number === 1 ? pull : undefined),
      });
    await specs[0]?.onCard?.({
      title: "Keep the old receipts?",
      body: "<p>Should old receipts stay?</p>",
      actions: [
        { id: "keep", label: "Keep them", default: true },
        { id: "drop", label: "Drop them" },
      ],
    });
    await tick();
    expect(await supervisor.settling.settle.reconcileExternalMerge(taskId)).toBe(true);
    await tick();
    const first = note() as Card;
    expect(onStage(first)).toBe(true);
    // INF-2744: the crewmate puts up its next merge card once the checks pass.
    checksPass();
    // INF-4018: the record still reads the pull request merged outside the
    // app, so the app's approval of that version does not hold the card.
    seedDelivery(tasks, taskId, { ci: "merged" });
    await emitCard.run({ title: "Ignored", presentation: 1, actions: [MERGE_ACTION] });
    crewmate.finishPrompt();
    await tick();
    const later = supervisor.cards
      .snapshot()
      .find((card) => card.taskId === taskId && isStoryNote(card) && card.id !== first.id) as Card;
    expect(later.createdAt).toBeGreaterThan(first.createdAt);
    expect(later.awaiting).toBe("close-out");
    expect(mergeLineOf(later)).toContain(MERGES_NEXT_WORDS);
    const held = supervisor.settling.locks.claim(taskId, "merge-pr");
    held.release();
    expect(supervisor.cards.get(later.id)?.awaiting).toBe("close-out");
  });

  // INF-2678's re-review: a note revised under its own id keeps its first
  // time. After a local merge kept the task open, the crewmate commits more
  // and revises its story note under the same id for the new version: that
  // revision waits for its own merge, not the earlier one's line.
  it("draws a same-id story revision for a later version with its own pending line (INF-2678)", async () => {
    const crewmate = fakeCrewmate();
    const head = "5ca2d466ee21f9733827383f23df81f3874e0d10";
    const later = "9e1f6c2b7d4a8053e6c1b2a7f9d0e3c4b5a69788";
    let stories: ChangePresentation[] = [];
    const completionPresentation = vi.fn(async (_taskId: string, revision: number) => {
      const story = stories.find((entry) => entry.revision === revision) as ChangePresentation;
      return {
        title: story.title,
        body: presentationCardBody(story),
        riskDeclaration: story.risk,
        requiredActions: story.requiredActions,
        pictures: story.pictures,
      };
    });
    const harness = setup(crewmate, {
      completionPresentation,
      validateLocalStory: async () => (stories.at(-1) as ChangePresentation).head,
    });
    const { supervisor, tasks, specs, workspace } = harness;
    (workspace.taskWorkStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      dirty: false,
      unlandedCommits: 1,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Share the completed change",
      intent: intentOf("share the same story"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("local-only");
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(true);
    const version = (revision: number, at: string): ChangePresentation => ({
      version: 1,
      taskId,
      revision,
      destination: { kind: "local", project: "repo-meter" },
      title: "The upload survives restart",
      base: head,
      head: at,
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
    });
    const prepare = (story: ChangePresentation) => {
      stories = [...stories, story];
      tasks.delivery.updateChangePresentation(taskId, () => ({
        revisions: stories,
        receipts: [],
        completion: {
          revision: story.revision,
          head: story.head,
          contentHash: "fixture-story-content",
        },
      }));
    };
    prepare(version(1, head));
    seedDelivery(tasks, taskId, { ci: "green" });
    const emitCard = bindTool(EMIT_CARD_TOOL, specs[0] as CrewmateSpec);
    // A question still open keeps the task open past its merge.
    await specs[0]?.onCard?.({
      title: "Keep the old receipts?",
      body: "<p>Should old receipts stay?</p>",
      actions: [
        { id: "keep", label: "Keep them", default: true },
        { id: "drop", label: "Drop them" },
      ],
    });
    // INF-2744: the crewmate shows its merge card, which the app keeps
    // without buttons as the story note.
    await emitCard.run({
      id: "meter-story",
      title: "Ignored",
      presentation: 1,
      actions: [MERGE_ACTION],
    });
    crewmate.finishPrompt();
    await tick();
    const note = () =>
      supervisor.cards
        .snapshot()
        .find((card) => card.taskId === taskId && isStoryNote(card)) as Card;
    // INF-2744: with autonomy on, the app merges from the merge card once
    // the crewmate's turn ends; the open question keeps the task open.
    expect(tasks.get(taskId)?.status).not.toBe("done");
    expect(tasks.get(taskId)?.delivery?.landedHead).toBe(head);
    await tick();
    const first = note();
    expect(onStage(first)).toBe(true);
    expect(mergeLineOf(first)).toContain(MERGE_CLOSES_WORDS.continues);
    prepare(version(2, later));
    await emitCard.run({
      id: first.id,
      title: "Ignored",
      presentation: 2,
      actions: [MERGE_ACTION],
    });
    await tick();
    const revised = supervisor.cards.get(first.id) as Card;
    expect(revised.createdAt).toBe(first.createdAt);
    expect(mergeLineOf(revised)).toContain(MERGES_NEXT_WORDS);
    expect(mergeLineOf(revised)).not.toContain(MERGE_CLOSES_WORDS.continues);
    const question = supervisor.cards
      .snapshot()
      .find((card) => card.title === "Keep the old receipts?") as Card;
    supervisor.cardActions.act(question.id, "keep");
    crewmate.finishPrompt();
    await tick();
    await supervisor.settling.settle.settleTaskDetailed(taskId, "land");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({
      status: "done",
      closedReason: "landed",
      delivery: { landedHead: later },
    });
    const merged = supervisor.cards.get(first.id) as Card;
    expect(mergeLineOf(merged)).not.toContain(MERGES_NEXT_WORDS);
    expect(mergeLineOf(merged)).not.toContain(MERGE_CLOSES_WORDS.continues);
  });

  // INF-2678's review: after a merge that kept the task open, a later close
  // that merged nothing leaves the line as the merge drew it - its own
  // time, and that the task continued - and adds no sentence of its own.
  it("keeps a merge's own line when a later close merged nothing (INF-2678)", async () => {
    const head = "5ca2d466ee21f9733827383f23df81f3874e0d10";
    const pull: ForgePull = {
      number: 1,
      state: "closed",
      merged: true,
      headSha: head,
      branch: "fm/task-x",
      base: "main",
      readiness: "clean",
    };
    const { supervisor, tasks, taskId, note, specs } = await heldStoryNote(undefined, {
      readPull: async (_id, number) => (number === 1 ? pull : undefined),
    });
    await specs[0]?.onCard?.({
      title: "Keep the old receipts?",
      body: "<p>Should old receipts stay?</p>",
      actions: [
        { id: "keep", label: "Keep them", default: true },
        { id: "drop", label: "Drop them" },
      ],
    });
    await tick();
    expect(await supervisor.settling.settle.reconcileExternalMerge(taskId)).toBe(true);
    await tick();
    const merged = mergeLineOf(note());
    expect(merged).toContain(MERGE_CLOSES_WORDS.continues);
    await supervisor.settling.closing.closeTask(taskId, {
      status: "done",
      reason: "finished",
      actor: "firstmate",
      text: "The receipts question is settled.",
    });
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "finished" });
    expect(mergeLineOf(note())).toBe(merged);
  });

  // INF-2678's review: a merge the captain's own click sent reads as theirs,
  // never as merged on its own: the review's receipt names who sent it.
  it("draws a captain-sent merge as the captain's on a held story note (INF-2678)", async () => {
    const { supervisor, tasks, taskId, note } = await heldStoryNote();
    const head = "5ca2d466ee21f9733827383f23df81f3874e0d10";
    const review = {
      id: "review-1",
      kind: "github" as const,
      host: "github.com",
      owner: "octo",
      name: "meter",
      number: 1,
      headSha: head,
      base: "main",
      branch: tasks.get(taskId)?.branch ?? "",
      method: "squash" as const,
      title: "The upload survives restart",
      at: Date.now(),
      receipt: { head, at: Date.now() + 1, by: "captain" as const },
    };
    const held = supervisor.settling.locks.claim(taskId, "merge-pr");
    tasks.delivery.recordPermissionRecords(taskId, { mergeReviews: [review] });
    held.release();
    const shown = note() as Card;
    expect(onStage(shown)).toBe(true);
    expect(mergeLineOf(shown)).toContain(mergedWords("", false).trim());
    expect(mergeLineOf(shown)).not.toContain(mergedWords("", true).trim());
  });

  // INF-2490, the captain's q8 "include first-mate-merge": the first mate's
  // merge card on a task with a published story passes the gate a crewmate's
  // completion card does. INF-3623: a commit after the card refuses its
  // click, a story revised at the card's version keeps it, and the click
  // merges the finishing change and closes the task as merged (q3, q6).
  it("merges on the captain's click of the first mate's merge card on a published story and closes the task as merged (INF-2490)", async () => {
    const crewmate = fakeCrewmate();
    const head = "5ca2d466ee21f9733827383f23df81f3874e0d10";
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Merged #1 on GitHub." }));
    const { supervisor, tasks } = setup(crewmate, {
      checkCi: async () => "green",
      mergePullRequest,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Share the completed change",
      intent: intentOf("share the same story"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    const story: ChangePresentation = {
      version: 1,
      taskId,
      revision: 1,
      destination: {
        host: "github.com",
        projectId: 1,
        fullName: "octo/meter",
        visibility: "private",
      },
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
    const published = (revision: ChangePresentation) => {
      const region = presentationMarkdown(revision, new Map(), "passed");
      return {
        revision: revision.revision,
        head: revision.head,
        state: "confirmed" as const,
        region,
        regionHash: createHash("sha256").update(region).digest("hex"),
        number: 1,
      };
    };
    tasks.delivery.updateChangePresentation(taskId, () => ({
      revisions: [story],
      receipts: [],
      publication: published(story),
      published: published(story),
    }));
    seedDelivery(tasks, taskId, { headSha: head, prNumber: 1, ci: "green" });
    const mergeOffer = {
      taskId,
      title: "The upload fix is ready to merge",
      body: "<p>The crewmate's story is published and its checks passed.</p>",
      requiredActions: [],
      actions: [
        { id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE },
        { id: "wait", label: "Wait" },
      ],
    };
    const cardId = supervisor.addFirstmateCard(mergeOffer);
    const second = { ...story, revision: 2, head: "6db3e577ff32a8844938494f34f92a940985e121" };
    const revise = (next: ChangePresentation, publish = false) =>
      tasks.delivery.updateChangePresentation(taskId, (record) =>
        publish
          ? { ...record!, publication: published(next), published: published(next) }
          : { ...record!, revisions: [...record!.revisions, next] },
      );
    revise(second);
    expect(() => supervisor.cardActions.act(cardId, "merge")).toThrow();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(tasks.get(taskId)?.status).not.toBe("done");
    revise(second, true);
    seedDelivery(tasks, taskId, { headSha: second.head });
    supervisor.addFirstmateCard({ ...mergeOffer, id: cardId });
    expect(tasks.get(taskId)?.delivery?.completionOffers?.at(-1)).toMatchObject({
      cardId,
      headSha: second.head,
      presentationRevision: 2,
    });
    revise({ ...second, revision: 3, after: ["Restart reuses each receipt."] });
    supervisor.cardActions.act(cardId, "merge");
    await vi.waitFor(() =>
      expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "merged" }),
    );
    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(tasks.timeline(taskId).find((event) => event.kind === "merged")).toMatchObject({
      actor: "captain",
      text: "Merged #1 on GitHub.",
    });
  });
});
