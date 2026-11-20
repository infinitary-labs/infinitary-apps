import ts from "typescript";

export const CLAUDE_STORE_RULE = "e2e-claude-store-owner";
export type ClaudeStoreDiagnostic = { file: string; line: number; column: number; message: string };

/** INF-2394 measure 1: journeys use the signed-in-home owner, not its component seeds. */
export function lintClaudeStore(files: string[]): ClaudeStoreDiagnostic[] {
  const diagnostics: ClaudeStoreDiagnostic[] = [];
  for (const file of files) {
    const text = ts.sys.readFile(file);
    if (text === undefined) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
    const lines = text.split("\n");
    const declarations = new Map<string, ts.Expression>();
    const names = new Map<string, string>();
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        declarations.set(node.name.text, node.initializer);
      if (ts.isImportSpecifier(node))
        names.set(node.name.text, (node.propertyName ?? node.name).text);
      ts.forEachChild(node, collect);
    };
    collect(source);
    const nameOf = (node: ts.Expression): string => {
      if (ts.isIdentifier(node)) return names.get(node.text) ?? node.text;
      return ts.isPropertyAccessExpression(node) ? node.name.text : "";
    };
    // Follow destination initializers only, never a write's payload or read-only paths.
    const storePath = (node: ts.Node, seen = new Set<string>()): boolean => {
      if (ts.isIdentifier(node)) {
        if (seen.has(node.text)) return false;
        const value = declarations.get(node.text);
        return value ? storePath(value, new Set([...seen, node.text])) : false;
      }
      if (ts.isCallExpression(node) && nameOf(node.expression) === "claudeDefaultStore")
        return true;
      if (ts.isStringLiteralLike(node))
        return /(?:^|[/\\])(?:\.claude|\.credentials\.json|stub-credential)(?:$|[/\\])/.test(
          node.text,
        );
      if (
        ts.isTemplateExpression(node) &&
        /(?:\.claude|\.credentials\.json|stub-credential)/.test(node.getText(source))
      )
        return true;
      return ts.forEachChild(node, (child) => storePath(child, seen)) ?? false;
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = nameOf(node.expression);
        const componentSeed =
          name === "seedSignedInClaudeStore" || name === "seedClaudeCredentialFile";
        const write =
          /^(?:writeFile|appendFile|mkdir|rm|unlink|rename|copyFile|utimes|chmod)(?:Sync)?$/.test(
            name,
          );
        const destinations = name.startsWith("copyFile")
          ? node.arguments.slice(1, 2)
          : name.startsWith("rename")
            ? node.arguments.slice(0, 2)
            : node.arguments.slice(0, 1);
        if (componentSeed || (write && destinations.some((arg) => storePath(arg)))) {
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
          const exception = /e2e-claude-store: mutation --\s*\S/;
          if (!exception.test(lines[line] ?? "") && !exception.test(lines[line - 1] ?? ""))
            diagnostics.push({
              file,
              line: line + 1,
              column: character + 1,
              message:
                "Use signedInClaudeHome / launchSignedInClaude, not component seeds or a Claude-store writer. A journey proving a store mutation keeps an adjacent e2e-claude-store: mutation -- <reason> (INF-2394).",
            });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return diagnostics;
}
