import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { constants, enableCompileCache, flushCompileCache } from "node:module";
import { join } from "node:path";

/** The data folder's folder for compiled code (docs/architecture.md, "Loading the main code"). */
export const COMPILE_CACHE_FOLDER = "compile-cache";

/**
 * Turns on Node's compile cache before the app's own code loads, so a start
 * reads that code already compiled instead of compiling it again: the first
 * start of a build writes it, and every later one reads it. It lives in the
 * data folder, one folder per build, since a new build's files are new and
 * its predecessor's entries would only pile up.
 *
 * The data folder is never made here: on the first start, before the app
 * has checked and claimed it, nothing is cached. Returns the step to take
 * once the code has loaded - write what was compiled and remove other
 * builds' folders - or null when the cache is not on.
 */
export function startCompileCache(dataDir: string, build: string): (() => void) | null {
  if (!existsSync(dataDir)) return null;
  const root = join(dataDir, COMPILE_CACHE_FOLDER);
  const result = enableCompileCache(join(root, build));
  // Already on (NODE_COMPILE_CACHE chose its own folder), turned off by
  // NODE_DISABLE_COMPILE_CACHE, or unwritable: the app starts as it would
  // without one.
  if (result.status !== constants.compileCacheStatus.ENABLED) return null;
  return () => {
    flushCompileCache();
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (name !== build)
        void rm(join(root, name), { recursive: true, force: true }).catch(() => {});
    }
  };
}

/**
 * The build a cache folder belongs to: the app's version and the main entry
 * file's size and time, so a development rebuild under the same version gets
 * a folder of its own too.
 */
export function compileCacheBuild(
  version: string,
  entry: { size: number; mtimeMs: number },
): string {
  return `${version}-${entry.size}-${Math.trunc(entry.mtimeMs)}`.replace(/[^\w.-]/g, "_");
}
