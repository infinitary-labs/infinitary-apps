import { describe, expect, it } from "vitest";
import { documentLanguage } from "./language";

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
