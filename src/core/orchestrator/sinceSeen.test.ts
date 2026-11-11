/**
 * What changed since the captain last saw a merge card (INF-3715, the
 * captain's direction A on its plan: "the crewmate writes, the app hands
 * over the facts"; docs/card-authoring.md "Since the card you saw"). A real
 * CrewSupervisor through the crew harness replays INF-3566's case: a merge
 * card the captain saw at +1,366 lines, then the same change's merge card
 * again at +4,562. Each case drives the crewmate's own card door and the
 * window's sighting, and reads the answer, the card and the saved story.
 */

import { createHash } from "node:crypto";
import type { Card } from "@shared/cards";
import type { ChangePresentation } from "@shared/changePresentation";
import { changeLinesWords } from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  METER_RISK,
  SETTLE_MERGE,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { presentationCardBody, presentationMarkdown } from "../forge";
import { seenAtWords, sinceSeenLabel } from "./sinceSeen";

fakeCrewTimersEachTest();

const BASE = "5ca2d466ee21f9733827383f23df81f3874e0d10";
const SEEN_HEAD = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
const NEXT_HEAD = "9f1e3b2a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f";
// INF-3566: seen on Nov 10 at 12:33 PM Pacific, shown again 11 hours later.
const SEEN_AT = Date.UTC(2026, 10, 10, 20, 33);
const NEXT_AT = Date.UTC(2026, 11 - 1, 11, 8, 5);

const SUMMARY =
  "Review repairs grew this from 1,366 to 4,562 added lines.\n\nMost of the growth is tests and fixtures.";

/** A task on a pull request whose saved story the host has published at `head`. */
async function storyTask() {
  let clock = SEEN_AT - 60_000;
  const crewmate = fakeCrewmate();
  let story: ChangePresentation;
  const completionPresentation = vi.fn(async () => ({
    title: story.title,
    body: presentationCardBody(story),
    riskDeclaration: story.risk,
    requiredActions: story.requiredActions,
    pictures: story.pictures,
  }));
  const h = setup(crewmate, {
    checkCi: async () => "green",
    completionPresentation,
    now: () => clock,
  });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Merge passed batches",
    intent: intentOf("merge passed batches without an open app"),
    shape: { rigor_ask: "quick" },
  });
  await tick();
  vi.spyOn(h.supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
  vi.spyOn(h.supervisor.facts, "taskAutonomy").mockReturnValue(false);
  /** The crewmate's change is at `head`, its story published there, its lines read there. */
  const at = (head: string, added: number, deleted: number) => {
    story = {
      version: 1,
      taskId,
      revision: 1,
      destination: {
        host: "github.com",
        projectId: 1,
        fullName: "octo/queue",
        visibility: "private",
      },
      title: "feat(queue): merge passed batches without an open app",
      base: BASE,
      head,
      why: ["A passed batch waited for the app to be open."],
      whatChanged: ["The queue merges a passed batch itself."],
      before: ["A passed batch waited."],
      after: ["A passed batch merges."],
      views: [],
      noPicture: "The queue merges where the project lives; nothing on screen changes.",
      verification: ["The queue's tests passed."],
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
      number: 7,
    };
    const saved = story;
    h.tasks.delivery.updateChangePresentation(taskId, () => ({
      revisions: [saved],
      receipts: [],
      publication,
      published: publication,
    }));
    seedDelivery(h.tasks, taskId, {
      headSha: head,
      prNumber: 7,
      ci: "green",
      changeLines: { base: BASE, head, added, deleted, at: clock },
    });
  };
  const emit = (sinceSeen?: string) =>
    h.specs[0]?.onCard?.({
      id: "queue-merge",
      title: "Ignored",
      body: "",
      presentationRevision: 1,
      actions: [{ id: "merge", effect: SETTLE_MERGE }],
      ...(sinceSeen !== undefined ? { sinceSeen } : {}),
    }) as Promise<string>;
  /** The card as its author last wrote it: a crewmate's write reaches the stage at its turn's end. */
  const card = () => h.supervisor.cards.newestForTask(taskId) as Card;
  /** The crewmate's turn ends, and the window has the card in front of the captain. */
  const seen = async () => {
    crewmate.finishPrompt();
    await tick();
    clock = SEEN_AT;
    h.supervisor.cards.seen(card().id, card().offerId as string);
  };
  return { ...h, taskId, at, emit, card, seen, setClock: (to: number) => (clock = to) };
}

describe("a merge card shown again after the captain saw one", () => {
  it("hands the crewmate when the captain saw the earlier card and its lines then and now, then draws its summary first (INF-3566)", async () => {
    const h = await storyTask();
    h.at(SEEN_HEAD, 1366, 80);
    const first = await h.emit();
    // A merge card the captain has not seen before carries no notice.
    expect(first).not.toContain("The captain last saw");
    await h.seen();
    expect(h.tasks.get(h.taskId)?.delivery?.seenMerge).toMatchObject({
      cardId: h.card().id,
      at: SEEN_AT,
      headSha: SEEN_HEAD,
      lines: { added: 1366, deleted: 80 },
    });

    // Review repairs push the change to 4,562 added lines; the crewmate shows its card again.
    h.setClock(NEXT_AT);
    h.at(NEXT_HEAD, 4562, 90);
    const again = await h.emit();
    expect(again).toContain(
      `The captain last saw a merge card for this change on ${seenAtWords(SEEN_AT)}`,
    );
    expect(again).toContain(
      `version ${SEEN_HEAD.slice(0, 12)} (story revision 1), ${changeLinesWords(1366, 80)}`,
    );
    expect(again).toContain(
      `This card offers version ${NEXT_HEAD.slice(0, 12)} (story revision 1), ${changeLinesWords(4562, 90)}`,
    );
    expect(again).toContain("since_seen");
    // Nothing is refused: the card went up without a summary.
    expect(h.card().body).not.toContain("data-since-seen");

    const drawn = await h.emit(SUMMARY);
    expect(drawn).toContain("Your since_seen summary is drawn first on this card.");
    const body = h.card().body;
    expect(body.startsWith('<section class="inf-since-seen" data-since-seen>')).toBe(true);
    expect(body).toContain(`<h6>${sinceSeenLabel(SEEN_AT)}</h6>`);
    expect(body).toContain(
      "<p>Review repairs grew this from 1,366 to 4,562 added lines.</p><p>Most of the growth is tests and fixtures.</p>",
    );
    // The summary is the captain's alone: the saved story and what it publishes never hold it.
    const kept = h.tasks.get(h.taskId)?.delivery?.presentation;
    expect(JSON.stringify(kept)).not.toContain("Review repairs grew");
    expect(h.card().title).toBe("feat(queue): merge passed batches without an open app");
  });

  it("leaves out a summary on a change whose merge card the captain never saw, and says so", async () => {
    const h = await storyTask();
    h.at(SEEN_HEAD, 1366, 80);
    const answer = await h.emit(SUMMARY);
    expect(answer).toContain("since_seen was left out");
    expect(answer).not.toContain("The captain last saw");
    expect(h.card().body).not.toContain("data-since-seen");
    expect(h.card().body).not.toContain("Review repairs grew");
  });

  it("gives no notice for a card at the version and story the captain already saw", async () => {
    const h = await storyTask();
    h.at(SEEN_HEAD, 1366, 80);
    await h.emit();
    await h.seen();
    const again = await h.emit(SUMMARY);
    expect(again).not.toContain("The captain last saw");
    expect(again).toContain("since_seen was left out");
    expect(h.card().body).not.toContain("data-since-seen");
  });
});
