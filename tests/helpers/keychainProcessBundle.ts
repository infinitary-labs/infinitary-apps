import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { build } from "vite";
import { scratchDir } from "./scratchDirs";

/** Bundle the real process protocol with a scratch reader; no production test switch. */
export async function bundleKeychainProcess(readerSource: string): Promise<string> {
  const root = resolve(import.meta.dirname, "../..");
  const outDir = scratchDir("infinitary-keychain-process-");
  const entry = join(outDir, "entry.ts");
  writeFileSync(
    entry,
    `import { serveKeychainRequest } from ${JSON.stringify(join(root, "src/main/host/keychainProcessRuntime.ts"))};\n${readerSource}\nvoid serveKeychainRequest(reader, typeof readStatus === "function" ? readStatus : undefined);\n`,
  );
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    resolve: {
      alias: {
        "@core": join(root, "src/core"),
        "@shared": join(root, "src/shared"),
        "@keychain": join(root, "src/main/host/darwinKeychain.ts"),
        "@keychainCommand": join(root, "src/main/host/keychainCommand.ts"),
      },
    },
    ssr: { noExternal: true, external: ["koffi"], target: "node" },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "node24",
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "reader.cjs",
          paths: { koffi: createRequire(import.meta.url).resolve("koffi") },
        },
      },
    },
  });
  return join(outDir, "reader.cjs");
}

/** Every native query is pinned to this disposable store, never the real search list. */
export const scratchKeychainReaderSource = `
import { createDarwinKeychain, openDarwinKeychainApiForTest } from "@keychain";
const api = openDarwinKeychainApiForTest(process.env.TEST_KEYCHAIN_PATH);
const reader = createDarwinKeychain(api, async (path) => api.unlockKeychain(path));
const readStatus = (path) => api.keychainStatus(path);
`;
