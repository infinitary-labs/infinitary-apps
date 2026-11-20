import { describe, expect, it } from "vitest";
import type { CardAnswer, CardQuestion } from "./cards";
import { cardWrittenText } from "./cardWrittenText";

/**
 * Intent: the approved correction detector considers captain-written text
 * accompanying a reply or choice, never bare labels or staged settings.
 * These realistic submitted-form shapes own extraction, not classification
 * quality; that belongs to the private frozen-label live evaluations.
 */
const question = (
  name: string,
  kind: CardQuestion["kind"],
  control: CardQuestion["control"],
): CardQuestion => ({
  name,
  kind,
  control,
  prompt: kind === "opaque" ? null : "How should the work continue?",
  promptBasis: kind === "opaque" ? null : "legend",
  options: [],
  defaultBasis: kind === "opaque" ? "authored" : "none",
  required: false,
  gaps: kind === "opaque" ? ["opaque"] : [],
  complete: kind !== "opaque",
});

describe("captain-written card text", () => {
  it("excludes a bare choice even when its option label looks like an instruction", () => {
    const answer: CardAnswer = {
      name: "approach",
      values: ["always-ask"],
      labels: ["Always ask before building"],
      changed: true,
    };
    const offered: CardQuestion = {
      ...question(answer.name, "single", "radio"),
      options: answer.values.map((value, index) => ({
        value,
        label: answer.labels?.[index] ?? null,
        authoredDefault: false,
        disabled: false,
        hidden: false,
      })),
    };
    expect(cardWrittenText("", [answer], [offered])).toBe("");
    expect(cardWrittenText("   ")).toBe("");
  });

  it("keeps the exact caption, write-in and footer words, including conditions and numbers", () => {
    const caption = "Only for the next 4 reviews in this project.";
    const writeIn = "Show the proposed wording before keeping it.";
    const footer = "Do not apply this to other projects.";
    const answers: CardAnswer[] = [
      { name: "approach", values: [], changed: true, written: writeIn },
      { name: "anything_else", values: [], changed: true, written: footer },
    ];
    expect(cardWrittenText(caption, answers)).toBe([caption, writeIn, footer].join("\n\n"));
  });

  it("includes a changed visible text field but not an unchanged authored value", () => {
    const words = "For later work here, inspect the result before offering it.";
    const definition = question("working-rule", "text", "textarea");
    const answer: CardAnswer = { name: definition.name, values: [words], changed: true };
    expect(cardWrittenText("", [answer], [definition])).toBe(words);
    expect(cardWrittenText("", [{ ...answer, changed: false }], [definition])).toBe("");
    // Without typed control provenance, a value could just be an option id.
    expect(cardWrittenText("", [answer])).toBe("");
  });

  it("does not turn generated snapshots or hidden values into a new captain reply", () => {
    const words = "Keep the toolbar visible.";
    const answers: CardAnswer[] = [
      { name: "preview", values: [JSON.stringify({ text: words })], json: true, changed: true },
      { name: "hidden", values: [words], changed: true },
    ];
    expect(
      cardWrittenText("", answers, [
        question("preview", "opaque", "staged"),
        question("hidden", "opaque", "hidden"),
      ]),
    ).toBe("");
  });
});
