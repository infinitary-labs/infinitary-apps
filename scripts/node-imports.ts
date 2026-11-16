/**
 * Imports plain Node can load (INF-4500's weekly audit, addition 5;
 * docs/testing.md, "The weekly audit of the pull request check"). The
 * project's scripts run under plain Node's type stripping, which resolves a
 * relative import only by its exact file name: `./catalog` fails where the
 * test runner and the typecheck find `./catalog.ts`. Three such imports
 * passed the pull request check and failed later, in scripts a test or a
 * workflow starts with `node`.
 *
 * This walks every file plain Node starts - each one a `node` command names
 * in package.json, a workflow or a shell script, and each script a test
 * starts with the running Node - and every file their
 * relative imports reach, and refuses a relative import without its file's
 * extension. A type-only import is erased before Node reads the file, so it
 * is not followed, and neither is a dynamic `import()`, which a script may
 * take only under another runner. A module loaded through the Vite module runner is named
 * at run time, never by a static import, so it is not reached here.
 *
 *   node scripts/node-imports.ts    exits 1 naming each import Node cannot load
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What plain Node loads as a module. */
const MODULE = /\.(ts|mts|cts|js|mjs|cjs)$/;
/** Declarations and tests are never started by plain Node. */
const NOT_STARTED = /\.d\.[cm]?ts$|\.test\.[cm]?[jt]s$/;

export type Refusal = { file: string; line: number; specifier: string };

/** A path plain Node is told to start in a command: `node [flags] <path>`. */
const NODE_COMMAND = /\bnode\s+(?:--?[\w-]+(?:[= ]\S+)?\s+)*([\w./-]+\.(?:ts|mts|cts|js|mjs|cjs))\b/g;
/** A script a test starts with the running Node itself, named by its path or its path's parts. */
const TEST_START =
  /process\.execPath[\s\S]{0,600}?(?:"scripts"\s*,\s*"([\w.-]+\.(?:ts|mts|mjs|js))"|["'`/](scripts\/[\w./-]+\.(?:ts|mts|mjs|js))["'`])/g;

function filesUnder(root: string, dir: string, keep: (file: string) => boolean): string[] {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .filter((file) => !file.split("/").includes("node_modules") && keep(file));
}

/**
 * Every project file plain Node starts: those a `node` command names in
 * package.json, a workflow, an action or a shell script, and the scripts a
 * test starts with the running Node itself. A script loaded only through the
 * Vite module runner or imported by a test is not started by plain Node.
 */
export function nodeEntries(root: string): string[] {
  const entries = new Set<string>();
  const commands = [
    "package.json",
    ...filesUnder(root, ".github", (file) => /\.ya?ml$/.test(file)),
    ...filesUnder(root, "scripts", (file) => file.endsWith(".sh")),
  ];
  for (const file of commands)
    for (const match of readFileSync(join(root, file), "utf8").matchAll(NODE_COMMAND))
      entries.add(normalize(match[1] as string));
  const tests = [
    ...filesUnder(root, "tests", (file) => /\.[cm]?[jt]sx?$/.test(file)),
    ...filesUnder(root, "src", (file) => /\.test\.[cm]?[jt]sx?$/.test(file)),
  ];
  for (const file of tests)
    for (const match of readFileSync(join(root, file), "utf8").matchAll(TEST_START))
      entries.add(match[1] ? `scripts/${match[1]}` : (match[2] as string));
  return [...entries]
    .filter((file) => MODULE.test(file) && !NOT_STARTED.test(file) && existsSync(join(root, file)))
    .sort();
}

/** The module specifiers a file loads when Node runs it, with their lines. */
function loads(source: ts.SourceFile): Array<{ specifier: string; line: number }> {
  const found: Array<{ specifier: string; line: number }> = [];
  const add = (node: ts.Node, literal: ts.Expression | undefined) => {
    if (literal && ts.isStringLiteralLike(literal))
      found.push({
        specifier: literal.text,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) add(node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference))
        add(node, node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Each relative import without its file's extension in the files plain Node
 * starts from `entries` and the files their relative imports reach.
 */
export function refusedImports(root: string, entries: readonly string[]): Refusal[] {
  const refusals: Refusal[] = [];
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const { specifier, line } of loads(source)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const target = relative(root, resolve(root, dirname(file), specifier));
      if (!extname(specifier)) {
        refusals.push({ file, line, specifier });
        continue;
      }
      if (MODULE.test(target) && existsSync(join(root, target))) queue.push(target);
    }
  }
  return refusals;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refusals = refusedImports(ROOT, nodeEntries(ROOT));
  if (refusals.length) {
    console.error(
      "Plain Node loads a relative import only by its exact file name. Add the extension to each:",
    );
    for (const { file, line, specifier } of refusals)
      console.error(`  ${file}:${line}  "${specifier}"`);
    process.exit(1);
  }
}
