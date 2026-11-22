// Lets a child process a test starts load the app's own source files as they are, with Node's
// own TypeScript support (`--experimental-transform-types`): an import with no extension finds its
// `.ts` file, and `@core/` and `@shared/` find their folders under `src/`, as the build resolves
// them. Only tests pass this preload; the app never does.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const ALIASES = { "@core/": "core", "@shared/": "shared" };

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;
    for (const [alias, folder] of Object.entries(ALIASES))
      if (specifier.startsWith(alias)) base = join(SRC, folder, specifier.slice(alias.length));
    if (
      base === null &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:")
    )
      base = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
    if (base !== null && !/\.[cm]?[jt]sx?$/.test(base))
      for (const candidate of [`${base}.ts`, join(base, "index.ts")])
        if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
    return nextResolve(specifier, context);
  },
});
