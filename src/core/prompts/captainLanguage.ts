import { COMPLETION_CARD_HEADINGS } from "@shared/cardHeadings";
import { currentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE, servedLanguageName, writtenLanguage } from "@shared/i18n/languages";
import * as m from "@shared/i18n/messages.generated";

/**
 * The captain's language, as the first mate's context block and a
 * crewmate's prompt name it (INF-3674, the captain's answer: "Your language
 * for anything written to you; the project's own language for commits and
 * pull requests"; docs/i18n.md, "The crew's language").
 *
 * The rule itself is one sentence of `CARD_AUTHORING`, which every persona
 * reads once; this is only the fact it needs, read where the host builds the
 * words. It is the language the app speaks on the computer where the first
 * mate lives, so the crew writes in the language the window shows.
 */

/** The captain's language named for served text, such as `Simplified Chinese (zh-Hans)`. */
export function captainLanguageFact(): string {
  return servedLanguageName(writtenLanguage(currentLanguage()));
}

/**
 * A merge card's four headings in the language the app speaks, from the
 * catalog, in the order `COMPLETION_CARD_HEADINGS` names them in English.
 * Every message is a function, so a heading is worded when it is read and
 * follows the process's language.
 */
export function languageCompletionHeadings(): readonly string[] {
  return [
    m.cardHeadingWhy(),
    m.cardHeadingWhatChanged(),
    m.cardHeadingBefore(),
    m.cardHeadingAfter(),
  ];
}

/**
 * The headings a crewmate is told it may write in the captain's language,
 * or undefined when they are the English ones: the captain writes English,
 * or the catalog has no translation of them yet.
 */
export function captainCompletionHeadings(): readonly string[] | undefined {
  if (writtenLanguage(currentLanguage()) === SOURCE_LANGUAGE) return undefined;
  const headings = languageCompletionHeadings();
  return headings.every((heading, index) => heading === COMPLETION_CARD_HEADINGS[index])
    ? undefined
    : headings;
}
