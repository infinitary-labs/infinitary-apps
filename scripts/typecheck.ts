import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const native = require("tsrs/package.json") as { optionalDependencies: Record<string, string> };

/** INF-641: select by published platform, never by the result of a failed check. */
export function checkerPackage(platform: string = process.platform, arch: string = process.arch) {
  const prefix = `@tsrs/${platform}-${arch}`;
  return Object.keys(native.optionalDependencies).some(
    (name) => name === prefix || name.startsWith(`${prefix}-`),
  )
    ? "tsrs"
    : "@tsrs/wasm";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = checkerPackage();
  const manifestPath = require.resolve(`${name}/package.json`);
  const manifest = require(manifestPath) as { bin: Record<string, string> };
  const bin = manifest.bin[name === "tsrs" ? "tsrs" : "tsrs-wasm"];
  if (!bin) throw new Error(`${name} has no checker command`);
  // The root has no files: build mode must visit all referenced projects.
  process.argv.splice(2, 0, "-b");
  // Run the package's own launcher in this process. It owns exit codes/signals;
  // a missing binary, diagnostic or crash never selects a second checker.
  await import(pathToFileURL(join(dirname(manifestPath), bin)).href);
}
