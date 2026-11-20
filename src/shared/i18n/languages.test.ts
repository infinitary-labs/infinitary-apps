import { describe, expect, it } from "vitest";
import { languageArgument, languageFromArgv, resolveLanguage, textDirection } from "./languages.ts";

// The approved plan (INF-3674, question 3): the app follows this computer's
// language, falling back to English. These lists are what macOS answers for
// a computer's languages (Electron's `app.getPreferredSystemLanguages`).
const PLANNED = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "de", "fr", "pt-BR", "ar", "he"];

describe("resolveLanguage", () => {
  it("picks the first of the computer's languages the catalog has", () => {
    expect(resolveLanguage(["de-DE", "en-US"], PLANNED)).toBe("de");
    expect(resolveLanguage(["en-US", "de-DE"], PLANNED)).toBe("en");
    expect(resolveLanguage(["nl-NL", "fr-CA"], PLANNED)).toBe("fr");
  });

  it("tells the two written forms of Chinese apart by script and region", () => {
    expect(resolveLanguage(["zh-Hans-CN"], PLANNED)).toBe("zh-Hans");
    expect(resolveLanguage(["zh-Hant-TW"], PLANNED)).toBe("zh-Hant");
    expect(resolveLanguage(["zh-HK"], PLANNED)).toBe("zh-Hant");
  });

  it("takes Brazilian Portuguese for any Portuguese, and Hebrew under its old code", () => {
    expect(resolveLanguage(["pt-PT"], PLANNED)).toBe("pt-BR");
    expect(resolveLanguage(["iw-IL"], PLANNED)).toBe("he");
  });

  it("speaks English when nothing matches, and never picks a pseudo-language", () => {
    expect(resolveLanguage(["nl-NL", "sv-SE"], PLANNED)).toBe("en");
    expect(resolveLanguage([], PLANNED)).toBe("en");
    expect(resolveLanguage(["en-XA", "ar-XB"], ["en", "en-XA", "ar-XB"])).toBe("en");
    expect(resolveLanguage(["ar-EG"], ["en", "en-XA", "ar-XB"])).toBe("en");
  });

  it("speaks English today, with only the English catalog, whatever the computer's language", () => {
    expect(resolveLanguage(["zh-Hans-CN", "de-DE"], ["en", "en-XA", "ar-XB"])).toBe("en");
  });
});

// Question 7 of the plan: Arabic or Hebrew ships in the first round, so every
// language says which way its text runs.
describe("textDirection", () => {
  it("runs Arabic, Hebrew and the right-to-left pseudo-language right to left", () => {
    expect(["ar", "ar-EG", "he", "iw", "fa", "ur", "ar-XB"].map(textDirection)).toEqual(
      Array(7).fill("rtl"),
    );
  });

  it("runs every other planned language, and an unreadable tag, left to right", () => {
    expect(
      ["en", "en-XA", "zh-Hans", "ja", "ko", "de", "pt-BR", "not a tag"].map(textDirection),
    ).toEqual(Array(8).fill("ltr"));
  });
});

describe("the window's language argument", () => {
  it("carries the language to the page and reads English when it is absent or not a tag", () => {
    expect(languageFromArgv(["--x", languageArgument("zh-Hant")])).toBe("zh-Hant");
    expect(languageFromArgv(["--x"])).toBe("en");
    expect(languageFromArgv([languageArgument("<script>")])).toBe("en");
  });
});
