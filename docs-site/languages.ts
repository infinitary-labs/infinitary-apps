// The docs site's languages (docs/docs-site.md, "Languages"). They are the
// app's own catalog languages, read from the catalog's folders, never typed a
// second time. English is the source and keeps every address it has; each
// other language lives under its tag in lowercase (/ar/, /zh-hans/) and ships
// once its pages folder exists. A catalog language that has not shipped yet
// redirects to the same English page (catalogRedirects).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ownLanguageName, SOURCE_LANGUAGE, textDirection } from "../src/shared/i18n/languages.ts";

const CATALOG = new URL("../src/shared/i18n/messages/", import.meta.url);
export const PAGES = new URL("./src/content/docs/", import.meta.url);
export const WORDS = new URL("./words/", import.meta.url);

export { SOURCE_LANGUAGE, textDirection };

/** Where the site is published; every page's canonical address and alternates name it. */
export const SITE_ORIGIN = "https://docs.getinfinitary.com";

/** Every catalog language, English first, then the rest in name order. */
export function catalogLanguages(): string[] {
  const tags = readdirSync(CATALOG, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((tag) => tag !== SOURCE_LANGUAGE)
    .sort();
  return [SOURCE_LANGUAGE, ...tags];
}

/** The address segment and pages folder of a language other than English: its tag in lowercase. */
export function segmentOf(tag: string): string {
  return tag.toLowerCase();
}

/** Whether a language other than English has shipped: its pages folder exists. */
export function isShipped(tag: string): boolean {
  return tag === SOURCE_LANGUAGE || existsSync(new URL(`${segmentOf(tag)}/`, PAGES));
}

/** The catalog languages the site serves, English first. */
export function shippedLanguages(): string[] {
  return catalogLanguages().filter(isShipped);
}

/** The pages folder of a language, as a path. */
export function pagesFolder(tag: string): string {
  return fileURLToPath(tag === SOURCE_LANGUAGE ? PAGES : new URL(`${segmentOf(tag)}/`, PAGES));
}

/** The sidebar's words, which every catalog language's words file has (astro.config.mjs). */
export const SIDEBAR_WORDS = ["sidebar.start", "sidebar.using", "sidebar.reference", "sidebar.home"] as const;

/** The Keyboard page's own words, which each shipped language's words file has (scripts/docs-site-keyboard.ts). */
export const KEYBOARD_WORDS = [
  "keyboard.title",
  "keyboard.description",
  "keyboard.intro",
  "keyboard.search.heading",
  "keyboard.search",
  "keyboard.presets.heading",
  "keyboard.presets",
  "keyboard.change.heading",
  "keyboard.change",
  "keyboard.every.heading",
  "keyboard.every",
  "keyboard.column.command",
  "keyboard.column.mac",
  "keyboard.column.linux",
  "keyboard.notTyping",
  "keyboard.separator",
] as const;

/**
 * The words a translated Keyboard page needs beyond English's: the places a
 * command works, which the English page reads from the app.
 */
export const SCOPE_WORD_KEYS = {
  window: "keyboard.scope.window",
  "message-field": "keyboard.scope.message-field",
  "main-message": "keyboard.scope.main-message",
} as const;

/** One of the site's own words. */
export type SiteWord = (typeof SIDEBAR_WORDS)[number] | (typeof KEYBOARD_WORDS)[number] | (typeof SCOPE_WORD_KEYS)[keyof typeof SCOPE_WORD_KEYS];

/** The words a language's words file must have: the sidebar's always, and once it ships the Keyboard page's. */
export function siteWords(tag: string, shipped: boolean): SiteWord[] {
  if (!shipped) return [...SIDEBAR_WORDS];
  return [
    ...SIDEBAR_WORDS,
    ...KEYBOARD_WORDS,
    ...(tag === SOURCE_LANGUAGE ? [] : Object.values(SCOPE_WORD_KEYS)),
  ];
}

/** A language's own words file (words/<tag>.json), or an empty one when it has none yet. */
export function wordsOf(tag: string): Partial<Record<SiteWord, string>> {
  const file = new URL(`${tag}.json`, WORDS);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

/**
 * The id the site's Markdown gives a heading's words (github-slugger's), so a
 * translated heading can name the English heading's id. seen counts the ids
 * a page has given already, which number a repeated one.
 */
export function headingId(words: string, seen: Map<string, number> = new Map()): string {
  const base = words
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** Starlight's locales: English at the root, and each shipped language named in itself. */
export function starlightLocales(
  tags: readonly string[] = shippedLanguages(),
): Record<string, { label: string; lang: string; dir: "ltr" | "rtl" }> {
  return Object.fromEntries(
    tags.map((tag) => [
      tag === SOURCE_LANGUAGE ? "root" : segmentOf(tag),
      { label: ownLanguageName(tag), lang: tag, dir: textDirection(tag) },
    ]),
  );
}

/**
 * Starlight's translations of one of the site's own words, keyed by language
 * tag, from each catalog language's words file that has it.
 */
export function translationsOf(key: SiteWord): Record<string, string> {
  return Object.fromEntries(
    catalogLanguages()
      .filter((tag) => tag !== SOURCE_LANGUAGE)
      .flatMap((tag) => {
        const word = wordsOf(tag)[key];
        return word ? [[tag, word]] : [];
      }),
  );
}

/**
 * The lines of dist/_redirects: each catalog language that has not shipped
 * sends its addresses to the same English page for now, temporarily, so a
 * link to it never leads nowhere.
 */
export function catalogRedirects(tags: readonly string[] = catalogLanguages()): string[] {
  return tags
    .filter((tag) => !isShipped(tag))
    .flatMap((tag) => [`/${segmentOf(tag)} / 302`, `/${segmentOf(tag)}/* /:splat 302`]);
}
