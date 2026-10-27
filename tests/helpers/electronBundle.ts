import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { build } from "vite";
import { scratchDir } from "./scratchDirs";

const root = resolve(__dirname, "../..");

/**
 * The Electron binary the app runs on; its package names it, and core
 * imports no electron.
 */
export function electronBinary(): string {
  return join(
    root,
    "node_modules/electron/dist",
    readFileSync(join(root, "node_modules/electron/path.txt"), "utf8"),
  );
}

/**
 * Builds a test entry into one file, its imports inlined, and returns a
 * runner that starts it inside Electron as plain Node (`ELECTRON_RUN_AS_NODE`),
 * where Electron's own file reads show an `.asar` file as a folder.
 */
export async function bundleForElectron(
  entry: string,
): Promise<(...args: string[]) => SpawnSyncReturns<string>> {
  const outDir = scratchDir("infinitary-electron-bundle-");
  const name = `${basename(entry, ".ts")}.mjs`;
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    resolve: {
      alias: { "@core": resolve(root, "src/core"), "@shared": resolve(root, "src/shared") },
    },
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: resolve(root, entry),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "node24",
      rollupOptions: { output: { format: "es", entryFileNames: name } },
    },
  });
  return (...args) =>
    spawnSync(electronBinary(), [join(outDir, name), ...args], {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
}
