import { join, resolve } from "node:path";
import { build } from "vite";
import { buildLoadSupervisor } from "../../scripts/build-load-supervisor";
import { scratchDir } from "./scratchDirs";

/**
 * The command process's entry (src/core/axi/axiProcess.ts) built the way
 * the app builds it - one file, its imports inlined - so a test forks the
 * real thing with plain Node, as `sqlProcessBundle` does for the query
 * process.
 */
export async function bundleAxiProcess(): Promise<string> {
  buildLoadSupervisor();
  const root = resolve(__dirname, "../..");
  const outDir = scratchDir("infinitary-axi-process-");
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
      ssr: resolve(root, "src/core/axi/axiProcess.ts"),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "node24",
      rollupOptions: { output: { format: "es", entryFileNames: "axiProcess.mjs" } },
    },
  });
  return join(outDir, "axiProcess.mjs");
}
