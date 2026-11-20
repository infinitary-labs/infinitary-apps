/**
 * Every date, time, number and plural the app writes follows the app's
 * language (docs/i18n.md, "Formats"): outside src/shared/i18n/, a
 * `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` or `Intl`
 * formatter must be handed a locale the i18n module gives, never none, `[]`,
 * `undefined` or a fixed tag, and no fixed `"en-US"` appears at all. The
 * places that cannot yet follow it are listed below with why; the list only
 * shrinks.
 *
 *   node scripts/locale-formats.ts   exits 1 naming each place out of step
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Where a fixed or missing locale stays, and why. An entry no longer needed is a problem: the list only shrinks. */
export const FIXED_LOCALE_PLACES: Readonly<Record<string, string>> = {
  "src/core/prompts/timeZone.ts": "reads a zone's offset out of the formatter's own English words",
  "src/core/orchestrator/calendar.ts": "reads wall-clock numbers out of the formatter's parts",
  "src/core/runbooks/parts/map.js": "a part of the served guidance, which stays English",
};

const FORMAT_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);
const INTL_FORMATTERS = new Set(["DateTimeFormat", "NumberFormat", "RelativeTimeFormat", "PluralRules", "ListFormat", "DisplayNames"]);

/** A locale argument that leaves the language out: none, `[]`, `undefined`, or a fixed tag. */
function leavesLanguageOut(arg: ts.Expression | undefined): boolean {
  if (!arg) return true;
  if (ts.isArrayLiteralExpression(arg) && arg.elements.length === 0) return true;
  if (ts.isIdentifier(arg) && arg.text === "undefined") return true;
  return ts.isStringLiteralLike(arg);
}

/** `Intl.DateTimeFormat().resolvedOptions()` reads the computer's zone or locale; it formats nothing. */
function onlyReadsOptions(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isPropertyAccessExpression(parent) && parent.name.text === "resolvedOptions";
}

export function fixedLocaleProblems(files: Record<string, string>): string[] {
  const problems: string[] = [];
  const needed = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (!/^src\/.*\.(ts|tsx|js|mjs)$/.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path)) continue;
    if (path.startsWith("src/shared/i18n/")) continue;
    // An app panel's compiled messages: the format module's own rules, copied
    // into a module the panel can reach (scripts/generate-messages.ts).
    if (/^src\/panels\/[^/]+\/messages\.generated\.ts$/.test(path)) continue;
    const kind = path.endsWith("x") ? ts.ScriptKind.TSX : path.endsWith("ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
    const found: string[] = [];
    const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    const walk = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) && node.text === "en-US") {
        found.push(`${path}:${line(node)}: a fixed "en-US"; write it through src/shared/i18n/format.ts`);
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        const receiver = node.expression.expression;
        const intl = ts.isIdentifier(receiver) && receiver.text === "Intl" && INTL_FORMATTERS.has(name);
        if ((FORMAT_METHODS.has(name) || (intl && !onlyReadsOptions(node))) && leavesLanguageOut(node.arguments[0])) {
          found.push(`${path}:${line(node)}: ${name} without the app's language; use src/shared/i18n/format.ts`);
        }
      } else if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        if (ts.isIdentifier(receiver) && receiver.text === "Intl" && INTL_FORMATTERS.has(node.expression.name.text) && leavesLanguageOut(node.arguments?.[0])) {
          found.push(`${path}:${line(node)}: Intl.${node.expression.name.text} without the app's language; use src/shared/i18n/format.ts`);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
    if (path in FIXED_LOCALE_PLACES) {
      if (found.length) needed.add(path);
      continue;
    }
    problems.push(...found);
  }
  for (const path of Object.keys(FIXED_LOCALE_PLACES)) {
    if (!needed.has(path)) problems.push(`scripts/locale-formats.ts: ${path} no longer writes a fixed locale; remove its entry, and the list shrinks`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], { encoding: "utf8" }).trim().split("\n");
  const problems = fixedLocaleProblems(Object.fromEntries([...new Set(paths)].map((path) => [path, readFileSync(path, "utf8")])));
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  }
}
