import { SOURCE_LANGUAGE } from "@shared/i18n/languages";

/**
 * The language the window's preload marked on the document as `lang`
 * (src/preload/index.ts), once the mark has landed: the preload marks the
 * document when its content has loaded, so a page read earlier would still
 * see the page's own `lang`. A page with no mark speaks English.
 */
export function documentLanguage(doc: Document = document): Promise<string> {
  const read = () => doc.documentElement.getAttribute("lang") || SOURCE_LANGUAGE;
  if (doc.readyState !== "loading") return Promise.resolve(read());
  return new Promise((resolve) =>
    doc.addEventListener("DOMContentLoaded", () => resolve(read()), { once: true }),
  );
}
