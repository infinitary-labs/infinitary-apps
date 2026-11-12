import { describe, expect, it } from "vitest";
import {
  changePresentationDraftSchema,
  retainedPresentationMediaSchema,
} from "./changePresentation";

// INF-3814's direction B, which the captain chose (INF-3826): a crewmate answers,
// for each After picture's final take, what a person using the view would call
// wrong, and the story waits until no fault its change caused is left.
const HEAD = "1".repeat(40);
const BASE = "0".repeat(40);
// The fault the captain named on a real merge card's After picture (INF-3796).
const COVERED = "The Annotate button sits on the end of the next line of card text.";

function draft(after: Record<string, unknown>) {
  return {
    title: "feat(cards): offer Annotate on selected words",
    base: BASE,
    head: HEAD,
    publishable: true,
    why: ["A person selecting words on a card should be offered a note."],
    whatChanged: ["A selection offers Annotate."],
    before: ["A selection opened a large editor."],
    after: ["A selection offers a small Annotate button."],
    views: [
      {
        id: "select",
        caption: "Words selected on a card",
        kind: "changed",
        before: [
          { path: "1-select-before.png", alt: "The editor", inspected: true, captureHead: BASE },
        ],
        after: [
          {
            path: "1-select-after.png",
            alt: "The Annotate button under the words",
            inspected: true,
            captureHead: HEAD,
            ...after,
          },
        ],
      },
    ],
    checked: [{ check: "Selection", result: "Annotate appears under the words." }],
    verification: [],
    risk: Object.fromEntries(
      ["blast", "behavior", "undo", "evidence", "sensitivity", "novelty", "deps"].map((name) => [
        name,
        { level: "low", why: "A card control" },
      ]),
    ),
    requiredActions: [],
    unfinished: [],
  };
}

describe("an After picture's answer to what a person would call wrong", () => {
  it("is required on every After picture", () => {
    expect(changePresentationDraftSchema.safeParse(draft({})).success).toBe(false);
    expect(changePresentationDraftSchema.safeParse(draft({ faults: [] })).success).toBe(true);
  });

  it("refuses the story while a fault is the change's own, naming the picture and what to do", () => {
    const parsed = changePresentationDraftSchema.safeParse(
      draft({ faults: [{ fault: COVERED, cause: "change" }] }),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      `1-select-after.png in view select shows a fault your change caused: ${COVERED} Fix it, take the picture again, open the new take and answer again for it. The story was not saved.`,
    ]);
  });

  it("lets a fault from before the change or one the captain chose through", () => {
    const faults = [
      { fault: "The toolbar icons sit one pixel low.", cause: "before-change" },
      { fault: "The button is narrower than the line, as the plan chose.", cause: "chosen" },
    ];
    expect(changePresentationDraftSchema.safeParse(draft({ faults })).success).toBe(true);
  });

  it("is never carried into the saved story the merge card and pull request draw", () => {
    const saved = {
      asset: "picture-0123456789abcdef0123456789abcdef",
      alt: "The Annotate button under the words",
      captureHead: HEAD,
    };
    expect(retainedPresentationMediaSchema.safeParse(saved).success).toBe(true);
    expect(retainedPresentationMediaSchema.safeParse({ ...saved, faults: [] }).success).toBe(false);
  });
});
