// pnpm leaves out an optional package whose download failed, and says
// nothing: the install exits 0 and reports fewer packages added than it
// resolved (pnpm 11's linking returns early for an optional package whose
// download threw). An optional package here is mostly a platform's native
// part, such as the Claude SDK's or esbuild's, so the install looks whole
// and the first program that loads that part fails: a batch's Linux
// journeys failed with "Cannot find module" for the Claude SDK's Linux
// package after npm's registry timed out on it.
//
// pnpm still links the left-out package from each package that needs it, so
// a dropped package leaves a link that leads nowhere, and nothing else does:
// a package skipped because it is built for another platform gets no link at
// all. This reads every package link the install made in the folder it runs
// in and fails, naming each package left out, when a link leads nowhere.
//
// It runs first in the project's own postinstall, which every install runs
// after linking; the Windows installer check installs without scripts and
// runs it by itself (docs/testing.md, "pnpm's own download").

import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A package the install left out: its name, its folder in pnpm's store, which names its version, and the packages that need it. */
type Dropped = { name: string; stored: string; neededBy: string[] };

function entries(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/** Each package link in one node_modules folder, a scope's packages included, as [name, path]. */
function packageLinks(folder: string): [string, string][] {
  const found: [string, string][] = [];
  for (const name of entries(folder)) {
    // .bin, .pnpm and pnpm's own state files are not packages.
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const scoped of entries(join(folder, name))) {
        found.push([`${name}/${scoped}`, join(folder, name, scoped)]);
      }
    } else found.push([name, join(folder, name)]);
  }
  return found;
}

/** The packages the install in `root` left out, each named once. */
function droppedPackages(root: string): Dropped[] {
  const modules = join(root, "node_modules");
  const store = join(modules, ".pnpm");
  // The project's own packages, those pnpm lifts for every package to find,
  // and each stored package's own (its folder holds it beside its links).
  const places: [string, string][] = [
    ["the project", modules],
    ["every package", join(store, "node_modules")],
  ];
  for (const entry of entries(store)) {
    if (entry !== "node_modules") places.push([entry, join(store, entry, "node_modules")]);
  }
  const dropped = new Map<string, Dropped>();
  for (const [needer, folder] of places) {
    for (const [name, path] of packageLinks(folder)) {
      // A link that leads nowhere; a package's own folder always exists.
      if (existsSync(path)) continue;
      // Where it leads, under the store: the left-out package's own folder.
      const stored = relative(store, resolve(dirname(path), readlinkSync(path))).split(sep)[0] || name;
      const known = dropped.get(stored) ?? { name, stored, neededBy: [] };
      if (needer !== "every package") known.neededBy.push(needer);
      dropped.set(stored, known);
    }
  }
  return [...dropped.values()];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dropped = droppedPackages(process.cwd());
  if (dropped.length > 0) {
    console.error(
      `pnpm left out ${dropped.length} package(s) it could not download, without saying so: it skips an optional package whose download failed.`,
    );
    for (const item of dropped) {
      const needed = item.neededBy.length > 0 ? `, needed by ${item.neededBy.join(", ")}` : "";
      console.error(`  ${item.name} (${item.stored})${needed}`);
    }
    console.error("Run the install again: pnpm's warnings above name each download it tried again.");
    process.exit(1);
  }
}
