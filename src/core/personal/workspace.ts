import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NamingRule } from "@shared/runbooks";
import { APP_GIT_IDENTITY, git } from "../workspace/git";
import { composedName } from "../workspace/naming";
import { PERSONAL_AGENTS_MD } from "./seed/agentsMd";
import { INFINITARY_ENV_DTS } from "./seed/infinitaryEnv.generated";
import { PERSONAL_TSCONFIG_JSON } from "./seed/tsconfigJson";
import { seedWorkspaceSkills } from "./workspaceSkills";

/**
 * The personal workspace seeder (talk-to-personalize Step 2, report
 * section 4.1). `userData/fleet/personal/` is a
 * git repo the app owns the SHAPE of and the captain owns the CONTENT of:
 *
 * - it exists after every boot, initialised as a git repo on `main`;
 * - every managed file below is force-copied when its text differs, so a
 *   stale or edited copy is restored ("self-healed") and a new app version
 *   refreshes the contract it ships;
 * - unrelated files stay; app-managed skills, including the sequences guide,
 *   refresh from packaged content and overwrite local edits;
 * - a heal is committed under the app's identity, so the repo's history
 *   shows what the app changed and what a crewmate changed.
 *
 * The managed set is data (`MANAGED_FILES`) plus, when a source tree is at
 * hand, the app-owned skill TREES under `.claude/skills/`
 * (./workspaceSkills.ts, Step 3): same rule, same commit, only whole
 * directories instead of single files, because the design skill is 136
 * files and some of them are fonts. Never
 * fatal: a workspace the app cannot write (a read-only volume) logs and
 * boots without personal panels rather than without an app.
 */
export type ManagedFile = { path: string; content: string };

export const MANAGED_FILES: readonly ManagedFile[] = [
  { path: "AGENTS.md", content: PERSONAL_AGENTS_MD },
  { path: "infinitary-env.d.ts", content: INFINITARY_ENV_DTS },
  { path: "tsconfig.json", content: PERSONAL_TSCONFIG_JSON },
];

/**
 * Managed files the app no longer ships, removed at the next seed:
 * `firstmate-env.d.ts` is `infinitary-env.d.ts` since the Infinitary rename,
 * and the two side by side would declare every type twice.
 */
export const RETIRED_MANAGED_FILES: readonly string[] = ["firstmate-env.d.ts"];

export type SeedResult = {
  /** The directory (or its git repo) did not exist before this boot. */
  created: boolean;
  /** Managed paths written this boot because they were missing or differed. */
  healed: string[];
};

export type SeedOptions = {
  dir: string;
  managed?: readonly ManagedFile[];
  /**
   * The self-source root the app-owned skills are copied from. Absent (a
   * test that only cares about the managed files) seeds no skills.
   */
  skillsSourceDir?: string;
  /** The active naming runbook's rule, which names the commit the host makes; absent or null, none is on. */
  namingRule?: () => NamingRule | null;
  log?: (message: string) => void;
  /**
   * Takes the heal's commit to run later, once the files are on disk,
   * instead of the seed awaiting it: the app's start hands it to the
   * workspace's queue of git writes, so the first mate never waits for git.
   * A workspace the seed just created commits before it returns, as does
   * every seed without it: its first commit is what later writes build on.
   */
  commitLater?: (commit: () => Promise<void>) => void;
};

export async function seedPersonalWorkspace(options: SeedOptions): Promise<SeedResult> {
  const { dir } = options;
  const managed = options.managed ?? MANAGED_FILES;
  const log = options.log ?? (() => {});
  await mkdir(dir, { recursive: true });
  let created = false;
  if (!(await isRepoRoot(dir))) {
    await git(dir, ["init", "-b", "main"]);
    created = true;
  }
  const healed: string[] = [];
  for (const file of managed) {
    const target = join(dir, file.path);
    let current: string | null = null;
    try {
      current = await readFile(target, "utf8");
    } catch {
      current = null;
    }
    if (current === file.content) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
    healed.push(file.path);
  }
  // Only with the default managed set, whose files replaced them.
  const retired: string[] = [];
  if (managed === MANAGED_FILES)
    for (const path of RETIRED_MANAGED_FILES) {
      const target = join(dir, path);
      if ((await readFile(target).catch(() => null)) === null) continue;
      await rm(target, { force: true });
      // Committed only when the repo held it; an untracked copy just goes.
      if (await git(dir, ["ls-files", "--", path]).catch(() => "")) retired.push(path);
    }
  if (options.skillsSourceDir !== undefined) {
    const skills = await seedWorkspaceSkills({
      sourceDir: options.skillsSourceDir,
      workspaceDir: dir,
    });
    healed.push(...skills.healed);
    if (skills.missing.length > 0) {
      log(`personal workspace: no source for skills ${skills.missing.join(", ")}`);
    }
  }
  const written = [...healed, ...retired];
  if (written.length === 0) return { created, healed };
  const commit = () =>
    commitHeal(dir, written, {
      created,
      changed: healed.length > 0 || retired.length > 0,
      namingRule: options.namingRule,
      log,
    });
  if (options.commitLater && !created) options.commitLater(commit);
  else await commit();
  return { created, healed };
}

/**
 * Commits what a seed wrote, under the app's identity. Never throws: the
 * files are on disk either way, and a commit that cannot happen (a lock
 * left by another process, an odd repo state) is a log line.
 */
async function commitHeal(
  dir: string,
  written: string[],
  heal: {
    created: boolean;
    changed: boolean;
    namingRule: SeedOptions["namingRule"];
    log: (message: string) => void;
  },
): Promise<void> {
  try {
    await git(dir, ["add", "-A", "--", ...written]);
    heal.log(`personal workspace: ${heal.created ? "seeded" : "refreshed"} ${written.join(", ")}`);
    // A heal that restores exactly what HEAD holds stages no change and
    // needs no commit; a new app version's contract does.
    if (await stagedMatchesHead(dir, written)) return;
    await git(dir, [
      ...APP_GIT_IDENTITY,
      "commit",
      "-m",
      composedName(
        heal.created
          ? "seed the personal workspace"
          : heal.changed
            ? "refresh managed files"
            : "seed the sequences skill",
        heal.namingRule?.() ?? null,
      ),
      "--only",
      "--",
      ...written,
    ]);
  } catch (error) {
    heal.log(`personal workspace: could not commit managed files: ${String(error)}`);
  }
}

async function stagedMatchesHead(dir: string, paths: string[]): Promise<boolean> {
  try {
    await git(dir, ["diff", "--cached", "--quiet", "--", ...paths]);
    return true;
  } catch {
    // Exit 1 means the index differs from HEAD (or there is no HEAD yet).
    return false;
  }
}

/**
 * The directory is itself a repo's top level - not merely inside one, which
 * `rev-parse --is-inside-work-tree` would also say of a plain folder under
 * some ancestor repo.
 */
async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    const top = await git(dir, ["rev-parse", "--show-toplevel"]);
    return (await realpath(top)) === (await realpath(dir));
  } catch {
    return false;
  }
}
