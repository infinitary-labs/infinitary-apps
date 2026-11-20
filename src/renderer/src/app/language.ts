import { setComputerLocale, setCurrentLanguage } from "@shared/i18n/current";
import { COMPUTER_LOCALE_ATTRIBUTE, SOURCE_LANGUAGE, textDirection } from "@shared/i18n/languages";
import { chosenLanguage } from "@shared/i18n/start";

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

let defaultTag = SOURCE_LANGUAGE;

/**
 * The window's default language, the one its preload marked: what it speaks
 * while the captain chose none (docs/i18n.md, "The default language").
 */
export function windowDefaultLanguage(): string {
  return defaultTag;
}

/**
 * Keeps the window in the language the captain chose (docs/i18n.md, "The
 * language choice"): the one the saved look names when the catalog has it,
 * and otherwise `computerTag`, the computer's own language the preload marked
 * before the first paint. Each change sets the page's language and marks the
 * document's `lang` and `dir`, so what is worded next, frames included,
 * speaks it; `LanguageRoot` draws the window again in it. Answers what stops
 * following.
 */
export function followLanguage(
  computerTag: string,
  choice: () => string | null,
  subscribe: (listener: () => void) => () => void,
  doc: Document = document,
): () => void {
  defaultTag = computerTag;
  // English writes dates and times in the computer's own locale the preload marked.
  setComputerLocale(doc.documentElement.getAttribute(COMPUTER_LOCALE_ATTRIBUTE));
  const apply = () => {
    const tag = chosenLanguage(choice() ?? undefined, computerTag);
    doc.documentElement.setAttribute("lang", tag);
    doc.documentElement.setAttribute("dir", textDirection(tag));
    setCurrentLanguage(tag);
  };
  apply();
  return subscribe(apply);
}

let pickerHadFocus = false;

/**
 * The language picker notes, as it applies a language, whether it holds the
 * focus, so the picker drawn anew in the new language takes it back.
 */
export function notePickerChange(focused: boolean): void {
  pickerHadFocus = focused;
}

/**
 * Whether the language picker held the focus when it applied the language,
 * so the picker drawn anew in the new language takes it back; answers once
 * per change.
 */
export function takePickerFocus(): boolean {
  const had = pickerHadFocus;
  pickerHadFocus = false;
  return had;
}
