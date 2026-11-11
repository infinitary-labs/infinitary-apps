import {
  languageFormatTag,
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

export function setCurrentLanguage(tag: string): void {
  language = tag;
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

/**
 * The locale for dates and times written in the computer's own forms:
 * undefined in English, so the runtime uses the computer's own region as it
 * always has, and the chosen language's tag otherwise.
 */
export function regionalLocale(): string | undefined {
  return language === SOURCE_LANGUAGE ? undefined : languageFormatTag(language);
}
