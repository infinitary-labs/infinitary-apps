/**
 * The language fact (docs/i18n.md): which language the app speaks, which
 * way its text runs, and how a computer's own list of languages picks one.
 * Every process reads the same rules from here; this file imports nothing,
 * so the message compiler (scripts/generate-messages.ts) reads it too.
 */

/** The language every message is written in first, and the one any missing translation falls back to. */
export const SOURCE_LANGUAGE = "en";

/**
 * The made-up languages a test reads the window in (docs/i18n.md,
 * "The pseudo-languages"), compiled from the English catalog and never
 * picked from a computer's own languages: `en-XA` marks and lengthens every
 * message, so a word that skipped the catalog stands out, and `ar-XB` runs
 * every message right to left, so a layout that assumes left to right does.
 */
export const PSEUDO_LANGUAGES = ["en-XA", "ar-XB"] as const;
export type PseudoLanguage = (typeof PSEUDO_LANGUAGES)[number];

export function isPseudoLanguage(tag: string): tag is PseudoLanguage {
  return (PSEUDO_LANGUAGES as readonly string[]).includes(tag);
}

/**
 * The scripts in current use that are written right to left, by their
 * Unicode script codes. A language's direction is read from its likely
 * script, so `ar`, `he`, `fa` and `ur` run right to left, and `ar-XB` with
 * them.
 */
const RIGHT_TO_LEFT_SCRIPTS = new Set([
  "Arab",
  "Hebr",
  "Thaa",
  "Syrc",
  "Nkoo",
  "Adlm",
  "Rohg",
  "Mand",
  "Samr",
]);

export type TextDirection = "ltr" | "rtl";

/** Which way a language's text runs; a tag the runtime cannot read runs left to right. */
export function textDirection(tag: string): TextDirection {
  const script = likelySubtags(tag)?.script;
  return script && RIGHT_TO_LEFT_SCRIPTS.has(script) ? "rtl" : "ltr";
}

interface Subtags {
  language: string;
  script: string | undefined;
  region: string | undefined;
  /** The region the tag itself names, before the runtime fills one in. */
  namedRegion: string | undefined;
}

function likelySubtags(tag: string): Subtags | undefined {
  try {
    const named = new Intl.Locale(tag);
    const likely = named.maximize();
    return {
      language: likely.language,
      script: likely.script,
      region: likely.region,
      namedRegion: named.region,
    };
  } catch {
    return undefined;
  }
}

/**
 * The language the app speaks for a computer whose languages are
 * `preferred`, most preferred first, out of the languages the catalog has.
 * Each preferred language is tried in turn: first a catalog language with
 * its script and, when the catalog language names one, its region (so
 * `zh-TW` finds `zh-Hant` and `pt-BR` finds `pt-BR`), then one with its
 * script alone (so `pt-PT` finds `pt-BR`). A pseudo-language is never
 * picked this way, and nothing matching means English.
 */
export function resolveLanguage(
  preferred: readonly string[],
  available: readonly string[],
): string {
  const choices = available
    .filter((tag) => !isPseudoLanguage(tag))
    .flatMap((tag) => {
      const subtags = likelySubtags(tag);
      return subtags ? [{ tag, subtags }] : [];
    });
  for (const wanted of preferred) {
    const want = likelySubtags(wanted);
    if (!want) continue;
    const sameScript = choices.filter(
      ({ subtags }) => subtags.language === want.language && subtags.script === want.script,
    );
    const exact = sameScript.find(
      ({ subtags }) => !subtags.namedRegion || subtags.region === want.region,
    );
    const near = exact ?? sameScript[0];
    if (near) return near.tag;
  }
  return SOURCE_LANGUAGE;
}

/**
 * How the main process tells a window's page its language: an argument the
 * preload reads before the first paint, as it does the window's material
 * (src/shared/windowMaterial.ts), and marks on the document as `lang` and
 * `dir`.
 */
export const LANGUAGE_ARG = "--fm-language=";

export function languageArgument(tag: string): string {
  return `${LANGUAGE_ARG}${tag}`;
}

/** The language an argument names, or the source language when none does or it is not a language tag. */
export function languageFromArgv(argv: readonly string[]): string {
  const arg = argv.find((entry) => entry.startsWith(LANGUAGE_ARG));
  const tag = arg?.slice(LANGUAGE_ARG.length);
  return tag && likelySubtags(tag) ? tag : SOURCE_LANGUAGE;
}

/**
 * How the main process tells a window's page the computer's own preferred
 * locale (docs/i18n.md, "Dates and times"): an argument beside the
 * language's, which the preload marks on the document under
 * `COMPUTER_LOCALE_ATTRIBUTE`.
 */
export const LOCALE_ARG = "--fm-locale=";
export const COMPUTER_LOCALE_ATTRIBUTE = "data-computer-locale";

export function localeArgument(tag: string): string {
  return `${LOCALE_ARG}${tag}`;
}

/** A locale tag the runtime reads, in its canonical form, or undefined for none or one it cannot read. */
export function readableLocale(tag: string | null | undefined): string | undefined {
  if (!tag) return undefined;
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

/** The computer's preferred locale an argument names, or undefined when none does. */
export function localeFromArgv(argv: readonly string[]): string | undefined {
  return readableLocale(
    argv.find((entry) => entry.startsWith(LOCALE_ARG))?.slice(LOCALE_ARG.length),
  );
}

/**
 * The locale the language's own numbers, money and fixed dates are written
 * in: English keeps the US forms the app has always written (`1,234`,
 * `$12.50`), a pseudo-language its base language's, and every other
 * language its own tag.
 */
export function languageFormatTag(tag: string): string {
  if (tag === SOURCE_LANGUAGE) return "en-US";
  if (isPseudoLanguage(tag)) return tag.slice(0, 2);
  return tag;
}

/**
 * The language the crew writes to the captain in (docs/i18n.md, "The
 * crew's language"): the language the app speaks, except that a
 * pseudo-language, which only a test reads the window in, is written as
 * English.
 */
export function writtenLanguage(tag: string): string {
  return isPseudoLanguage(tag) ? SOURCE_LANGUAGE : tag;
}

/**
 * A language as served text names it, in English with its tag:
 * `English (en)`, `Simplified Chinese (zh-Hans)`. A tag the runtime has no
 * name for is named by the tag alone.
 */
export function servedLanguageName(tag: string): string {
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames([SOURCE_LANGUAGE], { type: "language" }).of(tag);
  } catch {
    return tag;
  }
  return name && name !== tag ? `${name} (${tag})` : tag;
}

/**
 * A language named in its own words, as a person who reads it looks for it
 * in a list: `简体中文`, `Español`, `العربية`. A tag the runtime has no name
 * for is named by the tag.
 */
export function ownLanguageName(tag: string): string {
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames([tag], { type: "language" }).of(tag);
  } catch {
    return tag;
  }
  if (!name) return tag;
  return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
}
