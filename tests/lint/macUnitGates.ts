import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * A Vitest case that only a Mac runs (docs/testing.md, "Tests that need a
 * Mac"): Linux runs the whole suite, and the full check's Mac lane runs only
 * the files listed in `scripts/mac-unit-tests.ts`. A case behind a gate that
 * skips it everywhere but macOS therefore runs in CI only when its file is
 * on that list; anywhere else it runs nowhere, and nothing says so.
 *
 * The rule is lexical, by design, as the journeys' Mac tag lint is
 * (tests/lint/e2eMacTag.ts). A gate is a `runIf` or `skipIf` call on
 * `describe`, `it` or `test` (or one of their chains). Its condition is read
 * for the two platforms the checks run on, Linux and macOS: a comparison of
 * `process.platform` with a platform name, `!`, `&&`, `||`, parentheses, and
 * a constant the same file declares whose value is such a condition. Anything else
 * in it - an opt-in, a tool that may be missing - is taken as met, since it
 * cannot tell the platforms apart. A gate is Mac-only when its case runs on
 * macOS and not on Linux.
 */

export type MacGate = {
  /** The line the gate's call starts on, counting from one. */
  line: number;
  /** The gate as written, such as `describe.runIf(process.platform === "darwin")`. */
  text: string;
};

type Platform = "darwin" | "linux";
/** What a condition is on each platform; null where it cannot tell them apart. */
type Reading = { darwin: boolean; linux: boolean } | null;

const SUITE_ROOTS = new Set(["describe", "it", "test"]);

function rootOf(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootOf(expression.expression);
  if (ts.isCallExpression(expression)) return rootOf(expression.expression);
  return null;
}

function isPlatformRead(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "platform" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "process"
  );
}

function platformName(expression: ts.Expression): string | null {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : null;
}

function read(
  condition: ts.Expression,
  constants: Map<string, ts.Expression>,
  seen = new Set<string>(),
): Reading {
  const each = (value: (platform: Platform) => boolean): Reading => ({
    darwin: value("darwin"),
    linux: value("linux"),
  });
  if (ts.isParenthesizedExpression(condition)) return read(condition.expression, constants, seen);
  if (
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const inner = read(condition.operand, constants, seen);
    return inner && { darwin: !inner.darwin, linux: !inner.linux };
  }
  if (ts.isIdentifier(condition)) {
    const value = constants.get(condition.text);
    if (!value || seen.has(condition.text)) return null;
    return read(value, constants, new Set([...seen, condition.text]));
  }
  if (ts.isBinaryExpression(condition)) {
    const operator = condition.operatorToken.kind;
    const equal =
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken;
    const unequal =
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken;
    if (equal || unequal) {
      const name = isPlatformRead(condition.left)
        ? platformName(condition.right)
        : isPlatformRead(condition.right)
          ? platformName(condition.left)
          : null;
      if (name === null) return null;
      return each((platform) => (platform === name) === equal);
    }
    const and = operator === ts.SyntaxKind.AmpersandAmpersandToken;
    const or = operator === ts.SyntaxKind.BarBarToken;
    if (and || or) {
      const left = read(condition.left, constants, seen);
      const right = read(condition.right, constants, seen);
      // A part that cannot tell the platforms apart is taken as met.
      const met = (reading: Reading, platform: Platform) => (reading ? reading[platform] : true);
      if (!left && !right) return null;
      return each((platform) =>
        and
          ? met(left, platform) && met(right, platform)
          : met(left, platform) || met(right, platform),
      );
    }
  }
  return null;
}

function constantsOf(source: ts.SourceFile): Map<string, ts.Expression> {
  const constants = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const)
      for (const declaration of node.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          constants.set(declaration.name.text, declaration.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constants;
}

export function macOnlyGates(text: string, file = "file.test.ts"): MacGate[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const constants = constantsOf(source);
  const gates: MacGate[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "runIf" || node.expression.name.text === "skipIf") &&
      SUITE_ROOTS.has(rootOf(node.expression.expression) ?? "") &&
      node.arguments[0]
    ) {
      const reading = read(node.arguments[0], constants);
      const skips = node.expression.name.text === "skipIf";
      const runs = (platform: Platform) => (reading ? reading[platform] !== skips : true);
      if (runs("darwin") && !runs("linux"))
        gates.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          text: node.getText(source),
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return gates;
}

export function macOnlyFiles(files: readonly string[]): Map<string, MacGate[]> {
  const found = new Map<string, MacGate[]>();
  for (const file of files) {
    const gates = macOnlyGates(readFileSync(file, "utf8"), file);
    if (gates.length > 0) found.set(file, gates);
  }
  return found;
}
