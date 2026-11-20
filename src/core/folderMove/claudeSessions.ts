import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { encodeClaudeProjectDir } from "../claude/claudeTranscript";
import { type CopyOptions, copyEntry } from "./copy";

/**
 * Claude's own records for the folders that moved (./move.ts). The client
 * keeps a session under `~/.claude/projects/<encoded working folder>/`
 * (`claude/claudeTranscript.ts`) and resumes it only from the folder named
 * after the working folder it is started in, so a session started in a
 * working copy of the older folder is copied under the new working copy's
 * name. Claude's own folders are never changed or removed: the copy is
 * added beside them.
 *
 * The working folders are read from the new folder itself - the folder, its
 * top-level folders and theirs (`worktrees/<task>`, `firstmate/home`,
 * `fleet/personal`), and the same of `work/`, the folder a computer that
 * runs work keeps its own working copies in (`work/worktrees/<task>`,
 * docs/helper.md) - because the encoding loses characters: matching by a
 * prefix would also take another folder's sessions (`firstmate-3000-dev`
 * starts with `firstmate-3000-`).
 */

function folders(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * The working folders under `to` a Claude session may have been started in,
 * relative to it: of the folder and of its `work/`, each the folder, its
 * top-level folders and theirs.
 */
function workingFolders(to: string): string[] {
  const found = new Set<string>();
  for (const base of ["", "work"]) {
    found.add(base);
    for (const top of folders(join(to, base))) {
      found.add(join(base, top));
      for (const child of folders(join(to, base, top))) found.add(join(base, top, child));
    }
  }
  return [...found];
}

/**
 * Copies each Claude session folder named after a working folder in `from`
 * under the name of the same working folder in `to`. A session file already
 * under the new name is kept. Answers what it copied.
 */
export async function mapClaudeSessions(input: {
  /** The older folder by every path that names it (`move.ts` `pathsOf`). */
  from: readonly string[];
  /** This app's folder by every path that names it: the client names a folder by the path it was started in. */
  to: readonly string[];
  configDir: string;
  copy: CopyOptions;
}): Promise<{ from: string; to: string }[]> {
  const projects = join(input.configDir, "projects");
  const existing = new Set(folders(projects));
  if (existing.size === 0) return [];
  const [own] = input.to;
  if (own === undefined) return [];
  const copied: { from: string; to: string }[] = [];
  for (const folder of workingFolders(own)) {
    const targets = [...new Set(input.to.map((to) => encodeClaudeProjectDir(join(to, folder))))];
    for (const from of input.from) {
      const source = encodeClaudeProjectDir(join(from, folder));
      if (!existing.has(source)) continue;
      for (const target of targets) {
        if (target === source) continue;
        await copyInto(join(projects, source), join(projects, target), input.copy);
        copied.push({ from: join(projects, source), to: join(projects, target) });
      }
    }
  }
  return copied;
}

/** Copies a session folder under a new name, keeping every file already there. */
async function copyInto(sourceDir: string, targetDir: string, copy: CopyOptions): Promise<void> {
  if (!existsSync(targetDir)) {
    await copyEntry(sourceDir, targetDir, copy);
    return;
  }
  for (const name of readdirSync(sourceDir))
    if (!existsSync(join(targetDir, name)))
      await copyEntry(join(sourceDir, name), join(targetDir, name), copy);
}
