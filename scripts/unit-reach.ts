import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import ts from "typescript";

/** INF-2394 measure 3: direct edges only, never the importers of an importer. */
export const VITEST_FILE = /^(src|tests)\/.+\.test\.tsx?$/;

export function unitFiles(root: string): string[] {
  return ["src", "tests"]
    .flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
        .filter((file) => VITEST_FILE.test(file)),
    )
    .sort();
}

/** Read the compiler aliases, including renderer UI imports; never build a closure. */
export function directUnitReach(
  changed: readonly string[],
  files: readonly string[],
  root: string,
): string[] {
  const paths: Record<string, string[]> = {};
  let options: ts.CompilerOptions = {};
  for (const name of ["tsconfig.node.json", "tsconfig.web.json"]) {
    const config = ts.readConfigFile(join(root, name), ts.sys.readFile);
    if (config.error)
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
    if (converted.errors.length)
      throw new Error(ts.flattenDiagnosticMessageText(converted.errors[0]!.messageText, "\n"));
    options = converted.options;
    Object.assign(paths, options.paths);
  }
  options.paths = paths;
  const cache = ts.createModuleResolutionCache(root, (file) => file, options);
  const subjects = new Set(changed.filter((file) => !VITEST_FILE.test(file)));
  if (subjects.size === 0) return [];
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    // A deleted module still has direct importers that must run.
    fileExists: (file) => subjects.has(file.slice(root.length + 1)) || ts.sys.fileExists(file),
  };
  return files
    .filter((file) => {
      if (changed.includes(file)) return false;
      const source = ts.createSourceFile(
        file,
        readFileSync(join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      let reached = false;
      const pathMatches = (value: string) => {
        if (!value) return false;
        const candidates = [normalize(value), normalize(join(dirname(file), value))];
        return [...subjects].some((subject) => candidates.includes(subject));
      };
      const visit = (node: ts.Node): void => {
        if (reached) return;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const imported = ts.resolveModuleName(
            node.moduleSpecifier.text,
            resolve(root, file),
            options,
            host,
            cache,
          ).resolvedModule?.resolvedFileName;
          if (imported && subjects.has(imported.slice(root.length + 1))) reached = true;
        } else if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
          const specifier = node.arguments[0];
          if (specifier && ts.isStringLiteral(specifier)) {
            const imported = ts.resolveModuleName(
              specifier.text,
              resolve(root, file),
              options,
              host,
              cache,
            ).resolvedModule?.resolvedFileName;
            if (imported && subjects.has(imported.slice(root.length + 1))) reached = true;
          }
        } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (pathMatches(node.text)) reached = true;
        } else if (ts.isTemplateExpression(node)) {
          // Workflow readers iterate names inside a literal directory. Keep that
          // directory's candidates rather than trying to execute the test.
          if (
            node.head.text.endsWith("/") &&
            [...subjects].some((subject) => subject.startsWith(node.head.text))
          )
            reached = true;
        } else if (ts.isCallExpression(node)) {
          const name = ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : "";
          if (name === "join" || name === "resolve") {
            const parts = node.arguments
              .filter((arg) => ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
              .map((arg) => arg.text);
            if (parts.length && pathMatches(join(...parts))) reached = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return reached;
    })
    .sort();
}
