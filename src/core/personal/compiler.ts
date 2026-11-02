import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { ownHostModule } from "@shared/codeNames";
import {
  type HostModuleKey,
  PERSONAL_CONTRACTS_MODULE,
  PERSONAL_HOST_MODULES,
} from "@shared/personal/manifest";
import { frameLibHostModuleUrl } from "@shared/plugins/frameLib";
import {
  PANEL_CARD_VIEWS_MAX,
  PANEL_NAME_PATTERN,
  panelCardViewSource,
} from "@shared/plugins/panelCards";
import ts from "typescript";

/**
 * The personal-extension compiler (talk-to-personalize Step 2; the
 * baby-menu pattern, report section 4). It transpiles one module graph -
 * `panel.tsx` and every local file it reaches, or `server.ts` and its -
 * into plain ES modules under a content-addressed directory, and it is
 * where coherence is ENFORCED: an import is admitted or refused here, with
 * the offending path named, never at display time.
 *
 * The allowlist (design section 6, layer 3):
 * - a panel may import `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`,
 *   `@infinitary/ui`, and local files inside its own directory;
 * - a server module may import `node:*` built-ins and local files;
 * - either may import `@infinitary/contracts` for TYPES only (the transpile
 *   elides a type-only import; one that survives was a value use);
 * - nothing else: no npm package, no host path, no file that leaves the
 *   extension directory (through `..` or a symlink), no dynamic `import()`.
 *
 * Every panel runs in the frame realm (INF-2205 piece C: the captain's own,
 * the ones he added and the app's own alike), so host modules are rewritten
 * to the lib the shell serves at `app-frame://lib/<key>.mjs`, each of which
 * default-exports a namespace; a named import becomes a destructuring of
 * it, so the `@infinitary/ui` surface is whatever `src/renderer/src/design/`
 * exports, with no list to maintain. Local imports keep their relative
 * shape with an `.mjs` extension.
 *
 * A panel's card views (`cards/<view>.tsx`, docs/ui-plugins.md "A panel's
 * cards") are entries of the same graph: compiled with the panel, under
 * the same allowlist and the same hash, so a panel and its cards are one
 * version and a panel added from elsewhere has its cards pinned with it.
 *
 * A panel may bring its own stylesheet (FI3-1014 piece 6): a local
 * `import styles from "./board.css"` is admitted as TEXT - the file becomes
 * a module whose default export is its contents (`board.css.mjs`), which
 * the panel puts in a `<style>` of its own - so a stylesheet is a file of
 * the graph like any other, hashed and pinned with it, and never a request
 * the page makes.
 *
 * Output is `<cacheRoot>/<id>/<hash>/<relative>.mjs`, the hash over every
 * source in the graph: identical sources give the identical URL (and the
 * same module instance, in the renderer and in the core's `import()`), and
 * any edit gives a fresh one - that IS the hot reload and the cache bust.
 * Nothing here is ever evicted; the cache is small and the D-13 purge
 * clears it.
 */

export type PersonalModuleKind = "panel" | "server";

export const PERSONAL_ENTRY_FILES: Record<PersonalModuleKind, string> = {
  panel: "panel.tsx",
  server: "server.ts",
};

export type CompileOptions = {
  extensionId: string;
  extensionDir: string;
  kind: PersonalModuleKind;
  cacheRoot: string;
};

export type CompiledModule = {
  /** 16 hex characters over the whole source graph. */
  hash: string;
  outputDir: string;
  /** The compiled entry (`panel.mjs` / `server.mjs`), absolute. */
  entryPath: string;
  /** Every source file the graph reached, absolute, sorted. */
  sourceFiles: string[];
  /** A panel's card views, each compiled to `cards/<view>.mjs` beside it, sorted. Empty for a server. */
  views: string[];
};

/** A refusal names the file (as `<id>/<relative>`) and says why. */
export class PersonalCompileError extends Error {
  constructor(
    readonly extensionId: string,
    readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = "PersonalCompileError";
  }
}

const LOCAL_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];
/** A panel's own stylesheet: admitted as text, and only when the import names the file whole. */
const STYLESHEET_EXTENSION = ".css";
const HASH_LENGTH = 16;

const TRANSPILE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  sourceMap: false,
  // Elide an import used only as a type: that is what makes a type-only
  // `@infinitary/contracts` import legal and invisible.
  verbatimModuleSyntax: false,
};

type GraphModule = {
  /** Absolute source path. */
  path: string;
  /** Relative to the extension directory, forward slashes. */
  relative: string;
  source: string;
  /** Transpiled and rewritten ES module text. */
  output: string;
};

export async function compilePersonalModule(options: CompileOptions): Promise<CompiledModule> {
  const extensionRoot = await realDir(options.extensionDir);
  const entry = join(extensionRoot, PERSONAL_ENTRY_FILES[options.kind]);
  const views = options.kind === "panel" ? await cardViews(options.extensionId, extensionRoot) : [];
  const modules = new Map<string, GraphModule>();
  const queue = [entry, ...views.map((view) => join(extensionRoot, panelCardViewSource(view)))];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (modules.has(path)) continue;
    const rel = relativeInside(extensionRoot, path);
    const source = await readFile(path, "utf8");
    if (extname(path) === STYLESHEET_EXTENSION) {
      // A stylesheet is text: its module default-exports it, and imports nothing.
      modules.set(path, {
        path,
        relative: rel,
        source,
        output: `export default ${JSON.stringify(source)};\n`,
      });
      continue;
    }
    const transpiled = transpile(source, path, options.extensionId, rel);
    const rewritten = await rewriteImports({
      ...options,
      extensionRoot,
      filePath: path,
      fileRelative: rel,
      output: transpiled,
    });
    modules.set(path, { path, relative: rel, source, output: rewritten.output });
    for (const local of rewritten.locals) {
      if (!modules.has(local)) queue.push(local);
    }
  }
  const ordered = [...modules.values()].sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = contentHash(options.kind, ordered);
  const outputDir = join(options.cacheRoot, options.extensionId, hash);
  const entryPath = join(outputDir, outputName(relativeInside(extensionRoot, entry)));
  if (!existsSync(entryPath)) {
    for (const module of ordered) {
      const target = join(outputDir, outputName(module.relative));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, module.output, "utf8");
    }
  }
  return {
    hash,
    outputDir,
    entryPath,
    sourceFiles: ordered.map((module) => module.path),
    views,
  };
}

/**
 * A panel's card views: every `.tsx` directly in its `cards/` directory,
 * by name. A view's name is kebab-case, since `cards.emit` and the
 * manifest name it; a file named otherwise is refused with its path, never
 * passed over. Helpers a view imports live outside `cards/` or as `.ts`.
 */
async function cardViews(extensionId: string, extensionRoot: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(join(extensionRoot, "cards"), { withFileTypes: true });
  } catch {
    return [];
  }
  const views: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== ".tsx") continue;
    const name = entry.name.slice(0, -".tsx".length);
    if (!PANEL_NAME_PATTERN.test(name)) {
      throw new PersonalCompileError(
        extensionId,
        `${extensionId}/cards/${entry.name}`,
        `${extensionId}/cards/${entry.name}: a card view's file name is kebab-case, like cards/notes.tsx`,
      );
    }
    views.push(name);
  }
  if (views.length > PANEL_CARD_VIEWS_MAX) {
    throw new PersonalCompileError(
      extensionId,
      `${extensionId}/cards`,
      `${extensionId}/cards holds ${views.length} card views; a panel may have ${PANEL_CARD_VIEWS_MAX}`,
    );
  }
  return views.sort();
}

/**
 * The served path of a compiled file, relative to its hash directory. A
 * stylesheet keeps its own extension before `.mjs`, so `board.css` and
 * `board.tsx` never compile to the same file.
 */
export function outputName(sourceRelative: string): string {
  const ext = extname(sourceRelative);
  if (ext === STYLESHEET_EXTENSION) return `${sourceRelative}.mjs`;
  return `${ext ? sourceRelative.slice(0, -ext.length) : sourceRelative}.mjs`;
}

/**
 * Transpiles one file. A syntax error is refused here, with the file and
 * the first message named, rather than emitted as JavaScript that fails
 * at import time where nothing could name the file.
 */
function transpile(source: string, fileName: string, extensionId: string, rel: string): string {
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: TRANSPILE_OPTIONS,
    reportDiagnostics: true,
  });
  const first = result.diagnostics?.[0];
  if (first) {
    const text = ts.flattenDiagnosticMessageText(first.messageText, " ");
    const line =
      first.file && first.start !== undefined
        ? `:${first.file.getLineAndCharacterOfPosition(first.start).line + 1}`
        : "";
    throw new PersonalCompileError(
      extensionId,
      `${extensionId}/${rel}`,
      `${extensionId}/${rel}${line}: ${text}`,
    );
  }
  return result.outputText;
}

type RewriteInput = CompileOptions & {
  extensionRoot: string;
  filePath: string;
  fileRelative: string;
  output: string;
};

type Replacement = { start: number; end: number; text: string };

type ImportSite = {
  node: ts.ImportDeclaration | ts.ExportDeclaration;
  specifierNode: ts.StringLiteral;
  specifier: string;
};

/**
 * Walks the emitted JS for every static import/export-from and refuses,
 * admits, or rewrites each. Works on the AST, not a regex, so a `from "x"`
 * inside a string or comment is never touched. A local import is resolved
 * on the SOURCE tree and rewritten to the resolved file's output path
 * (`./lib` reaching `lib/index.tsx` becomes `./lib/index.mjs`), so the
 * emitted graph mirrors the source tree one to one.
 */
async function rewriteImports(input: RewriteInput): Promise<{ output: string; locals: string[] }> {
  const file = ts.createSourceFile(
    input.filePath,
    input.output,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const where = `${input.extensionId}/${input.fileRelative}`;
  const refuse = (message: string): never => {
    throw new PersonalCompileError(input.extensionId, where, message);
  };
  const allowed =
    input.kind === "panel"
      ? `react, @infinitary/ui, and files inside ${input.extensionId}/`
      : `node:* built-ins and files inside ${input.extensionId}/`;

  const sites: ImportSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifierNode = node.moduleSpecifier;
      if (specifierNode && ts.isStringLiteral(specifierNode)) {
        sites.push({ node, specifierNode, specifier: specifierNode.text });
      }
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      refuse(`${where} uses a dynamic import(); import at the top of the file instead`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  const replacements: Replacement[] = [];
  const locals: string[] = [];
  let hostImportIndex = 0;
  for (const { node, specifierNode, specifier } of sites) {
    if (isLocal(specifier) && extname(specifier) === STYLESHEET_EXTENSION) {
      // A stylesheet is a panel's, read as text by one default import.
      if (input.kind === "server") {
        refuse(
          `${where} imports "${specifier}"; a stylesheet belongs to the panel, not server code`,
        );
      }
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      if (!clause?.name || clause.namedBindings) {
        refuse(
          `${where} imports "${specifier}" without a name; a stylesheet is text: import styles from "${specifier}"`,
        );
      }
    }
    if (isLocal(specifier)) {
      const resolved = await resolveLocal(specifier, input.filePath, input.extensionRoot, refuse);
      locals.push(resolved);
      const target = outputName(relativeInside(input.extensionRoot, resolved));
      const from = dirname(input.fileRelative);
      let rel = relative(from === "." ? "" : from, target)
        .split("\\")
        .join("/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      replacements.push({
        start: specifierNode.getStart(file),
        end: specifierNode.getEnd(),
        text: JSON.stringify(rel),
      });
      continue;
    }
    // Another spelling's name for a host module is the same module (`@infinitary/ui`).
    const named = ownHostModule(specifier);
    if (named === PERSONAL_CONTRACTS_MODULE) {
      refuse(`${where} imports "${specifier}" as a value; it is type-only (use \`import type\`)`);
    }
    if (input.kind === "server") {
      if (specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
      refuse(`${where} imports "${specifier}", which a server module cannot use (${allowed})`);
    }
    const key = (PERSONAL_HOST_MODULES as Record<string, HostModuleKey | undefined>)[named];
    if (!key) {
      refuse(`${where} imports "${specifier}", which a panel cannot use (${allowed})`);
    }
    if (ts.isExportDeclaration(node)) {
      refuse(`${where} re-exports "${specifier}"; import it and export your own names`);
    }
    const importNode = node as ts.ImportDeclaration;
    const local = `__fm_host${hostImportIndex++}`;
    const url = frameLibHostModuleUrl(key as HostModuleKey);
    const lines = [`import ${local} from ${JSON.stringify(url)};`];
    const clause = importNode.importClause;
    if (clause?.name) lines.push(`const ${clause.name.text} = ${local};`);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      lines.push(`const ${bindings.name.text} = ${local};`);
    } else if (bindings && ts.isNamedImports(bindings)) {
      const names = bindings.elements.map((element) =>
        element.propertyName
          ? `${element.propertyName.text}: ${element.name.text}`
          : element.name.text,
      );
      if (names.length > 0) lines.push(`const { ${names.join(", ")} } = ${local};`);
    }
    replacements.push({ start: node.getStart(file), end: node.getEnd(), text: lines.join("\n") });
  }

  let output = input.output;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  return { output, locals };
}

function isLocal(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Resolves a local import on the source tree: the exact file when the
 * specifier carries a module extension, else the first of `<base>.<ext>`
 * then `<base>/index.<ext>` that exists. The resolved REAL path must stay
 * inside the extension directory - `..` and a symlink are the same escape.
 */
async function resolveLocal(
  specifier: string,
  fromPath: string,
  extensionRoot: string,
  refuse: (message: string) => never,
): Promise<string> {
  const base = resolve(dirname(fromPath), specifier);
  const id = basename(extensionRoot);
  const inside = (path: string): boolean => {
    const rel = relative(extensionRoot, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!inside(base)) {
    refuse(`${where(fromPath, extensionRoot)} imports "${specifier}", which leaves ${id}/`);
  }
  const ext = extname(specifier);
  const candidates =
    LOCAL_EXTENSIONS.includes(ext) || ext === STYLESHEET_EXTENSION
      ? [base]
      : [
          ...LOCAL_EXTENSIONS.map((suffix) => `${base}${suffix}`),
          ...LOCAL_EXTENSIONS.map((suffix) => join(base, `index${suffix}`)),
        ];
  for (const candidate of candidates) {
    let real: string;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      real = await realpath(candidate);
    } catch {
      continue;
    }
    if (!inside(real)) {
      refuse(`${where(fromPath, extensionRoot)} imports "${specifier}", which leaves ${id}/`);
    }
    return real;
  }
  return refuse(
    `${where(fromPath, extensionRoot)} imports "${specifier}", which is not a file in ${id}/`,
  );
}

function where(fromPath: string, extensionRoot: string): string {
  return `${basename(extensionRoot)}/${relativeInside(extensionRoot, fromPath)}`;
}

function relativeInside(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

async function realDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

function contentHash(kind: PersonalModuleKind, modules: readonly GraphModule[]): string {
  const hash = createHash("sha256");
  hash.update(`${kind}\0`);
  // A panel's output points its host imports at the frame realm's lib, so
  // it is a version of its own, apart from the in-window output a panel of
  // the captain's had before every panel drew in a frame.
  if (kind === "panel") hash.update("frame\0");
  for (const module of modules) {
    hash.update(`${module.relative}\0${module.source}\0`);
  }
  return hash.digest("hex").slice(0, HASH_LENGTH);
}
