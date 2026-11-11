import { currentLanguage, languageLocale, regionalLocale } from "./current.ts";
import { languageFormatTag } from "./languages.ts";

/**
 * Numbers, money, dates and plural forms in the app's language
 * (docs/i18n.md, "Formats"). Every place the app writes one for a person
 * goes through here, never through a fixed locale: `pnpm check`
 * (scripts/locale-formats.ts) refuses a locale literal or a bare
 * `toLocaleString` anywhere else. In English each writes exactly what the
 * app wrote before: numbers and money in US forms, dates and times in the
 * computer's own.
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
