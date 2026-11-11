import { setCurrentLanguage } from "./current.ts";
import { resolveLanguage } from "./languages.ts";
import { CATALOG_LANGUAGES } from "./messages.generated.ts";

/**
 * Where a process starts speaking (docs/i18n.md, "The language fact"): the
 * catalog language that best matches the computer's own languages, most
 * preferred first, or English when none does. Answers the language set.
 */
export function startLanguage(preferred: readonly string[]): string {
  const language = resolveLanguage(preferred, CATALOG_LANGUAGES);
  setCurrentLanguage(language);
  return language;
}
