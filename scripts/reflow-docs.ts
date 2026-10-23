import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One sentence per line for the project's prose: `docs/`, `primitives/` and the design
 * skill. Git merges line by line, so a paragraph kept on one line made two
 * edits to different sentences of it collide; with a line per sentence they
 * merge. Markdown renders a line break inside a paragraph as a space, so
 * the pages read exactly as before.
 *
 * `node scripts/reflow-docs.ts` names every file that is not at one
 * sentence per line and exits 1; `--write` rewrites them. A unit test
 * (tests/reflow-docs.test.ts) holds every file to it.
 *
 * Only paragraphs and list items move. Headings, tables, code, HTML, block
 * quotes, front matter and a paragraph with a hard line break stay exactly
 * as written, and a split that would start a line with block syntax (a list
 * marker, a heading, a table pipe, an HTML tag) is not made.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The folders held to one sentence per line. */
export const SENTENCE_LINE_ROOTS = ["docs", "primitives", ".claude/skills/infinitary-design"] as const;

/** Folders inside those that hold someone else's files. */
const SKIPPED_FOLDERS = new Set(["vendor", "node_modules"]);

/** Every Markdown file held to one sentence per line, relative to the repository. */
export function sentenceLineFiles(root: string = REPO_ROOT): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(path);
      } else if (entry.name.endsWith(".md")) {
        found.push(relative(root, path));
      }
    }
  };
  for (const folder of SENTENCE_LINE_ROOTS) walk(join(root, folder));
  return found.sort();
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const ATX_HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)\s*$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])( +)(\S.*)$/;
/** A line starting with any of these would leave the paragraph it sits in. */
const BLOCK_START = /^([-*+](\s|$)|\d{1,9}[.)](\s|$)|#{1,6}(\s|$)|>|\||<|`{3,}|~{3,}|=+\s*$|-+\s*$|\[[^\]]*\]:)/;
/** What may close a sentence after its stop: brackets, quotes and emphasis. */
const CLOSERS = new Set([")", "]", '"', "'", "”", "’", "*", "_"]);
/** What a sentence may start with. */
const SENTENCE_START = /[\p{Lu}0-9`"“*_[(]/u;
/** Words whose stop does not end a sentence. */
const ABBREVIATION = /^(e\.g|i\.e|etc|vs|cf|al|approx|incl|Inc|Ltd|Mr|Mrs|Ms|Dr|St|Jr|Sr|Fig|[A-Za-z]|([A-Za-z]\.)+[A-Za-z])$/;

/** A paragraph or a list item's text, as it was written. */
type Run = { lines: string[]; prefix: string; indent: string };

/** Splits one paragraph's text, joined on spaces, into its sentences. */
export function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "`") {
      // A code span: skip to the closing run of the same length.
      let ticks = 1;
      while (text[index + ticks] === "`") ticks++;
      const close = text.indexOf("`".repeat(ticks), index + ticks);
      index = close < 0 ? index + ticks : close + ticks;
      continue;
    }
    if (char === "<" && /[A-Za-z/!?]/.test(text[index + 1] ?? "")) {
      // An HTML tag or an autolink: skip to its end.
      const close = text.indexOf(">", index);
      index = close < 0 ? index + 1 : close + 1;
      continue;
    }
    if (char === "." || char === "!" || char === "?") {
      let end = index + 1;
      while (end < text.length && CLOSERS.has(text[end] ?? "")) end++;
      let next = end;
      while (text[next] === " ") next++;
      const word = text
        .slice(text.lastIndexOf(" ", index) + 1, index)
        .replace(/^[^\p{L}\p{N}]+/u, "");
      if (
        next > end &&
        next < text.length &&
        SENTENCE_START.test(text[next] ?? "") &&
        !(char === "." && ABBREVIATION.test(word)) &&
        !BLOCK_START.test(text.slice(next))
      ) {
        sentences.push(text.slice(start, end));
        start = next;
        index = next;
        continue;
      }
    }
    index++;
  }
  sentences.push(text.slice(start));
  return sentences;
}

function reflowRun(run: Run): string[] {
  const { lines } = run;
  // A hard line break is the author's own; keep that paragraph as written.
  if (lines.slice(0, -1).some((line) => / {2,}$|\\$/.test(line))) return lines;
  const text = [lines[0]?.slice(run.prefix.length) ?? "", ...lines.slice(1)]
    .map((line) => line.trim())
    .join(" ");
  return sentencesOf(text).map((sentence, index) =>
    index === 0 ? `${run.prefix}${sentence}` : `${run.indent}${sentence}`,
  );
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

/** The same Markdown with every paragraph and list item at one sentence per line. */
export function reflowMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let run: Run | null = null;
  let fence: { mark: string; length: number } | null = null;
  // Raw until a blank line: an HTML block, a table, a block quote.
  let raw = false;
  let comment = false;
  // The content columns of the list items still open, innermost last.
  const lists: number[] = [];

  const flush = () => {
    if (run) out.push(...reflowRun(run));
    run = null;
  };

  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      out.push(...lines.slice(0, end + 1));
      index = end + 1;
    }
  }

  for (; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (fence) {
      out.push(line);
      const close = FENCE.exec(line);
      if (close?.[2]?.[0] === fence.mark && close[2].length >= fence.length && line.trim() === close[2]) {
        fence = null;
      }
      continue;
    }
    if (comment) {
      out.push(line);
      if (line.includes("-->")) comment = false;
      continue;
    }
    if (line.trim() === "") {
      flush();
      raw = false;
      out.push(line);
      continue;
    }
    if (raw) {
      out.push(line);
      continue;
    }
    const opener = FENCE.exec(line);
    if (opener) {
      flush();
      fence = { mark: opener[2]?.[0] ?? "`", length: opener[2]?.length ?? 3 };
      out.push(line);
      continue;
    }
    const pending: Run | null = run;
    if (pending && (SETEXT_UNDERLINE.test(line) || TABLE_DELIMITER.test(line))) {
      // The paragraph so far is a heading's text or a table's header row.
      out.push(...pending.lines, line);
      run = null;
      raw = TABLE_DELIMITER.test(line) && line.includes("|");
      continue;
    }
    const indent = leadingSpaces(line);
    if (ATX_HEADING.test(line) || THEMATIC_BREAK.test(line) || LINK_DEFINITION.test(line)) {
      flush();
      while ((lists.at(-1) ?? -1) > indent) lists.pop();
      out.push(line);
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("<") || trimmed.startsWith("|") || trimmed.startsWith(">")) {
      flush();
      out.push(line);
      if (trimmed.startsWith("<!--") && !line.includes("-->")) comment = true;
      else raw = true;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item && !THEMATIC_BREAK.test(line)) {
      flush();
      const prefix = `${item[1]}${item[2]}${item[3]}`;
      while ((lists.at(-1) ?? -1) > indent) lists.pop();
      lists.push(prefix.length);
      if (BLOCK_START.test(item[4] ?? "")) {
        // A list item that opens with code, a table or HTML stays as written.
        out.push(line);
        raw = true;
        continue;
      }
      run = { lines: [line], prefix, indent: " ".repeat(prefix.length) };
      continue;
    }
    if (run) {
      run.lines.push(line);
      continue;
    }
    while ((lists.at(-1) ?? -1) > indent) lists.pop();
    const column = lists.at(-1);
    if (indent >= (column ?? 0) + 4) {
      // An indented code block.
      out.push(line);
      continue;
    }
    const lead = line.slice(0, indent);
    run = { lines: [line], prefix: lead, indent: lead };
  }
  flush();
  return out.join("\n");
}

function main(args: string[]): number {
  const write = args.includes("--write");
  const unfinished: string[] = [];
  for (const file of sentenceLineFiles()) {
    const path = join(REPO_ROOT, file);
    const text = readFileSync(path, "utf8");
    const reflowed = reflowMarkdown(text);
    if (reflowed === text) continue;
    unfinished.push(file);
    if (write) writeFileSync(path, reflowed);
  }
  if (write) {
    console.log(`Reflowed ${unfinished.length} file(s) to one sentence per line.`);
    return 0;
  }
  if (unfinished.length === 0) return 0;
  console.error(
    `Not at one sentence per line (run node scripts/reflow-docs.ts --write):\n${unfinished.join("\n")}`,
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
