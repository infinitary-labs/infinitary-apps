/**
 * The holds registry check (INF-242's plan, INF-473; docs/delivery-rigor.md,
 * "The holds"). Every hold the app places on work is one entry of `HOLDS`
 * in `src/shared/holds.ts`, and every site cites its entry through
 * `overridePasses`, `softHoldWords` or `fixedHoldWords`. This keeps the
 * list, its sites and the docs table in step:
 *
 *   - every kind a site cites is in the registry, at the level its call asks
 *     for (the override passes only a soft hold with no way of its own);
 *   - every kind in the registry has a site, so no entry outlives its hold;
 *   - no code writes a hold's sentence by hand, outside the registry;
 *   - the docs table lists the registry, in order, with each level and what
 *     each rests on.
 *
 * Which level a hold takes is a judgment by the four questions, never this
 * check. Plain Node type stripping, no install; `pnpm check` runs it.
 *
 *   node scripts/holds.ts    exits 1 naming each hold out of step
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDS } from "../src/shared/holds.ts";

type Registry = Record<string, { level: string; restsOn: string; way?: string }>;

const CALLS = {
  overridePasses: { kindArg: 1, asks: "overridable" },
  softHoldWords: { kindArg: 0, asks: "soft" },
  fixedHoldWords: { kindArg: 0, asks: "fixed" },
} as const;
type Call = keyof typeof CALLS;

const REGISTRY_FILE = "src/shared/holds.ts";
const DOCS_FILE = "docs/delivery-rigor.md";
/** A hold's sentence, which only the registry writes. */
const HAND_WRITTEN = /Soft hold |This is the fixed limit /;

export type Citation = { path: string; line: number; call: Call; kind: string };

/** The arguments of the call whose open parenthesis is at `open`, split at its own commas. */
function argumentsAt(text: string, open: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = open + 1;
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (quote) {
      if (char === "\\") at++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, at));
        return args;
      }
    } else if (char === "," && depth === 1) {
      args.push(text.slice(start, at));
      start = at + 1;
    }
  }
  return undefined;
}

export function citationsIn(path: string, text: string): Citation[] {
  const citations: Citation[] = [];
  for (const match of text.matchAll(/\b(overridePasses|softHoldWords|fixedHoldWords)\(/g)) {
    const call = match[1] as Call;
    const open = (match.index ?? 0) + match[0].length - 1;
    const kindArg = argumentsAt(text, open)?.[CALLS[call].kindArg];
    if (kindArg === undefined) continue;
    const line = text.slice(0, match.index).split("\n").length;
    for (const literal of kindArg.matchAll(/"([^"\\]*)"/g)) {
      // A kind read through a comparison (`x === "a" ? "b" : "c"`) is the
      // branches', not the compared value's.
      const before = kindArg.slice(0, literal.index).trimEnd();
      if (/[=!]==?$/.test(before)) continue;
      citations.push({ path, line, call, kind: literal[1] ?? "" });
    }
  }
  return citations;
}

export function docsRows(markdown: string): { kind: string; level: string; restsOn: string }[] {
  const section = markdown.split(/^## The holds$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^\| `([^`]+)` \| ([^|]+?) \| ([^|]+?) \|/gm)].map(
    ([, kind = "", level = "", restsOn = ""]) => ({ kind, level: level.trim(), restsOn: restsOn.trim() }),
  );
}

export function holdProblems(
  registry: Registry,
  sources: { path: string; text: string }[],
  docs: string,
): string[] {
  const problems: string[] = [];
  const cited = new Set<string>();
  for (const source of sources) {
    if (source.path === REGISTRY_FILE) continue;
    source.text.split("\n").forEach((text, index) => {
      if (HAND_WRITTEN.test(text))
        problems.push(
          `${source.path}:${index + 1}: a hold's sentence written by hand; end the refusal with softHoldWords or fixedHoldWords so it names its registered kind`,
        );
    });
    for (const citation of citationsIn(source.path, source.text)) {
      const where = `${citation.path}:${citation.line}`;
      const hold = registry[citation.kind];
      if (!hold) {
        problems.push(
          `${where}: ${citation.call} cites "${citation.kind}", a hold outside the registry; add it to HOLDS in ${REGISTRY_FILE} with its level, and to the table in ${DOCS_FILE}`,
        );
        continue;
      }
      cited.add(citation.kind);
      const asks = CALLS[citation.call].asks;
      const fits =
        asks === "fixed"
          ? hold.level === "fixed"
          : hold.level === "soft" && (asks === "soft" || hold.way === undefined);
      if (!fits)
        problems.push(
          `${where}: ${citation.call} cites "${citation.kind}", which the registry holds ${hold.level}${hold.way ? " with a way of its own" : ""}`,
        );
    }
  }
  for (const kind of Object.keys(registry))
    if (!cited.has(kind))
      problems.push(
        `${REGISTRY_FILE}: "${kind}" has no site; cite it where the hold is placed, or remove it`,
      );
  const rows = docsRows(docs);
  const kinds = Object.keys(registry);
  if (rows.map((row) => row.kind).join() !== kinds.join())
    problems.push(
      `${DOCS_FILE}: "The holds" table lists ${rows.map((row) => row.kind).join(", ") || "nothing"}; the registry lists ${kinds.join(", ")}, in that order`,
    );
  for (const row of rows) {
    const hold = registry[row.kind];
    if (hold && (row.level !== hold.level || row.restsOn !== hold.restsOn))
      problems.push(
        `${DOCS_FILE}: "${row.kind}" reads ${row.level}, ${row.restsOn}; the registry holds it ${hold.level}, ${hold.restsOn}`,
      );
  }
  return problems;
}

function main(): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Tracked files and new ones git does not ignore, as CI will read them.
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));
  const sources = paths.flatMap((path) => {
    try {
      return [{ path, text: readFileSync(resolve(root, path), "utf8") }];
    } catch {
      // A tracked file deleted in the working copy.
      return [];
    }
  });
  const problems = holdProblems(HOLDS, sources, readFileSync(resolve(root, DOCS_FILE), "utf8"));
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`holds: ${problems.length} out of step with the registry`);
    return 1;
  }
  console.log(`holds: ${Object.keys(HOLDS).length} holds, each cited and in the docs table`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main());
