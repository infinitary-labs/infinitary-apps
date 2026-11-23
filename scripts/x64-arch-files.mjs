#!/usr/bin/env node
// The one list of Mach-O files a universal Infinitary.app may carry as a
// single architecture: electron-builder.yml's `mac.x64ArchFiles`. The
// universal merge (@electron/universal) takes every Mach-O that is identical
// in both slices as-is, and aborts unless that pattern names it, so a file
// the pattern names is single-arch by design and every other Mach-O must
// carry both arm64 and x86_64. scripts/verify-app.sh asks this script
// instead of keeping a list of its own (the v0.1.0 release failed its signed
// gate on a koffi addon the merge had been told to keep), and the match is
// the merger's own: its minimatch, with its `matchBase: true`, against a path
// relative to the .app.
//
//   node scripts/x64-arch-files.mjs pattern
//       print mac.x64ArchFiles
//   node scripts/x64-arch-files.mjs uncovered <relative path ...>
//       print each path (relative to the .app, e.g.
//       Contents/Resources/app.asar.unpacked/...) the pattern does NOT name,
//       one per line; exit 0 whether or not any is printed

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function electronBuilderConfig() {
  const electronBuilder = createRequire(require.resolve("electron-builder/package.json"));
  const yaml = electronBuilder("js-yaml");
  return yaml.load(readFileSync(join(root, "electron-builder.yml"), "utf8"));
}

function universalMatcher() {
  const electronBuilder = createRequire(require.resolve("electron-builder/package.json"));
  const appBuilderLib = createRequire(electronBuilder.resolve("app-builder-lib/package.json"));
  const universal = createRequire(appBuilderLib.resolve("@electron/universal/package.json"));
  const { minimatch } = universal("minimatch");
  return (path, pattern) => minimatch(path, pattern, { matchBase: true });
}

export function x64ArchFiles() {
  const pattern = electronBuilderConfig()?.mac?.x64ArchFiles;
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("electron-builder.yml has no mac.x64ArchFiles");
  }
  return pattern;
}

export function uncovered(paths) {
  const pattern = x64ArchFiles();
  const matches = universalMatcher();
  return paths.filter((path) => !matches(path, pattern));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "pattern" && args.length === 0) {
    console.log(x64ArchFiles());
  } else if (command === "uncovered") {
    for (const path of uncovered(args)) console.log(path);
  } else {
    console.error("usage: x64-arch-files.mjs pattern | uncovered <relative path ...>");
    process.exit(2);
  }
}
