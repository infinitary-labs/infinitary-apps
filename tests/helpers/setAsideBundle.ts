import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { scratchDir } from "./scratchDirs";

/**
 * The process a file is set aside in (src/core/files/setAsideProcess.ts)
 * built the way the app builds it - one file, its imports inlined - so a
 * test forks the real thing with plain Node, as `sqlProcessBundle` does for
 * the query process; and beside it `recordHolder`, the app's own process as
 * the files command runs in it (tests/helpers/recordHolder.ts). SQLite's
 * native module stays where it is installed: each names it by its full path.
 */
export async function bundleSetAside(): Promise<{ setAsideProcess: string; recordHolder: string }> {
  const root = resolve(__dirname, "../..");
  const outDir = scratchDir("infinitary-set-aside-");
  const sqlite = pathToFileURL(
    createRequire(join(root, "package.json")).resolve("better-sqlite3"),
  ).href;
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
      ssr: true,
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "node24",
      rollupOptions: {
        input: {
          setAsideProcess: resolve(root, "src/core/files/setAsideProcess.ts"),
          recordHolder: resolve(root, "tests/helpers/recordHolder.ts"),
        },
        external: ["better-sqlite3"],
        output: {
          format: "es",
          entryFileNames: "[name].mjs",
          paths: { "better-sqlite3": sqlite },
        },
      },
    },
  });
  return {
    setAsideProcess: join(outDir, "setAsideProcess.mjs"),
    recordHolder: join(outDir, "recordHolder.mjs"),
  };
}
