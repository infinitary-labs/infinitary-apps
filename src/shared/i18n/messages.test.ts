import { afterEach, describe, expect, it } from "vitest";
import { setCurrentLanguage } from "./current.ts";
import * as m from "./messages.generated.ts";

// The approved plan (INF-3674, piece 1): the catalog compiles to one typed
// function per message that answers in the current language, and the
// pseudo-languages mark every message so a word that skipped the catalog
// stands out.
afterEach(() => setCurrentLanguage("en"));

describe("compiled messages", () => {
  it("answer in English with the English plural forms and grouped counts", () => {
    expect(m.composerLines({ count: 1 })).toBe("1 line");
    expect(m.composerLines({ count: 1240 })).toBe("1,240 lines");
    expect(m.fileCancel({ name: "notes.txt" })).toBe("Cancel preparing notes.txt");
  });

  it("bracket, accent and lengthen every message in en-XA, keeping what the caller fills in", () => {
    setCurrentLanguage("en-XA");
    expect(m.fileAdd()).toBe("[Åðð ƒîļéš ~~~]");
    expect(m.fileCancel({ name: "notes.txt" })).toBe("[Çáñçéļ þŕéþáŕîñĝ notes.txt ~~~~~~]");
    expect(m.composerLines({ count: 2 })).toBe("[2 ļîñéš ~~]");
  });

  it("write every run of words right to left in ar-XB, with English plural forms", () => {
    setCurrentLanguage("ar-XB");
    expect(m.fileReadyAnnounce({ name: "notes.txt" })).toBe("notes.txt‮ ready‬");
    expect(m.composerLines({ count: 1 })).toBe("1‮ line‬");
  });
});
