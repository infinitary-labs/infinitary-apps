import { describe, expect, it } from "vitest";
import {
  KEYBOARD_WORDS,
  SIDEBAR_WORDS,
  SITE_ORIGIN,
  SOURCE_LANGUAGE,
  siteWords,
} from "../docs-site/languages.ts";
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

  it("refuses a link to an English page and a changed routing field", () => {
    const linked = pageWith(/\]\(\/[a-z-]+\/[a-z-]+\/[^)]*\)/);
    const english = withPage(linked, (text) =>
      text.replace(/\]\(\/[a-z-]+\/([a-z-]+\/[^)]*)\)/, "](/$1)"),
    );
    expect(problemsOf(english, linked).join("\n")).toContain("(not in its language)");
    // The same English page, written as the site's full address.
    const absolute = withPage(linked, (text) =>
      text.replace(/\]\(\/[a-z-]+\/([a-z-]+\/[^)]*)\)/, `](${SITE_ORIGIN}/$1)`),
    );
    expect(problemsOf(absolute, linked).join("\n")).toContain("(not in its language)");
    // The page's own language, written as the site's full address, is the same link.
    const own = withPage(linked, (text) =>
      text.replace(/\]\((\/[a-z-]+\/[a-z-]+\/[^)]*)\)/, `](${SITE_ORIGIN}$1)`),
    );
    expect(problemsOf(own, linked)).toEqual([]);
    const name = pageWith(/^title:/m);
    const drafted = withPage(name, (text) => text.replace(/^title:/m, "draft: true\ntitle:"));
    expect(problemsOf(drafted, name).join("\n")).toContain('"draft: true"');
  });

  it("refuses a changed nested frontmatter value, and keeps a worded field's own lines", () => {
    const name = pageWith(/^title:/m);
    const english = site.english.get(name) ?? "";
    const hidden = (text: string, value: boolean) =>
      text.replace(/^title:/m, `sidebar:\n  hidden: ${value}\ntitle:`);
    const changed = {
      ...withPage(name, (text) => hidden(text, true)),
      english: new Map(site.english).set(name, hidden(english, false)),
    };
    const problems = problemsOf(changed, name).filter((problem) => problem.includes("frontmatter"));
    expect(problems.join("\n")).toContain('"  hidden: false"');
    const folded = withPage(name, (text) =>
      text.replace(/^description: (.*)$/m, "description: >\n  $1"),
    );
    expect(problemsOf(folded, name)).toEqual([]);
  });

  it("holds a page in a folder as it holds the rest", () => {
    const english = new Map(site.english).set(
      "guides/one.md",
      "---\ntitle: One\n---\n\n## Start\n",
    );
    expect(languageProblems({ ...site, english }).join("\n")).toContain(
      `${language?.segment}/guides/one.md is missing`,
    );
  });
});

/**
 * The words files, on a small fixed catalog: English, one language that has
 * shipped and one that has not, each with the words the site reads in it.
 */
describe("the docs site's words", () => {
  const english = site.words.get(SOURCE_LANGUAGE) ?? {};
  const wordsFor = (tag: string, shipped: boolean) =>
    Object.fromEntries(siteWords(tag, shipped).map((key) => [key, english[key] ?? key]));
  const fixture = (words: Record<string, Record<string, unknown>>): SiteLanguages => ({
    catalog: ["en", "ar", "ja"],
    english: new Map(),
    languages: new Map([["ar", { segment: "ar", pages: new Map() }]]),
    words: new Map(Object.entries(words)),
  });
  const complete = {
    en: wordsFor("en", true),
    ar: wordsFor("ar", true),
    ja: wordsFor("ja", false),
  };

  it("passes when every language has the words the site reads in it", () => {
    expect(languageProblems(fixture(complete))).toEqual([]);
  });

  it("refuses a missing, blank or non-text word, and a missing words file", () => {
    const keyboard = KEYBOARD_WORDS[0];
    const sidebar = SIDEBAR_WORDS[0];
    const cases: [Record<string, Record<string, unknown>>, string][] = [
      [
        { ...complete, en: { ...complete.en, [keyboard]: undefined } },
        `words/en.json lacks "${keyboard}"`,
      ],
      [
        { ...complete, ar: { ...complete.ar, [keyboard]: " " } },
        `words/ar.json lacks "${keyboard}"`,
      ],
      [{ ...complete, ja: { ...complete.ja, [sidebar]: 3 } }, `words/ja.json lacks "${sidebar}"`],
      [{ en: complete.en, ar: complete.ar }, "words/ja.json is missing"],
    ];
    for (const [words, problem] of cases) {
      expect(languageProblems(fixture(words)).join("\n")).toContain(problem);
    }
  });

  it("refuses a word the site does not use, and a file for a language outside the catalog", () => {
    const problems = languageProblems(
      fixture({ ...complete, ar: { ...complete.ar, "sidebar.nowhere": "x" }, xx: complete.ja }),
    );
    expect(problems).toEqual([
      'words/ar.json has "sidebar.nowhere", a word the site does not use',
      "words/xx.json is for xx, which is not a catalog language",
    ]);
  });
});
