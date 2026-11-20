import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

// Use the updater's own YAML parser and the configuration packaged beside it.
const require = createRequire(import.meta.url);
const { load } = createRequire(require.resolve("electron-updater/package.json"))("js-yaml") as {
  load: (text: string) => unknown;
};

/**
 * After the app stops, make the next scenario download its artifact again.
 * Library/Caches is shared with macOS and native helpers: stopping the app's
 * main process does not give this probe ownership of that entire directory.
 */
export function resetMacDownloadCache(home: string, configPath: string): void {
  const config = load(readFileSync(configPath, "utf8"));
  assert(config && typeof config === "object" && "updaterCacheDirName" in config);
  const name = config.updaterCacheDirName;
  assert(
    typeof name === "string" &&
      name.length > 0 &&
      name !== "." &&
      name !== ".." &&
      basename(name) === name,
    "The updater cache must name one directory inside Library/Caches",
  );
  rmSync(join(home, "Library/Caches", name), { recursive: true, force: true });
}
