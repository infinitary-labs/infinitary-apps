/**
 * The layout runs both ways (docs/i18n.md, "Right to left"): the window and
 * its panels lay out from the start of a line, not from its left, so a
 * right-to-left language mirrors them. In the stylesheets under the window
 * and the app's own panels, and in the inline styles of their code, a margin,
 * padding, border or radius names a side by `inline-start` and `inline-end`,
 * text aligns to `start` or `end`, and a float to `inline-start` or
 * `inline-end`; a stylesheet places a box with `inset-inline-start` and
 * `inset-inline-end`, never `left` or `right`.
 *
 * A side that must stay physical says why with `physical: <reason>` in a
 * comment on its line or the line above, such as a box centred with
 * `left: 50%` and `translateX(-50%)`, which mirrors to itself. An inline
 * style's `left` and `right` are not read: they are coordinates the code
 * measured, such as a pointer's.
 *
 *   node scripts/logical-css.ts   exits 1 naming each physical side
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Where the check reads: the window, the app's own panels and the built-in runbooks' panels, where stylesheets live. */
const ROOTS = ["src/renderer/src/", "src/panels/", "resources/runbooks/"];
/** The developer-only gallery of the design's parts. */
const NOT_SHOWN = /^src\/renderer\/src\/design\/fixtures\//;
const WAIVER = /physical:\s*\S/;

/** A stylesheet's physical sides and the logical ones that replace them. */
const CSS_PROPERTIES =
  /(^|[;{\s])((margin|padding|border|scroll-margin|scroll-padding)-(left|right)(-[a-z]+)?|border-(top|bottom)-(left|right)-radius|left|right)\s*:/;
const CSS_VALUES = /(^|[;{\s])(text-align|float|clear)\s*:\s*(left|right)\b/;

/** An inline style's physical sides, as React names them. */
const STYLE_PROPERTIES =
  /^(margin|padding|border|scrollMargin|scrollPadding)(Left|Right)(Color|Style|Width)?$|^border(Top|Bottom)(Left|Right)Radius$/;
const STYLE_VALUES = new Set(["textAlign", "float", "clear"]);

export function cssProblems(path: string, text: string): string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  let inComment = false;
  lines.forEach((line, index) => {
    // Comments are words about the layout, not the layout.
    let code = "";
    for (let at = 0; at < line.length; at++) {
      if (inComment) {
        if (line.startsWith("*/", at)) {
          inComment = false;
          at++;
        }
      } else if (line.startsWith("/*", at)) {
        inComment = true;
        at++;
      } else code += line[at];
    }
    if (!CSS_PROPERTIES.test(code) && !CSS_VALUES.test(code)) return;
    if (/^\s*--/.test(code) || /@property/.test(code)) return;
    if (WAIVER.test(line) || WAIVER.test(lines[index - 1] ?? "")) return;
    problems.push(
      `${path}:${index + 1}: ${code.trim()} names a physical side; use the inline-start or inline-end form, or say why it stays with physical: <reason> (docs/i18n.md, "Right to left")`,
    );
  });
  return problems;
}

export function styleProblems(path: string, text: string): string[] {
  const problems: string[] = [];
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split("\n");
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const name = node.name.text;
      const value = node.initializer;
      const physical =
        STYLE_PROPERTIES.test(name) ||
        (STYLE_VALUES.has(name) && ts.isStringLiteral(value) && /^(left|right)$/.test(value.text));
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
      if (physical && !WAIVER.test(lines[line] ?? "") && !WAIVER.test(lines[line - 1] ?? ""))
        problems.push(
          `${path}:${line + 1}: ${node.getText(tree)} names a physical side; use the InlineStart or InlineEnd form, or say why it stays with physical: <reason> (docs/i18n.md, "Right to left")`,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return problems;
}

/** Every physical side in the files the check reads, as one line each. */
export function logicalCssProblems(files: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!ROOTS.some((root) => path.startsWith(root)) || NOT_SHOWN.test(path)) continue;
    if (/\.(test|spec)\.tsx?$/.test(path)) continue;
    if (path.endsWith(".css")) problems.push(...cssProblems(path, text));
    else if (/\.tsx?$/.test(path)) problems.push(...styleProblems(path, text));
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...ROOTS], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  const files: Record<string, string> = {};
  for (const path of new Set(paths)) {
    try {
      files[path] = readFileSync(path, "utf8");
    } catch {}
  }
  const problems = logicalCssProblems(files);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  }
}
