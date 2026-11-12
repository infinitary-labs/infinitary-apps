import { SOURCE_LANGUAGE } from "@shared/i18n/languages";

/**
 * The language the window's preload marked on the document as `lang`
 * (src/preload/index.ts), once the mark has landed: the preload marks the
 * document at DOMContentLoaded, and the page's own module script runs
 * before that event, while the document is still `interactive` and holds
 * the page's own `lang`. So a page read before the document is `complete`
 * waits for DOMContentLoaded, whose listeners run in order, the preload's
 * first; a page read after that waits for `complete`, which follows it.
 * A page with no mark speaks English.
 */
export function documentLanguage(doc: Document = document): Promise<string> {
  const read = () => doc.documentElement.getAttribute("lang") || SOURCE_LANGUAGE;
  if (doc.readyState === "complete") return Promise.resolve(read());
  return new Promise((resolve) => {
    const done = () => {
      doc.removeEventListener("DOMContentLoaded", done);
      doc.removeEventListener("readystatechange", completed);
      resolve(read());
    };
    const completed = () => {
      if (doc.readyState === "complete") done();
    };
    doc.addEventListener("DOMContentLoaded", done);
    doc.addEventListener("readystatechange", completed);
  });
}
