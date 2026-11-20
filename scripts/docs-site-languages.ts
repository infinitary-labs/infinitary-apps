import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  catalogLanguages,
  pagesFolder,
  SOURCE_LANGUAGE,
  shippedLanguages,
  WORDS,
  wordsOf,
} from "../docs-site/languages.ts";
import { SCOPE_WORD_KEYS } from "./docs-site-keyboard.ts";
import { errorLine } from "./github-errors.ts";
import { REPO_ROOT } from "./moduleRunner.ts";

/**
 * The docs site's languages check (docs/docs-site.md, "Languages"). It holds
 * every shipped language to the English pages without judging the prose:
 *
 * - each language has every page English has, and no page English lacks;
 * - each translated page names, as `source` in its frontmatter, the
 *   fingerprint of the English page it was written from, and that English
 *   page has not changed since;
 * - each translated page keeps the English page's links (its language's
 *   address segment aside), pictures, code, keys and frontmatter fields, and
 *   its headings keep their levels and the English page's ids;
 * - each language's words file has every word English's has.
 *
 *   node scripts/docs-site-languages.ts --check          fails on any of these
 *   node scripts/docs-site-languages.ts --stamp <page>   records a translated
 *       page's English fingerprint, once its translator has re-read it
 */

/** Pages the build writes rather than a person: Keyboard has its own generator and check, What's new is English everywhere. */
export const GENERATED_PAGES = new Set(["keyboard.mdx", "whats-new.md"]);

/** The fingerprint a translated page records of the English page it was written from. */
export function fingerprint(english: string): string {
  return createHash("sha256").update(english).digest("hex").slice(0, 16);
}

/** A page's frontmatter fields and its body. */
export function splitPage(text: string): { fields: Map<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const fields = new Map<string, string>();
  for (const line of match?.[1]?.split("\n") ?? []) {
    const field = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (field?.[1]) fields.set(field[1], field[2] ?? "");
  }
  return { fields, body: match ? text.slice(match[0].length) : text };
}

/** github-slugger's id for a heading's words, as the site's Markdown gives English headings. */
function slugOf(words: string, seen: Map<string, number>): string {
  const base = words
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** A heading's words as a reader sees them: Markdown's marks and link targets left out. */
function headingWords(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

/** What a translation must keep of a page: the parts no translator rewords. */
export type Structure = {
  fields: string[];
  links: string[];
  pictures: string[];
  code: string[];
  keys: string[];
  headings: string[];
};

/**
 * A page's structure. On a translated page, segment is its language's address
 * segment, left out of its links so they compare with English's, and each
 * heading's id is the one it names (`{#id}`); on English, the one its words make.
 */
export function structureOf(text: string, segment?: string): Structure {
  const { fields, body } = splitPage(text);
  const fences = [...body.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1] ?? "");
  const prose = body.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
  const unprefixed = (href: string) =>
    segment && (href === `/${segment}/` || href.startsWith(`/${segment}/`))
      ? href.slice(segment.length + 1)
      : href;
  const seen = new Map<string, number>();
  const headings = [...prose.matchAll(/^(#{1,6}) (.*)$/gm)].map((match) => {
    const level = match[1]?.length ?? 0;
    const words = match[2] ?? "";
    const named = /\s\{#([^}\s]+)\}\s*$/.exec(words);
    const id = segment ? (named?.[1] ?? "(no id)") : slugOf(headingWords(words), seen);
    return `h${level}#${id}`;
  });
  const sorted = (list: string[]) => list.sort();
  return {
    fields: sorted([...fields.keys()].filter((field) => field !== "source")),
    links: sorted(
      [
        ...[...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? ""),
        ...[...prose.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map((match) => match[1] ?? ""),
      ]
        .filter((href) => !/\.(webp|png|jpe?g|svg|gif)$/.test(href))
        .map(unprefixed),
    ),
    pictures: sorted([
      ...[...prose.matchAll(/<img\s[^>]*src="([^"]*)"/g)].map((match) => match[1] ?? ""),
      ...[...prose.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? ""),
    ]),
    code: sorted([
      ...fences,
      ...[...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? ""),
    ]),
    keys: sorted([...prose.matchAll(/<kbd>(.*?)<\/kbd>/g)].map((match) => match[1] ?? "")),
    headings,
  };
}

/** Where a translated page's structure differs from the English page's, in words. */
function structureProblems(english: Structure, translated: Structure): string[] {
  const parts: { key: keyof Structure; name: string }[] = [
    { key: "fields", name: "frontmatter fields" },
    { key: "links", name: "links" },
    { key: "pictures", name: "pictures" },
    { key: "code", name: "code" },
    { key: "keys", name: "keys" },
    { key: "headings", name: "headings (level and id, in order)" },
  ];
  return parts.flatMap(({ key, name }) => {
    const want = english[key];
    const have = translated[key];
    if (JSON.stringify(want) === JSON.stringify(have)) return [];
    const missing = want.filter((item) => !have.includes(item));
    const extra = have.filter((item) => !want.includes(item));
    const detail = [
      missing.length ? `English has ${missing.map((item) => JSON.stringify(item)).join(", ")}` : "",
      extra.length ? `it has ${extra.map((item) => JSON.stringify(item)).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    return [`its ${name} differ from the English page's${detail ? `: ${detail}` : " (order or count)"}`];
  });
}

/** The words a language's words file must have: English's, and for a translated Keyboard page, where each command works. */
function requiredWords(tag: string, shipped: boolean, english: Record<string, string>): string[] {
  const keys = Object.keys(english);
  if (!shipped) return keys.filter((key) => key.startsWith("sidebar."));
  return tag === SOURCE_LANGUAGE ? keys : [...keys, ...Object.values(SCOPE_WORD_KEYS)];
}

/** What the check reads: the pages of English and of each language, by file name, and each language's words. */
export type SiteLanguages = {
  english: ReadonlyMap<string, string>;
  languages: ReadonlyMap<string, { segment: string; pages: ReadonlyMap<string, string> }>;
  words: ReadonlyMap<string, Record<string, string>>;
};

/** Every way the site's languages fall short, as one line each. */
export function languageProblems(site: SiteLanguages): string[] {
  const problems: string[] = [];
  const english = site.words.get(SOURCE_LANGUAGE) ?? {};
  const known = new Set([...Object.keys(english), ...Object.values(SCOPE_WORD_KEYS)]);
  for (const [tag, words] of site.words) {
    const shipped = tag === SOURCE_LANGUAGE || site.languages.has(tag);
    for (const key of requiredWords(tag, shipped, english)) {
      if (!words[key]) problems.push(`words/${tag}.json lacks "${key}", which ${tag === SOURCE_LANGUAGE ? "the site" : "English"} has`);
    }
    for (const key of Object.keys(words)) {
      if (!known.has(key)) problems.push(`words/${tag}.json has "${key}", a word the site does not use`);
    }
  }
  for (const [tag, { segment, pages }] of site.languages) {
    if (!site.words.has(tag)) problems.push(`words/${tag}.json is missing`);
    for (const name of site.english.keys()) {
      if (name !== "whats-new.md" && !pages.has(name)) problems.push(`${segment}/${name} is missing: English has ${name}`);
    }
    for (const [name, text] of pages) {
      const source = site.english.get(name);
      if (source === undefined || name === "whats-new.md") {
        problems.push(`${segment}/${name} has no English page to be a translation of`);
        continue;
      }
      if (GENERATED_PAGES.has(name)) continue;
      const recorded = splitPage(text).fields.get("source");
      if (recorded !== fingerprint(source)) {
        problems.push(
          recorded
            ? `${segment}/${name} was written from an earlier ${name}: bring it up to date with the English page, then run node scripts/docs-site-languages.ts --stamp docs-site/src/content/docs/${segment}/${name}`
            : `${segment}/${name} names no source: run node scripts/docs-site-languages.ts --stamp docs-site/src/content/docs/${segment}/${name} once it is translated`,
        );
      }
      for (const problem of structureProblems(structureOf(source), structureOf(text, segment))) {
        problems.push(`${segment}/${name}: ${problem}`);
      }
    }
  }
  return problems;
}

/** The pages in a folder, by file name, its language folders left out. */
function pagesIn(folder: string): Map<string, string> {
  return new Map(
    readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name))
      .map((entry) => [entry.name, readFileSync(join(folder, entry.name), "utf8")]),
  );
}

/** The site's languages as the repository holds them. */
export function readSiteLanguages(): SiteLanguages {
  const tags = catalogLanguages();
  const shipped = new Set(shippedLanguages());
  const wordFiles = new Set(readdirSync(WORDS).map((name) => name.replace(/\.json$/, "")));
  return {
    english: pagesIn(pagesFolder(SOURCE_LANGUAGE)),
    languages: new Map(
      tags
        .filter((tag) => tag !== SOURCE_LANGUAGE && shipped.has(tag))
        .map((tag) => [tag, { segment: tag.toLowerCase(), pages: pagesIn(pagesFolder(tag)) }]),
    ),
    words: new Map(tags.filter((tag) => wordFiles.has(tag)).map((tag) => [tag, wordsOf(tag)])),
  };
}

/** Records a translated page's English fingerprint in its frontmatter. */
export function stamp(path: string): void {
  const full = resolve(path);
  const segment = relative(pagesFolder(SOURCE_LANGUAGE), full).split(/[\\/]/);
  const name = segment.at(-1) ?? "";
  if (segment.length !== 2 || !name) throw new Error(`${path} is not a translated page`);
  const english = readFileSync(join(pagesFolder(SOURCE_LANGUAGE), name), "utf8");
  const text = readFileSync(full, "utf8");
  const line = `source: ${fingerprint(english)}`;
  const stamped = /^---\n[\s\S]*?^source:.*$/m.test(text)
    ? text.replace(/^source:.*$/m, line)
    : text.replace(/^---\n/, `---\n${line}\n`);
  writeFileSync(full, stamped);
}

if (process.argv[1]?.endsWith("docs-site-languages.ts")) {
  const at = process.argv.indexOf("--stamp");
  if (at !== -1) {
    const pages = process.argv.slice(at + 1);
    if (pages.length === 0) throw new Error("usage: node scripts/docs-site-languages.ts --stamp <page>...");
    for (const page of pages) stamp(page);
  } else {
    const problems = languageProblems(readSiteLanguages());
    if (problems.length > 0) {
      for (const problem of problems) console.error(errorLine(problem, { title: "Docs site languages" }));
      console.error(`The docs site's languages check failed (docs/docs-site.md, "Languages"); run from ${REPO_ROOT}.`);
      process.exit(1);
    }
    console.log(`The docs site's languages check passed: ${[...readSiteLanguages().languages.keys()].join(", ") || "English only"}.`);
  }
}
