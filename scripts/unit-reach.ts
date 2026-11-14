import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import ts from "typescript";

/** INF-2394 measure 3: direct edges only, never the importers of an importer. */
export const VITEST_FILE = /^(src|tests)\/.+\.test\.tsx?$/;

/** What the compiler reads as a module; any other imported file is data. */
const CODE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Served text: words the app serves its agents, which a test reads through
 * the module that builds the prompt (INF-2925's audit: the crew prompt's
 * budget test imports piResources.ts, which imports the generated runbook
 * fallback, two edges from the change). A served-text module is carried like
 * data, one step past the test's own imports, and a test naming a folder
 * that holds it, as the runbook loaders' tests do, reads it too.
 */
export function servedText(path: string): boolean {
  return path.startsWith("resources/runbooks/") || path === "src/core/runbooks/fallback.generated.ts";
}

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

/** Explicit indirect contracts from the accepted weekly audit (INF-3262). */
const CONTRACT_DEPENDENCIES: ReadonlyArray<{
  owns: (path: string) => boolean;
  readers: readonly string[];
}> = [
  {
    owns: (path) => path.startsWith("src/shared/channels/"),
    readers: ["src/shared/actions.test.ts", "src/shared/ipc.test.ts"],
  },
  {
    owns: (path) => path === "src/core/storage/migrations.ts",
    readers: [
      "src/core/storage/decisionMigrations.test.ts",
      "src/core/storage/inboxMigrations.test.ts",
      "src/core/storage/retireKeepOpen.test.ts",
    ],
  },
  {
    owns: (path) => path === "src/core/tasks/taskService.ts",
    readers: ["src/core/orchestrator/settleService.boundary.test.ts"],
  },
  // The wake words pins read every wake's words byte for byte through
  // tests/helpers/wakeWords.ts and wakes.ts, which takes them from its
  // `*Wakes.ts` modules: a changed wake reached the merge batch unread (INF-3614).
  {
    owns: (path) => /^src\/core\/orchestrator\/(wakes|[a-z]+Wakes)\.ts$/.test(path),
    readers: [
      "src/core/orchestrator/wakes.words.batches.test.ts",
      "src/core/orchestrator/wakes.words.cards.test.ts",
      "src/core/orchestrator/wakes.words.corrections.test.ts",
      "src/core/orchestrator/wakes.words.crewmate.test.ts",
      "src/core/orchestrator/wakes.words.firstmate.test.ts",
    ],
  },
  // The Claude session contract runs the seat through tests/helpers/sessionContract.ts,
  // which pins the seat's served prompt and contract stamp from these two
  // modules: a change to how the seat stamps its prompt passed its pull
  // request check and failed the merge batch on both Claude harnesses.
  {
    owns: (path) => path === "src/core/orchestrator/seat.ts" || path === "src/core/pi/piResources.ts",
    readers: [
      "src/core/claude/claudeSession.contract.integration.test.ts",
      "src/core/claude/claudeSession.contract.test.ts",
    ],
  },
  // The Claude classifier test runs scripts/score-kind-classifier.ts under
  // plain Node, which loads the provider catalog without the test runner's
  // resolution: an import it could not load passed the pull request check and
  // failed the merge batch.
  {
    owns: (path) => path === "src/shared/providers.ts",
    readers: ["src/core/claude/claudeClassifierSession.integration.test.ts"],
  },
];

/**
 * Read the compiler aliases, including renderer UI imports; never build a closure.
 *
 * A data file a module imports (a runbook's JSON, a stylesheet read as text)
 * is part of that module's own text, so a test importing that module directly
 * reads the data directly too (INF-2426: the crew guidance tests read
 * resources/runbooks through piResources.ts). That is the one step taken
 * past the test's own imports, and only through data or served text (the
 * generated runbook fallback, `servedText`): any other changed module is
 * never followed to the importers of its importers.
 */
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
  const data = [...subjects].filter((file) => !CODE_FILE.test(file) || servedText(file));
  // A module is imported without its extension; data keeps its own.
  const dataNames = [
    ...new Set(data.map((file) => basename(file).replace(/\.[cm]?[jt]sx?$/, ""))),
  ];
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    // A deleted module still has direct importers that must run.
    fileExists: (file) => subjects.has(file.slice(root.length + 1)) || ts.sys.fileExists(file),
  };
  /** The project file a specifier names, ignoring a bundler query such as `?raw`. */
  const target = (specifier: string, from: string): string | undefined => {
    const bare = specifier.replace(/\?.*$/, "");
    const resolved =
      ts.resolveModuleName(bare, from, options, host, cache).resolvedModule?.resolvedFileName ??
      (bare.startsWith(".") ? resolve(dirname(from), bare) : undefined);
    const file = resolved === undefined ? undefined : relative(root, resolved);
    return file && !file.startsWith("..") ? file : undefined;
  };
  /** Import, re-export, `import()` and `require` specifiers, as written. */
  const specifiers = (node: ts.Node): string | undefined => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      return node.moduleSpecifier.text;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) return specifier.text;
    }
    return undefined;
  };
  const readsData = new Map<string, boolean>();
  /** Whether a module a test imports imports a changed data file itself. */
  const importsChangedData = (imported: string): boolean => {
    // A package never imports a project file.
    if (data.length === 0 || VITEST_FILE.test(imported) || imported.includes("node_modules/"))
      return false;
    const known = readsData.get(imported);
    if (known !== undefined) return known;
    const absolute = join(root, imported);
    const text = CODE_FILE.test(imported) && existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
    let found = false;
    if (dataNames.some((name) => text.includes(name))) {
      const visit = (node: ts.Node): void => {
        if (found) return;
        const specifier = specifiers(node);
        if (specifier !== undefined) {
          const file = target(specifier, absolute);
          if (file && data.includes(file)) found = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(ts.createSourceFile(imported, text, ts.ScriptTarget.Latest, true));
    }
    readsData.set(imported, found);
    return found;
  };
  return files
    .filter((file) => {
      if (changed.includes(file)) return false;
      if (
        CONTRACT_DEPENDENCIES.some(
          ({ owns, readers }) => readers.includes(file) && [...subjects].some(owns),
        )
      )
        return true;
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
        return [...subjects].some(
          (subject) =>
            candidates.includes(subject) ||
            // A test that loads the runbook folder serves every runbook in it.
            (servedText(subject) &&
              candidates.some(
                (folder) => servedText(`${folder}/`) && subject.startsWith(`${folder}/`),
              )),
        );
      };
      const visit = (node: ts.Node): void => {
        if (reached) return;
        const specifier = specifiers(node);
        if (specifier !== undefined) {
          const imported = target(specifier, resolve(root, file));
          if (imported && (subjects.has(imported) || importsChangedData(imported))) reached = true;
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
