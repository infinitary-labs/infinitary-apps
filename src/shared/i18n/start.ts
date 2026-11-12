import { setCurrentLanguage } from "./current.ts";
import { resolveLanguage } from "./languages.ts";
import { CATALOG_LANGUAGES } from "./messages.generated.ts";

/**
 * Where a process starts speaking (docs/i18n.md, "The language fact"): the
 * catalog language that best matches the computer's own languages, most
 * preferred first, or English when none does. A run that is not the
 * packaged app may name its language instead, a pseudo-language included
 * (`INFINITARY_LANGUAGE`, `languageOverride`). Answers the language set.
 */
export function startLanguage(preferred: readonly string[], override?: string): string {
  const named = CATALOG_LANGUAGES.find((tag) => tag === override);
  const language = named ?? resolveLanguage(preferred, CATALOG_LANGUAGES);
  setCurrentLanguage(language);
  return language;
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
