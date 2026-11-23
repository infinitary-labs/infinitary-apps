import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadYamlFile } from "./helpers/releaseWorkflows";

/**
 * The Linux packages build with no Electron rebuild of native modules
 * (`npmRebuild: false` in electron-builder.linux.yml; docs/linux-packages.md,
 * "What is built"). electron-builder would otherwise rebuild every production
 * dependency with a binding.gyp for Electron, downloading Electron's headers
 * first. Skipping that is right only while each such module ships its own
 * Node-API build for Linux x64, which Electron loads as it is: a module built
 * against one Node's ABI would load in Node and fail in the packaged app.
 */

const root = join(__dirname, "..");

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const manifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;

/** Where Node's resolution finds `name` from `from`: the nearest node_modules holding it. */
function installed(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

function productionPackages(): string[] {
  const seen = new Set<string>([root]);
  const queue = [root];
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    const { dependencies = {}, optionalDependencies = {} } = manifest(dir);
    for (const name of Object.keys({ ...dependencies, ...optionalDependencies })) {
      const found = installed(name, dir);
      // An optional dependency for another system is not installed here.
      if (found === undefined && name in optionalDependencies) continue;
      if (found === undefined)
        throw new Error(`${manifest(dir).name} depends on ${name}, which is not installed`);
      if (seen.has(found)) continue;
      seen.add(found);
      queue.push(found);
    }
  }
  return [...seen];
}

/** A Node-API addon registers through napi_register_module_v1; one built for a Node ABI does not. */
const isNodeApi = (file: string) => readFileSync(file).includes("napi_register_module_v1");

describe("the Linux packages' native modules", () => {
  it("are not rebuilt for Electron", () => {
    expect(loadYamlFile("electron-builder.linux.yml").npmRebuild).toBe(false);
  });

  it("each ship a Node-API build for Linux x64 that Electron loads as it is", () => {
    const native = productionPackages().filter((dir) => existsSync(join(dir, "binding.gyp")));
    // The walk reaches the one native module the app ships today.
    expect(native.map((dir) => manifest(dir).name)).toContain("better-sqlite3");
    for (const dir of native) {
      const { name } = manifest(dir);
      const build = join(dir, "prebuilds", "linux-x64.node");
      expect(existsSync(build), `${name} has no Linux x64 build of its own`).toBe(true);
      expect(isNodeApi(build), `${name}'s Linux x64 build is not a Node-API addon`).toBe(true);
    }
  });
});
