import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { scratchDir } from "./scratchDirs";

/** The real record reader entry, bundled as shipped, with the installed SQLite module. */
export async function bundleRecordProcess(): Promise<string> {
  const root = resolve(__dirname, "../..");
  const outDir = scratchDir("infinitary-record-process-");
  const sqlite = pathToFileURL(
    createRequire(join(root, "package.json")).resolve("better-sqlite3"),
  ).href;
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    resolve: {
      alias: { "@core": resolve(root, "src/core"), "@shared": resolve(root, "src/shared") },
    },
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: resolve(root, "src/core/recordReads/recordProcess.ts"),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "node24",
      rollupOptions: {
        external: ["better-sqlite3"],
        output: {
          format: "es",
          entryFileNames: "recordProcess.mjs",
          paths: { "better-sqlite3": sqlite },
        },
      },
    },
  });
  return join(outDir, "recordProcess.mjs");
}
