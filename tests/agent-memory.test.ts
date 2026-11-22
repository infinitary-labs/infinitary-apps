import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENTS_WARNING_WORD_LIMIT,
  AGENTS_WORD_CEILING,
  DOCS_INDEX,
  indexProblems,
  listedPages,
  MEMORY_FILE,
  memoryProblems,
  pointerProblems,
  pointersIn,
  wordCount,
  wordProblem,
} from "../scripts/agent-memory.ts";

/**
 * The size check on AGENTS.md (INF-5611's approved plan, the captain's
 * "warn at 1200 words, but the hard error is raised at something higher like
 * 1500"). `pnpm check` runs it over the project; here, what it refuses, on
 * the project's own AGENTS.md and docs index.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const memory = readFileSync(`${root}${MEMORY_FILE}`, "utf8");
const index = readFileSync(`${root}${DOCS_INDEX}`, "utf8");
/** The file grown to `words` words by repeating its own text. */
const grownTo = (words: number) => {
  const all = memory.split(/\s+/).filter(Boolean);
  return Array.from({ length: words }, (_, at) => all[at % all.length]).join(" ");
};

describe("the size check on AGENTS.md", () => {
  it("passes the project as it stands", () => {
    expect(memoryProblems(root)).toEqual([]);
  });

  it("counts words as wc -w does", () => {
    expect(wordCount(`${memory}\nextra words`)).toBe(wordCount(memory) + 2);
  });

  it("refuses the file only past the ceiling, and warns only past the warning line", () => {
    expect(wordProblem(grownTo(AGENTS_WORD_CEILING), AGENTS_WORD_CEILING)).toBeUndefined();
    expect(wordProblem(grownTo(AGENTS_WORD_CEILING + 1), AGENTS_WORD_CEILING)).toMatch(
      /1501 words, over the 1500-word ceiling/,
    );
    const between = grownTo(AGENTS_WARNING_WORD_LIMIT + 100);
    expect(wordProblem(between, AGENTS_WORD_CEILING)).toBeUndefined();
    expect(wordProblem(between, AGENTS_WARNING_WORD_LIMIT)).toMatch(
      /1300 words, over the 1200-word warning line/,
    );
    expect(
      wordProblem(grownTo(AGENTS_WARNING_WORD_LIMIT), AGENTS_WARNING_WORD_LIMIT),
    ).toBeUndefined();
  });

  // Each case breaks one pointer the file holds now, found by reading it, so a
  // later trim that drops any one pointer leaves the case standing.
  const lines = memory.split("\n");
  const quoted = pointersIn(memory).find((pointer) => pointer.headings.length);
  /** The file with one line rewritten. */
  const withLine = (line: number, edit: (text: string) => string) =>
    lines.map((text, at) => (at === line - 1 ? edit(text) : text)).join("\n");

  it("refuses a path that does not exist and a quoted heading its page does not have", () => {
    if (!quoted) throw new Error(`${MEMORY_FILE} quotes no section heading after a path`);
    const moved = withLine(quoted.line, (text) =>
      text.replace(`\`${quoted.path}\``, "`docs/no-such-page.md`"),
    );
    expect(pointerProblems(moved, root)).toEqual([
      expect.stringMatching(/`docs\/no-such-page\.md` does not exist/),
    ]);
    const heading = quoted.headings[0] ?? "";
    const renamed = withLine(quoted.line, (text) =>
      text.replace(`"${heading}"`, '"No such section"'),
    );
    expect(pointerProblems(renamed, root)).toEqual([
      expect.stringMatching(/has no section "No such section"/),
    ]);
  });

  it("refuses a docs page the index leaves out and a listed page that is gone", () => {
    const listed = listedPages(index);
    const [page] = listed;
    if (!page) throw new Error(`${DOCS_INDEX} lists no page`);
    expect(
      indexProblems(
        listed.filter((name) => name !== page),
        listed,
      ),
    ).toEqual([expect.stringContaining(`${page} is not listed`)]);
    expect(
      indexProblems(
        listed,
        listed.filter((name) => name !== page),
      ),
    ).toEqual([expect.stringContaining(`lists ${page}, which is not under docs/`)]);
  });
});
