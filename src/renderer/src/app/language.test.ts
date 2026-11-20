import {
  currentLanguage,
  regionalLocale,
  setComputerLocale,
  setCurrentLanguage,
} from "@shared/i18n/current";
import { COMPUTER_LOCALE_ATTRIBUTE } from "@shared/i18n/languages";
import { afterEach, describe, expect, it } from "vitest";
import { documentLanguage, followLanguage } from "./language";

// The approved plan (INF-3674): a window speaks the language its preload
// marked on the document. The page's module script runs while the document
// is `interactive`, before DOMContentLoaded, when the preload's mark has not
// landed yet, so a window read then spoke English whatever the mark said.
class Doc extends EventTarget {
  readyState: DocumentReadyState;
  private lang: string;
  readonly documentElement = {
    getAttribute: (name: string) => (name === "lang" ? this.lang : null),
  };
  constructor(readyState: DocumentReadyState, lang: string) {
    super();
    this.readyState = readyState;
    this.lang = lang;
  }
  /** The preload's mark, set by its own DOMContentLoaded listener, added first. */
  marksAtLoad(lang: string) {
    this.addEventListener("DOMContentLoaded", () => {
      this.lang = lang;
    });
  }
}

const asDocument = (doc: Doc) => doc as unknown as Document;

describe("the window's language", () => {
  it("is the preload's mark when the page reads it before DOMContentLoaded", async () => {
    const doc = new Doc("interactive", "en");
    doc.marksAtLoad("ja");
    const read = documentLanguage(asDocument(doc));
    doc.dispatchEvent(new Event("DOMContentLoaded"));
    await expect(read).resolves.toBe("ja");
  });

  it("is read at once from a complete document, and is English with no mark", async () => {
    await expect(documentLanguage(asDocument(new Doc("complete", "de")))).resolves.toBe("de");
    await expect(documentLanguage(asDocument(new Doc("complete", "")))).resolves.toBe("en");
  });
});

// The approved plan (INF-3674): the window follows the captain's choice in
// Settings, and the computer's language while there is none, live.
describe("following the language choice", () => {
  afterEach(() => {
    setCurrentLanguage("en");
    setComputerLocale(undefined);
  });

  const marks = (computerLocale?: string) => {
    const attributes = new Map<string, string>();
    const doc = {
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        getAttribute: (name: string) =>
          name === COMPUTER_LOCALE_ATTRIBUTE ? (computerLocale ?? null) : null,
      },
    } as unknown as Document;
    return { doc, attributes };
  };

  // The captain's answer to the review of the first languages (INF-3850):
  // English stays the default and only a choice switches the language; in
  // English, dates and times take the computer's own locale, named outright.
  it("speaks the choice, marks lang and dir, and returns to English with the computer's date forms", () => {
    const { doc, attributes } = marks("en-GB");
    let choice: string | null = null;
    let changed = () => {};
    const stop = followLanguage(
      "en",
      () => choice,
      (listener) => {
        changed = listener;
        return () => {};
      },
      doc,
    );
    expect([currentLanguage(), attributes.get("lang"), attributes.get("dir")]).toEqual([
      "en",
      "en",
      "ltr",
    ]);
    expect(regionalLocale()).toBe("en-GB");
    choice = "ar";
    changed();
    expect([currentLanguage(), attributes.get("lang"), attributes.get("dir")]).toEqual([
      "ar",
      "ar",
      "rtl",
    ]);
    expect(regionalLocale()).toBe("ar");
    choice = null;
    changed();
    expect([currentLanguage(), attributes.get("dir")]).toEqual(["en", "ltr"]);
    expect(regionalLocale()).toBe("en-GB");
    stop();
  });
});
