import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The journey files a change can break (docs/testing.md, "Journeys on the
 * pull request"). The pull request's Mac check runs only these, so the
 * breaks the alpha's full Mac run used to find one to three at a time -
 * after the change merged - surface on the change that caused them.
 *
 *   node scripts/affected-journeys.ts [--base <ref>] [--head <ref>] [--json]
 *
 * prints the spec files, one per line (or a JSON object with the reason for
 * each), and exits 0 whether or not any file is affected. A journey is
 * affected when
 *
 * 1. it is a spec file the change edits;
 * 2. a helper it imports, directly or through another helper, is a file the
 *    change edits, and imports an export whose declaration or body changed:
 *    one under `tests/e2e/`, a shared one under `tests/` such as
 *    `tests/helpers/`, or a script;
 * 3. it imports a changed module of `src/shared/` and names a symbol that
 *    module's diff adds or removes. Importing the file is not enough;
 * 4. it, or a helper most journeys do not import, names a renderer hook
 *    (`data-*`) as a whole token the change adds or removes in `src/`; or
 * 5. it, or a helper most journeys do not import, holds a sentence of two or
 *    more words as its own quoted string, one the change adds or removes in
 *    a string of `src/`; or
 * 6. it, or a helper most journeys do not import, names a hook that a
 *    changed file under `src/renderer/` draws, even when the change adds or
 *    removes none: the file owns what that hook shows; or
 * 7. its changed path matches a targeted fallback row below, even when no
 *    hook, symbol or sentence changed.
 *
 * A fragment inside a longer quote, a hook name inside a longer token, and a
 * sentence held only by the stand-in do not select every journey that reaches
 * that file. A change no journey or helper it imports reaches runs no
 * journey. The release's full Mac check is `verify.yml` and is not this
 * selection.
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const E2E = "tests/e2e";

/** A module of the product, as opposed to the test code a journey runs. */
const isSource = (file: string) => file.startsWith("src/");

export type Reasons = Map<string, string[]>;

// These narrow fallbacks cover breaks that do not change a hook or copied
// words. Union them with the existing selection, never replace it.
const FALLBACKS = [
  {
    paths: ["src/renderer/src/cards/", "src/renderer/src/app/HomeScreen.tsx"],
    specs: ["keyboard-routing.spec.ts", "stage-reveals.spec.ts"],
  },
  {
    paths: ["src/renderer/src/app/focusRecovery.ts", "src/renderer/src/plugins/frames/frameFocus.ts"],
    specs: ["frame-focus.spec.ts", "focus-recovery.spec.ts", "card-task-keys.spec.ts"],
  },
  { paths: ["src/core/devices/"], specs: ["devices.spec.ts"] },
  {
    // Automatic placement on the Mac's own readings: no hook or words change with its rules.
    paths: [
      "src/core/routing/placementEngine.ts",
      "src/core/placed/automaticPlacement.ts",
      "src/core/placed/placementFacts.ts",
      "src/core/placed/resourceSampler.ts",
      "src/core/placed/computerResources.ts",
      "src/core/placed/computerResourceFeed.ts",
      "src/main/host/resourceMemory.ts",
    ],
    specs: ["automatic-placement.spec.ts"],
  },
] as const;

/** Relative imports and re-exports of a TypeScript file, resolved to repository paths. */
export function importsOf(
  file: string,
  source: string,
  exists: (file: string) => boolean = (candidate) => existsSync(join(ROOT, candidate)),
): string[] {
  const found: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  for (const [, specifier] of source.matchAll(pattern)) {
    if (!specifier || !(specifier.startsWith(".") || specifier.startsWith("@shared/"))) continue;
    const base = specifier.startsWith("@shared/")
      ? join("src/shared", specifier.slice("@shared/".length))
      : normalize(join(dirname(file), specifier));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) {
      if (exists(candidate) && /\.tsx?$/.test(candidate)) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

/** Every file a spec reaches through its imports, itself included. */
export function closureOf(
  entry: string,
  read: (file: string) => string | undefined,
  cache: Map<string, string[]> = new Map(),
): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    let imports = cache.get(file);
    if (!imports) {
      const source = read(file);
      imports =
        source === undefined ? [] : importsOf(file, source, (candidate) => read(candidate) !== undefined);
      cache.set(file, imports);
    }
    // Only the test code a journey runs is walked into - `tests/e2e`, the shared
    // helpers under `tests/` and a script it imports. A module of `src/` is a
    // leaf, since what its own imports change reaches a journey through the
    // hooks and words below, not through the import.
    if (!isSource(file)) for (const next of imports) walk(next);
  };
  walk(entry);
  return [...seen];
}

/** The `data-*` hooks and the sentences of two or more words a source diff adds or removes. */
export function tokensOfDiff(diff: string): { hooks: Set<string>; sentences: Set<string> } {
  const hooks = new Set<string>();
  const sentences = new Set<string>();
  // Cancellation is per file: moving words between files still changes both owners.
  for (const part of diff.split(/^diff --git /m)) {
    if (/^a\/src\/.*\.(?:test|spec)\.[^ ]+ /m.test(part)) continue;
    const sides = [new Set<string>(), new Set<string>()];
    const phrases = [new Set<string>(), new Set<string>()];
    for (const line of part.split("\n")) {
      if (!/^[+-](?![+-])/.test(line)) continue;
      const side = line.startsWith("+") ? 0 : 1;
      const text = line.slice(1);
      for (const [hook] of text.matchAll(/\bdata-[a-z][a-z0-9-]*/g)) sides[side]?.add(hook);
      for (const [, , sentence] of text.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
        const words = (sentence ?? "").trim();
        if (/^[^\s${}<>=]+(?:\s+[^\s${}<>=]+)+$/.test(words) && words.length >= 8)
          phrases[side]?.add(words);
      }
    }
    for (const [index, side] of sides.entries())
      for (const hook of side) if (!sides[1 - index]?.has(hook)) hooks.add(hook);
    for (const [index, side] of phrases.entries())
      for (const phrase of side) if (!phrases[1 - index]?.has(phrase)) sentences.add(phrase);
  }
  return { hooks, sentences };
}

/**
 * The phrase is the whole of one quoted string, not a fragment of a longer
 * quote or of a longer line. The same quote reader as `tokensOfDiff`.
 */
export function holdsPhrase(text: string, phrase: string): boolean {
  for (const match of text.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    if ((match[2] ?? "").trim() === phrase) return true;
  }
  return false;
}

/** The hook is a whole token, not a piece of a longer hook name or a path. */
export function holdsHook(text: string, hook: string): boolean {
  const escaped = hook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`).test(text);
}

/** Every `data-*` hook a renderer file draws, before or after the change. */
export function ownedHooks(
  changed: readonly string[],
  read: (file: string) => string | undefined,
  readBefore?: (file: string) => string | undefined,
): Map<string, Set<string>> {
  const owned = new Map<string, Set<string>>();
  for (const file of changed) {
    // A unit test beside the screen draws nothing a person sees.
    if (!file.startsWith("src/renderer/") || /\.(?:test|spec)\.[^/]+$/.test(file)) continue;
    const hooks = new Set<string>();
    for (const text of [read(file), readBefore?.(file)])
      for (const [hook] of (text ?? "").matchAll(/(?<![A-Za-z0-9-])data-[a-z][a-z0-9-]*/g))
        hooks.add(hook);
    if (hooks.size > 0) owned.set(file, hooks);
  }
  return owned;
}

const NOT_A_SYMBOL = new Set([
  "string",
  "boolean",
  "number",
  "object",
  "undefined",
  "null",
  "true",
  "false",
  "return",
  "const",
  "function",
  "export",
  "import",
  "type",
  "from",
  "optional",
  "literal",
  "enum",
  "array",
  "record",
  "unknown",
  "void",
  "async",
  "await",
  "Record",
  "Omit",
  "Partial",
  "Promise",
]);

/**
 * Symbols a shared-module diff adds or removes: a property key of four or
 * more letters or an export, with at least one capital letter.
 * A name on both sides of the diff was moved, not changed. A name shorter
 * than four letters (`run`, `id`, `text`) does not name the change.
 */
export function symbolsOfDiff(diff: string): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const part of diff.split(/^diff --git /m)) {
    const path = part.match(/a\/(\S+)/)?.[1];
    // A unit test under src/shared is not a module a journey imports.
    if (!path?.startsWith("src/shared/") || /\.(?:test|spec)\./.test(path)) continue;
    const added = new Set<string>();
    const removed = new Set<string>();
    for (const line of part.split("\n")) {
      if (!/^[+-](?![+-])/.test(line)) continue;
      const text = line.slice(1);
      // A colon in a comment ("holds: a line") is not a property.
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
      const into = line.startsWith("+") ? added : removed;
      const code = text.replace(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g, "").replace(/\/\/.*$/, "");
      // A key at the start of a line or after `{` or `,`. A parameter
      // (`event: FmEvent`) is not a symbol the change introduced.
      for (const match of code.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]{3,})\s*\??\s*:/g)) {
        if (/[A-Z]/.test(match[1] ?? "") && !NOT_A_SYMBOL.has(match[1] ?? ""))
          into.add(match[1] ?? "");
      }
      for (const match of code.matchAll(
        /\bexport\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
      )) {
        if (/[A-Z]/.test(match[1] ?? "")) into.add(match[1] ?? "");
      }
    }
    const delta = new Set<string>();
    for (const name of added) if (name && !removed.has(name)) delta.add(name);
    for (const name of removed) if (name && !added.has(name)) delta.add(name);
    if (delta.size > 0) byFile.set(path, delta);
  }
  return byFile;
}

function names(text: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/** Top-level helper declarations; keep this package-free for choose-journeys. */
function declarations(source: string): Map<string, { text: string; exported: boolean }> {
  const result = new Map<string, { text: string; exported: boolean }>();
  const pattern =
    /^(export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([\w$]+)/gm;
  const starts = [...source.matchAll(pattern)];
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1]?.index ?? source.length;
    // A declaration's leading documentation belongs to it, not its predecessor.
    let text = source.slice(start.index, end).trim();
    const comment = text.lastIndexOf("/**");
    if (comment >= 0 && /^\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/.test(text.slice(comment)))
      text = text.slice(0, comment).trim();
    result.set(start[2] ?? "", { text, exported: Boolean(start[1]) });
  }
  for (const match of source.matchAll(/^export\s*\{([^}]+)\}(?:\s+from\s+["'][^"']+["'])?/gm)) {
    for (const item of (match[1] ?? "").split(",")) {
      const [local, alias] = item
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      if (local) {
        const name = alias ?? local;
        const declaration = name === local ? result.get(local)?.text : "";
        result.set(name, { text: `${declaration ?? ""}\n${match[0]}`, exported: true });
      }
    }
  }
  for (const match of source.matchAll(/^export default\s+([\s\S]*?)(?=^export |$(?![\s\S]))/gm))
    result.set("default", { text: match[0].trim(), exported: true });
  return result;
}

/** Changed exports, including exports using an edited private declaration. */
export function changedExports(before: string, after: string): Set<string> {
  const old = declarations(before);
  const next = declarations(after);
  const all = new Set([...old.keys(), ...next.keys()]);
  const changed = new Set([...all].filter((name) => old.get(name)?.text !== next.get(name)?.text));
  // Imports and top-level setup have no declaration owner. They can affect any export.
  const preamble = (source: string) =>
    source.slice(
      0,
      source.search(
        /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s/m,
      ),
    );
  if (preamble(before) !== preamble(after)) for (const name of all) changed.add(name);
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of all) {
      if (changed.has(name)) continue;
      const text = `${old.get(name)?.text ?? ""}\n${next.get(name)?.text ?? ""}`;
      if ([...changed].some((dependency) => names(text, dependency))) {
        changed.add(name);
        grew = true;
      }
    }
  }
  return new Set(
    [...changed].filter((name) => old.get(name)?.exported || next.get(name)?.exported),
  );
}

/** The imported name is the original export, not a local alias. */
function importsChangedName(
  file: string,
  source: string,
  target: string,
  exports: Set<string>,
  read: Change["read"],
): boolean {
  for (const match of source.matchAll(
    /(?:import|export)\s+(type\s+)?(\{[^}]+\}|\*(?:\s+as\s+\w+)?|[\w$]+(?:\s*,\s*\{[^}]+\})?)\s+from\s*["']([^"']+)["']/g,
  )) {
    const clause = match[2] ?? "";
    const statement = `import "${match[3]}"`;
    if (!importsOf(file, statement, (path) => read(path) !== undefined).includes(target)) continue;
    if (/\*/.test(clause)) return exports.size > 0;
    if (!clause.startsWith("{") && exports.has("default")) return true;
    const named = clause.match(/\{([^}]+)\}/)?.[1];
    if (
      named?.split(",").some((item) =>
        exports.has(
          item
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0] ?? "",
        ),
      )
    )
      return true;
  }
  return false;
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** What the selection reads: the changed paths, the source diff, the specs, and a file's text. */
export type Change = {
  changed: readonly string[];
  sourceDiff: string;
  specs: readonly string[];
  read: (file: string) => string | undefined;
  readBefore?: (file: string) => string | undefined;
};

export function select({ changed, sourceDiff, specs, read, readBefore }: Change): Reasons {
  const changedSet = new Set(changed);
  const { hooks, sentences } = tokensOfDiff(sourceDiff);
  const owned = ownedHooks(changed, read, readBefore);
  const symbols = symbolsOfDiff(sourceDiff);
  const helperExports = new Map<string, Set<string>>();
  if (readBefore)
    for (const file of changed)
      if (!isSource(file) && /\.tsx?$/.test(file) && !file.endsWith(".spec.ts"))
        helperExports.set(file, changedExports(readBefore(file) ?? "", read(file) ?? ""));
  // A deleted helper still has importers, and its removed exports still matter.
  const availableRead = (file: string) =>
    read(file) ?? (helperExports.has(file) ? readBefore?.(file) : undefined);
  const importCache = new Map<string, string[]>();
  const reachOf = new Map<string, string[]>();
  const reachCount = new Map<string, number>();
  for (const spec of specs) {
    const reach = closureOf(spec, availableRead, importCache);
    reachOf.set(spec, reach);
    for (const file of reach) {
      if (file.startsWith(`${E2E}/`) && file !== spec)
        reachCount.set(file, (reachCount.get(file) ?? 0) + 1);
    }
  }
  // A helper most journeys import is the stand-in class: a phrase or a symbol
  // found only there does not select those journeys. An edit to the helper
  // itself still does, below.
  const wide = (file: string) => (reachCount.get(file) ?? 0) > specs.length / 2;
  // A word most journeys already use does not name this change.
  const narrowOf = (spec: string) =>
    (reachOf.get(spec) ?? [])
      .filter((file) => file.startsWith(`${E2E}/`) && (file === spec || !wide(file)))
      .map((file) => read(file) ?? "")
      .join("\n");
  const ordinary = new Map<string, boolean>();
  const isOrdinary = (symbol: string) => {
    let known = ordinary.get(symbol);
    if (known === undefined) {
      const named = specs.filter((spec) => names(narrowOf(spec), symbol)).length;
      known = named > specs.length / 2;
      ordinary.set(symbol, known);
    }
    return known;
  };
  const reasons: Reasons = new Map();
  const add = (spec: string, why: string) => {
    const list = reasons.get(spec) ?? [];
    if (list.length < 3 && !list.includes(why)) list.push(why);
    reasons.set(spec, list);
  };
  for (const spec of specs) {
    if (changedSet.has(spec)) add(spec, "the change edits this journey");
    const reach = reachOf.get(spec) ?? [];
    for (const file of reach)
      if (
        file !== spec &&
        changedSet.has(file) &&
        !isSource(file) &&
        (!helperExports.has(file) ||
          reach.some((importer) =>
            importsChangedName(
              importer,
              availableRead(importer) ?? "",
              file,
              helperExports.get(file) ?? new Set(),
              availableRead,
            ),
          ))
      )
        add(spec, `imports ${file}, which the change edits`);
    const narrow = reach.filter(
      (file) => file.startsWith(`${E2E}/`) && (file === spec || !wide(file)),
    );
    const narrowText = narrow.map((file) => read(file) ?? "").join("\n");
    for (const [file, changedSymbols] of symbols) {
      if (!reach.includes(file)) continue;
      for (const symbol of changedSymbols) {
        if (isOrdinary(symbol) || !names(narrowText, symbol)) continue;
        add(spec, `names ${symbol} in ${file}, which the change adds or removes`);
        break;
      }
    }
    for (const hook of hooks)
      if (holdsHook(narrowText, hook)) add(spec, `reads ${hook}, which the change adds or removes`);
    for (const sentence of sentences)
      if (holdsPhrase(narrowText, sentence))
        add(spec, `holds "${sentence}", which the change adds or removes`);
    for (const [file, drawn] of owned) {
      // Only a hook the journey's own text mentions can be one it reads.
      const reads = [...drawn].find((hook) => narrowText.includes(hook) && holdsHook(narrowText, hook));
      if (reads) add(spec, `reads ${reads}, which ${file} draws`);
    }
  }
  const available = new Set(specs);
  for (const row of FALLBACKS) {
    const matches = changed.filter((file) =>
      row.paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)),
    );
    if (matches.length === 0) continue;
    for (const name of row.specs) {
      const spec = `${E2E}/${name}`;
      if (!available.has(spec)) throw new Error(`Stale journey fallback target: ${spec}`);
      // Keep every existing reason, including a full three-reason list.
      reasons.set(spec, [...(reasons.get(spec) ?? []), `targeted fallback for ${matches.join(", ")}`]);
    }
  }
  return reasons;
}

export function affected(base: string, head: string): Reasons {
  const changed = git(["diff", "--name-only", `${base}...${head}`])
    .split("\n")
    .filter(Boolean);
  const sourceDiff = changed.some((file) => file.startsWith("src/"))
    ? git(["diff", "-U0", `${base}...${head}`, "--", "src"])
    : "";
  const specs = readdirSync(join(ROOT, E2E))
    .filter((file) => file.endsWith(".spec.ts"))
    .map((file) => `${E2E}/${file}`);
  const files = new Map<string, string | undefined>();
  const read = (file: string) => {
    if (!files.has(file)) {
      const path = join(ROOT, file);
      files.set(file, existsSync(path) ? readFileSync(path, "utf8") : undefined);
    }
    return files.get(file);
  };
  const before = git(["merge-base", base, head]).trim();
  const beforeFiles = new Map<string, string | undefined>();
  const readBefore = (file: string) => {
    if (!beforeFiles.has(file)) {
      try {
        beforeFiles.set(file, git(["show", `${before}:${file}`]));
      } catch {
        beforeFiles.set(file, undefined);
      }
    }
    return beforeFiles.get(file);
  };
  return select({ changed, sourceDiff, specs, read, readBefore });
}

function main(): void {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
  };
  const reasons = affected(value("--base", "origin/main"), value("--head", "HEAD"));
  const files = [...reasons.keys()].sort();
  if (args.includes("--json"))
    console.log(JSON.stringify(Object.fromEntries(files.map((file) => [file, reasons.get(file)])), null, 2));
  else for (const file of files) console.log(relative(".", file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
