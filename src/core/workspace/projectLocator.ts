import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * locate_project's host side (contract v1, spec section 1.4 + G-2): typed
 * project lookup on disk, replacing prompt-steered bash exploration.
 * Case-insensitive basename match - exact first, then substring - over a
 * fixed root list: the fleet root's managed repos (via the registry, so
 * adopted symlinks resolve to their real paths), ~/github at org and repo
 * level, the common project parents, and ~ one level deep. Never follows
 * symlinks out, never enters hidden or system directories. Read-only.
 */

export type LocatedProject = {
  path: string;
  isGitRepo: boolean;
  origin?: string;
  repoId?: string;
};

export type LocateOptions = {
  /** Managed repos (the fleet root's contents, by their real paths). */
  managed: { id: string; name: string; path: string }[];
  /** Injectable for tests; defaults to os.homedir(). */
  home?: string;
};

const MAX_RESULTS = 8;

/** Home children never entered: system directories, per the spec. */
const SYSTEM_DIRS = new Set(["Library", "Applications"]);

/** Common project parents scanned one level deep, under the home. */
const PROJECT_PARENTS = ["projects", "code", "src", "work", "dev", "Documents"];

export function locateProject(name: string, options: LocateOptions): LocatedProject[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const home = options.home ?? homedir();

  const candidates = new Map<string, { path: string; base: string; repoId?: string }>();
  const add = (path: string, base: string, repoId?: string) => {
    if (!candidates.has(path)) candidates.set(path, { path, base, ...(repoId ? { repoId } : {}) });
  };

  // Managed repos first: adopted data never moves, so the registry's real
  // paths stand in for the fleet root's symlinks.
  for (const repo of options.managed) {
    add(repo.path, repo.name, repo.id);
  }

  // ~ one level deep, skipping hidden and system directories.
  for (const child of safeDirs(home)) {
    add(join(home, child), child);
  }
  // ~/github at org level and repo level.
  const github = join(home, "github");
  for (const org of safeDirs(github)) {
    add(join(github, org), org);
    for (const repo of safeDirs(join(github, org))) {
      add(join(github, org, repo), repo);
    }
  }
  // The common project parents.
  for (const parent of PROJECT_PARENTS) {
    const dir = join(home, parent);
    for (const child of safeDirs(dir)) {
      add(join(dir, child), child);
    }
  }

  const exact: { path: string; repoId?: string }[] = [];
  const partial: { path: string; repoId?: string }[] = [];
  for (const candidate of candidates.values()) {
    const base = candidate.base.toLowerCase();
    if (base === needle) exact.push(candidate);
    else if (base.includes(needle)) partial.push(candidate);
  }
  const picked = [...exact, ...partial].slice(0, MAX_RESULTS);
  return picked.map((candidate) => {
    const gitDir = join(candidate.path, ".git");
    const isGitRepo = existsSync(gitDir);
    const origin = isGitRepo ? originOf(gitDir) : undefined;
    return {
      path: candidate.path,
      isGitRepo,
      ...(origin ? { origin } : {}),
      ...(candidate.repoId ? { repoId: candidate.repoId } : {}),
    };
  });
}

/** Child directories of `dir`, skipping symlinks, hidden, and system dirs. */
function safeDirs(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".") || SYSTEM_DIRS.has(entry)) continue;
    try {
      // Symlinked children are skipped entirely: following one could leave
      // the scanned roots.
      if (!lstatSync(join(dir, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    dirs.push(entry);
  }
  return dirs;
}

/** The origin remote's url from .git/config, without spawning git. */
function originOf(gitDir: string): string | undefined {
  try {
    if (!statSync(gitDir).isDirectory()) return undefined;
    const config = readFileSync(join(gitDir, "config"), "utf8");
    const section = config.split(/\[remote "origin"\]/)[1];
    if (!section) return undefined;
    const beforeNext = section.split(/\n\[/)[0] ?? section;
    return beforeNext.match(/\burl\s*=\s*(.+)/)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** Render the tool result: candidates or an honest not-found. */
export function renderLocated(name: string, results: LocatedProject[]): string {
  if (results.length === 0) {
    return `No project matching "${name}" found on disk. Ask the user with one decision card if the work needs it.`;
  }
  const lines = results.map((result) => {
    const parts = [
      result.path,
      result.isGitRepo ? "git repo" : "not a git repo",
      ...(result.origin ? [`origin ${result.origin}`] : []),
      ...(result.repoId ? [`already managed (repo_id: ${result.repoId})`] : []),
    ];
    return `- ${parts.join(" | ")}`;
  });
  return [`Found ${results.length} candidate${results.length > 1 ? "s" : ""}:`, ...lines].join(
    "\n",
  );
}
