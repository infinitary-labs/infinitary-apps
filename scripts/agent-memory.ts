/**
 * The size check on `AGENTS.md`, the file every agent session in this
 * project reads first (docs/testing.md, "The size check on AGENTS.md").
 * It has two lines, the captain's picks, built as the prompt budget's two
 * are: past `AGENTS_WORD_CEILING` words `pnpm check` refuses the change, and
 * past `AGENTS_WARNING_WORD_LIMIT` words a run on main fails and starts one
 * trim task, holding nothing.
 *
 * The same `pnpm check` run keeps the file's pointers true: every path it
 * names in backticks exists, every quoted section heading after a path is a
 * heading of that page, and `docs/README.md` lists every page under `docs/`
 * and no page that is gone. Plain Node type stripping, no install.
 *
 *   node scripts/agent-memory.ts          exits 1 naming each problem
 *   node scripts/agent-memory.ts --warn   exits 1 when the file is past the warning line
 *
 * agent-memory.yml runs `--warn` on each push to main that changes the file,
 * this script or the workflow, and by hand. No pull request, batch, main
 * check or release reads it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printErrors } from "./github-errors.ts";

/** The hard line: `pnpm check` refuses an `AGENTS.md` longer than this many words. */
export const AGENTS_WORD_CEILING = 1500;

/** The warning line: a run on main fails past it, and its red run starts one trim task. */
export const AGENTS_WARNING_WORD_LIMIT = 1200;

/** Where each file the check reads sits, from the project's top. */
export const MEMORY_FILE = "AGENTS.md";
export const DOCS_INDEX = "docs/README.md";

/** The rule a trim follows, named in every message. */
const RULE = `${MEMORY_FILE}'s "Maintaining this file"`;

/** The number of words in a text, as `wc -w` counts them. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The problem with the file's length against a line, or none. */
export function wordProblem(text: string, line: number): string | undefined {
  const words = wordCount(text);
  if (words <= line) return undefined;
  return `${MEMORY_FILE}: ${words} words, over the ${line}-word ${line === AGENTS_WORD_CEILING ? "ceiling" : "warning line"} (warning line ${AGENTS_WARNING_WORD_LIMIT}, ceiling ${AGENTS_WORD_CEILING}); move detail to the page that owns it and keep one sentence per rule, by ${RULE}`;
}

/** A path the file points at, with the section headings quoted after it. */
export type Pointer = { line: number; path: string; headings: string[] };

/**
 * Whether a backticked span names a file or folder: no space, wildcard,
 * placeholder or home folder, and a slash or a file extension.
 */
export function isPath(span: string): boolean {
  if (/[\s*<>~()]/.test(span)) return false;
  return span.includes("/") || /\.(md|ts|tsx|mjs|js|json|yml|yaml)$/.test(span);
}

/**
 * Every path the text names in backticks, with each "quoted heading" that
 * follows it before the next backticked span, a closing bracket, a table
 * cell's edge or the line's end.
 */
export function pointersIn(text: string): Pointer[] {
  const pointers: Pointer[] = [];
  text.split("\n").forEach((content, index) => {
    const spans = [...content.matchAll(/`([^`]+)`/g)];
    spans.forEach((span, at) => {
      const path = span[1] ?? "";
      if (!isPath(path)) return;
      const from = (span.index ?? 0) + span[0].length;
      const next = spans[at + 1]?.index ?? content.length;
      const tail = content.slice(from, next).split(/[)|]/)[0] ?? "";
      const headings = [...tail.matchAll(/"([^"]+)"/g)].map((quote) => quote[1] ?? "");
      pointers.push({ line: index + 1, path, headings });
    });
  });
  return pointers;
}

/** The section headings of a Markdown page, without their marks or backticks. */
export function headingsOf(page: string): string[] {
  return [...page.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)].map((match) => (match[1] ?? "").replaceAll("`", ""));
}

/** Each pointer in the file that leads nowhere, as one line. */
export function pointerProblems(text: string, root: string): string[] {
  const problems: string[] = [];
  for (const { line, path, headings } of pointersIn(text)) {
    const target = resolve(root, path);
    if (!existsSync(target)) {
      problems.push(`${MEMORY_FILE}:${line}: \`${path}\` does not exist; point at the page that owns the subject now`);
      continue;
    }
    if (!headings.length) continue;
    const have = statSync(target).isFile() ? headingsOf(readFileSync(target, "utf8")) : [];
    for (const heading of headings)
      if (!have.includes(heading))
        problems.push(`${MEMORY_FILE}:${line}: \`${path}\` has no section "${heading}"; quote a heading it has`);
  }
  return problems;
}

/** The pages `docs/README.md` lists, one per line as "- `name.md`: what it owns". */
export function listedPages(index: string): string[] {
  return [...index.matchAll(/^- `([^`/]+\.md)`:/gm)].map((match) => match[1] ?? "");
}

/** Each page under `docs/` the index leaves out, and each listed page that is gone, as one line. */
export function indexProblems(listed: readonly string[], pages: readonly string[]): string[] {
  const problems: string[] = [];
  const have = new Set(pages);
  const named = new Set(listed);
  for (const page of pages)
    if (!named.has(page)) problems.push(`${DOCS_INDEX}: docs/${page} is not listed; add a line saying what it owns`);
  for (const page of listed)
    if (!have.has(page)) problems.push(`${DOCS_INDEX}: lists ${page}, which is not under docs/; remove its line`);
  return problems;
}

/** Every problem the check finds in the project at `root`. */
export function memoryProblems(root: string): string[] {
  const text = readFileSync(resolve(root, MEMORY_FILE), "utf8");
  const pages = readdirSync(resolve(root, "docs")).filter((name) => name.endsWith(".md") && name !== "README.md");
  const index = readFileSync(resolve(root, DOCS_INDEX), "utf8");
  const size = wordProblem(text, AGENTS_WORD_CEILING);
  return [...(size ? [size] : []), ...pointerProblems(text, root), ...indexProblems(listedPages(index), pages)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv.includes("--warn")) {
    const text = readFileSync(resolve(root, MEMORY_FILE), "utf8");
    const warning = wordProblem(text, AGENTS_WARNING_WORD_LIMIT);
    console.log(`${MEMORY_FILE}: ${wordCount(text)} words (warning line ${AGENTS_WARNING_WORD_LIMIT}, ceiling ${AGENTS_WORD_CEILING})`);
    if (warning) {
      printErrors([warning], { title: "AGENTS.md warning line" });
      process.exitCode = 1;
    }
  } else {
    const problems = memoryProblems(root);
    if (problems.length) {
      printErrors(problems, { title: "AGENTS.md check" });
      process.exitCode = 1;
    }
  }
}
