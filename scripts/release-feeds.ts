import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ReleaseManifest } from "../src/core/update/releaseFeeds.ts";
import type { Publication } from "../src/core/update/tapPublication.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/** Computes metadata only from the finalized/adopted bytes. It publishes nothing. */
async function digest(file: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64") {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest(encoding);
}
function readOptional(path: string): unknown | undefined {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
const { values } = parseArgs({ options: Object.fromEntries(
  ["directory", "zip", "dmg", "windows", "linux", "version", "source-commit", "channel"].map(name => [name, { type: "string" as const }]),
) });
function required(name: string): string {
  const value = values[name];
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
}
const version = required("version");
if (!/^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/.test(version)) throw new Error("Invalid release version");
const channel = required("channel");
if (channel !== "stable" && channel !== "alpha") throw new Error("Invalid release channel");
const zip = resolve(required("zip"));
const dmg = resolve(required("dmg"));
const directory = resolve(required("directory"));
// An alpha's Windows installer, when the release publishes one (docs/windows.md).
const windows = typeof values.windows === "string" && values.windows ? resolve(values.windows) : undefined;
const manifest: ReleaseManifest = {
  schemaVersion: 1, version, sourceCommit: required("source-commit"),
  zip: { asset: basename(zip), size: statSync(zip).size, sha256: await digest(zip, "sha256", "hex"), sha512: await digest(zip, "sha512", "base64") },
  dmg: { asset: basename(dmg), size: statSync(dmg).size, sha256: await digest(dmg, "sha256", "hex") },
  ...(windows && {
    windows: { asset: basename(windows), size: statSync(windows).size, sha256: await digest(windows, "sha256", "hex") },
  }),
};
const publication: Publication = {
  channel, version, sourceCommit: manifest.sourceCommit, assetName: manifest.zip.asset, sha256: manifest.zip.sha256,
  linux: JSON.parse(readFileSync(required("linux"), "utf8")),
};
const runner = await openModuleRunner();
try {
  const { releaseFeedFiles } = await runner.import<typeof import("../src/core/update/releaseFeeds.ts")>(join(REPO_ROOT, "src/core/update/releaseFeeds.ts"));
  const { PUBLIC_RELEASE_NAMES } = await runner.import<typeof import("../src/core/update/releaseSource.ts")>(join(REPO_ROOT, "src/core/update/releaseSource.ts"));
  const result = releaseFeedFiles({ publication, manifest,
    currentTargets: readOptional(join(directory, PUBLIC_RELEASE_NAMES.targetsFile)),
    currentBuilds: readOptional(join(directory, PUBLIC_RELEASE_NAMES.buildsFile)),
    previousManifest: readOptional(join(directory, `versions/${version}.json`)),
  });
  for (const [name, content] of Object.entries(result.files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(JSON.stringify({ files: Object.keys(result.files), notes: result.notes }));
} finally { await runner.close(); }
