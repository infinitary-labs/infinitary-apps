import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { scratchDir } from "./scratchDirs";

/**
 * The query process's entry (src/core/sql/sqlProcess.ts) built the way the
 * app builds it - one file, its imports inlined - so a test forks the real
 * thing with plain Node. The app's own build makes it an electron-vite entry
 * beside `keychainProcessMain`; a test cannot fork the TypeScript source,
 * because Node's type stripping does not resolve the `@shared` aliases.
 */
export async function bundleSqlProcess(): Promise<string> {
  // Read from this file's own address, so a vitest file and the phone test home's module runner both find the root.
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const outDir = scratchDir("infinitary-sql-process-");
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    resolve: {
      alias: {
        "@core": resolve(root, "src/core"),
        "@shared": resolve(root, "src/shared"),
      },
    },
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: resolve(root, "src/core/sql/sqlProcess.ts"),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "node24",
      rollupOptions: { output: { format: "es", entryFileNames: "sqlProcess.mjs" } },
    },
  });
  return join(outDir, "sqlProcess.mjs");
}
