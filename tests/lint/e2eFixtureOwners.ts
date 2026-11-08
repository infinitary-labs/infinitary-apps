import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { standInAreas as fixtureAreas } from "../../scripts/affected-journeys.ts";

export const FIXTURE_OWNER_RULE = "e2e-fixture-owner";
export type FixtureOwnerDiagnostic = {
  file: string;
  line: number;
  column: number;
  message: string;
};

/** One declaration parser serves selection and ownership (INF-2394 measures 2 and 4). */
export { fixtureAreas };

/**
 * INF-2394 measure 4: filesystem-shaped saved state and home preparation belong
 * to an imported, declared owner. Empty directories have no saved-state format. Project content and artifacts are test input,
 * not stand-ins for the app's saved state; a reasoned adjacent annotation names
 * those inputs or a mutation the journey actually proves. This is a lexical
 * fence, not interprocedural dataflow or a verdict on a test's six words.
 */
export function lintFixtureOwners(files: string[]): FixtureOwnerDiagnostic[] {
  const program = ts.createProgram(files, { noResolve: true, noLib: true });
  const checker = program.getTypeChecker();
  const findings: FixtureOwnerDiagnostic[] = [];
  for (const file of files) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const source = program.getSourceFile(file);
    if (!source) continue;
    const spec = file.endsWith(".spec.ts");
    const declared = !spec && fixtureAreas(source.text).length > 0;
    const lines = source.text.split("\n");
    const imports = new Map<string, string>();
    const names = new Map<string, string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const module = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          imports.set(binding.name.text, module);
          names.set(binding.name.text, (binding.propertyName ?? binding.name).text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings))
        imports.set(bindings.name.text, module);
    }
    const report = (node: ts.Node, message: string) => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const reason = /e2e-fixture: (?:input|mutation) --\s*\S/;
      // Existing Claude mutation proofs retain their narrower, independently checked annotation.
      const claudeMutation = /e2e-claude-store: mutation --\s*\S/;
      if (
        [lines[line], lines[line - 1]].some(
          (text) => text && (reason.test(text) || claudeMutation.test(text)),
        )
      )
        return;
      findings.push({ file, line: line + 1, column: character + 1, message });
    };
    const calleeName = (node: ts.Expression): string => {
      if (ts.isIdentifier(node)) return names.get(node.text) ?? node.text;
      return ts.isPropertyAccessExpression(node) ? node.name.text : "";
    };
    const importedOwner = (expression: ts.Expression): boolean => {
      const target = ts.isCallExpression(expression) ? expression.expression : expression;
      const id = ts.isPropertyAccessExpression(target) ? target.expression : target;
      if (!ts.isIdentifier(id)) return false;
      const module = imports.get(id.text);
      if (!module?.startsWith(".")) return false;
      const path = resolve(dirname(file), module);
      const owner = [path, `${path}.ts`, resolve(path, "index.ts")].find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      );
      const text = owner ? ts.sys.readFile(owner) : undefined;
      return text !== undefined && fixtureAreas(text).length > 0;
    };
    const homePath = (node: ts.Node, seen = new Set<ts.Symbol>()): boolean => {
      // These are authored project files, not a stand-in for an app-owned format.
      // Resolve aliases before this check so a worktree named `dir` stays project input.
      if (
        ts.isCallExpression(node) &&
        calleeName(node.expression) === "join" &&
        node.arguments.some(
          (argument) =>
            ts.isStringLiteralLike(argument) &&
            /^(?:worktrees|workspace|workspaces)$/.test(argument.text),
        )
      )
        return false;
      // The account vault's own folder (`accounts/`, src/core/pi/accountVault.ts)
      // under any data folder, however the folder is named: a helper's `dir`
      // parameter is as much the app's saved state as `userDataDir`
      // (INF-2456, the account files INF-2417's ledger found the lint missed).
      if (
        ts.isCallExpression(node) &&
        calleeName(node.expression) === "join" &&
        node.arguments.length > 1 &&
        ts.isIdentifier(node.arguments[0] as ts.Expression) &&
        ts.isStringLiteralLike(node.arguments[1] as ts.Expression) &&
        (node.arguments[1] as ts.StringLiteralLike).text === "accounts"
      )
        return true;
      if (ts.isIdentifier(node)) {
        if (/^(?:home|homeDir|userData|userDataDir|accountsDir)$/.test(node.text)) return true;
        const symbol = checker.getSymbolAtLocation(node);
        if (!symbol || seen.has(symbol)) return false;
        const declaration = symbol.valueDeclaration;
        return !!(
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          homePath(declaration.initializer, new Set([...seen, symbol]))
        );
      }
      if (ts.isPropertyAccessExpression(node))
        return /^(?:homeDir|userDataDir|dataDir)$/.test(node.name.text);
      if (
        ts.isCallExpression(node) &&
        !/^(?:join|resolve|dirname|claudeDefaultStore)$/.test(calleeName(node.expression))
      )
        return false;
      return ts.forEachChild(node, (child) => homePath(child, seen)) ?? false;
    };
    // The quota fixture reader's snapshot file, named in the destination or in a variable holding it.
    const quotaEnvelope = (node: ts.Node, seen = new Set<ts.Symbol>()): boolean => {
      if (ts.isStringLiteralLike(node)) return node.text === "snapshot.json";
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (!symbol || seen.has(symbol)) return false;
        const declaration = symbol.valueDeclaration;
        return !!(
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          quotaEnvelope(declaration.initializer, new Set([...seen, symbol]))
        );
      }
      if (ts.isCallExpression(node) && !/^(?:join|resolve)$/.test(calleeName(node.expression)))
        return false;
      return ts.forEachChild(node, (child) => quotaEnvelope(child, seen)) ?? false;
    };
    const visit = (node: ts.Node) => {
      if (
        !declared &&
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node) ||
          ts.isMethodDeclaration(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
        node.name.text === "prepareHome"
      ) {
        const initializer = ts.isPropertyAssignment(node)
          ? node.initializer
          : ts.isShorthandPropertyAssignment(node)
            ? node.name
            : undefined;
        if (!initializer || !importedOwner(initializer))
          report(
            node,
            "Pass an imported home-fixture owner (or its factory) to prepareHome; declare its @journey-area product reader (INF-2394).",
          );
      }
      if (!declared && ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (
          /^(?:writeFile|appendFile|rm|unlink|rename|copyFile|cp|symlink|utimes|chmod)(?:Sync)?$/.test(
            name,
          )
        ) {
          const destinations = /^(?:copyFile|cp|symlink)/.test(name)
            ? node.arguments.slice(1, 2)
            : name.startsWith("rename")
              ? node.arguments.slice(0, 2)
              : node.arguments.slice(0, 1);
          if (destinations.some((destination) => homePath(destination)))
            report(
              node,
              "Move home/userData fixture writes to an imported owner declaring @journey-area. A journey proving a mutation or authoring project input names it adjacently with e2e-fixture: mutation|input -- <reason> (INF-2394).",
            );
          else if (destinations.some((destination) => quotaEnvelope(destination)))
            report(
              node,
              "Seed the quota reading through seedQuotaFixture (tests/e2e/quotaFixtures.ts), which owns snapshot.json and models.json and checks them against the reader's schemas (INF-2455).",
            );
        }
      }
      if (
        !spec &&
        !declared &&
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        /^(?:seed|writeMock)/.test(node.name.text)
      )
        report(
          node,
          "An exported seed/mock helper declares the product reader it stands in for with @journey-area (INF-2394).",
        );
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}
