import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
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
 * git-tracked tree as extraResources (`Contents/Resources/self-source`);
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
