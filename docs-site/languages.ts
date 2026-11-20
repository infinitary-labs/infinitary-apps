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

/** A language's own words file (words/<tag>.json), or an empty one when it has none yet. */
export function wordsOf(tag: string): Record<string, string> {
  const file = new URL(`${tag}.json`, WORDS);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
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
export function translationsOf(key: string): Record<string, string> {
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
