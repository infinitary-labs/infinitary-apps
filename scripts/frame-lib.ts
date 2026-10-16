import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build, type Plugin, type Rollup, runnerImport } from "vite";
import { BUILTIN_FRAME_PANELS, builtinPanelDir } from "../src/shared/plugins/frameLib";

/**
 * The frame realm's library, built with the app (one plugin vehicle, Phase A
 * item 4; docs/ui-plugins.md "The frame realm"). A panel drawn in a
 * sandboxed frame - one the captain added from elsewhere, and the app's own
 * Tasks and Activity - loads React, the JSX runtime, the design library and
 * the runtime that builds `PanelProps` from `app-frame://lib/`, which the
 * shell answers from `out/frame-lib/`.
 *
 * `frameLibPlugin` runs in the MAIN build (electron.vite.config.ts): before
 * main is bundled it builds the lib, hashes every file it wrote, and hands
 * main those pins as the virtual module `virtual:fm-frame-lib`. So the pins
 * live in the main bundle - inside the integrity-checked archive in a
 * packaged app - and the shell serves a lib file only while its bytes still
 * match (src/main/frames/frameProtocol.ts), and every panel document carries
 * the same pins as its import map's `integrity`.
 *
 * The lib is one Rollup build with one entry per served module; shared code
 * (React above all) lands in chunks the entries import, so a panel and the
 * runtime use ONE React. It is a production build in dev too: nothing in it
 * is hot-reloaded, and a change to it needs the app restarted.
 *
 * The app's own panels are not entries of that build: each is an ordinary
 * panel folder (`src/panels/<id>/`, docs/ui-plugins.md "The app's own
 * panels are ordinary folders") that the PANEL COMPILER builds for the
 * frame realm, exactly as it builds a panel added from elsewhere - the same
 * allowlist, so the folder reaches nothing but React, `@infinitary/ui` and
 * its own files - and its output is copied into the lib under
 * `builtin/<id>/` and pinned with the rest.
 */

export const FRAME_LIB_VIRTUAL_ID = "virtual:fm-frame-lib";
const RESOLVED_VIRTUAL_ID = `\0${FRAME_LIB_VIRTUAL_ID}`;

/** Every file the lib serves, by the name the shell answers it at. */
const ENTRIES: Record<string, string> = {
  boot: "src/renderer/src/frameRealm/entries/boot.ts",
  react: "src/renderer/src/frameRealm/entries/react.ts",
  "jsx-runtime": "src/renderer/src/frameRealm/entries/jsx-runtime.ts",
  "jsx-dev-runtime": "src/renderer/src/frameRealm/entries/jsx-dev-runtime.ts",
  ui: "src/renderer/src/frameRealm/entries/ui.ts",
};

/** Where the app's own panel folders live, each named by its panel's id. */
export const APP_PANELS_DIR = "src/panels";

function sha256(text: string | Uint8Array): string {
  return `sha256-${createHash("sha256").update(text).digest("base64")}`;
}

/** Builds the lib into `outDir` and returns file -> pin for every file written. */
export async function buildFrameLib(root: string, outDir: string): Promise<Record<string, string>> {
  const output = await build({
    configFile: false,
    root,
    mode: "production",
    logLevel: "warn",
    publicDir: false,
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": resolve(root, "src/shared"),
      },
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      sourcemap: false,
      modulePreload: false,
      reportCompressedSize: false,
      // Electron 43's Chromium; the lib runs nowhere else.
      target: "chrome140",
      rollupOptions: {
        input: Object.fromEntries(
          Object.entries(ENTRIES).map(([name, source]) => [name, resolve(root, source)]),
        ),
        // An entry is a served module: its exports are its contract.
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          entryFileNames: "[name].mjs",
          chunkFileNames: "chunks/[name]-[hash].mjs",
        },
      },
    },
  });
  const outputs = (Array.isArray(output) ? output : [output]) as Rollup.RollupOutput[];
  const pins: Record<string, string> = {};
  for (const file of outputs.flatMap((result) => result.output)) {
    if (file.type !== "chunk") {
      // The shell serves modules and nothing else; an asset here would be a
      // file no panel could load, so the build says so instead of shipping it.
      throw new Error(`the frame lib emitted a non-module file: ${file.fileName}`);
    }
    pins[file.fileName] = sha256(file.code);
  }
  for (const [file, bytes] of await compileAppPanels(root)) {
    const target = join(outDir, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    pins[file] = sha256(bytes);
  }
  return pins;
}

/** Every file under `dir`, relative to it with forward slashes. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

/**
 * The app's own panel folders, each compiled by the panel compiler for the
 * frame realm: lib path -> bytes, under `builtin/<id>/`. The compiler is
 * the core's own module (src/core/personal/compiler.ts), loaded through
 * Vite's module runner so its `@shared` imports resolve as they do in the
 * app; a folder it refuses fails the build, naming the file.
 */
export async function compileAppPanels(root: string): Promise<Map<string, Uint8Array>> {
  const { module: compiler } = await runnerImport<typeof import("../src/core/personal/compiler")>(
    resolve(root, "src/core/personal/compiler.ts"),
    {
      configFile: false,
      root,
      logLevel: "warn",
      resolve: { alias: { "@shared": resolve(root, "src/shared") } },
    },
  );
  const cacheRoot = await mkdtemp(join(tmpdir(), "fm-app-panels-"));
  const files = new Map<string, Uint8Array>();
  try {
    for (const id of BUILTIN_FRAME_PANELS) {
      const compiled = await compiler.compilePersonalModule({
        extensionId: id,
        extensionDir: resolve(root, APP_PANELS_DIR, id),
        kind: "panel",
        cacheRoot,
        realm: "frame",
      });
      for (const file of await filesUnder(compiled.outputDir)) {
        files.set(
          `${builtinPanelDir(id)}/${file}`,
          new Uint8Array(await readFile(join(compiled.outputDir, file))),
        );
      }
    }
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
  return files;
}

export function frameLibPlugin(root: string, outDir: string): Plugin {
  let pins: Record<string, string> | null = null;
  return {
    name: "fm-frame-lib",
    async buildStart() {
      pins = await buildFrameLib(root, outDir);
    },
    resolveId(id) {
      return id === FRAME_LIB_VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;
      if (!pins) throw new Error("the frame lib was not built before main");
      return `export const FRAME_LIB_PINS = Object.freeze(${JSON.stringify(pins)});\n`;
    },
  };
}
