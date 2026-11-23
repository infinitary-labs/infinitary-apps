import {
  languageFormatTag,
  readableLocale,
  SOURCE_LANGUAGE,
  type TextDirection,
  textDirection,
} from "./languages.ts";

/**
 * The language this process speaks (docs/i18n.md, "The language fact"),
 * set once where the process starts: the main process from the computer's
 * own languages, a window's page from its preload's argument. Every
 * compiled message and every format reads it; a process that never sets it
 * speaks English.
 */
let language: string = SOURCE_LANGUAGE;

export function currentLanguage(): string {
  return language;
}

const listeners = new Set<(tag: string) => void>();

/**
 * Sets the language the process speaks; each listener hears a change, so
 * what the process worded ahead of time, such as a menu, is worded again.
 */
export function setCurrentLanguage(tag: string): void {
  if (tag === language) return;
  language = tag;
  for (const listener of listeners) listener(tag);
}

export function onLanguageChange(listener: (tag: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Words `word` in `tag` and answers it, the process's own language left as
 * it was: the English a saved fact keeps beside it is worded this way
 * whatever the process speaks (docs/i18n.md, "Saved facts"), and command
 * search matches a command's English words as well as its words in the
 * chosen language (docs/keyboard.md). Nothing hears the change, since it
 * never outlives the call.
 */
export function inLanguage<T>(tag: string, word: () => T): T {
  const spoken = language;
  language = tag;
  try {
    return word();
  } finally {
    language = spoken;
  }
}

export function currentDirection(): TextDirection {
  return textDirection(language);
}

/**
 * The locale for the language's own numbers, money and fixed-form dates:
 * `en-US` in English, as the app has always written them.
 */
export function languageLocale(): string {
  return languageFormatTag(language);
}

let computerLocale: string | undefined;

/**
 * Sets the computer's own preferred locale, the first of its preferred
 * languages, set where the process starts: the main process from the
 * computer, a window's page from its preload's mark.
 */
export function setComputerLocale(tag: string | null | undefined): void {
  computerLocale = readableLocale(tag);
}

/**
 * The locale for dates and times written in the computer's own forms
 * (docs/i18n.md, "Dates and times"): in English the computer's own
 * preferred locale, named explicitly, since the packaged Mac app keeps only
 * the shipped languages' folders and the runtime's own default would fall
 * back to US forms; undefined when none was set; and the chosen language's
 * tag otherwise. `tag` names another language than the process's own.
 */
export function regionalLocale(tag: string = language): string | undefined {
  return tag === SOURCE_LANGUAGE ? computerLocale : languageFormatTag(tag);
}
