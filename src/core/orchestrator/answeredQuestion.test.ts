import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import type { EmittedCardInput } from "../session/tools";
import { seedTask } from "../tasks/seedTask";
import type { CardService } from "./cardService";
import { readerSavedAnswer } from "./readerData";

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
function world(clock = { now: 1000 }) {
  const { tasks, cardStore, make } = setup(undefined, () => clock.now);
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

  it("counts only the newest answer, so a deliberate re-ask can be asked again", () => {
    const clock = { now: 1000 };
    const { cards } = world(clock);
    const first = cards.emitCrewmateCard("review-1", { ...findingCard("Keep?"), id: "a" }, "m");
    answer(cards, first);
    clock.now = 2000;
    const why = "The builder changed the words since.";
    const second = cards.emitCrewmateCard(
      "review-1",
      { ...findingCard("Keep?"), id: "b", asksAgain: { card: first, why } },
      "m",
    );
    answer(cards, second, "send", [
      { name: QUESTION, values: ["leave"], labels: ["Leave as built"], changed: true },
    ]);
    clock.now = 3000;
    const third = { ...findingCard("Keep?"), id: "c" };
    for (const asksAgain of [undefined, { card: first, why }])
      expect(() =>
        cards.emitCrewmateCard("review-1", { ...third, ...(asksAgain ? { asksAgain } : {}) }, "m"),
      ).toThrow(
        /on card "card-review-1-b" [\s\S]*- placed-kept-words: "Leave as built" \(leave\), changed/,
      );
    const asked = cards.emitCrewmateCard(
      "review-1",
      { ...third, asksAgain: { card: second, why } },
      "m",
    );
    expect(cards.get(asked)).toBeDefined();
  });

  it("skips the check for a computer that cannot send asks_again", () => {
    const { cards } = world();
    const first = cards.emitCrewmateCard("review-1", { ...findingCard("Keep?"), id: "a" }, "m");
    answer(cards, first);
    const card = { ...findingCard("Keep?"), id: "b" };
    const shown = cards.emitCrewmateCard("review-1", card, "m", undefined, undefined, false);
    expect(cards.get(shown)).toBeDefined();
  });
  it("marks an unsafe data reader's words in the answers it serves back", () => {
    const { cards, tasks } = world();
    seedTask(tasks, {
      id: "reader",
      title: "Read the page",
      status: "idle",
      shape: { kind: "research", deliverable: "answer", unsafe_data_reader: true },
    });
    const first = cards.emitCrewmateCard("reader", { ...findingCard("Keep?"), id: "a" }, "m");
    answer(cards, first);
    // The label's own mark, read from the fence its saved-answer marking draws.
    const fence = readerSavedAnswer(`card:${first}`, "Fix the words now").match(/fence=(\w+)/)?.[1];
    const marked = `[[reader-data fence=${fence} `;
    expect(fence).toBeDefined();
    expect(cards.cardRead(first)?.ended?.answers.join("\n")).toContain(marked);
    expect(() =>
      cards.emitCrewmateCard("reader", { ...findingCard("Keep?"), id: "b" }, "m"),
    ).toThrow(marked);
  });
});
