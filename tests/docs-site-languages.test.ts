import { describe, expect, it } from "vitest";
import {
  fingerprint,
  GENERATED_PAGES,
  languageProblems,
  readSiteLanguages,
  type SiteLanguages,
} from "../scripts/docs-site-languages.ts";

/**
 * The docs site's languages check (docs/docs-site.md, "Languages"): INF-5272's
 * plan, piece 1, asks that the site speak the app's catalog languages with
 * each translated page kept to the English page it was written from, its
 * links, pictures, code, keys and headings unchanged, and each language's
 * words complete. Every case starts from the site's own pages, changed in
 * memory the way a translator's slip or a later English edit would change them.
 */

const site = readSiteLanguages();
const [tag, language] = [...site.languages][0] ?? [];

/** The site with the first shipped language's pages changed. */
function withPages(change: (pages: Map<string, string>) => void): SiteLanguages {
  if (!tag || !language) throw new Error("the site ships no translated language");
  const pages = new Map(language.pages);
  change(pages);
  return { ...site, languages: new Map(site.languages).set(tag, { ...language, pages }) };
}

/** The site with one translated page of the first shipped language rewritten. */
function withPage(name: string, edit: (text: string) => string): SiteLanguages {
  return withPages((pages) => {
    const text = pages.get(name);
    if (text === undefined) throw new Error(`${name} is missing`);
    pages.set(name, edit(text));
  });
}

/** A translated page, written by a person, that holds what the pattern matches. */
function pageWith(pattern: RegExp): string {
  const name = [...(language?.pages ?? [])].find(
    ([page, text]) => !GENERATED_PAGES.has(page) && pattern.test(text),
  )?.[0];
  if (!name) throw new Error(`no translated page matches ${pattern}`);
  return name;
}

/** The site's problems that name a translated page. */
function problemsOf(changed: SiteLanguages, name: string): string[] {
  return languageProblems(changed).filter((problem) =>
    problem.includes(`${language?.segment}/${name}`),
  );
}

describe("the docs site's languages check", () => {
  it("passes on the site as it stands", () => {
    expect(tag, "a translated language ships").toBeTruthy();
    expect(languageProblems(site)).toEqual([]);
  });

  it("refuses a language that lacks one of English's pages", () => {
    const name = pageWith(/./);
    const changed = withPages((pages) => pages.delete(name));
    expect(problemsOf(changed, name).join("\n")).toContain("is missing");
  });

  it("refuses a page English lacks, and a translated What's new", () => {
    for (const name of ["not-in-english.md", "whats-new.md"]) {
      const changed = withPages((pages) => pages.set(name, "---\ntitle: x\n---\n"));
      expect(problemsOf(changed, name).join("\n")).toContain("has no English page");
    }
  });

  it("refuses a page whose English page changed after it was translated", () => {
    const name = pageWith(/./);
    const english = site.english.get(name) ?? "";
    const changed = {
      ...site,
      english: new Map(site.english).set(name, `${english}\nA new sentence.\n`),
    };
    expect(fingerprint(english)).not.toBe(fingerprint(`${english}\nA new sentence.\n`));
    expect(problemsOf(changed, name).join("\n")).toContain(`written from an earlier ${name}`);
  });

  it("refuses a page with no recorded source", () => {
    const name = pageWith(/^source:/m);
    const problems = problemsOf(
      withPage(name, (text) => text.replace(/^source:.*\n/m, "")),
      name,
    );
    expect(problems.join("\n")).toContain("names no source");
  });

  const slips: { part: string; pattern: RegExp; edit: (text: string) => string }[] = [
    {
      part: "links",
      pattern: /\]\(\/[a-z-]+\/[^)]*\)/,
      edit: (text) => text.replace(/\]\((\/[a-z-]+\/)([^)]*)\)/, "]($1$2-moved)"),
    },
    {
      part: "pictures",
      pattern: /<img\s[^>]*src="/,
      edit: (text) => text.replace(/(<img\s[^>]*src=")([^"]*)"/, '$1/pictures/elsewhere.webp"'),
    },
    {
      part: "code",
      pattern: /`[^`\n]+`/,
      edit: (text) => text.replace(/`([^`\n]+)`/, "`$1 translated`"),
    },
    // No hand-written page names a key yet, so the slip is a key the English page lacks.
    { part: "keys", pattern: /./, edit: (text) => `${text}\nاضغط <kbd>⌘</kbd>.\n` },
    {
      part: "headings",
      pattern: /^#{2,6} .*\{#[^}]+\}$/m,
      edit: (text) => text.replace(/\{#([^}]+)\}$/m, "{#$1-renamed}"),
    },
  ];
  for (const { part, pattern, edit } of slips) {
    it(`refuses a page whose ${part} differ from the English page's`, () => {
      const name = pageWith(pattern);
      expect(problemsOf(site, name)).toEqual([]);
      expect(problemsOf(withPage(name, edit), name).join("\n")).toContain(`its ${part}`);
    });
  }

  it("refuses a heading that names no English id", () => {
    const name = pageWith(/^#{2,6} .*\{#[^}]+\}$/m);
    const problems = problemsOf(
      withPage(name, (text) => text.replace(/ \{#[^}]+\}$/m, "")),
      name,
    );
    expect(problems.join("\n")).toContain("(no id)");
  });

  it("refuses a words file that lacks a word the site needs", () => {
    const sidebar = Object.keys(site.words.get("en") ?? {}).find((key) =>
      key.startsWith("sidebar."),
    );
    const unshipped = [...site.words.keys()].find(
      (word) => word !== "en" && !site.languages.has(word),
    );
    for (const [words, key] of [
      [tag, Object.keys(site.words.get("en") ?? {}).find((key) => key.startsWith("keyboard."))],
      [unshipped, sidebar],
    ] as const) {
      if (!words || !key) throw new Error("the site has no such words to take away");
      const without = { ...site.words.get(words) };
      delete without[key];
      const changed = { ...site, words: new Map(site.words).set(words, without) };
      expect(languageProblems(changed)).toEqual([
        `words/${words}.json lacks "${key}", which English has`,
      ]);
    }
  });

  it("refuses a word the site does not use", () => {
    const words = { ...site.words.get(tag ?? ""), "sidebar.nowhere": "x" };
    const changed = { ...site, words: new Map(site.words).set(tag ?? "", words) };
    expect(languageProblems(changed)).toEqual([
      `words/${tag}.json has "sidebar.nowhere", a word the site does not use`,
    ]);
  });
});
