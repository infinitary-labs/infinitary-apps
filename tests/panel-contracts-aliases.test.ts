import { join, resolve } from "node:path";
import { build, normalizePath, type Plugin, type Rollup, type UserConfig } from "vite";
import { describe, expect, it } from "vitest";

/**
 * The window's build and the tests resolve a panel's contracts specifiers
 * through their own aliases, beside the tsconfig paths the type checker
 * reads. Every panel imports the contracts for types only, and the compiler
 * erases a type-only import before the bundler resolves it, so an alias
 * naming a missing file passes every check until the first value import.
 */
const CONTRACTS = join(resolve(__dirname, ".."), "src/shared/personal/contracts.ts");
const SPECIFIERS = ["@infinitary/contracts", "@firstmate/contracts"];

async function windowBuildModules(specifier: string): Promise<string[]> {
  const { renderer } = (await import("../electron.vite.config")).default as {
    renderer: { root: string; resolve: UserConfig["resolve"] };
  };
  const entry = "panel-contracts-entry";
  const panel: Plugin = {
    name: entry,
    resolveId: (id) => (id === entry ? id : undefined),
    load: (id) =>
      id === entry ? `export { PANEL_DRAFT_MAX } from ${JSON.stringify(specifier)};` : undefined,
  };
  const built = (await build({
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: "silent",
    root: renderer.root,
    resolve: renderer.resolve,
    plugins: [panel],
    // An app build drops its entry's exports, and with them every module
    // the entry only re-exports, unless the signature is kept.
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: entry, preserveEntrySignatures: "strict" },
    },
  })) as Rollup.RollupOutput;
  return built.output.flatMap((part) => (part.type === "chunk" ? part.moduleIds : []));
}

describe("the contracts module a panel imports", () => {
  it("is the module a test imports under either name", async () => {
    const direct = await import("../src/shared/personal/contracts");
    expect(await import("@infinitary/contracts")).toBe(direct);
    expect(await import("@firstmate/contracts")).toBe(direct);
  });

  it.each(SPECIFIERS)("is the module the window's build bundles for %s", async (specifier) => {
    expect(await windowBuildModules(specifier)).toContain(normalizePath(CONTRACTS));
  });
});
