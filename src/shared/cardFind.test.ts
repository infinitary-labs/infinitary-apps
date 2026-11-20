import { describe, expect, it } from "vitest";
import { findMatches } from "./cardFind";

/**
 * Find in this card (docs/keyboard.md, "Finding in the shown card"): typed
 * words find the card's words whatever their case, accents or curly quotes,
 * and each match points back at the words as the card draws them.
 */
describe("findMatches", () => {
  // A card's words as a page hands them out: its blocks apart, a curly
  // apostrophe, an accent and a space that does not break.
  const card = [
    "Keyboard settings lists it beside its key, and the café menu reads “keyboard” too.",
    "The captain’s Résumé tab keeps its words.",
    "Don’t move the key",
  ].join("\u0000");
  const found = (words: string) =>
    findMatches(card, words).map((span) => card.slice(span.start, span.end));

  it("ignores case, accents and curly quotes, and gives back the words as drawn", () => {
    expect(found("keyboard")).toEqual(["Keyboard", "keyboard"]);
    expect(found("cafe")).toEqual(["café"]);
    expect(found("CAFÉ MENU")).toEqual(["café menu"]);
    expect(found("captain's resume")).toEqual(["captain’s Résumé"]);
    expect(found('"keyboard"')).toEqual(["“keyboard”"]);
    expect(found("keeps its")).toEqual(["keeps its"]);
  });

  it("never runs a match from one block into the next, and finds nothing for spaces", () => {
    expect(found("words. Don")).toEqual([]);
    expect(found("   ")).toEqual([]);
    expect(found("")).toEqual([]);
  });
});
