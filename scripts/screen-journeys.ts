import ts from "typescript";

/** Edited regions on each side, including the surviving neighbour of a deletion. */
export function screenRanges(
  diff: string,
  file: string,
  side: "before" | "after",
): [number, number][] {
  const part = diff.split(/^diff --git /m).find((part) => part.startsWith(`a/${file} b/`));
  if (!part) return [];
  return [...part.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => {
    const start = Number(match[side === "before" ? 1 : 3]);
    const count = Number(match[side === "before" ? 2 : 4] ?? 1);
    return [Math.max(1, start), Math.max(1, start + Math.max(1, count) - 1)];
  });
}

/** Read the smallest edited JSX subtree, or its enclosing declaration for non-JSX work.
 * Follow local declaration consumers so a changed layout helper still selects the screen
 * that uses it. Imports and unowned setup conservatively retain the whole screen.
 */
export function editedScreenText(file: string, text: string, ranges: [number, number][]): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const line = (offset: number) => source.getLineAndCharacterOfPosition(offset).line + 1;
  const selected = new Set<ts.Node>();
  const owners = new Set<ts.Statement>();
  for (const [start, end] of ranges) {
    const statements = source.statements.filter(
      (node) => line(node.getStart(source)) <= end && line(node.end) >= start,
    );
    if (!statements.length || statements.some(ts.isImportDeclaration)) return text;
    for (const statement of statements) {
      let region: ts.Node = statement;
      const visit = (node: ts.Node) => {
        if (line(node.getStart(source)) > start || line(node.end) < end) return;
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
          region = node;
        node.forEachChild(visit);
      };
      visit(statement);
      selected.add(region);
      owners.add(statement);
      // A child edit can change its container's dimensions, but not a sibling's contents.
      for (let parent = region.parent; parent && parent !== statement; parent = parent.parent)
        if (ts.isJsxElement(parent)) selected.add(parent.openingElement);
    }
  }
  const nameOf = (statement: ts.Statement): string[] => {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      return statement.name ? [statement.name.text] : [];
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.flatMap((decl) =>
        ts.isIdentifier(decl.name) ? [decl.name.text] : [],
      );
    return [];
  };
  let grew = true;
  while (grew) {
    grew = false;
    const names = new Set([...owners].flatMap(nameOf));
    for (const statement of source.statements) {
      if (owners.has(statement)) continue;
      let uses = false;
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && names.has(node.text)) uses = true;
        node.forEachChild(visit);
      };
      statement.forEachChild(visit);
      if (uses) {
        owners.add(statement);
        selected.add(statement);
        grew = true;
      }
    }
  }
  return [...selected].map((node) => node.getText(source)).join("\n");
}
