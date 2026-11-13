/** INF-1879: enforce the table's single corner and presentation-only dispatcher. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CARD_LEAVE } from "../src/shared/cardLeave.ts";

export function cornerProblems(files: Record<string, string>): string[] {
  const problems: string[] = [];
  let closeCalls = 0;
  let dismissCalls = 0;
  for (const [path, text] of Object.entries(files)) {
    if (/\.(test|spec)\.tsx?$/.test(path)) continue;
    if (!path.startsWith("src/") || !/\.(ts|tsx)$/.test(path)) continue;
    const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(tree);
        if (name === "window.infinitary.cards.close") {
          closeCalls++;
          if (path !== "src/renderer/src/app/cardActions.ts") problems.push(`${path}: use the shell's card-leave dispatcher`);
        }
        if (name === "this.cards.dismiss") {
          dismissCalls++;
          if (path !== "src/core/orchestrator/crewSupervisor.ts") problems.push(`${path}: only the supervisor dispatches the corner`);
        }
      }
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "CardCorner" && node.children.some(child => !ts.isJsxText(child) || child.text.trim())) problems.push(`${path}: CardCorner owns its button, not its caller`);
      if (ts.isJsxAttribute(node) && node.name.getText(tree) === "data-card-leave" && path !== "src/renderer/src/design/cards/CardSize.tsx") problems.push(`${path}: draw the leaving control through CardCorner`);
      if ((path.startsWith("src/renderer/src/cards/") || path.startsWith("src/renderer/src/design/cards/")) && path !== "src/renderer/src/design/cards/CardSize.tsx" && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === "IconButton") {
        const leave = node.attributes.properties.filter(ts.isJsxAttribute).some(attr => attr.name.getText(tree) === "onClick" && attr.initializer?.getText(tree) === "{onClose}");
        if (leave) problems.push(`${path}: a card's leaving button belongs in CardCorner`);
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
    // The compiled catalog holds the words cardLeave.ts takes from it (docs/i18n.md).
    if (path !== "src/shared/cardLeave.ts" && !path.endsWith("messages.generated.ts") && /(?:Put aside|Hide) ·/.test(text)) problems.push(`${path}: corner rest words belong in cardLeave.ts`);
  }
  if (closeCalls > 1) problems.push("The shell must have one card-close dispatcher");
  if (dismissCalls > 1) problems.push("The supervisor must have one corner dispatcher");
  const expected = Object.entries(CARD_LEAVE).map(([kind, row]) => `| \`${kind}\` | ${row.label} | ${row.operation} |`);
  const section = (files["docs/card-authoring.md"] ?? "").split("## Put a card aside")[1]?.split(/^## /m)[0] ?? "";
  const rows = section.split("\n").filter(line => /^\| `[^`]+` \|/.test(line));
  if (JSON.stringify(rows) !== JSON.stringify(expected)) problems.push("docs/card-authoring.md: corner rows must match cardLeave.ts in order");
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src", "docs/card-authoring.md"], { encoding: "utf8" }).trim().split("\n");
  const problems = cornerProblems(Object.fromEntries([...new Set(paths)].map(path => [path, readFileSync(path, "utf8")])));
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
}
