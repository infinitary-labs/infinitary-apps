import { describe, expect, it } from "vitest";
import { currentLanguage, setCurrentLanguage } from "./current.ts";
import { isPseudoLanguage, SOURCE_LANGUAGE } from "./languages.ts";
import { CATALOG_LANGUAGES } from "./messages.generated.ts";
import {
  choosableLanguages,
  chosenLanguage,
  computerLanguage,
  FOLLOWS_COMPUTER,
  startLanguage,
} from "./start.ts";

// The captain's answer to the review of the first languages (INF-3850):
// English stays the default until the raw-words ledger is empty, and only an
// explicit choice in Settings switches the language. These read the real
// catalog, so a language added to it is covered with no change here.
describe("the language the app speaks", () => {
  it("is English while the captain chose none, whatever the computer asks for", () => {
    expect(FOLLOWS_COMPUTER).toBe(false);
    expect(chosenLanguage(undefined, computerLanguage(["ja-JP", "en-US"]))).toBe(SOURCE_LANGUAGE);
    expect(chosenLanguage(undefined, computerLanguage(["zh-Hant-TW"]))).toBe(SOURCE_LANGUAGE);
  });

  it("starts a process in English and answers the computer's language for the choice to weigh", () => {
    try {
      expect(startLanguage(["de-DE"])).toBe("de");
      expect(currentLanguage()).toBe(SOURCE_LANGUAGE);
    } finally {
      setCurrentLanguage(SOURCE_LANGUAGE);
    }
  });

  it("is the captain's choice over English and the computer's language", () => {
    expect(chosenLanguage("ar", computerLanguage(["de-DE"]))).toBe("ar");
    expect(chosenLanguage("ja", computerLanguage(["en-US"]))).toBe("ja");
  });

  it("falls back to English for a choice this catalog lacks or a pseudo-language", () => {
    // A newer build may save a language this one does not ship.
    expect(chosenLanguage("sv", "ko")).toBe(SOURCE_LANGUAGE);
    expect(chosenLanguage("en-XA", "ko")).toBe(SOURCE_LANGUAGE);
  });

  it("speaks a pseudo-language a development run names, and the choice still wins", () => {
    expect(computerLanguage(["ja-JP"], "en-XA")).toBe("en-XA");
    expect(chosenLanguage(undefined, computerLanguage(["ja-JP"], "en-XA"))).toBe("en-XA");
    expect(computerLanguage(["ja-JP"], "not-a-language")).toBe("ja");
    expect(chosenLanguage("es", computerLanguage(["ja-JP"], "en-XA"))).toBe("es");
  });

  it("offers every translation, and English only through the picker's default", () => {
    const offered = choosableLanguages();
    expect(offered).not.toContain(SOURCE_LANGUAGE);
    expect(offered).toEqual(
      CATALOG_LANGUAGES.filter((tag) => !isPseudoLanguage(tag) && tag !== SOURCE_LANGUAGE),
    );
    expect(offered.length).toBeGreaterThan(1);
  });
});
