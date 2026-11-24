import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import type { EmittedCardInput } from "../session/tools";
import { seedTask } from "../tasks/seedTask";
import type { CardService } from "./cardService";
import { renderWake } from "./wakes";

// INF-6523: a reviewer re-raised the captain's answered wording question
// under a new card id, after its round's notes and its read of the first
// card showed no answer. The question and answer below are that card's.
const QUESTION = "placed-kept-words";
const ANSWERS = [
  {
    name: QUESTION,
    values: ["fix-now"],
    labels: ["Fix the words now"],
    changed: true,
  },
];

function findingCard(
  legend: string,
  values: readonly string[] = ["fix-now", "leave"],
  extra: Partial<EmittedCardInput> = {},
): EmittedCardInput {
  const options = values
    .map(
      (value) => `<label><input type="radio" name="${QUESTION}" value="${value}"> ${value}</label>`,
    )
    .join("");
  return {
    title: "Review of INF-6521: one question waits",
    body: `<p>The change keeps words the captain placed.</p><fieldset><legend>${legend}</legend>${options}<label><input type="radio" name="${QUESTION}" value="other" data-inf-write-in> Something else</label></fieldset>`,
    actions: [
      { id: "send", label: "Send my answer", default: true },
      { id: "not-now", label: "Not now", declines: true },
    ],
    ...extra,
  };
}

/** A builder with two review rounds, and another builder with its own review. */
function world() {
  const { tasks, cardStore, make } = setup();
  seedTask(tasks, { id: "builder", title: "Keep placed words", status: "idle" });
  for (const [id, parentId] of [
    ["review-1", "builder"],
    ["review-2", "builder"],
    ["other-review", "other-builder"],
  ] as const) {
    if (parentId === "other-builder")
      seedTask(tasks, { id: parentId, title: "Other work", status: "idle" });
    seedTask(tasks, {
      id,
      title: "Review",
      status: "idle",
      parentId,
      shape: { kind: "review", kind_source: "host:review", basis: parentId },
    });
  }
  return { cards: make(), cardStore, tasks };
}

function answer(cards: CardService, id: string, action = "send", answers = ANSWERS): void {
  cards.resolve(cards.shown(id) as Card, action, action, answers);
}

describe("a question the captain already answered", () => {
  it("the card read says how a closed card ended, and an open card says nothing of it", () => {
    const { cards } = world();
    const id = cards.emitCrewmateCard(
      "review-1",
      { ...findingCard("Keep the words?"), id: "a" },
      "m",
    );
    expect(cards.cardRead(id)?.ended).toBeUndefined();
    answer(cards, id);
    expect(cards.cardRead(id)).toMatchObject({
      open: false,
      ended: {
        how: "chose",
        by: "captain",
        at: 1000,
        choice: { id: "send", label: "Send my answer" },
        answers: ['- placed-kept-words: "Fix the words now" (fix-now), changed'],
      },
    });
    const withdrawn = cards.emitCrewmateCard(
      "review-1",
      { ...findingCard("Keep the words?", ["title", "body"]), id: "b" },
      "m",
    );
    cards.close(withdrawn, { kind: "crewmate", taskId: "review-1" });
    const read = cards.cardRead(withdrawn)?.ended;
    expect(read).toMatchObject({ how: "author-withdrawal", answers: [] });
    expect(read?.choice).toBeUndefined();
  });

  it("refuses the same name and options on a new card, reworded, naming the earlier answer", () => {
    const { cards } = world();
    const first = cards.emitCrewmateCard(
      "review-1",
      { ...findingCard("Keep the words?"), id: "a" },
      "m",
    );
    answer(cards, first);
    const again = {
      ...findingCard("Should the placed words stay as the captain wrote them?"),
      title: "Review of INF-6521: the wording question",
      id: "b",
    };
    expect(() => cards.emitCrewmateCard("review-1", again, "m")).toThrow(
      /already answered this question on card "card-review-1-a" \("Review of INF-6521: one question waits"\), closed at 1970-01-01T00:00:01\.000Z by choosing "Send my answer"\.\nIts question "placed-kept-words" asked: "Keep the words\?", with the options "fix-now", "leave"\.\nTheir answers:\n- placed-kept-words: "Fix the words now" \(fix-now\), changed\n[\s\S]*asks_again \{card: "card-review-1-a", why\}/,
    );
    expect(cards.get("card-review-1-b")).toBeUndefined();
    const asked = cards.emitCrewmateCard(
      "review-1",
      { ...again, asksAgain: { card: first, why: "The builder changed the words since." } },
      "m",
    );
    expect(cards.get(asked)?.title).toBe(again.title);
  });

  it("lets the same name with other options through", () => {
    const { cards } = world();
    const first = cards.emitCrewmateCard(
      "review-1",
      { ...findingCard("Keep the words?"), id: "a" },
      "m",
    );
    answer(cards, first);
    const other = cards.emitCrewmateCard(
      "review-1",
      { ...findingCard("Which words?", ["title", "body"]), id: "b" },
      "m",
    );
    expect(cards.get(other)).toBeDefined();
  });

  it("lets a question through when the captain declined or put off the earlier card", () => {
    for (const close of ["not-now", "later"] as const) {
      const { cards } = world();
      const putOff = { id: "later", label: "Not until I ask", until: { kind: "word" as const } };
      const first = cards.emitCrewmateCard(
        "review-1",
        {
          ...findingCard("Keep the words?"),
          id: "a",
          actions: [...findingCard("").actions, putOff],
        },
        "m",
      );
      answer(cards, first, close);
      const again = cards.emitCrewmateCard(
        "review-1",
        { ...findingCard("Keep the words?"), id: "b" },
        "m",
      );
      expect(cards.get(again)).toBeDefined();
    }
  });

  it("refuses the repeat from another review of the same builder, never from another builder's", () => {
    const { cards } = world();
    const first = cards.emitCrewmateCard(
      "review-1",
      { ...findingCard("Keep the words?"), id: "a" },
      "m",
    );
    answer(cards, first);
    expect(() =>
      cards.emitCrewmateCard("review-2", { ...findingCard("Keep the words?"), id: "a" }, "m"),
    ).toThrow(/already answered this question on card "card-review-1-a"/);
    const other = cards.emitCrewmateCard(
      "other-review",
      { ...findingCard("Keep the words?"), id: "a" },
      "m",
    );
    expect(cards.get(other)).toBeDefined();
  });

  it("names the reviewer's open card on the builder's report wake", () => {
    const { cards } = world();
    const shown = cards.emitCrewmateCard(
      "review-1",
      { ...findingCard("Keep the words?"), id: "a" },
      "m",
    );
    const facts = () => ({
      kind: "report" as const,
      task: { id: "builder", title: "Keep placed words" },
      crewmate: "crewmate 1",
      excerpt: "Pushed the fix.",
      filed: [],
      ...cards.threads.wakeCards("builder"),
    });
    expect(renderWake({ facts: facts() })).toContain(
      `Its reviewer's Review finding card is on the captain's screen: ${shown} "Review of INF-6521: one question waits". The app already handed those findings to the reviewer and sends the captain's choice to this task, so ask nobody for a card about them.`,
    );
    answer(cards, shown);
    expect(renderWake({ facts: facts() })).not.toContain("Review finding card");
  });
});
