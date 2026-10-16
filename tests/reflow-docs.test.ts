import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reflowMarkdown, sentenceLineFiles } from "../scripts/reflow-docs.ts";

const REPO_ROOT = resolve(__dirname, "..");

describe("one sentence per line", () => {
  it("holds the docs and the design skill to it", () => {
    const files = sentenceLineFiles(REPO_ROOT);
    expect(files).toContain("docs/testing.md");
    expect(files).toContain(".claude/skills/infinitary-design/readme.md");
    expect(files.some((file) => file.includes("/vendor/"))).toBe(false);
    const unfinished = files.filter((file) => {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      return reflowMarkdown(text) !== text;
    });
    // Fix with: node scripts/reflow-docs.ts --write
    expect(unfinished).toEqual([]);
  });

  it("puts each sentence of a paragraph or a list item on a line of its own", () => {
    expect(reflowMarkdown("One rule. Two rules! Three? `Four` ends.\n")).toBe(
      "One rule.\nTwo rules!\nThree?\n`Four` ends.\n",
    );
    expect(reflowMarkdown("- **Bold lead.** Then a second.\n  1. Nested one. And two.\n")).toBe(
      "- **Bold lead.**\n  Then a second.\n  1. Nested one.\n     And two.\n",
    );
  });

  it("joins a hard-wrapped paragraph before it splits it", () => {
    expect(reflowMarkdown("A sentence wrapped\nover two lines. And a\nsecond one.\n")).toBe(
      "A sentence wrapped over two lines.\nAnd a second one.\n",
    );
  });

  it("splits no abbreviation, code span, tag, or place a line would leave its paragraph", () => {
    const kept = [
      "Use a stub, e.g. `Foo`, or a fake, i.e. Bar, before it runs.",
      'Run `pnpm check. Then` and <a title="x. Y">this</a> together.',
      "The count fell in 2026. 1. is not a list here.",
      "It ends with a dash. - not a list item.",
    ];
    for (const text of kept) expect(reflowMarkdown(text)).toBe(text);
  });

  it("leaves code, tables, headings, HTML, quotes and hard breaks as written", () => {
    const kept = [
      "# A heading. With two sentences.",
      "```\nCode. Stays.\n```",
      "| A. B. | C |\n| --- | --- |\n| D. E. | F |",
      "<details>\nRaw HTML. Stays.\n</details>",
      "> A quote. Stays.",
      "A hard break.  \nKept. As written.",
      "---\nname: front-matter\ndescription: One. Two.\n---",
    ];
    for (const text of kept) expect(reflowMarkdown(text)).toBe(text);
  });

  it("changes nothing on a second pass", () => {
    const text = readFileSync(join(REPO_ROOT, "docs/testing.md"), "utf8");
    const once = reflowMarkdown(text.replaceAll("\n- ", "\n- Lead. "));
    expect(reflowMarkdown(once)).toBe(once);
  });
});
