import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Plugin } from "vite";

/**
 * The packages the main build bundles into its own chunks instead of leaving
 * them for Node to load file by file at start (docs/architecture.md, "Loading
 * the main code"). Each brings hundreds of small files the app reads before
 * its window or first mate can start, and one bundled chunk loads in a
 * fraction of the time. Their own dependencies come along, except a package
 * the app itself depends on, which stays one shared copy outside.
 *
 * `@earendil-works/pi-ai` stays outside: it loads its Bedrock and sign-in
 * code through a specifier held in a variable, which a bundle cannot follow.
 * The Claude client package and the TypeScript compiler are already one file
 * each, so bundling them would save nothing.
 */
export const BUNDLED_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/client",
  "typebox",
] as const;

/**
 * A bundled module that still names its own place in a way the plugin cannot
 * carry, each read and found harmless, with why. A new one fails the build
 * until it is read and listed here.
 */
export const UNCARRIED_PLACES: Readonly<Record<string, string>> = {
  // Loading Pi extensions: the app hands Pi no extension, ever
  // (src/core/pi/piResourceLoader.ts), so none of these paths runs.
  "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js":
    "import.meta.resolve and require.resolve only while loading a Pi extension",
  "jiti/lib/jiti.mjs": "Pi's extension loader's compiler: imports what an extension names",
  "jiti/lib/jiti-static.mjs": "Pi's extension loader's compiler: imports what an extension names",
  "jiti/dist/jiti.cjs": "Pi's extension loader's compiler: imports what an extension names",
  "jiti/dist/babel.cjs": "Pi's extension loader's compiler: imports what an extension names",
};

export const LOCATED_VIRTUAL_ID = "\0inf-located";

/**
 * The runtime half: a bundled module asks where its own file is shipped. The
 * answer walks Node's own lookup from the chunk, one package at a time along
 * the chain the build recorded, so it finds the same files in a development
 * checkout's linked folders and in a packaged app's flat ones.
 */
export const LOCATED_RUNTIME = `
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const roots = new Map();
function lookup(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(name + " is not installed where " + from + " can reach it");
  }
}
function root(chain) {
  const key = chain.join("\\0");
  let dir = roots.get(key);
  if (dir === undefined) {
    dir = here;
    for (const name of chain) dir = lookup(dir, name);
    roots.set(key, dir);
  }
  return dir;
}
export function path(chain, inside) { return join(root(chain), inside); }
export function dir(chain, inside) { return dirname(path(chain, inside)); }
export function url(chain, inside) { return pathToFileURL(path(chain, inside)).href; }
// What a CommonJS module's require() of this module receives.
export default { path, dir, url };
`;

type PackageJson = {
  name?: string;
  version?: string;
  type?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readJson(file: string): PackageJson {
  return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
}

/** Node's lookup of a package by name from a folder, to its real folder. */
export function lookupPackage(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/** The installed package a file belongs to: its real folder, name and the file's path inside it. */
export function packageOf(file: string): { root: string; name: string; inside: string } | null {
  const marker = `${sep}node_modules${sep}`;
  const at = file.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = file.slice(at + marker.length).split(sep);
  const parts = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  const root = file.slice(0, at + marker.length) + parts.join(sep);
  return {
    root,
    name: parts.join("/"),
    inside: relative(root, file).split(sep).join("/"),
  };
}

/**
 * The names Node walks from the app's folder to reach a package's real
 * folder: each from the one before it, through production dependencies only,
 * since a packaged app carries no others. Breadth first, so the shortest.
 */
export function packageChain(appRoot: string, target: string): string[] | null {
  const want = realpathSync(target);
  const seen = new Set<string>();
  let level: { dir: string; chain: string[] }[] = [{ dir: appRoot, chain: [] }];
  while (level.length > 0) {
    const next: typeof level = [];
    for (const { dir, chain } of level) {
      const json = readJson(join(dir, "package.json"));
      const names = new Set([
        ...Object.keys(json.dependencies ?? {}),
        ...Object.keys(json.optionalDependencies ?? {}),
        ...Object.keys(json.peerDependencies ?? {}),
      ]);
      for (const name of names) {
        const found = lookupPackage(dir, name);
        if (!found || seen.has(found)) continue;
        seen.add(found);
        const reached = [...chain, name];
        if (found === want) return reached;
        next.push({ dir: found, chain: reached });
      }
    }
    level = next;
  }
  return null;
}

/** Whether a bundled file is CommonJS, by its extension or its package's type. */
function isCommonJs(file: string, root: string): boolean {
  if (file.endsWith(".cjs")) return true;
  if (file.endsWith(".mjs")) return false;
  for (let dir = dirname(file); dir.startsWith(root); dir = dirname(dir)) {
    const json = join(dir, "package.json");
    if (existsSync(json)) return readJson(json).type !== "module";
    if (dir === root) break;
  }
  return true;
}

const PLACE_WORDS = /import\.meta\.(?:url|dirname|filename)\b/g;
const FREE_DIRNAME = /(?<![\w$.])__dirname(?![\w$])/g;
const FREE_FILENAME = /(?<![\w$.])__filename(?![\w$])/g;
// What the plugin cannot carry: a lookup from the chunk's place, or an
// import whose specifier is not written out.
const UNCARRIED = /import\.meta\.resolve\b|require\.resolve\b|\bimport\(\s*(?!["'`])/;

/**
 * Rewrites one bundled module so every name of its own place - its URL,
 * folder or file - names where the original file is shipped instead of the
 * chunk it was bundled into. Returns null when the module names no place.
 */
export function carryPlace(
  code: string,
  chain: string[],
  inside: string,
  commonJs: boolean,
): string | null {
  const names = PLACE_WORDS.test(code) || (commonJs && /__dirname|__filename/.test(code));
  PLACE_WORDS.lastIndex = 0;
  if (!names) return null;
  const at = `${JSON.stringify(chain)}, ${JSON.stringify(inside)}`;
  if (commonJs) {
    const head =
      `var __infLocated = require(${JSON.stringify(LOCATED_VIRTUAL_ID)});` +
      `var __infFilename = __infLocated.path(${at}), __infDirname = __infLocated.dir(${at});`;
    return (
      head +
      code
        .replace(FREE_DIRNAME, "__infDirname")
        .replace(FREE_FILENAME, "__infFilename")
        .replace(/import\.meta\.url\b/g, `__infLocated.url(${at})`)
    );
  }
  return (
    `import * as __infLocated from ${JSON.stringify(LOCATED_VIRTUAL_ID)};` +
    code
      .replace(/import\.meta\.url\b/g, `__infLocated.url(${at})`)
      .replace(/import\.meta\.dirname\b/g, `__infLocated.dir(${at})`)
      .replace(/import\.meta\.filename\b/g, `__infLocated.path(${at})`)
  );
}

/**
 * The main build's plugin for bundled packages. It keeps every bundled file
 * finding its own neighbours - a package's own folder, a wasm file, a worker
 * script, a native module - where the package is shipped, and fails the
 * build on anything it cannot carry or on a shared package a bundled one
 * would reach at another version.
 */
export function bundledPackagesPlugin(appRoot: string): Plugin {
  // A module outside the app's production dependencies (a development
  // package the build already bundled) is left exactly as it was.
  const chains = new Map<string, string[] | null>();
  const chainOf = (root: string): string[] | null => {
    if (!chains.has(root)) chains.set(root, packageChain(appRoot, root));
    return chains.get(root) ?? null;
  };
  const appJson = readJson(join(appRoot, "package.json"));
  const shared = new Set(Object.keys(appJson.dependencies ?? {}));
  return {
    name: "inf-bundled-packages",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === LOCATED_VIRTUAL_ID) return source;
      if (!importer || source.startsWith(".") || source.startsWith("\0")) return null;
      const from = packageOf(importer);
      if (!from) return null;
      const name = source.startsWith("@")
        ? source.split("/").slice(0, 2).join("/")
        : (source.split("/")[0] ?? source);
      // A dependency the app shares stays one copy outside the bundle, loaded
      // from the app's folder: it must be the version the bundled package was
      // built against.
      if (!shared.has(name) || BUNDLED_PACKAGES.some((bundled) => bundled === name)) return null;
      const theirs = lookupPackage(from.root, name);
      const ours = lookupPackage(appRoot, name);
      if (!theirs || !ours) return null;
      const theirVersion = readJson(join(theirs, "package.json")).version;
      const ourVersion = readJson(join(ours, "package.json")).version;
      if (theirVersion !== ourVersion) {
        this.error(
          `${from.name} is bundled but needs ${name} ${theirVersion}, and the app shares ${ourVersion}: bundle it, or keep ${from.name} outside`,
        );
      }
      return null;
    },
    load(id) {
      return id === LOCATED_VIRTUAL_ID ? LOCATED_RUNTIME : null;
    },
    transform(code, id) {
      if (id.startsWith("\0")) return null;
      const file = id.split("?")[0] ?? id;
      const where = packageOf(file);
      if (!where) return null;
      const chain = chainOf(where.root);
      if (!chain) return null;
      const key = `${where.name}/${where.inside}`;
      if (UNCARRIED.test(code) && !(key in UNCARRIED_PLACES)) {
        this.error(
          `${key} looks itself up in a way a bundle cannot carry; read it and list it in UNCARRIED_PLACES, or keep its package outside`,
        );
      }
      return carryPlace(code, chain, where.inside, isCommonJs(file, where.root));
    },
  };
}
