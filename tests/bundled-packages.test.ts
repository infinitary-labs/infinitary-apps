import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { describe, expect, test, vi } from "vitest";
import {
  BUNDLED_PACKAGES,
  bundledPackagesPlugin,
  LOCATED_RUNTIME,
  lookupPackage,
} from "../scripts/bundled-packages.ts";
import { scratchDir } from "./helpers/scratchDirs.ts";

/**
 * The main build bundles a few packages to load less code at start, "without
 * losing any functionality" (the captain's words on the startup work): a
 * bundled file must still find the files it ships beside - its package's own
 * folder, a wasm file, a worker script - in a development checkout and in a
 * packaged app's flat folders, and the build must refuse a lookup it cannot
 * carry rather than ship it broken.
 */

const repo = resolve(__dirname, "..");
// Building the coding agent's whole package graph: measured at 3.4 s at
// its fastest on the Mac mini, budgeted at five times that.
vi.setConfig({ testTimeout: 20_000 });

/** The main build's choice, as electron-vite makes it: the app's own dependencies stay outside, but for the bundled ones. */
function externalFor(appRoot: string, bundled: readonly string[]): (id: string) => boolean {
  const json = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const outside = Object.keys(json.dependencies ?? {}).filter((name) => !bundled.includes(name));
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  return (id) =>
    builtins.has(id) ||
    id === "electron" ||
    outside.some((name) => id === name || id.startsWith(`${name}/`));
}

async function bundle(
  appRoot: string,
  entry: string,
  outDir: string,
  bundled: readonly string[] = BUNDLED_PACKAGES,
): Promise<string> {
  await build({
    configFile: false,
    logLevel: "silent",
    root: dirnameOf(entry),
    plugins: [bundledPackagesPlugin(appRoot)],
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        external: externalFor(appRoot, bundled),
        output: { format: "es", entryFileNames: "[name].mjs" },
      },
    },
  });
  return join(outDir, "entry.mjs");
}

function dirnameOf(file: string): string {
  return resolve(file, "..");
}

describe("the main build's bundled packages", () => {
  test("the bundled coding agent finds its own folder and resizes a picture with its wasm", async () => {
    // The app's folder as the built app sees it: its chunks under out/main,
    // its installed packages beside them.
    const app = scratchDir("bundled-agent-");
    symlinkSync(join(repo, "node_modules"), join(app, "node_modules"));
    const entry = join(app, "entry.mjs");
    writeFileSync(
      entry,
      'export { getPackageDir, VERSION, resizeImage } from "@earendil-works/pi-coding-agent";\n',
    );
    const built = await bundle(repo, entry, join(app, "out", "main"));
    const text = readFileSync(built, "utf8");
    expect(text).not.toMatch(/from\s*"@earendil-works\/pi-coding-agent"/);

    const agent = (await import(pathToFileURL(built).href)) as {
      getPackageDir: () => string;
      VERSION: string;
      resizeImage: (
        bytes: Uint8Array,
        mime: string,
        options: { maxWidth: number; maxHeight: number },
      ) => Promise<{ width: number; height: number; wasResized: boolean } | null>;
    };
    const installed = lookupPackage(repo, "@earendil-works/pi-coding-agent") as string;
    expect(realpathSync(agent.getPackageDir())).toBe(installed);
    expect(agent.VERSION).toBe(
      (JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { version: string })
        .version,
    );
    // A real picture from the project, 462 by 260, made to fit 100 wide.
    const picture = readFileSync(
      join(repo, "release-notes/pictures/activity-settles-setting-runs-dark.png"),
    );
    const resized = await agent.resizeImage(new Uint8Array(picture), "image/png", {
      maxWidth: 100,
      maxHeight: 100,
    });
    expect(resized).toMatchObject({ width: 100, wasResized: true });
  });

  test("a bundled file finds its package in a packaged app's flat and nested folders", async () => {
    // How a packaged app lays out its packages: most at the top, a second
    // version nested under the package that needs it.
    const app = scratchDir("bundled-flat-");
    const place = (dir: string, name: string, version: string): string => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
      return realpathSync(dir);
    };
    place(join(app, "node_modules", "agent"), "agent", "1.0.0");
    const shared = place(join(app, "node_modules", "shared"), "shared", "2.0.0");
    const nested = place(
      join(app, "node_modules", "agent", "node_modules", "schema"),
      "schema",
      "1.0.0",
    );
    place(join(app, "node_modules", "schema"), "schema", "2.0.0");
    const chunks = join(app, "out", "main", "chunks");
    mkdirSync(chunks, { recursive: true });
    writeFileSync(join(chunks, "located.mjs"), LOCATED_RUNTIME);
    const located = (await import(pathToFileURL(join(chunks, "located.mjs")).href)) as {
      path: (chain: string[], inside: string) => string;
    };
    expect(located.path(["agent", "schema"], "dist/index.js")).toBe(join(nested, "dist/index.js"));
    expect(located.path(["agent", "shared"], "photon_rs_bg.wasm")).toBe(
      join(shared, "photon_rs_bg.wasm"),
    );
  });

  test("the build refuses a bundled file that imports what a variable names", async () => {
    const app = scratchDir("bundled-refused-");
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "looks-up": "1.0.0" } }),
    );
    const pkg = join(app, "node_modules", "looks-up");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "looks-up", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), "export const load = (name) => import(name);\n");
    const entry = join(app, "entry.mjs");
    writeFileSync(entry, 'export { load } from "looks-up";\n');
    await expect(bundle(app, entry, join(app, "out"), ["looks-up"])).rejects.toThrow(
      /looks-up\/index\.js looks itself up in a way a bundle cannot carry/,
    );
  });
});
