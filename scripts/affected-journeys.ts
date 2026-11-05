import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { editedScreenText, screenRanges } from "./screen-journeys.ts";
import { callsMethod, changedMessages, PRELOAD } from "./window-messages.ts";

/**
 * The journey files a change can break (docs/testing.md, "Journeys on the
 * pull request"). The pull request's Mac check runs only these, so the
 * breaks the alpha's full Mac run used to find one to three at a time -
 * after the change merged - surface on the change that caused them.
 *
 *   node scripts/affected-journeys.ts [--base <ref>] [--head <ref>] [--json]
 *   node scripts/affected-journeys.ts --plan [--ran "<successful run files>"]
 *   node scripts/affected-journeys.ts --named "<journey> <journey>" [--json]
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
 *    module's diff adds or removes (direct imports also match rule 12);
 * 4. it, or a helper most journeys do not import, names a renderer hook
 *    (`data-*`) as a whole token the change adds or removes in `src/`; or
 * 5. it, or a helper most journeys do not import, holds a sentence of two or
 *    more words as its own quoted string, one the change adds or removes in
 *    a string of `src/`; or
 * 6. it, or a helper most journeys do not import, names a hook that a
 *    edited region under `src/renderer/` draws, even when the change adds or
 *    removes none: the region owns what that hook shows. A hub hook, one more
 *    than `JOURNEY_SELECTION_CAP` journeys read, does not select this way; or
 * 7. it, or a helper most journeys do not import, calls a
 *    `window.infinitary` method, or names a read, whose message between the
 *    window and the core the change edits (./window-messages.ts); or
 * 8. its changed path matches a targeted fallback row below, even when no
 *    hook, symbol or sentence changed; or
 * 9. a commit of the change names it in a `Journeys:` trailer: the author
 *    knows the change reaches it where no rule above reads that reach; or
 * 10. it, or a helper most journeys do not import, reads words a string of
 *    `src/` serves, and the change alters what it reads: a pattern of its
 *    own with a word of four or more letters matches differently, or a tool
 *    its stand-in scripts by name (one most journeys do not script) appears
 *    a different number of times. Only strings of two or more words count;
 * 11. it is the freeze journey and the change edits the freeze recorder or
 *    the main process's own start and clock, other than a unit test
 *    (`FREEZE_JOURNEY`).
 * 12. it directly imports a changed product module, even with unchanged names,
 *     or a product module that imports a changed data file, such as a
 *     runbook's JSON, which is part of that module's text (INF-2426). A hub
 *     module, one more than `JOURNEY_SELECTION_CAP` journeys import directly,
 *     does not select by import alone: its readers still follow rules 3 to 10,
 *     and main's full run catches the rest (INF-2486, cut C);
 * 13. it imports a helper declaring `@journey-area src/path/` for a changed area,
 *     other than a unit test there, which no journey runs (INF-2486, cut B).
 *     The journey imports that stand-in directly, not only through the shared launcher.
 *
 * A fragment inside a longer quote, a hook name inside a longer token, and a
 * sentence held only by the stand-in do not select every journey that reaches
 * that file. A change no journey or helper it imports reaches runs no
 * journey. The release's full Mac check is `verify.yml` and is not this
 * selection.
 */

/** INF-2394 measure 2: the captain approved 40 as the short-list/sweep split. */
export const JOURNEY_SELECTION_CAP = 40;

/** Typed coverage declarations on stand-ins; paths are exact files or directory prefixes. */
export function standInAreas(source: string): string[] {
  return [...source.matchAll(/^\s*\*?\s*@journey-area (src\/[\w./-]+)\s*$/gm)].map((match) => match[1] ?? "");
}

/** Record the entire selection against files from successful runs, never a chosen subset. */
export function selectionCoverage(listed: readonly string[], ran: readonly string[], all: readonly string[]) {
  const selected = [...new Set(listed)].sort();
  const executed = [...new Set(ran)].sort();
  const required = selected.length > JOURNEY_SELECTION_CAP ? [...new Set(all)].sort() : selected;
  return {
    route: selected.length > JOURNEY_SELECTION_CAP ? "linux-sweep" : "selected",
    listed: selected,
    run: executed,
    missing: required.filter((file) => !executed.includes(file)),
  };
}

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const E2E = "tests/e2e";

/** A module of the product, as opposed to the test code a journey runs. */
const isSource = (file: string) => file.startsWith("src/");

export type Reasons = Map<string, string[]>;

// These narrow fallbacks cover breaks that do not change a hook or copied
// words. Union them with the existing selection, never replace it.
const FALLBACKS = [
  { paths: ["src/shared/cardLeave.ts", "src/shared/cards.ts", "src/core/orchestrator/cardService.ts", "src/core/orchestrator/crewSupervisor.ts", "src/renderer/src/design/cards/"], specs: ["card-leave.spec.ts"] },
  {
    paths: ["src/renderer/src/cards/", "src/renderer/src/app/HomeScreen.tsx"],
    specs: ["keyboard-routing.spec.ts", "stage-reveals.spec.ts", "card-leave.spec.ts"],
  },
  {
    paths: ["src/renderer/src/app/focusRecovery.ts", "src/renderer/src/plugins/frames/frameFocus.ts"],
    specs: ["frame-focus.spec.ts", "focus-recovery.spec.ts", "card-task-keys.spec.ts"],
  },
  { paths: ["src/core/devices/"], specs: ["devices.spec.ts"] },
  {
    // The Mac journey drives this controller and shared store, even when no drawn hook changes.
    paths: [
      "src/core/update/macUpdates.ts",
      "src/core/update/macInstallation.ts",
      "src/core/update/updateChecker.ts",
      "src/renderer/src/app/updateState.ts",
    ],
    specs: ["mac-updates.spec.ts"],
  },
  {
    paths: ["tests/fixtures/installed-updates/runningWork.ts"],
    specs: ["installed-update-work.spec.ts"],
  },
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

/**
 * The freeze journey (INF-2061's plan; docs/freeze-recorder.md, "Before a
 * change merges"): the recorder and the main process's own start and clock
 * can hold its main thread with no hook, symbol or words changing, so a
 * change to them runs the journey. Any other main-process change runs it
 * through the rules above, and main's full run runs it on every push
 * (INF-2486, cut E). Paths ending in `/` are folders.
 */
export const FREEZE_JOURNEY = {
  paths: [
    "src/core/freeze/",
    "src/main/index.ts",
    "src/main/app.ts",
    "src/core/orchestrator/ticker.ts",
  ],
  spec: `${E2E}/main-thread-freeze.spec.ts`,
} as const;

/** A unit test beside the product, which no journey runs. */
const isUnitTest = (file: string) => /\.test\.tsx?$/.test(file);

/** Why the change runs the freeze journey, or undefined when it touches none of its paths. */
export function freezeJourneyReason(changed: readonly string[]): string | undefined {
  const reaches = changed.filter(
    (file) =>
      FREEZE_JOURNEY.paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)) &&
      !isUnitTest(file),
  );
  if (reaches.length === 0) return undefined;
  const named = reaches.slice(0, 3).join(", ");
  return `edits the freeze recorder or the main process's start or clock: ${named}${reaches.length > 3 ? ` and ${reaches.length - 3} more` : ""}`;
}

/**
 * The journeys the change's commits name in their `Journeys:` trailers, as
 * `git log --format=%(trailers:key=Journeys,valueonly)` prints them. A name
 * is a spec's file name with or without `.spec.ts`, or its path.
 */
export function declaredJourneys(trailers: string): string[] {
  const named = trailers
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((name) => {
      const file = name.replace(/^(?:\.\/)?(?:tests\/e2e\/)?/, "");
      return `${E2E}/${file.endsWith(".spec.ts") ? file : `${file}.spec.ts`}`;
    });
  return [...new Set(named)];
}

/** Relative imports and re-exports of a TypeScript file, resolved to repository paths. */
export function importsOf(
  file: string,
  source: string,
  exists: (file: string) => boolean = (candidate) => existsSync(join(ROOT, candidate)),
): string[] {
  const found: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  for (const [, specifier] of source.matchAll(pattern)) {
    if (!specifier || !(specifier.startsWith(".") || (specifier.startsWith("@shared/") || specifier.startsWith("@core/")))) continue;
    const base = specifier.startsWith("@shared/")
      ? join("src/shared", specifier.slice("@shared/".length))
      : specifier.startsWith("@core/")
        ? join("src/core", specifier.slice("@core/".length))
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

/**
 * The data files a module imports by relative path, such as a runbook's JSON or
 * a stylesheet read as text; a bundler query such as `?raw` is not part of it.
 */
export function dataImportsOf(file: string, source: string): string[] {
  const found: string[] = [];
  for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const path = specifier?.replace(/\?.*$/, "") ?? "";
    if (path.startsWith(".") && extname(path) && !/\.[cm]?[jt]sx?$/.test(path))
      found.push(normalize(join(dirname(file), path)));
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
 * The quoted strings of two or more words each source file's diff adds and
 * removes, keyed by file: the served words a stand-in reads by pattern or by
 * a tool's name (`readsServedWords`). App unit tests serve nothing.
 */
export function servedStrings(diff: string): Map<string, { added: string[]; removed: string[] }> {
  const byFile = new Map<string, { added: string[]; removed: string[] }>();
  for (const part of diff.split(/^diff --git /m)) {
    const path = part.match(/a\/(\S+)/)?.[1];
    if (!path?.startsWith("src/") || /\.(?:test|spec)\.[^ /]+$/.test(path)) continue;
    const sides = { added: [] as string[], removed: [] as string[] };
    for (const line of part.split("\n")) {
      if (!/^[+-](?![+-])/.test(line)) continue;
      // A comment serves nothing.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line.slice(1))) continue;
      const into = line.startsWith("+") ? sides.added : sides.removed;
      for (const [, , text] of line.slice(1).matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g))
        // A single word is a value of the code, such as `"checked"`, not served words.
        if (/\S\s+\S/.test(text ?? "")) into.push(text ?? "");
    }
    if (sides.added.length || sides.removed.length) byFile.set(path, sides);
  }
  return byFile;
}

/**
 * The regular-expression literals a journey's text reads words with, each
 * holding a literal word of four or more letters: a pattern with none, such
 * as `/(\S+)/`, matches any words and names no change.
 */
export function patternsIn(text: string): RegExp[] {
  const found: RegExp[] = [];
  for (const [, body, flags] of text.matchAll(
    /(?<=[(=,:!&|?]\s*)\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])*)\/([dgimsuy]*)/g,
  )) {
    const literal = (body ?? "").replace(/\\./g, " ").replace(/\[[^\]]*\]/g, " ");
    if (!/[A-Za-z]{4,}/.test(literal)) continue;
    try {
      found.push(new RegExp(body ?? "", (flags ?? "").replace(/[gy]/g, "")));
    } catch {
      // Not a pattern, such as a division that looks like one.
    }
  }
  return found;
}

/** The tools a stand-in scripts by name, as `name: "check_change"`. */
export function scriptedTools(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/\bname:\s*["']([a-z]+(?:_[a-z]+)+)["']/g)].map(([, tool]) => tool ?? ""),
  );
}

/**
 * Whether the words a reader takes from a file's served strings differ
 * between the two sides: the same match on both sides is moved, not changed.
 */
function readsDifferently(
  sides: { added: string[]; removed: string[] },
  reader: (text: string) => string[],
): string | undefined {
  const count = (strings: string[]) => {
    const seen = new Map<string, number>();
    for (const text of strings) for (const word of reader(text)) seen.set(word, (seen.get(word) ?? 0) + 1);
    return seen;
  };
  const added = count(sides.added);
  const removed = count(sides.removed);
  for (const [word, times] of added) if (removed.get(word) !== times) return word;
  for (const [word, times] of removed) if (added.get(word) !== times) return word;
  return undefined;
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

/** Every `data-*` hook an edited screen region draws, before or after the change. */
export function ownedHooks(
  changed: readonly string[],
  read: (file: string) => string | undefined,
  readBefore?: (file: string) => string | undefined,
  sourceDiff = "",
): Map<string, Set<string>> {
  const owned = new Map<string, Set<string>>();
  for (const file of changed) {
    // A unit test beside the screen draws nothing a person sees.
    if (!file.startsWith("src/renderer/") || /\.(?:test|spec)\.[^/]+$/.test(file)) continue;
    const hooks = new Set<string>();
    for (const side of ["before", "after"] as const) {
      const text = (side === "before" ? readBefore?.(file) : read(file)) ?? "";
      const ranges = screenRanges(sourceDiff, file, side);
      // With no hunk/source (including callers supplying only paths), retain
      // whole-file coverage. A deleted owner still contributes its old hooks.
      const region = ranges.length ? editedScreenText(file, text, ranges) : text;
      for (const [hook] of region.matchAll(/(?<![A-Za-z0-9-])data-[a-z][a-z0-9-]*/g))
        hooks.add(hook);
    }
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
  /** The journeys the change's commits declare they reach (`declaredJourneys`). */
  declared?: readonly string[];
};

export function select({
  changed,
  sourceDiff,
  specs,
  read,
  readBefore,
  declared = [],
}: Change): Reasons {
  const changedSet = new Set(changed);
  const { hooks, sentences } = tokensOfDiff(sourceDiff);
  const owned = ownedHooks(changed, read, readBefore, sourceDiff);
  const symbols = symbolsOfDiff(sourceDiff);
  const served = servedStrings(sourceDiff);
  const messages = readBefore
    ? changedMessages(changed, read, readBefore)
    : { methods: new Map<string, string>(), reads: new Map<string, string>() };
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
  const directOf = new Map<string, string[]>();
  const readerCount = new Map<string, number>();
  for (const spec of specs) {
    const reach = closureOf(spec, availableRead, importCache);
    reachOf.set(spec, reach);
    for (const file of reach) {
      if (file.startsWith(`${E2E}/`) && file !== spec)
        reachCount.set(file, (reachCount.get(file) ?? 0) + 1);
    }
    const direct = importsOf(spec, read(spec) ?? "", (path) => read(path) !== undefined || readBefore?.(path) !== undefined);
    directOf.set(spec, direct);
    for (const file of new Set(direct)) readerCount.set(file, (readerCount.get(file) ?? 0) + 1);
  }
  // INF-2486, cut C: a product module more journeys import than the cap
  // would make a sweep of any edit to it by import alone.
  const hub = (file: string) => (readerCount.get(file) ?? 0) > JOURNEY_SELECTION_CAP;
  // A helper most journeys import is the stand-in class: a phrase or a symbol
  // found only there does not select those journeys. An edit to the helper
  // itself still does, below.
  const wide = (file: string) => (reachCount.get(file) ?? 0) > specs.length / 2;
  // A word most journeys already use does not name this change.
  const narrowTexts = new Map<string, string>();
  const narrowOf = (spec: string) => {
    let text = narrowTexts.get(spec);
    if (text === undefined) {
      text = (reachOf.get(spec) ?? [])
        .filter((file) => file.startsWith(`${E2E}/`) && (file === spec || !wide(file)))
        .map((file) => read(file) ?? "")
        .join("\n");
      narrowTexts.set(spec, text);
    }
    return text;
  };
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
  // INF-2486, cut C: a hook more journeys read than the cap, drawn by an
  // edited region, would make a sweep of any edit there.
  const hookReaders = new Map<string, number>();
  for (const hook of new Set([...owned.values()].flatMap((drawn) => [...drawn])))
    hookReaders.set(hook, specs.filter((spec) => holdsHook(narrowOf(spec), hook)).length);
  // A tool most journeys script names no change to the one that reads it.
  const toolUsers = new Map<string, number>();
  if (served.size > 0)
    for (const spec of specs)
      for (const tool of scriptedTools(narrowOf(spec))) toolUsers.set(tool, (toolUsers.get(tool) ?? 0) + 1);
  const reasons: Reasons = new Map();
  const add = (spec: string, why: string) => {
    const list = reasons.get(spec) ?? [];
    if (list.length < 3 && !list.includes(why)) list.push(why);
    reasons.set(spec, list);
  };
  for (const spec of specs) {
    if (changedSet.has(spec)) add(spec, "the change edits this journey");
    const reach = reachOf.get(spec) ?? [];
    for (const file of directOf.get(spec) ?? []) {
      if (!isSource(file) || hub(file)) continue;
      if (changedSet.has(file)) add(spec, `directly imports ${file}, which the change edits`);
      const data = dataImportsOf(file, read(file) ?? "").find((path) => changedSet.has(path));
      if (data) add(spec, `directly imports ${file}, which imports ${data}, which the change edits`);
    }
    for (const helper of importsOf(spec, read(spec) ?? "", (path) => read(path) !== undefined).filter((file) => !isSource(file))) {
      for (const area of standInAreas(read(helper) ?? "")) {
        const hit = changed.find(
          (file) => !isUnitTest(file) && (area.endsWith("/") ? file.startsWith(area) : file === area),
        );
        if (hit) add(spec, `imports stand-in ${helper} for ${area}, which the change edits (${hit})`);
      }
    }
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
    if (served.size > 0) {
      const patterns = patternsIn(narrowText);
      const tools = [...scriptedTools(narrowText)].filter(
        (tool) => (toolUsers.get(tool) ?? 0) <= specs.length / 2,
      );
      for (const [file, sides] of served) {
        for (const pattern of patterns) {
          const global = new RegExp(pattern.source, `${pattern.flags}g`);
          const word = readsDifferently(sides, (text) => [...text.matchAll(global)].map(([match]) => match));
          if (word !== undefined)
            add(spec, `reads "${word}" with ${pattern}, words ${file} serves that the change adds or removes`);
        }
        for (const tool of tools) {
          const word = readsDifferently(sides, (text) =>
            [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_])${tool}(?![A-Za-z0-9_])`, "g"))].map(
              ([match]) => match,
            ),
          );
          if (word !== undefined) add(spec, `scripts ${tool}, which words ${file} serves add or remove`);
        }
      }
    }
    for (const [file, drawn] of owned) {
      // Only a hook the journey's own text mentions can be one it reads.
      const reads = [...drawn].find(
        (hook) =>
          (hookReaders.get(hook) ?? 0) <= JOURNEY_SELECTION_CAP &&
          narrowText.includes(hook) &&
          holdsHook(narrowText, hook),
      );
      if (reads) add(spec, `reads ${reads}, which ${file} draws`);
    }
    for (const [method, channel] of messages.methods)
      if (callsMethod(narrowText, method))
        add(
          spec,
          channel
            ? `calls window.infinitary.${method}, whose message ${channel} the change edits`
            : `calls window.infinitary.${method}, which the change edits in ${PRELOAD}`,
        );
    for (const [name, channel] of messages.reads)
      if (holdsPhrase(narrowText, name))
        add(spec, `reads ${name}, whose message ${channel} the change edits`);
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
  for (const spec of declared) {
    // A misspelt name would silently run nothing the author promised.
    if (!available.has(spec))
      throw new Error(`A commit's Journeys: trailer names ${spec}, which is not a journey`);
    reasons.set(spec, [...(reasons.get(spec) ?? []), "the change's commits declare it reaches this journey"]);
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
  const declared = declaredJourneys(
    git(["log", "--format=%(trailers:key=Journeys,valueonly)", `${base}..${head}`]),
  );
  const reasons = select({ changed, sourceDiff, specs, read, readBefore, declared });
  const freeze = freezeJourneyReason(changed);
  if (freeze) reasons.set(FREEZE_JOURNEY.spec, [...(reasons.get(FREEZE_JOURNEY.spec) ?? []), freeze]);
  return reasons;
}

/**
 * The journeys a request on a branch names (docs/testing.md, "Journeys on
 * request"), read as a trailer's names are. A name that is no journey
 * refuses rather than silently running nothing for it.
 */
export function named(list: string): Reasons {
  const specs = new Set(readdirSync(join(ROOT, E2E)).map((file) => `${E2E}/${file}`));
  const requested = declaredJourneys(list);
  if (requested.length === 0) throw new Error("Name at least one journey to run");
  const reasons: Reasons = new Map();
  for (const spec of requested) {
    if (!specs.has(spec)) throw new Error(`The request names ${spec}, which is not a journey`);
    reasons.set(spec, ["requested by name"]);
  }
  return reasons;
}

function main(): void {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
  };
  const reasons = args.includes("--named")
    ? named(value("--named", ""))
    : affected(value("--base", "origin/main"), value("--head", "HEAD"));
  const files = [...reasons.keys()].sort();
  if (args.includes("--plan") || args.includes("--ran")) {
    const ran = args.includes("--ran") ? declaredJourneys(value("--ran", "")) : [];
    const coverage = selectionCoverage(files, ran, readdirSync(join(ROOT, E2E)).filter((file) => file.endsWith(".spec.ts")).map((file) => `${E2E}/${file}`));
    console.log(JSON.stringify({ base: value("--base", "origin/main"), head: git(["rev-parse", value("--head", "HEAD")]).trim(), ...coverage }, null, 2));
    if (args.includes("--ran") && coverage.missing.length) process.exitCode = 1;
  } else if (args.includes("--json"))
    console.log(JSON.stringify(Object.fromEntries(files.map((file) => [file, reasons.get(file)])), null, 2));
  else for (const file of files) console.log(relative(".", file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
