import ts from "typescript";

export const MAC_TAG_RULE = "e2e-mac-tag";

export type MacTagDiagnostic = { file: string; line: number; column: number; message: string };

/**
 * A test runs on the Mac only when it needs a Mac (docs/principles.md,
 * 2026-10-28; docs/testing.md, "Tests that need a Mac"). A pull request's
 * Mac job and a requested full check run only the tests that carry
 * `MAC_ONLY_TAG`, so a test that reads a Mac fact without it never runs on a
 * Mac until the nightly check, and a tagged test that reads none takes the
 * Mac for a run Linux already makes.
 *
 * The rule is lexical, by design. A test reads a Mac fact when its own code,
 * or a `test.skip` or hook of a describe or file around it, names
 * `THIS_DESKTOP` or `HAS_APP_MENU` (tests/e2e/desktop.ts) or the platform
 * name "darwin". A same-file helper the test calls is not followed, and a
 * comparison with "linux" is not a Mac fact: a step only Linux runs needs no
 * Mac. A test carries the tag in its own details (`{ tag: MAC_ONLY_TAG }`)
 * or a describe's around it.
 */
const MAC_NAMES = new Set(["THIS_DESKTOP", "HAS_APP_MENU"]);
const MAC_PLATFORM = "darwin";
const TAG_NAME = "MAC_ONLY_TAG";
const TAG_VALUE = "@mac-only";
/** Calls in a describe or file whose code runs for every test in it. */
const SCOPE_CALLS = new Set([
  "skip",
  "fixme",
  "fail",
  "slow",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
]);

type Scope = { tagged: boolean; reads: Set<string>; parent?: Scope };

/** One test call: a `for` loop's test is one call however many tests it makes. */
export type MacTest = {
  line: number;
  column: number;
  /** It, or a describe around it, carries the tag. */
  tagged: boolean;
  /** The Mac facts it reads, its own and those of the describes and file around it. */
  reads: string[];
};

function chain(expression: ts.Expression): string[] {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    // `/key/.test(type)` is a pattern's, not Playwright's.
    const root = chain(expression.expression);
    return root.length > 0 ? [...root, expression.name.text] : [];
  }
  return [];
}

function macReads(node: ts.Node): Set<string> {
  const reads = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child) && MAC_NAMES.has(child.text)) reads.add(child.text);
    else if (
      (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) &&
      child.text === MAC_PLATFORM
    )
      reads.add(`"${MAC_PLATFORM}"`);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return reads;
}

/** Whether a test or describe call's details carry the tag. */
function carriesTag(call: ts.CallExpression): boolean {
  const isTag = (value: ts.Expression) =>
    (ts.isIdentifier(value) && value.text === TAG_NAME) ||
    (ts.isStringLiteral(value) && value.text === TAG_VALUE);
  for (const argument of call.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || property.name.getText() !== "tag") continue;
      const value = property.initializer;
      if (isTag(value)) return true;
      if (ts.isArrayLiteralExpression(value) && value.elements.some(isTag)) return true;
    }
  }
  return false;
}

function inherited(scope: Scope | undefined): { tagged: boolean; reads: Set<string> } {
  const reads = new Set<string>();
  let tagged = false;
  for (let at = scope; at; at = at.parent) {
    tagged ||= at.tagged;
    for (const read of at.reads) reads.add(read);
  }
  return { tagged, reads };
}

/** Every test call of a spec, whether it carries the tag and the Mac facts it reads. */
export function macTests(source: string, file = "journey.spec.ts"): MacTest[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const found: { call: ts.CallExpression; scope: Scope; tagged: boolean; reads: Set<string> }[] =
    [];
  const walk = (node: ts.Node, scope: Scope) => {
    if (ts.isCallExpression(node)) {
      const names = chain(node.expression);
      if (names[0] === "test") {
        const kind = names[1];
        if (kind === "describe" && names[2] !== "configure") {
          const inner: Scope = { tagged: carriesTag(node), reads: new Set(), parent: scope };
          for (const argument of node.arguments) walk(argument, inner);
          return;
        }
        if (kind && SCOPE_CALLS.has(kind)) {
          // `test.skip("title", body)` declares a test; `test.skip(condition, why)` skips the scope.
          const declares = kind === "skip" && node.arguments.some((arg) => ts.isFunctionLike(arg));
          if (!declares) {
            for (const read of macReads(node)) scope.reads.add(read);
            return;
          }
        }
        if (kind === undefined || kind === "only" || kind === "skip" || kind === "fixme") {
          found.push({ call: node, scope, tagged: carriesTag(node), reads: macReads(node) });
          return;
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => walk(child, scope));
  };
  const root: Scope = { tagged: false, reads: new Set() };
  walk(parsed, root);
  return found.map(({ call, scope, tagged, reads }) => {
    const around = inherited(scope);
    const { line, character } = parsed.getLineAndCharacterOfPosition(call.getStart(parsed));
    return {
      line: line + 1,
      column: character + 1,
      tagged: tagged || around.tagged,
      reads: [...new Set([...reads, ...around.reads])].sort(),
    };
  });
}

/** Whether a spec holds a test that carries the tag: the Mac runs that file's tagged tests. */
export function needsMac(source: string, file?: string): boolean {
  return macTests(source, file).some((test) => test.tagged);
}

export function lintMacTag(files: string[]): MacTagDiagnostic[] {
  const diagnostics: MacTagDiagnostic[] = [];
  for (const file of files) {
    const text = ts.sys.readFile(file);
    if (text === undefined) continue;
    for (const test of macTests(text, file)) {
      if (test.reads.length > 0 && !test.tagged)
        diagnostics.push({
          file,
          line: test.line,
          column: test.column,
          message: `This test reads a Mac fact (${test.reads.join(", ")}) without ${TAG_NAME}, so no pull request runs it on a Mac. Tag it (tests/e2e/tags.ts).`,
        });
      else if (test.tagged && test.reads.length === 0)
        diagnostics.push({
          file,
          line: test.line,
          column: test.column,
          message: `This test carries ${TAG_NAME} but reads no Mac fact (THIS_DESKTOP, HAS_APP_MENU or "darwin"), so Linux alone covers it. Remove the tag.`,
        });
    }
  }
  return diagnostics;
}
