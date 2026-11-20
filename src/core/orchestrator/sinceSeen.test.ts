/**
 * What changed since the captain last saw a merge card (INF-3715, the
 * captain's direction A on its plan: "the crewmate writes, the app hands
 * over the facts"; docs/card-authoring.md "Since the card you saw"). A real
 * CrewSupervisor through the crew harness replays INF-3566's case: a merge
 * card the captain saw at +1,366 lines, then the same change's merge card
 * again at +4,562. Each case drives the crewmate's own card door and the
 * window's sighting, and reads the answer, the card and the saved story.
 *
 * INF-5035: the sighting is today's report (`seenUpdate`), which every
 * window and phone has sent since protocol 16, and the older report keeps
 * the same record; the captain's own click keeps it too, and the label
 * names that click. INF-4801's case replays an approval whose change came
 * back at a new version.
 */

import { createHash } from "node:crypto";
import type { Card } from "@shared/cards";
import type { ChangePresentation } from "@shared/changePresentation";
import { englishOf, said } from "@shared/i18n/said";
import { changeLinesWords } from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import { BatchHostForge, standInGit } from "../../../tests/helpers/batchHost";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  METER_RISK,
  SETTLE_MERGE,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { standingApproval } from "../../../tests/helpers/settleHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { presentationCardBody, presentationMarkdown } from "../forge";
import { seedProject } from "../workspace/seedProject";
import { createOwnBatches } from "./ownBatches";
import { seenAtWords, sinceSeenSaid } from "./sinceSeen";

fakeCrewTimersEachTest();

const BASE = "5ca2d466ee21f9733827383f23df81f3874e0d10";
const SEEN_HEAD = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
const NEXT_HEAD = "9f1e3b2a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f";
// INF-3566: seen on Nov 10 at 12:33 PM Pacific, shown again 11 hours later.
const SEEN_AT = Date.UTC(2026, 10, 10, 20, 33);
const NEXT_AT = Date.UTC(2026, 11 - 1, 11, 8, 5);

// INF-4801's crewmate's own words on the card that came back.
const INF_4801_SUMMARY =
  "The batch returned this fix because the published contract was missing a field. I added it and nothing else changed.";

const SUMMARY =
  "Review repairs grew this from 1,366 to 4,562 added lines.\n\nMost of the growth is tests and fixtures.";

/** The app's label over a returning card's summary, as its English; undefined when the card draws none. */
function labelOf(body: string): string | undefined {
  const label = /^<section class="inf-since-seen" data-since-seen><h6 [^>]*>([^<]*)<\/h6>/.exec(
    body,
  )?.[1];
  return label
    ?.replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

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
  let cardId = "queue-merge";
  const emit = (sinceSeen?: string) =>
    h.specs[0]?.onCard?.({
      id: cardId,
      title: "Ignored",
      body: "",
      presentationRevision: 1,
      // A merge that keeps the task open: the app writes Not now beside it.
      actions: [{ id: "merge", effect: { ...SETTLE_MERGE, after: "continue" } }],
      ...(sinceSeen !== undefined ? { sinceSeen } : {}),
    }) as Promise<string>;
  /** The card as its author last wrote it: a crewmate's write reaches the stage at its turn's end. */
  const card = () => h.supervisor.cards.newestForTask(taskId) as Card;
  /**
   * The crewmate's turn ends, and the window has the card in front of the
   * captain: through today's report of the drawn update, or the older
   * report of the offer that a window before protocol 16 sends.
   */
  const seen = async (report: "update" | "offer" = "update") => {
    crewmate.finishPrompt();
    await tick();
    clock = SEEN_AT;
    if (report === "offer") {
      h.supervisor.cards.seen(card().id, card().offerId as string);
      return;
    }
    const shown = h.supervisor.cards.snapshot().find((entry) => entry.id === card().id);
    if (!shown?.lifecycleId || !shown.currentUpdateId) throw new Error("No drawn update to see.");
    h.supervisor.cards.seenUpdate(shown.id, shown.lifecycleId, shown.currentUpdateId);
  };
  /** The captain's own click on the card's button, at `when`; the crewmate shows its next card under a new id. */
  const click = async (actionId: string, when: number) => {
    crewmate.finishPrompt();
    await tick();
    clock = when;
    h.supervisor.cardActions.act(card().id, actionId);
    await tick();
    cardId = "queue-merge-2";
  };
  return { ...h, taskId, at, emit, card, seen, click, setClock: (to: number) => (clock = to) };
}

/**
 * The approved change goes in line at `head`, its batch's checks fail, and
 * the batch's repair sends it back with `reason`: the app's batch wiring
 * over the task record and the real kept approval, with GitHub stood in.
 */
async function sendBack(h: Awaited<ReturnType<typeof storyTask>>, head: string, reason: string) {
  const repo = "repo-queue";
  seedProject(h.db, {
    id: repo,
    name: "queue",
    path: "/code/queue",
    origin: "https://github.com/octo/queue.git",
    delivery: "queue-pr",
  });
  const record = h.tasks.get(h.taskId);
  if (!record?.branch) throw new Error("The task has no branch.");
  // The merge click keeps the captain's approval at the version the card offered.
  seedDelivery(h.tasks, h.taskId, {
    mergeAuthorization: standingApproval({
      target: {
        repoId: repo,
        host: "github.com",
        owner: "octo",
        name: "queue",
        branch: record.branch,
        // The kept approval of a pushed branch with no pull request, as ownBatches.test.ts keeps it.
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: head,
    }),
  });
  const forge = new BatchHostForge(head);
  const batches = createOwnBatches({
    repos: h.repos,
    forgeFor: () => forge,
    ticker: { now: () => NEXT_AT - 60_000, register: () => () => {} },
    tasks: h.tasks,
    presentations: {
      batchRegion: async () => ({ story: { projectText: "" } as never, region: "" }),
    },
    inbox: h.inbox,
    late: () => ({
      checks: { declaredAbsent: () => false },
      settling: {
        kept: { runMergeAuthorization: async () => {} },
        approvals: h.supervisor.settling.approvals,
      },
    }),
    firstmate: () => undefined,
    note: () => {},
    git: standInGit(forge),
  });
  batches.enqueue(repo, {
    taskId: h.taskId,
    branch: record.branch,
    head,
    title: "feat(queue): merge passed batches without an open app",
    body: "",
    at: NEXT_AT - 60_000,
  });
  await batches.pass(repo);
  forge.report([{ name: "unit-tests", state: "failure" }]);
  await batches.pass(repo);
  const refused = await batches.answer(repo, {
    action: "send-back",
    head: forge.batchHead,
    changes: [{ taskId: h.taskId, reason }],
  });
  if (refused) throw new Error(`The send-back was refused: ${refused}`);
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
    // Nothing is refused: the card went up without a summary, and says it came back.
    expect(labelOf(h.card().body)).toBe(englishOf(sinceSeenSaid({ at: SEEN_AT })));
    expect(h.card().body).not.toContain("<p>Review repairs grew");

    const drawn = await h.emit(SUMMARY);
    expect(drawn).toContain("Your since_seen summary is drawn first on this card.");
    const body = h.card().body;
    expect(body.startsWith('<section class="inf-since-seen" data-since-seen>')).toBe(true);
    expect(labelOf(body)).toBe(englishOf(said("cardSinceSeenSaw", { when: seenAtWords(SEEN_AT) })));
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
  it("keeps the earlier card through the older sighting report too, so the two reports cannot drift", async () => {
    const h = await storyTask();
    h.at(SEEN_HEAD, 1366, 80);
    await h.emit();
    await h.seen("offer");
    expect(h.tasks.get(h.taskId)?.delivery?.seenMerge).toMatchObject({
      cardId: h.card().id,
      at: SEEN_AT,
      headSha: SEEN_HEAD,
    });
  });

  it("names the captain's approval when the change they approved comes back from its batch at a new version (INF-4801)", async () => {
    const h = await storyTask();
    vi.spyOn(h.supervisor.facts, "taskDelivery").mockReturnValue("queue-pr");
    h.at(SEEN_HEAD, 1366, 80);
    await h.emit();
    await h.seen();
    // INF-4801: approved at 4:50 PM, which keeps the approval at that version and puts it in line.
    const approvedAt = SEEN_AT + 17 * 60_000;
    await h.click("merge", approvedAt);
    expect(h.tasks.get(h.taskId)?.delivery?.seenMerge).toMatchObject({
      at: approvedAt,
      act: { kind: "approved" },
      headSha: SEEN_HEAD,
    });
    // Its batch's checks failed and the batch's repair sent it back, through the app's own wiring.
    await sendBack(h, SEEN_HEAD, "the published contract was missing a field");
    // A send-back keeps the captain's approval (INF-5097, the captain's answer Keep).
    expect(h.tasks.get(h.taskId)?.delivery?.mergeAuthorization?.status).toBe("standing");
    // The crewmate repaired it and shows its card again at the new version.
    h.setClock(NEXT_AT);
    h.at(NEXT_HEAD, 1370, 80);
    const answer = await h.emit(INF_4801_SUMMARY);
    expect(answer).toContain(
      `The captain approved a merge card for this change on ${seenAtWords(approvedAt)}`,
    );
    const body = h.card().body;
    expect(labelOf(body)).toBe(
      englishOf(said("cardSinceSeenApproved", { when: seenAtWords(approvedAt) })),
    );
    expect(body).toContain(`<p>${INF_4801_SUMMARY}</p>`);
    // The summary comes first, above the story's Why.
    expect(body.indexOf(INF_4801_SUMMARY)).toBeLessThan(body.indexOf("A passed batch waited"));
  });

  it("keeps the captain's other button with no sighting before it, and names it", async () => {
    const h = await storyTask();
    h.at(SEEN_HEAD, 1366, 80);
    await h.emit();
    await h.click("not-now", SEEN_AT);
    expect(h.tasks.get(h.taskId)?.delivery?.seenMerge).toMatchObject({
      at: SEEN_AT,
      act: { kind: "chose", button: "Not now" },
    });
    h.setClock(NEXT_AT);
    h.at(NEXT_HEAD, 4562, 90);
    const answer = await h.emit();
    expect(answer).toContain(
      `The captain chose “Not now” on a merge card for this change on ${seenAtWords(SEEN_AT)}`,
    );
    // Without a summary the label stands alone, and the answer still asks for one.
    expect(labelOf(h.card().body)).toBe(
      englishOf(said("cardSinceSeenChose", { button: "Not now", when: seenAtWords(SEEN_AT) })),
    );
    expect(answer).toContain("Show this card again with the same id and since_seen");
  });
});
