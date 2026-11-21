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

  it("refuses a path that does not exist and a quoted heading its page does not have", () => {
    const moved = memory.replace("`docs/forge.md`", "`docs/where-projects-live.md`");
    expect(pointerProblems(moved, root)).toEqual([
      expect.stringMatching(/`docs\/where-projects-live\.md` does not exist/),
    ]);
    const renamed = memory.replace('"The swept batch"', '"The combined batch"');
    expect(pointerProblems(renamed, root)).toEqual([
      expect.stringMatching(/`docs\/testing\.md` has no section "The combined batch"/),
    ]);
  });

  it("refuses a docs page the index leaves out and a listed page that is gone", () => {
    const listed = listedPages(index);
    expect(listed).toContain("testing.md");
    const pages = [...listed];
    expect(
      indexProblems(
        listed.filter((page) => page !== "forge.md"),
        pages,
      ),
    ).toEqual([expect.stringMatching(/docs\/forge\.md is not listed/)]);
    expect(
      indexProblems(
        listed,
        pages.filter((page) => page !== "forge.md"),
      ),
    ).toEqual([expect.stringMatching(/lists forge\.md, which is not under docs\//)]);
  });
});
