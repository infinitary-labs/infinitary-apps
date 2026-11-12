import { currentLanguage, languageLocale, regionalLocale } from "./current.ts";
import { languageFormatTag, SOURCE_LANGUAGE } from "./languages.ts";

/**
 * Numbers, money, dates and plural forms in the app's language
 * (docs/i18n.md, "Formats"). Every place the app writes one for a person
 * goes through here, never through a fixed locale: `pnpm check`
 * (scripts/locale-formats.ts) refuses a locale literal or a bare
 * `toLocaleString` anywhere else. In English numbers and money keep the US
 * forms the app always wrote, and dates and times name the computer's own
 * preferred locale outright ("Dates and times").
 */

type When = Date | number;

/** A count or amount in the language's own digits and grouping: `1,234` in English. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(languageLocale(), options);
}

/**
 * US dollars in the language's own money form: `$12` for a whole amount
 * and `$12.50` otherwise in English, or always `fractionDigits` places when
 * given.
 */
export function formatUsd(amount: number, fractionDigits?: number): string {
  const digits = fractionDigits ?? (Number.isInteger(amount) ? 0 : 2);
  return amount.toLocaleString(languageLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** A date in the computer's own form while the app speaks English, in the language's otherwise. */
export function formatDate(at: When, options?: Intl.DateTimeFormatOptions): string {
  return new Date(at).toLocaleDateString(regionalLocale(), options);
}

/** A time of day, written as `formatDate` writes a date. */
export function formatTime(at: When, options?: Intl.DateTimeFormatOptions): string {
  return new Date(at).toLocaleTimeString(regionalLocale(), options);
}

/** A date and time together, written as `formatDate` writes a date. */
export function formatDateTime(at: When, options?: Intl.DateTimeFormatOptions): string {
  return new Date(at).toLocaleString(regionalLocale(), options);
}

/** A date in the language's own form, US English while the app speaks English, for the places that always wrote it so. */
export function formatLanguageDate(at: When, options?: Intl.DateTimeFormatOptions): string {
  return new Date(at).toLocaleDateString(languageLocale(), options);
}

/** A date and time in the language's own form, as `formatLanguageDate`. */
export function formatLanguageDateTime(at: When, options?: Intl.DateTimeFormatOptions): string {
  return new Date(at).toLocaleString(languageLocale(), options);
}

/** A date-time formatter for a place that formats many times, in the computer's own form as `formatDate`. */
export function dateTimeFormat(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(regionalLocale(), options);
}

/**
 * The locale of text served to a model, which stays English whatever the
 * captain's language (docs/i18n.md, "What stays English"): a count in a
 * tool's answer reads `1,234`.
 */
export const SERVED_LOCALE = "en-US";

export function servedNumber(value: number): string {
  return value.toLocaleString(SERVED_LOCALE);
}

const pluralRules = new Map<string, Intl.PluralRules>();

/**
 * Which plural form of a message `count` takes in the current language
 * (`one` or `other` in English), or in `locale` when given: a
 * pseudo-language's messages keep English's forms.
 */
export function pluralCategory(
  count: number,
  locale = languageFormatTag(currentLanguage()),
): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * Items joined as one list in the language's own form: `a, b and c` in
 * English, as the app has always written them (no comma before the last
 * word), and `Intl.ListFormat`'s form in any other language. `or` joins
 * choices: `a, b or c`.
 */
export function formatList(items: readonly string[], join: "and" | "or" = "and"): string {
  if (currentLanguage() !== SOURCE_LANGUAGE) {
    const type = join === "and" ? "conjunction" : "disjunction";
    return new Intl.ListFormat(languageLocale(), { style: "long", type }).format(items);
  }
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${join} ${items.at(-1)}`;
}
