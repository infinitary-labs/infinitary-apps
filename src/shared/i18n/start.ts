import { currentLanguage, setCurrentLanguage } from "./current.ts";
import { isPseudoLanguage, resolveLanguage, SOURCE_LANGUAGE } from "./languages.ts";
import { CATALOG_LANGUAGES } from "./messages.generated.ts";

/**
 * The language the computer itself asks for (docs/i18n.md, "The language
 * fact"): the catalog language that best matches the computer's own
 * languages, most preferred first, or English when none does. A run that is
 * not the packaged app may name it instead, a pseudo-language included
 * (`INFINITARY_LANGUAGE`, `languageOverride`).
 */
export function computerLanguage(preferred: readonly string[], override?: string): string {
  const named = CATALOG_LANGUAGES.find((tag) => tag === override);
  return named ?? resolveLanguage(preferred, CATALOG_LANGUAGES);
}

/**
 * Whether the app speaks the computer's own language while the captain chose
 * none (docs/i18n.md, "The default language"). Not yet: English stays the
 * default until every word a person reads is in the catalog, the raw-words
 * ledger empty (`scripts/raw-words.ts`), and only a choice in Settings
 * switches the language meanwhile.
 */
export const FOLLOWS_COMPUTER = false;

/**
 * The language the app speaks while the captain chose none: English, or the
 * computer's own once `FOLLOWS_COMPUTER`; a pseudo-language a development
 * run names is always spoken, since it exists to find raw words.
 */
export function defaultLanguage(computer: string): string {
  return FOLLOWS_COMPUTER || isPseudoLanguage(computer) ? computer : SOURCE_LANGUAGE;
}

/**
 * The language the app speaks (docs/i18n.md, "The language choice"): the
 * one the captain chose in Settings → Appearance when the catalog has it,
 * and otherwise the default (`defaultLanguage`). A choice the catalog
 * lacks, such as one a newer build saved, falls back to the default.
 */
export function chosenLanguage(choice: string | undefined, computer: string): string {
  const chosen = CATALOG_LANGUAGES.find((tag) => tag === choice);
  return chosen && !isPseudoLanguage(chosen) ? chosen : defaultLanguage(computer);
}

/**
 * Speaks the captain's choice (`chosenLanguage`) for the computer's own
 * language, or for the one this process already speaks when it names none.
 * The core calls it as soon as its settings open, before boot recovery and
 * the first mate's inbox word any turn (docs/i18n.md, "The language choice");
 * the main process follows later changes.
 */
export function speakChoice(choice: string | undefined, computer = currentLanguage()): void {
  setCurrentLanguage(chosenLanguage(choice, computer));
}

/**
 * The languages a person can choose in Settings: every catalog language but
 * the pseudo-languages, and but English while it is the default, which the
 * picker's first choice already names.
 */
export function choosableLanguages(): string[] {
  return CATALOG_LANGUAGES.filter(
    (tag) => !isPseudoLanguage(tag) && (FOLLOWS_COMPUTER || tag !== SOURCE_LANGUAGE),
  );
}

/**
 * Where a process starts speaking, before any saved choice is read: the
 * default language (`defaultLanguage`) for the computer's own
 * (`computerLanguage`). Answers the computer's language, which a saved
 * choice is weighed against.
 */
export function startLanguage(preferred: readonly string[], override?: string): string {
  const computer = computerLanguage(preferred, override);
  setCurrentLanguage(defaultLanguage(computer));
  return computer;
}

/**
 * The language a development or test run names in `INFINITARY_LANGUAGE`,
 * such as `en-XA` to find words that skipped the catalog; the packaged app
 * ignores it and follows the computer.
 */
export function languageOverride(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean,
): string | undefined {
  return packaged ? undefined : env.INFINITARY_LANGUAGE || undefined;
}
