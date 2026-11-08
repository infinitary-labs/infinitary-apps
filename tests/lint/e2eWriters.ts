import ts from "typescript";

export const WRITER_RULE = "e2e-no-writer-after-launch";

export type WriterDiagnostic = { file: string; line: number; column: number; message: string };

/**
 * A spec seeds the app's saved data BEFORE it launches the app, with the
 * stores it shares with the core. Once the app runs, it is the one writer
 * (docs/e2e-contracts.md, "One writer once the app runs"): a second
 * `TaskService` constructor runs boot recovery against the live database
 * ("database is locked", running turns marked interrupted), and any other
 * writer races the core's own. A spec that wants to read saved state after
 * launch goes through `tests/e2e/savedData.ts` (read-only, query_only).
 *
 * The rule is lexical, by design: a writer constructor
 * (`openDatabase`, `new TaskService`, `new CardService`, `new CardStore`)
 * is refused when it (a) comes after a launch call (`launchApp`, a
 * `launch…` wrapper or `relaunch`) in the same test or helper and before the
 * app is closed again, (b) sits in
 * a closure kept or handed to a poll inside a test (`const read = () => ...`),
 * which runs whenever it is called, or (c) sits in a same-file helper that a test calls
 * after a launch. Seeding before the launch, in the test's own body or in a
 * helper called before it, stays.
 *
 * A read of the saved data goes through its owner, `tests/e2e/savedData.ts`
 * (`readSavedData`, `readKnowledgeData`), which opens the file read-only with
 * `query_only` on and closes it. So a spec's own `new Database(path,
 * { readonly: true })` is refused wherever it sits: a read-only open is only
 * ever a read, and a read has its one owner. A writable `new Database` is a
 * seed, which the stopped app allows; the writer rule above does not name it.
 */
const WRITER_CALLS = new Set(["openDatabase"]);
const WRITER_CLASSES = new Set(["TaskService", "CardService", "CardStore"]);
/** A journey whose subject is a write by someone else says why on the line, or the one above it. */
const WAIVER = /e2e-writer-ok:\s*\S/;
const LAUNCH_NAME = /^(?:launch|relaunch|claudeLaunch)/;

type Fn = ts.FunctionLikeDeclaration;

export function lintWriters(files: string[]): WriterDiagnostic[] {
  const diagnostics: WriterDiagnostic[] = [];
  for (const file of files) {
    const text = ts.sys.readFile(file);
    if (text === undefined) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
    diagnostics.push(...lintSource(source, file));
  }
  return diagnostics;
}

function isFunctionLike(node: ts.Node): node is Fn {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function rootIdentifier(expression: ts.Expression): string | undefined {
  let node = expression;
  while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) node = node.expression;
  return ts.isIdentifier(node) ? node.text : undefined;
}

function isWriter(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) return WRITER_CALLS.has(calleeName(node) ?? "");
  if (ts.isNewExpression(node)) return WRITER_CLASSES.has(calleeName(node) ?? "");
  return false;
}

/** `app.close()`, `first.close()`, `closeApp(app)`: the app stops; a database handle's own `close` does not. */
function isAppClose(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return node.expression.text === "closeApp";
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "close" &&
    !/(?:db|database|store|service)$/i.test(node.expression.expression.getText())
  );
}

/** `new Database(path, { readonly: true })`: a spec opening the saved data itself to read it. */
function isRawRead(node: ts.Node): boolean {
  if (!ts.isNewExpression(node) || calleeName(node) !== "Database") return false;
  const options = node.arguments?.[1];
  return (
    options !== undefined &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === "readonly" &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword,
    )
  );
}

const RAW_READ =
  "A spec that opens the saved data itself to read it skips its owner. Read through readSavedData or readKnowledgeData in tests/e2e/savedData.ts (read-only, query_only; docs/e2e-contracts.md, One writer once the app runs).";

function isLaunch(node: ts.Node): boolean {
  return ts.isCallExpression(node) && LAUNCH_NAME.test(calleeName(node) ?? "");
}

const DEFERRING_CALLS = /^(?:poll|toPass|waitFor|waitForFunction|on|once|setInterval|setTimeout)$/;

/**
 * A closure that runs later, whenever it is called: one kept in a variable
 * (`const read = () => ...`) or handed to a poll, a retry, a listener or a
 * timer. A callback that runs at once (`map`, `forEach`) is not.
 */
function isDeferred(fn: Fn): boolean {
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent)) return true;
  if (ts.isCallExpression(parent) && parent.arguments.includes(fn as ts.Expression))
    return DEFERRING_CALLS.test(calleeName(parent) ?? "");
  return false;
}

/** A function a test runs as its own body: an argument of a `test…(...)` call. */
function isTestBody(fn: Fn): boolean {
  const call = fn.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments.includes(fn as ts.Expression) &&
    rootIdentifier(call.expression) === "test"
  );
}

function lintSource(source: ts.SourceFile, file: string): WriterDiagnostic[] {
  const out: WriterDiagnostic[] = [];
  const lines = source.text.split("\n");
  const report = (node: ts.Node, why: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    // `// e2e-writer-ok: <why>` on the line or the one above waives it.
    if (WAIVER.test(lines[line] ?? "") || WAIVER.test(lines[line - 1] ?? "")) return;
    out.push({ file, line: line + 1, column: character + 1, message: why });
  };

  // Same-file helpers that open a writer, by name.
  const openers = new Map<string, Fn>();
  const containsWriter = (root: ts.Node): boolean => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (isWriter(node)) found = true;
      else ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
  };
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && containsWriter(node.body))
      openers.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      containsWriter(node.initializer.body)
    )
      openers.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);

  /** Units: each test body, and each top-level function that is not itself a test body. */
  const checkUnit = (unit: Fn) => {
    if (!unit.body) return;
    // Where the app starts and stops running, in source order.
    const events: { at: number; running: boolean }[] = [];
    const findEvents = (node: ts.Node) => {
      if (isLaunch(node)) events.push({ at: node.getEnd(), running: true });
      else if (isAppClose(node)) events.push({ at: node.getStart(source), running: false });
      ts.forEachChild(node, findEvents);
    };
    findEvents(unit.body);
    events.sort((a, b) => a.at - b.at);
    const runningAt = (at: number) =>
      events.filter((event) => event.at < at).at(-1)?.running === true;
    const visit = (node: ts.Node, closure: boolean) => {
      if (isFunctionLike(node) && node !== unit) {
        // A nested test body (test.step, describe) is a unit on its own.
        if (isTestBody(node)) return;
        if (isDeferred(node)) closure = true;
      }
      if (isWriter(node)) {
        if (closure)
          report(
            node,
            "A writer opened in a closure runs whenever the closure is called, which is after the app launched (a poll's read, a callback). Seed before launch; read after launch through tests/e2e/savedData.ts (docs/e2e-contracts.md, One writer once the app runs).",
          );
        else if (runningAt(node.getStart(source)))
          report(
            node,
            "A writer opened after the app launched is a second writer beside the core. Seed before launch; read after launch through tests/e2e/savedData.ts (docs/e2e-contracts.md, One writer once the app runs).",
          );
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        openers.has(node.expression.text) &&
        runningAt(node.getStart(source))
      )
        report(
          node,
          `${node.expression.text}() opens a writer and is called after the app launched. Seed before launch; read after launch through tests/e2e/savedData.ts (docs/e2e-contracts.md, One writer once the app runs).`,
        );
      ts.forEachChild(node, (child) => visit(child, closure));
    };
    visit(unit.body, false);
  };

  const findRawReads = (node: ts.Node) => {
    if (isRawRead(node)) report(node, RAW_READ);
    ts.forEachChild(node, findRawReads);
  };
  findRawReads(source);
  const find = (node: ts.Node) => {
    if (isFunctionLike(node) && isTestBody(node)) checkUnit(node);
    ts.forEachChild(node, find);
  };
  find(source);
  // Top-level helpers (not test bodies): a writer in a closure there is still deferred.
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) checkUnit(statement);
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) checkUnit(init);
      }
  }
  return out;
}
