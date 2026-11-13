/**
 * The raw-words check (docs/i18n.md, "Words still typed in the code"): the
 * words the window, its panels and its keyboard commands show come from the
 * catalog, so a file under those roots holds no words typed in for a person
 * to read. The files that still do are on `RAW_WORDS_LEDGER` with how many
 * runs of words each holds; the ledger only shrinks. A file not on it must
 * hold none, a listed file may not gain one, and a listed file that lost
 * some must lower its count, or leave the ledger at none, in the same pull
 * request.
 *
 * What counts as words a person reads, read from each file's syntax:
 * - JSX text holding a letter;
 * - a string or template in a JSX attribute a person reads (`aria-label`,
 *   `title`, `placeholder`, `alt`, `label` and their kin);
 * - anywhere else, a string or template that reads as prose: two or more
 *   words holding letters, or one capitalized word such as `Cancel`, that is
 *   not an id, a class list, a key name, a path or a style.
 * A string compared with `===`, used as a case, a property name, a type, an
 * import, a selector or an event name, or handed to an `Error` or `console`
 * is not words a person reads. Words that must stay typed in say why with
 * `i18n-exempt: <reason>` on their line or the line above, which covers the
 * statement or expression starting there: a name, a symbol,
 * or a developer-only view.
 *
 *   node scripts/raw-words.ts          exits 1 naming each file out of step with the ledger
 *   node scripts/raw-words.ts --list   every file holding raw words, with its count
 *   node scripts/raw-words.ts --show <file>   each run of raw words in one file
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Where the check reads: the window, the app's own panels, and the keyboard commands' words. */
export const RAW_WORDS_ROOTS: readonly string[] = ["src/renderer/src/", "src/panels/", "src/shared/keyboard.ts"];

/**
 * Files under the roots that are not shown to a person: the developer-only
 * gallery of the design's parts and Observe view, and generated files.
 */
const NOT_SHOWN = [
  /^src\/renderer\/src\/design\/fixtures\//,
  /^src\/renderer\/src\/plugins\/builtin\/observe\//,
  /\.generated\.tsx?$/,
];

/** JSX attributes whose value a person reads or hears. */
const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "aria-placeholder",
  "title",
  "placeholder",
  "alt",
  "label",
]);

/** Single capitalized words a key or an event names, never words a person reads. */
const KEY_NAMES = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "Shift",
  "Meta",
  "Alt",
  "Control",
  "Space",
  "Insert",
  "Dead",
  "Unidentified",
  "Process",
  "PageUp",
  "PageDown",
  "Infinitary",
]);

/** Calls whose string arguments name code, not words: selectors, attributes, events, errors and logs. */
const CODE_CALLS = new Set([
  "querySelector",
  "querySelectorAll",
  "getElementById",
  "getElementsByClassName",
  "closest",
  "matches",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "setAttribute",
  "getAttribute",
  "hasAttribute",
  "removeAttribute",
  "toggleAttribute",
  "setProperty",
  "getPropertyValue",
  "createElement",
  "add",
  "remove",
  "toggle",
  "contains",
  "invoke",
  "send",
  "on",
  "off",
  "emit",
  "postMessage",
  "require",
  "Symbol",
  "Error",
  "TypeError",
  "RangeError",
  "describe",
  "it",
  "test",
]);

const WAIVER = /i18n-exempt:\s*\S/;

/** CSS functions and the like: a value with one of these is a style, not words. */
const CSS_FUNCTIONS =
  /var\(--|calc\(|min\(|max\(|minmax\(|clamp\(|color-mix\(|translate[XYZ3d]*\(|rotate\(|scale[XY]?\(|rgba?\(|hsla?\(|oklch\(|cubic-bezier\(|steps\(|repeat\(|(linear|radial|conic)-gradient\(|inset\(|drop-shadow\(|blur\(/;
/** One word of a CSS value: a length, a time, a keyword or an easing. */
const CSS_WORD =
  /^(-?[\d.]+(px|em|rem|%|ms|s|deg|turn|fr|vh|vw|vmin|vmax|ch|ex|lh|dvh|svh)?|auto|none|solid|dashed|dotted|double|transparent|inherit|initial|unset|currentcolor|ease|ease-in|ease-out|ease-in-out|linear|normal|bold|italic|nowrap|hidden|visible|clip|scroll|absolute|relative|fixed|sticky|flex|grid|block|contents|inline|inline-flex|inline-block|inline-grid|center|start|end|flex-start|flex-end|space-between|space-around|baseline|stretch|pointer|default|column|row|wrap|both|forwards|backwards|infinite|alternate|opacity|transform|background|color|border-color|box-shadow|width|height|top|left|right|bottom|span|dense|min-content|max-content|fit-content|break-word|anywhere|pre-wrap|uppercase|lowercase|tabular-nums|ellipsis|[a-z]+(-[a-z]+)*\(.*\)?|\/)$/i;

/** Whether a literal is a style, a media query or a selector rather than words. */
function readsAsCode(text: string): boolean {
  if (CSS_FUNCTIONS.test(text)) return true;
  if (/^\(\s*[a-z-]+\s*(:|\))/.test(text) || text.startsWith("@media")) return true;
  if (/^\(.*\b\d+(px|vh|vw|%)/.test(text)) return true;
  if (/^\s*(<|&lt;)[a-z/!]/i.test(text)) return true;
  if (/^[MmLlHhVvCcSsQqTtAaZz][\d\s.,MmLlHhVvCcSsQqTtAaZz-]*$/.test(text) && /\d/.test(text)) return true;
  if (/\[[\w-]+(?:[~|^$*]?=[^\]]*)?\]|:not\(|:focus|:hover|::?[a-z-]+\(/.test(text)) return true;
  return text.split(/[\s,]+/).every((word) => word === "" || CSS_WORD.test(word));
}

/** Whether a literal's text reads as words a person reads. */
export function readsAsWords(text: string): boolean {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(trimmed)) return false;
  if (readsAsCode(trimmed)) return false;
  if (/^(https?:|mailto:|file:|data:|[./~]|#[\w-]+$)/.test(trimmed)) return false;
  if (/[{};]/.test(trimmed) && /:/.test(trimmed)) return false;
  const words = trimmed.split(" ").filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return false;
  if (words.length === 1) {
    const word = (words[0] ?? "").replace(/[.,:;!?…)]+$/, "").replace(/^[(]+/, "");
    if (KEY_NAMES.has(word)) return false;
    return /^\p{Lu}\p{Ll}+$/u.test(word) || (/^\p{Lu}\p{Ll}/u.test(word) && /[.!?…:]$/.test(trimmed));
  }
  if (!/\p{Ll}/u.test(trimmed)) return false;
  if (words.every((word) => /^[a-z0-9]+([-_:/.][a-z0-9]+)+$/.test(word) || /^--/.test(word))) return false;
  if (words.some((word) => /^[a-z][\w]*-[\w-]+$/.test(word)) && words.every((word) => /^[\w-]+$/.test(word)))
    return false;
  if (words.every((word) => /^[a-z]+[A-Z]\w*$/.test(word) || /^[\w.]+\(.*\)$/.test(word))) return false;
  return true;
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "console") return "console";
    return callee.name.text;
  }
  return undefined;
}

/** Whether a literal sits where its text names code rather than words a person reads. */
function inCodePosition(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) ||
      (ts.isConditionalExpression(parent) && child !== parent.condition) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)))
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent))
    return true;
  if (ts.isLiteralTypeNode(parent) || ts.isImportTypeNode(parent)) return true;
  if (ts.isCaseClause(parent)) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === child) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === child)
    return true;
  if (ts.isEnumMember(parent)) return true;
  if (ts.isExpressionStatement(parent)) return true;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.InKeyword
    )
      return true;
  }
  if (ts.isJsxAttribute(parent) || (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent))) {
    const attribute = ts.isJsxAttribute(parent) ? parent : (parent.parent as ts.JsxAttribute);
    return !TEXT_ATTRIBUTES.has(attribute.name.getText());
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const name = calleeName(parent);
    if (name === "console" || (name && (CODE_CALLS.has(name) || /Error$/.test(name)))) return true;
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
      const receiver = parent.expression.expression.getText();
      if (/\b(classList|dataset|style|localStorage|sessionStorage)$/.test(receiver)) return true;
    }
  }
  if (ts.isTaggedTemplateExpression(parent)) return true;
  if (ts.isThrowStatement(parent)) return true;
  return false;
}

/** A template's own text, with each hole standing for a number. */
function templateText(node: ts.TemplateExpression): string {
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("0");
}

/** CSS units and other short code a template writes beside a hole. */
const TEMPLATE_CODE = /^(px|em|rem|ms|s|vh|vw|deg|fr|ch|ex|x|n|k|kb|mb|gb)$/i;

/** Whether a template's own text reads as words: as a string does, or one plain word beside a hole, such as `{n} closed`. */
function templateReadsAsWords(text: string): boolean {
  if (readsAsCode(text)) return false;
  if (readsAsWords(text)) return true;
  if (/[{};()=<>]/.test(text) || /^\s*[./#~-]/.test(text)) return false;
  const words = text.split(/\s+/).filter((word) => /\p{L}/u.test(word));
  const [word] = words;
  return words.length === 1 && word !== undefined && /^\p{Ll}{3,}[.,]?$/u.test(word) && !TEMPLATE_CODE.test(word);
}

/** One run of raw words: its line and its text. */
export type RawWords = { line: number; text: string };

/** Each run of raw words in one file's text. */
export function rawWordsIn(path: string, text: string): RawWords[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split("\n");
  const found: RawWords[] = [];
  const at = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
  // A waiver on a node's line or the line above covers it, and one above a
  // statement or an expression covers every run inside it.
  const waived = (node: ts.Node) => {
    for (let around: ts.Node | undefined = node; around && !ts.isSourceFile(around); around = around.parent) {
      if (ts.isBlock(around) || ts.isModuleBlock(around)) break;
      const line = at(around);
      if (WAIVER.test(lines[line] ?? "") || WAIVER.test(lines[line - 1] ?? "")) return true;
    }
    return false;
  };
  const add = (node: ts.Node, words: string) => {
    if (!waived(node)) found.push({ line: at(node) + 1, text: words.replace(/\s+/g, " ").trim() });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (/\p{L}/u.test(node.text)) add(node, node.text);
      return;
    }
    if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText()) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) {
        if (/\p{L}/u.test(node.initializer.text)) add(node, node.initializer.text);
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!inCodePosition(node) && readsAsWords(node.text)) add(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      if (!inCodePosition(node) && templateReadsAsWords(templateText(node))) add(node, node.getText(tree));
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** Whether the check reads this tracked file. */
export function isCheckedFile(path: string): boolean {
  if (!/\.(tsx?|js)$/.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path) || path.endsWith(".d.ts")) return false;
  if (NOT_SHOWN.some((pattern) => pattern.test(path))) return false;
  return RAW_WORDS_ROOTS.some((root) => (root.endsWith("/") ? path.startsWith(root) : path === root));
}

/**
 * The files that still hold raw words, with how many runs each holds. It only
 * shrinks: each area that moves its words into the catalog lowers or removes
 * its files' entries in the same pull request, until the ledger is empty.
 */
export const RAW_WORDS_LEDGER: Readonly<Record<string, number>> = {
  "src/panels/now/words.ts": 13,
  "src/renderer/src/accounts/ConnectChips.tsx": 22,
  "src/renderer/src/accounts/CopyCode.tsx": 1,
  "src/renderer/src/accounts/CustomApiForm.tsx": 172,
  "src/renderer/src/accounts/customApiFailures.ts": 35,
  "src/renderer/src/devices/JoinAnotherMac.tsx": 40,
  "src/renderer/src/devices/NearbyList.tsx": 4,
  "src/renderer/src/devices/RemoteControl.tsx": 6,
  "src/renderer/src/devices/viewWords.ts": 38,
  "src/renderer/src/settings/AddProject.tsx": 28,
  "src/renderer/src/settings/AutomationTab.tsx": 71,
  "src/renderer/src/settings/ControllingTab.tsx": 14,
  "src/renderer/src/settings/DecisionsGroup.tsx": 24,
  "src/renderer/src/settings/DeviceForgeRows.tsx": 13,
  "src/renderer/src/settings/DeviceRow.tsx": 24,
  "src/renderer/src/settings/DeviceSignIns.tsx": 32,
  "src/renderer/src/settings/DevicesAdd.tsx": 22,
  "src/renderer/src/settings/DevicesLinks.tsx": 15,
  "src/renderer/src/settings/DevicesTab.tsx": 15,
  "src/renderer/src/settings/ForgeBrowserAside.tsx": 27,
  "src/renderer/src/settings/ForgeSection.tsx": 18,
  "src/renderer/src/settings/LocalSeatSection.tsx": 9,
  "src/renderer/src/settings/ModelLevels.tsx": 43,
  "src/renderer/src/settings/ModelsSection.tsx": 9,
  "src/renderer/src/settings/PhoneCode.tsx": 1,
  "src/renderer/src/settings/ProjectsTab.tsx": 25,
  "src/renderer/src/settings/QueueKeyPanel.tsx": 1,
  "src/renderer/src/settings/ReasoningControl.tsx": 3,
  "src/renderer/src/settings/RemoveProject.tsx": 7,
  "src/renderer/src/settings/RunsOn.tsx": 7,
  "src/renderer/src/settings/SpeedControl.tsx": 6,
  "src/renderer/src/settings/SubscriptionsTab.tsx": 40,
  "src/renderer/src/settings/UsageTab.tsx": 43,
  "src/renderer/src/settings/WebsiteSignInsSection.tsx": 8,
  "src/renderer/src/settings/addProjectWords.ts": 11,
  "src/renderer/src/settings/automationWords.ts": 57,
  "src/renderer/src/settings/costLimitWords.ts": 7,
  "src/renderer/src/settings/deviceForgeWords.ts": 2,
  "src/renderer/src/settings/devicesWords.ts": 71,
  "src/renderer/src/settings/levelDrops.ts": 12,
  "src/renderer/src/settings/modelsWords.ts": 13,
  "src/renderer/src/settings/projectCostWords.ts": 6,
  "src/renderer/src/settings/projectsWords.ts": 41,
  "src/renderer/src/settings/reasoningWords.ts": 1,
  "src/renderer/src/settings/subscriptionsWords.ts": 14,
  "src/renderer/src/settings/usageWords.ts": 78,
};

/** Each problem with the files' raw words against the ledger, as one line. */
export function ledgerProblems(
  counts: Record<string, number>,
  ledger: Readonly<Record<string, number>>,
  script = "scripts/raw-words.ts",
): string[] {
  const problems: string[] = [];
  for (const [path, count] of Object.entries(counts)) {
    const listed = ledger[path];
    if (count === 0) continue;
    if (listed === undefined)
      problems.push(
        `${path}: ${count} run(s) of words typed in for a person to read; put them in the catalog (docs/i18n.md), or say why one stays with i18n-exempt`,
      );
    else if (count > listed)
      problems.push(
        `${path}: ${count} run(s) of raw words, more than the ledger's ${listed}; put the new words in the catalog (docs/i18n.md), the ledger only shrinks`,
      );
    else if (count < listed)
      problems.push(`${script}: ${path} now holds ${count} run(s) of raw words; lower its entry to ${count}`);
  }
  for (const path of Object.keys(ledger)) {
    if (!counts[path])
      problems.push(`${script}: ${path} holds no raw words now; remove its entry, and the ledger shrinks`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const showing = process.argv.indexOf("--show");
  if (showing !== -1) {
    const path = process.argv[showing + 1] ?? "";
    for (const words of rawWordsIn(path, readFileSync(path, "utf8"))) console.log(`${path}:${words.line}: ${words.text}`);
  } else {
    const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(isCheckedFile);
    const counts: Record<string, number> = {};
    for (const path of new Set(paths)) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      counts[path] = rawWordsIn(path, text).length;
    }
    if (process.argv.includes("--list")) {
      for (const [path, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
        if (count) console.log(`  "${path}": ${count},`);
    } else {
      const problems = ledgerProblems(counts, RAW_WORDS_LEDGER);
      if (problems.length) {
        console.error(problems.join("\n"));
        process.exitCode = 1;
      }
    }
  }
}
