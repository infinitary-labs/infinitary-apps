import ts from "typescript";

export const FRAME_ACTION_RULE = "e2e-frame-actions";
const ACTIONS = new Set([
  "click",
  "dblclick",
  "check",
  "uncheck",
  "setChecked",
  "tap",
  "hover",
  "dragTo",
]);
const LOCATORS = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "getByTitle",
  "getByAltText",
  "filter",
  "first",
  "last",
  "nth",
  "and",
  "or",
]);

export type FrameActionDiagnostic = { file: string; line: number; column: number; message: string };

/**
 * Track locator provenance, not variable names: a `find` or a `keyLink` can
 * live in a frame, while a variable named `frame` can be the shell's iframe
 * element. TypeScript resolves lexical scopes and imported helper aliases;
 * only the supplied e2e sources are loaded (no product graph or libraries).
 * This is intentionally a static boundary, not full data-flow analysis:
 * it follows initializers, helper returns and their arguments, not mutation.
 */
export function lintFrameActions(files: string[]): FrameActionDiagnostic[] {
  const program = ts.createProgram(files, {
    noResolve: true,
    noLib: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
  });
  const checker = program.getTypeChecker();
  const diagnostics: FrameActionDiagnostic[] = [];
  type Bindings = ReadonlyMap<ts.Symbol, boolean>;

  function symbolAt(node: ts.Node): ts.Symbol | undefined {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  }

  function member(node: ts.Expression): { receiver: ts.Expression; name: string } | undefined {
    if (ts.isPropertyAccessExpression(node))
      return { receiver: node.expression, name: node.name.text };
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      return { receiver: node.expression, name: node.argumentExpression.text };
    return undefined;
  }

  function fromFrame(node: ts.Node | undefined, bindings: Bindings, seen: Set<ts.Node>): boolean {
    if (!node || seen.has(node)) return false;
    const path = new Set(seen).add(node);
    const read = (value: ts.Node | undefined) => fromFrame(value, bindings, path);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return read(node.expression);
    if (ts.isConditionalExpression(node)) return read(node.whenTrue) || read(node.whenFalse);
    if (ts.isCallExpression(node)) {
      const access = member(node.expression);
      if (access) {
        if (access.name === "frameLocator" || access.name === "contentFrame") return true;
        // owner() is the iframe element in the OUTER document, not its contents.
        if (access.name === "owner") return false;
        if (LOCATORS.has(access.name))
          return (
            read(access.receiver) ||
            ((access.name === "and" || access.name === "or") && node.arguments.some(read))
          );
      }
      const symbol = symbolAt(node.expression);
      return (
        symbol?.declarations?.some((declaration) => {
          const value = ts.isVariableDeclaration(declaration)
            ? declaration.initializer
            : declaration;
          if (
            !value ||
            !(
              ts.isFunctionDeclaration(value) ||
              ts.isArrowFunction(value) ||
              ts.isFunctionExpression(value) ||
              ts.isMethodDeclaration(value)
            ) ||
            !value.body
          )
            return false;
          const args = new Map(bindings);
          value.parameters.forEach((parameter, index) => {
            const symbol = symbolAt(parameter.name);
            if (symbol) args.set(symbol, read(node.arguments[index] ?? parameter.initializer));
          });
          const returned = (expression: ts.Node) => fromFrame(expression, args, path);
          if (!ts.isBlock(value.body)) return returned(value.body);
          let found = false;
          const visit = (part: ts.Node) => {
            if (ts.isReturnStatement(part))
              found ||= !!part.expression && returned(part.expression);
            else if (!ts.isFunctionLike(part)) ts.forEachChild(part, visit);
          };
          visit(value.body);
          return found;
        }) ?? false
      );
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const symbol = symbolAt(node);
      if (!symbol) return false;
      if (bindings.has(symbol)) return bindings.get(symbol) === true;
      return (
        symbol.declarations?.some((declaration) => {
          if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration))
            return read(declaration.initializer);
          if (ts.isParameter(declaration))
            return /^(?:FrameLocator|Frame)$/.test(declaration.type?.getText() ?? "");
          return false;
        }) ?? false
      );
    }
    return false;
  }

  for (const source of program.getSourceFiles()) {
    if (!source.fileName.replaceAll("\\", "/").includes("/tests/e2e/")) continue;
    const lines = source.text.split(/\r?\n/);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const access = member(node.expression);
        if (
          access &&
          ACTIONS.has(access.name) &&
          fromFrame(access.receiver, new Map(), new Set())
        ) {
          const start = source.getLineAndCharacterOfPosition(node.getStart(source));
          const previous = lines[start.line - 1]?.trim() ?? "";
          // A single, adjacent exception names its reason; a file-wide bypass is not supported.
          const exception = /^\/\/ e2e-frame-actions: native -- (.+)$/.exec(previous);
          if (!exception?.[1]?.trim())
            diagnostics.push({
              file: source.fileName,
              line: start.line + 1,
              column: start.character + 1,
              message: `Native ${access.name} in a frame can be lost in the hidden test window. Use clickInBody or an in-frame event; a native-input contract needs an adjacent '// e2e-frame-actions: native -- <reason>'.`,
            });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return diagnostics;
}
