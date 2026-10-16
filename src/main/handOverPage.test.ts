import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import {
  actionOf,
  HAND_OVER_ADDRESS,
  type HandOverView,
  handOverBody,
  progressLine,
} from "./handOverPage";

const names = { from: "Firstmate 3000", to: "Infinitary" };

/** The page as a person reads it: its heading, its words, and each button with what it asks. */
function read(view: HandOverView) {
  const document = parseDocument(handOverBody(view, names));
  const text = (name: string) =>
    DomUtils.findAll((element) => element.name === name, document.children).map((element) =>
      DomUtils.textContent(element).trim(),
    );
  const buttons = DomUtils.findAll((element) => element.name === "button", document.children).map(
    (button) => ({ label: DomUtils.textContent(button).trim(), asks: button.attribs.value }),
  );
  const form = DomUtils.findOne((element) => element.name === "form", document.children);
  return {
    heading: text("h1")[0],
    words: text("p").join(" "),
    buttons,
    action: form?.attribs.action,
  };
}

describe("the hand-over window's page", () => {
  it("asks which work to open when both folders hold some, with three choices", () => {
    const page = read({
      kind: "ask",
      from: { path: "/a", lastOpened: 0 },
      to: { path: "/b", lastOpened: undefined },
    });
    expect(page.heading).toBe("Infinitary found saved work in two places");
    expect(page.buttons).toEqual([
      { label: "Bring Firstmate 3000's work", asks: "bring" },
      { label: "Keep Infinitary's work", asks: "keep" },
      { label: "Decide later", asks: "later" },
    ]);
    expect(page.action).toBe(HAND_OVER_ADDRESS);
  });

  it("offers Try again where waiting can mend the refusal, and Quit alone where it cannot", () => {
    const room = read({
      kind: "refused",
      refusal: { reason: "no-space", needed: 4_800_000_000, free: 1_200_000_000 },
    });
    expect(room.words).toContain("4.8 GB");
    expect(room.words).toContain("1.2 GB");
    expect(room.buttons.map((button) => button.asks)).toEqual(["again", "quit"]);
    const newer = read({ kind: "refused", refusal: { reason: "unsupported" } });
    expect(newer.buttons.map((button) => button.asks)).toEqual(["quit"]);
  });

  it("reads each button's navigation and nothing else", () => {
    expect(actionOf(`${HAND_OVER_ADDRESS}?do=bring`)).toBe("bring");
    expect(actionOf(`${HAND_OVER_ADDRESS}?do=delete`)).toBeUndefined();
    expect(actionOf("https://example.com/?do=bring")).toBeUndefined();
    expect(actionOf("not a url")).toBeUndefined();
  });

  it("says how far a move is as a share of its work", () => {
    expect(progressLine({ phase: "copying", done: 1, total: 4 })).toEqual({
      status: "Copying",
      amount: "25%",
      fill: 0.25,
    });
    expect(progressLine({ phase: "checking", done: 0, total: 0 })).toMatchObject({ amount: "" });
    expect(progressLine({ phase: "finishing", done: 0, total: 0 })).toMatchObject({ fill: 1 });
  });
});
