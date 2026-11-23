import type { Card, CardMessage } from "@shared/cards";
import type { ChangePresentation } from "@shared/changePresentation";
import * as m from "@shared/i18n/messages.generated";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { describe, expect, it, vi } from "vitest";
import { presentationCardBody } from "./forge/presentation";
import { authorAnswer, CardNotifier, NOTICE_BODY_LIMIT, type NoticeFacts } from "./notifications";
import { pendingMergeLine } from "./orchestrator/settleWords";

function card(overrides: Partial<Card> & { id: string }): Card {
  return {
    author: "firstmate",
    priority: 15,
    title: "A note",
    meta: "firstmate",
    body: "First line.\nSecond line.",
    actions: [],
    status: "ready",
    createdAt: Date.now(),
    ...overrides,
  };
}

function notifier(
  overrides: { enabled?: boolean; focused?: boolean; facts?: (card: Card) => NoticeFacts } = {},
) {
  const show = vi.fn();
  const instance = new CardNotifier({
    enabled: () => overrides.enabled ?? true,
    focused: () => overrides.focused ?? false,
    show,
    ...(overrides.facts ? { facts: overrides.facts } : {}),
  });
  return { instance, show };
}

function noticeOf(arriving: Card, facts?: (card: Card) => NoticeFacts) {
  const { instance, show } = notifier(facts ? { facts } : {});
  instance.observe([]);
  instance.observe([arriving]);
  expect(show).toHaveBeenCalledTimes(1);
  return show.mock.calls[0]?.[0];
}

// The change behind the first notification of INF-5030's screenshot, as its
// saved story read: a pull request title in type(scope) form, a task title in
// plain words, and a body the host opens with the heading Why.
const TASK_TITLE = "Let standing directions approve check-only actions";
const WHAT_CHANGED =
  "A standing direction that allows a check now approves it, so the check runs without another card.";
const HEAD = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
const STORY: ChangePresentation = {
  version: 2,
  taskId: "inf-4968",
  revision: 1,
  title: "feat(validation): honor existing standing directions for check-only actions",
  base: HEAD,
  head: HEAD,
  destination: { kind: "branch", origin: "https://github.com/infinitary-labs/infinitary" },
  why: ["A standing direction already allowed some checks, but the app still asked for each one."],
  whatChanged: [WHAT_CHANGED, "The validation record names the direction that allowed each check."],
  before: ["Each check-only action raised its own card, even when a direction covered it."],
  after: ["A covered check runs at once, and its record cites the direction."],
  views: [],
  noPicture: "Nothing on screen changed: a card stops appearing.",
  checked: [{ check: "A covered check", result: "It ran with no card." }],
  verification: ["Ran the validation tests three times."],
  risk: Object.fromEntries(
    RISK_DIMENSIONS.map((dimension) => [dimension, { level: "low", why: "Validation only" }]),
  ) as RiskDeclaration,
  requiredActions: [],
  unfinished: [],
  projectText: "",
  pictures: [],
  assets: [],
};
const STORY_FACTS = { project: "infinitary", storyName: TASK_TITLE };

describe("CardNotifier", () => {
  it("INF-476 minimizing and restoring an open message never posts a notification", () => {
    const { instance, show } = notifier();
    const review = card({ id: "launch-review", title: "The launch review is ready" });
    instance.observe([review]);
    instance.observe([{ ...review, minimized: true }]);
    instance.observe([review]);
    expect(show).not.toHaveBeenCalled();
  });
  it("never notifies for the boot snapshot - restored cards are old news", () => {
    const { instance, show } = notifier();
    instance.observe([card({ id: "old-decision" })]);
    expect(show).not.toHaveBeenCalled();
    instance.observe([card({ id: "old-decision" })]);
    expect(show).not.toHaveBeenCalled();
  });

  it("shows a card body's visible text, never its HTML markup", () => {
    const { instance, show } = notifier();
    instance.observe([]);
    instance.observe([
      card({
        id: "h1",
        status: "ready",
        body: "<p>Keep it &amp; go; <b>now</b>.</p><p>Second</p><script>x()</script>",
      }),
    ]);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ body: "A note\nKeep it & go; now." }),
    );
  });

  it("notifies once for a card born ready, with its kind, title and first prose", () => {
    const { instance, show } = notifier();
    instance.observe([]);
    instance.observe([card({ id: "d1", title: "Pick a course" })]);
    expect(show).toHaveBeenCalledTimes(1);
    // The card's id rides along, so a click on the notification opens that card (INF-4243's plan, piece 5).
    expect(show).toHaveBeenCalledWith({
      kind: "card",
      title: m.uiCardKindNote(),
      body: "Pick a course\nFirst line. Second line.",
      cardId: "d1",
    });
    // A body update re-broadcasts the same ready card: no second ping.
    instance.observe([card({ id: "d1", title: "Pick a course" })]);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("notifies when a card reaches the stage, not while it awaits its author", () => {
    const { instance, show } = notifier();
    instance.observe([]);
    // A crewmate's new card waits for its close-out: not there yet.
    instance.observe([card({ id: "c1", title: "Pick a course", awaiting: "close-out" })]);
    expect(show).not.toHaveBeenCalled();
    instance.observe([card({ id: "c1", title: "Pick a course" })]);
    expect(show).toHaveBeenCalledTimes(1);
    // The captain replied: off the stage. Its return is an arrival.
    instance.observe([card({ id: "c1", title: "Pick a course", awaiting: "answer" })]);
    instance.observe([card({ id: "c1", title: "Pick a course, answered" })]);
    expect(show).toHaveBeenCalledTimes(2);
    // A card that arrives after awaiting its close-out is new; one that
    // returns with its author's answer is a reply (INF-4774's plan, "New card or Reply").
    expect(show).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "card" }));
    expect(show).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "reply", title: m.noticeReply() }),
    );
  });

  it("notifies when a replied-under card returns with its answer", () => {
    const { instance, show } = notifier();
    instance.observe([card({ id: "c1", title: "Pick a course" })]);
    // The captain replied: off the stage, nothing to say yet.
    instance.observe([card({ id: "c1", title: "Pick a course", awaiting: "answer" })]);
    instance.observe([card({ id: "c1", title: "Pick a course", awaiting: "close-out" })]);
    expect(show).not.toHaveBeenCalled();
    instance.observe([card({ id: "c1", title: "Pick a course, answered" })]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "reply", title: m.noticeReply() }),
    );
    instance.observe([card({ id: "c1", title: "Pick a course, answered" })]);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("notifies once when a kept card the captain replied under returns answered", () => {
    const { instance, show } = notifier();
    instance.observe([card({ id: "c1", title: "Pick a course" })]);
    // A reply never moves its card: it stays on the stage, stamped, while its author answers.
    const sentBackAt = Date.now();
    instance.observe([card({ id: "c1", title: "Pick a course", awaiting: "answer", sentBackAt })]);
    expect(show).not.toHaveBeenCalled();
    instance.observe([card({ id: "c1", title: "Pick a course, answered" })]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenLastCalledWith({
      kind: "reply",
      cardId: "c1",
      title: m.noticeReply(),
      body: "Pick a course, answered\nFirst line. Second line.",
    });
    instance.observe([card({ id: "c1", title: "Pick a course, answered" })]);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("stays silent while the window is focused", () => {
    const { instance, show } = notifier({ focused: true });
    instance.observe([]);
    instance.observe([card({ id: "d1" })]);
    expect(show).not.toHaveBeenCalled();
  });

  it("stays silent when the user turned notifications off", () => {
    const { instance, show } = notifier({ enabled: false });
    instance.observe([]);
    instance.observe([card({ id: "d1" })]);
    expect(show).not.toHaveBeenCalled();
  });

  it("can notify again for a card id that left the stack and returned", () => {
    const { instance, show } = notifier();
    instance.observe([]);
    instance.observe([card({ id: "d1" })]);
    instance.observe([]);
    // A returning decision (a re-raised auth card, a parked decision coming
    // back) is a new user-facing moment.
    instance.observe([card({ id: "d1" })]);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("starts over when told to forget: what the next snapshot holds is old news", () => {
    const { instance, show } = notifier();
    instance.observe([card({ id: "d1" })]);
    instance.forget();
    // Born and finished while nobody heard: the read after a reload only seeds.
    instance.observe([card({ id: "d1" }), card({ id: "d2" })]);
    expect(show).not.toHaveBeenCalled();
    instance.observe([card({ id: "d1" }), card({ id: "d2" }), card({ id: "d3", title: "New" })]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringMatching(/^New\n/) }),
    );
  });

  it("seeds from a read snapshot only until a push has seeded", () => {
    const read = notifier();
    read.instance.seed([card({ id: "d1" })]);
    read.instance.observe([card({ id: "d1" }), card({ id: "d2", title: "After the read" })]);
    expect(read.show).toHaveBeenCalledTimes(1);
    expect(read.show).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringMatching(/^After the read\n/) }),
    );

    // A push got there first: the read is no newer, and is ignored.
    const pushed = notifier();
    pushed.instance.observe([card({ id: "d1" }), card({ id: "d2" })]);
    pushed.instance.seed([card({ id: "d1" })]);
    pushed.instance.observe([card({ id: "d1" }), card({ id: "d2" })]);
    expect(pushed.show).not.toHaveBeenCalled();
  });

  describe("its words (INF-5030's plan, arrangement A)", () => {
    it("a merge card asks to merge in its project, names its task and says what changed", () => {
      const notice = noticeOf(
        card({
          id: "merge-standing-directions",
          author: "crewmate",
          title: STORY.title,
          body: presentationCardBody(STORY),
          actions: [{ id: "merge", label: "Merge", effect: { kind: "merge", after: "close" } }],
        }),
        () => STORY_FACTS,
      );
      expect(notice.title).toBe(
        m.noticeAskInProject({ ask: m.noticeReadyToMerge(), project: "infinitary" }),
      );
      expect(notice.body).toBe(`${TASK_TITLE}\n${WHAT_CHANGED}`);
      // The screenshot's faults: the heading Why, and the pull request title's prefix.
      expect(`${notice.title}\n${notice.body}`).not.toMatch(/\bWhy\b|feat\(/);
    });

    it("a story note says it merges on its own, past the app's merge line", () => {
      const notice = noticeOf(
        card({
          id: "story-note",
          author: "crewmate",
          title: STORY.title,
          body: `${pendingMergeLine("project")}${presentationCardBody(STORY)}`,
          actions: [],
          risk: { declared: STORY.risk },
        }),
        () => STORY_FACTS,
      );
      expect(notice.title).toBe(
        m.noticeAskInProject({ ask: m.mergesOnItsOwn(), project: "infinitary" }),
      );
      expect(notice.body).toBe(`${TASK_TITLE}\n${WHAT_CHANGED}`);
    });

    it("a crewmate's question is a decision, named by its own title, with its first sentence", () => {
      const notice = noticeOf(
        card({
          id: "port-question",
          author: "crewmate",
          title: "Give each journey its own port",
          body: [
            "<p>Two journeys read the same port, so one fails when both run at once.</p>",
            '<fieldset><legend>Which fix?</legend><label><input type="radio" name="fix" value="own"> Own port</label></fieldset>',
          ].join(""),
          actions: [
            { id: "approve", label: "Approve and build", default: true },
            { id: "defer", label: "Save and defer" },
          ],
        }),
        () => ({ project: "infinitary" }),
      );
      expect(notice.title).toBe(
        m.noticeAskInProject({ ask: m.uiCardKindDecision(), project: "infinitary" }),
      );
      expect(notice.body).toBe(
        "Give each journey its own port\nTwo journeys read the same port, so one fails when both run at once.",
      );
    });

    it("a note that opens with a heading and a drawing shows its first sentence", () => {
      const notice = noticeOf(
        card({
          id: "backup-note",
          title: "The nightly backup finished",
          body: [
            "<h3>Result</h3>",
            '<figure aria-label="Backup size"><svg viewBox="0 0 750 60"><text x="0" y="40">42 GB</text></svg></figure>',
            "<details><summary>Steps</summary><p>Copied every folder.</p></details>",
            "<p>All 1,204 files were copied to the backup disk.</p>",
          ].join(""),
        }),
      );
      // A card with no task has no project.
      expect(notice.title).toBe(m.uiCardKindNote());
      expect(notice.body).toBe(
        "The nightly backup finished\nAll 1,204 files were copied to the backup disk.",
      );
    });

    it("a body with no prose gives the name alone", () => {
      const notice = noticeOf(
        card({
          id: "chart",
          title: "This week's usage",
          body: '<figure aria-label="Usage"><svg viewBox="0 0 750 60"><text>12</text></svg></figure>',
        }),
      );
      expect(notice.body).toBe("This week's usage");
    });

    it("a reply shows the author's answer since the captain's reply", () => {
      const at = Date.now();
      const message = (id: number, who: CardMessage["who"], text: string): CardMessage => ({
        id,
        cardId: "c1",
        who,
        text,
        at: at + id,
      });
      const thread = [
        message(1, "crewmate", "I started on the port fix."),
        message(2, "captain", "Does it also cover the Linux journeys?"),
        message(3, "host", "Revised the card."),
        message(4, "crewmate", "Yes: each Linux journey takes its own port too."),
      ];
      expect(authorAnswer(thread)).toBe("Yes: each Linux journey takes its own port too.");
      // Answered only by a revision, or not replied under at all: no answer.
      expect(authorAnswer(thread.slice(0, 3))).toBeUndefined();
      expect(authorAnswer(thread.slice(0, 1))).toBeUndefined();

      const facts = vi.fn((_card: Card, kind: "card" | "reply") =>
        kind === "reply" ? { answer: authorAnswer(thread) } : {},
      );
      const show = vi.fn();
      const instance = new CardNotifier({ enabled: () => true, focused: () => false, show, facts });
      const question = card({
        id: "c1",
        author: "crewmate",
        title: "Give each journey its own port",
      });
      instance.observe([question]);
      instance.observe([{ ...question, awaiting: "answer" }]);
      instance.observe([question]);
      expect(show).toHaveBeenCalledWith({
        kind: "reply",
        cardId: "c1",
        title: m.noticeReply(),
        body: "Give each journey its own port\nYes: each Linux journey takes its own port too.",
      });
    });

    it("cuts a long body at a whole word with an ellipsis", () => {
      const sentence = "Every crewmate now names the work it finished in plain words. ";
      const notice = noticeOf(
        card({ id: "long", title: "A long note", body: `<p>${sentence.repeat(20)}</p>` }),
      );
      expect(notice.body.length).toBeLessThanOrEqual(NOTICE_BODY_LIMIT);
      expect(notice.body).toMatch(/ [a-z.]+…$/);
      expect(`${sentence.repeat(20)}`).toContain(notice.body.split("\n")[1]?.slice(0, -1).trim());
    });
  });
});
