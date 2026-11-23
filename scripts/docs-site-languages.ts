import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogLanguages,
  headingId,
  KEYBOARD_WORDS,
  pagesFolder,
  SITE_ORIGIN,
  SCOPE_WORD_KEYS,
  SIDEBAR_WORDS,
  SOURCE_LANGUAGE,
  segmentOf,
  shippedLanguages,
  siteWords,
  WORDS,
} from "../docs-site/languages.ts";
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
 *   its headings keep their levels and the English page's ids, its links to
 *   the site's pages lead to its own language's, and its frontmatter keeps
 *   every value but its title and description;
 * - every catalog language's words file has each word the site reads in it.
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

export function splitPage(text: string): { fields: Map<string, string>; lines: string[]; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const lines = match?.[1]?.split("\n") ?? [];
  const fields = new Map<string, string>();
  for (const line of lines) {
    const field = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (field?.[1]) fields.set(field[1], field[2] ?? "");
  }
  return { fields, lines, body: match ? text.slice(match[0].length) : text };
}

/**
 * What a translation keeps of a page's frontmatter: each line as English has
 * it, nested ones included, in order, except a worded field's, which keep
 * only its name.
 */
function keptFrontmatter(lines: string[]): string[] {
  let worded = false;
  return lines.flatMap((line) => {
    const field = /^([A-Za-z][\w-]*):/.exec(line)?.[1];
    if (field) worded = WORDED_FIELDS.has(field) || field === "source";
    if (!worded) return [line];
    return field && field !== "source" ? [field] : [];
  });
}

/** The address Starlight builds a page at, from its path in its language's folder. */
function routeOf(name: string, segment?: string): string {
  const page = name.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
  return `/${segment ? `${segment}/` : ""}${page ? `${page}/` : ""}`;
}

/** The frontmatter fields a translation words in its own language; every other field keeps the English value. */
const WORDED_FIELDS = new Set(["title", "description"]);

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
export function structureOf(text: string, name: string, segment?: string): Structure {
  const { lines, body } = splitPage(text);
  const fences = [...body.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1] ?? "");
  const prose = body.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
  // Each link to the site, written any way, is where it leads from this page;
  // a translated page's leads to its own language's, and one that leads to an
  // English page is kept apart, so it differs.
  const route = `${SITE_ORIGIN}${routeOf(name, segment)}`;
  const unprefixed = (href: string) => {
    const url = URL.parse(href, route);
    if (!url || url.origin !== SITE_ORIGIN) return href;
    const path = url.pathname;
    const at = `${url.search}${url.hash}`;
    if (!segment) return `${path}${at}`;
    return path === `/${segment}/` || path.startsWith(`/${segment}/`)
      ? `${path.slice(segment.length + 1)}${at}`
      : `(not in its language) ${path}${at}`;
  };
  const seen = new Map<string, number>();
  const headings = [...prose.matchAll(/^(#{1,6}) (.*)$/gm)].map((match) => {
    const level = match[1]?.length ?? 0;
    const words = match[2] ?? "";
    const named = /\s\{#([^}\s]+)\}\s*$/.exec(words);
    const id = segment ? (named?.[1] ?? "(no id)") : headingId(headingWords(words), seen);
    return `h${level}#${id}`;
  });
  const sorted = (list: string[]) => list.sort();
  return {
    fields: keptFrontmatter(lines),
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

function structureProblems(english: Structure, translated: Structure): string[] {
  const parts: { key: keyof Structure; name: string }[] = [
    { key: "fields", name: "frontmatter (each line, title and description aside)" },
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

/**
 * What the check reads: the catalog's languages, the pages of English and of
 * each shipped language by their path in its folder, and each words file.
 */
export type SiteLanguages = {
  catalog: readonly string[];
  english: ReadonlyMap<string, string>;
  languages: ReadonlyMap<string, { segment: string; pages: ReadonlyMap<string, string> }>;
  words: ReadonlyMap<string, Record<string, unknown>>;
};

/** Every word the site reads from a words file. */
const KNOWN_WORDS = new Set<string>([...SIDEBAR_WORDS, ...KEYBOARD_WORDS, ...Object.values(SCOPE_WORD_KEYS)]);

export function languageProblems(site: SiteLanguages): string[] {
  const problems: string[] = [];
  for (const tag of site.catalog) {
    const words = site.words.get(tag);
    if (!words) {
      problems.push(`words/${tag}.json is missing: every catalog language has the site's words`);
      continue;
    }
    const shipped = tag === SOURCE_LANGUAGE || site.languages.has(tag);
    for (const key of siteWords(tag, shipped)) {
      const word = words[key];
      if (typeof word !== "string" || word.trim() === "") problems.push(`words/${tag}.json lacks "${key}", which the site reads`);
    }
  }
  for (const [tag, words] of site.words) {
    if (!site.catalog.includes(tag)) problems.push(`words/${tag}.json is for ${tag}, which is not a catalog language`);
    for (const key of Object.keys(words)) {
      if (!KNOWN_WORDS.has(key)) problems.push(`words/${tag}.json has "${key}", a word the site does not use`);
    }
  }
  for (const { segment, pages } of site.languages.values()) {
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
      for (const problem of structureProblems(structureOf(source, name), structureOf(text, name, segment))) {
        problems.push(`${segment}/${name}: ${problem}`);
      }
    }
  }
  return problems;
}

/**
 * The pages in a folder and the folders under it, by their path there, as
 * Starlight builds them; skip names the folders that are other languages'.
 */
function pagesIn(folder: string, skip: ReadonlySet<string> = new Set()): Map<string, string> {
  return new Map(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name))
      .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .filter((path) => !skip.has(path.split("/")[0] ?? ""))
      .map((path) => [path, readFileSync(join(folder, path), "utf8")]),
  );
}

export function readSiteLanguages(): SiteLanguages {
  const catalog = catalogLanguages();
  const shipped = new Set(shippedLanguages());
  const others = catalog.filter((tag) => tag !== SOURCE_LANGUAGE);
  return {
    catalog,
    english: pagesIn(pagesFolder(SOURCE_LANGUAGE), new Set(others.map(segmentOf))),
    languages: new Map(
      others
        .filter((tag) => shipped.has(tag))
        .map((tag) => [tag, { segment: segmentOf(tag), pages: pagesIn(pagesFolder(tag)) }]),
    ),
    words: new Map(
      readdirSync(WORDS)
        .filter((name) => name.endsWith(".json"))
        .map((name) => [name.slice(0, -".json".length), JSON.parse(readFileSync(join(fileURLToPath(WORDS), name), "utf8"))]),
    ),
  };
}

/** Records a translated page's English fingerprint in its frontmatter. */
export function stamp(path: string): void {
  const full = resolve(path);
  const [segment, ...rest] = relative(pagesFolder(SOURCE_LANGUAGE), full).split(/[\\/]/);
  const known = catalogLanguages().filter((tag) => tag !== SOURCE_LANGUAGE).map(segmentOf);
  if (!segment || !known.includes(segment) || rest.length === 0) throw new Error(`${path} is not a translated page`);
  const english = readFileSync(join(pagesFolder(SOURCE_LANGUAGE), ...rest), "utf8");
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
