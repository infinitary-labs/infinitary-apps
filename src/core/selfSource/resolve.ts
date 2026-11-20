import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { SourceIdentity } from "@shared/selfSource";
import { z } from "zod";

const sourceMapSchema = z
  .object({
    version: z.string().min(1),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    modules: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .refine((modules) => Object.keys(modules).length > 0),
  })
  .passthrough();

/**
 * Where the Firstmate agent reads its own source. Packaged builds ship the
 * filtered git-tracked source as extraResources (`Contents/Resources/self-source`),
 * without test fixtures or draft data terms;
 * unpackaged / dev uses the checkout itself so both modes look the same to
 * the agent. Nothing ever executes from this tree.
 */
export type SelfSourceLocation = {
  isPackaged: boolean;
  resourcesPath: string;
  /** Electron `app.getAppPath()`: the repo root when unpackaged. */
  appPath: string;
};

export function resolveSelfSourceDir(location: SelfSourceLocation): string {
  if (location.isPackaged) {
    return join(location.resourcesPath, "self-source");
  }
  return location.appPath;
}

/** Facts are read again for every conversation, never cached across updates or moves. */
export type SelfSourceFacts = SourceIdentity & {
  root: string;
  index: string;
  availability: "available" | "unavailable";
  reason?: string;
};

export type SelfSourceReader = () => SelfSourceFacts | Promise<SelfSourceFacts>;

export function readSelfSource(
  location: SelfSourceLocation & { computer: string; version: string },
): SelfSourceFacts {
  const root = resolveSelfSourceDir(location);
  const index = join(root, "self-map.json");
  const facts: SelfSourceFacts = {
    computer: location.computer,
    version: location.version,
    commit: null,
    mutable: !location.isPackaged,
    root,
    index,
    availability: "unavailable",
  };
  try {
    const map = sourceMapSchema.parse(JSON.parse(readFileSync(index, "utf8")));
    // The development map indexes an earlier snapshot, not the mutable checkout.
    if (location.isPackaged) {
      const outer = sourceMapSchema.parse(
        JSON.parse(readFileSync(join(location.resourcesPath, "self-map.json"), "utf8")),
      );
      if (map.version !== location.version || JSON.stringify(map) !== JSON.stringify(outer))
        throw new Error("The installed app and its source metadata disagree.");
    }
    const realRoot = realpathSync(root);
    for (const file of Object.keys(map.modules)) {
      const path = relative(realRoot, realpathSync(join(root, file)));
      if (isAbsolute(file) || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
        throw new Error("An indexed file escapes the source folder.");
      if (!statSync(join(root, file)).isFile())
        throw new Error("An indexed source file is missing.");
      accessSync(join(root, file), constants.R_OK);
    }
    return {
      ...facts,
      version: location.isPackaged ? map.version : location.version,
      commit: location.isPackaged ? map.commit : null,
      availability: "available",
    };
  } catch (error) {
    return { ...facts, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The build's identity alone, as `readSelfSource` reads it from the source
 * index, without checking every indexed file is there: the freeze recorder
 * tags its records with it at each start, where that walk read thousands
 * of files. A development build is its version with no commit, as
 * `readSelfSource` says of it either way; an installed build takes its
 * index's commit once both copies of the index agree with its version.
 */
export function readSelfSourceIdentity(
  location: SelfSourceLocation & { computer: string; version: string },
): SourceIdentity {
  const identity: SourceIdentity = {
    computer: location.computer,
    version: location.version,
    commit: null,
    mutable: !location.isPackaged,
  };
  if (!location.isPackaged) return identity;
  try {
    const read = (path: string) => sourceMapSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const map = read(join(resolveSelfSourceDir(location), "self-map.json"));
    const outer = read(join(location.resourcesPath, "self-map.json"));
    if (map.version !== location.version || JSON.stringify(map) !== JSON.stringify(outer))
      return identity;
    return { ...identity, version: map.version, commit: map.commit };
  } catch {
    return identity;
  }
}

/**
 * Fresh validation at a session-opening boundary, with filesystem work off
 * the main thread. It preserves every path and readability check of the
 * synchronous reader; it does not cache a success across conversations.
 */
export async function readSelfSourceAsync(
  location: SelfSourceLocation & { computer: string; version: string },
): Promise<SelfSourceFacts> {
  const root = resolveSelfSourceDir(location);
  const index = join(root, "self-map.json");
  const facts: SelfSourceFacts = {
    computer: location.computer,
    version: location.version,
    commit: null,
    mutable: !location.isPackaged,
    root,
    index,
    availability: "unavailable",
  };
  try {
    const map = sourceMapSchema.parse(JSON.parse(await readFile(index, "utf8")));
    if (location.isPackaged) {
      const outer = sourceMapSchema.parse(
        JSON.parse(await readFile(join(location.resourcesPath, "self-map.json"), "utf8")),
      );
      if (map.version !== location.version || JSON.stringify(map) !== JSON.stringify(outer))
        throw new Error("The installed app and its source metadata disagree.");
    }
    const realRoot = await realpath(root);
    for (const file of Object.keys(map.modules)) {
      const path = relative(realRoot, await realpath(join(root, file)));
      if (isAbsolute(file) || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
        throw new Error("An indexed file escapes the source folder.");
      if (!(await stat(join(root, file))).isFile())
        throw new Error("An indexed source file is missing.");
      await access(join(root, file), constants.R_OK);
    }
    return {
      ...facts,
      version: location.isPackaged ? map.version : location.version,
      commit: location.isPackaged ? map.commit : null,
      availability: "available",
    };
  } catch (error) {
    return { ...facts, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Only identity crosses the connection; filesystem paths remain local. */
export function sourceIdentity(facts: SelfSourceFacts): SourceIdentity {
  return {
    computer: facts.computer,
    version: facts.version,
    commit: facts.commit,
    mutable: facts.mutable,
  };
}

export function sourceContext(local: SelfSourceFacts | undefined, home?: SourceIdentity): string {
  return [
    "<infinitary_source>",
    `Executing computer's source: ${JSON.stringify(local ?? { availability: "unknown" })}`,
    `First mate's build identity (not a local path): ${JSON.stringify(home ?? null)}`,
    "Read the executing computer's source only at the root above, starting with its index. These facts describe Infinitary, not your project's working copy. Missing facts mean unknown, never a guessed Applications path. A mutable checkout is not a frozen installed build. Before investigating another computer's build, compare its source commit with the local one: only matching known, immutable commits describe the same source. If they differ or are unknown, keep the builds distinct and ask the first mate to coordinate the existing verified file handoff from the investigated computer. Never substitute this task's checkout, latest main, or another installed version. Unavailable source does not block unrelated work.",
    "</infinitary_source>",
  ].join("\n");
}
