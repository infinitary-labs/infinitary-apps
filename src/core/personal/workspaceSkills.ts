import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import retiredSkillIds from "../../../resources/personal-workspace/retired-skills.json" with {
  type: "json",
};

/**
 * The app-owned skills in the personal workspace (talk-to-personalize Step
 * 3, docs/personal-panels.md).
 *
 * The crewmate that personalizes the app discovers `.claude/skills/` in the
 * workspace it works in, exactly as a crewmate working on the app discovers
 * the repo's. Two kinds of skill land there:
 *
 * - `infinitary-design`, the app's OWN design skill, copied from the
 *   self-source tree. Not a summary of it, and not a second copy maintained
 *   by hand: the same files, so the crewmate personalizing the app follows
 *   the same rules as the crewmate building it, and a change to the design
 *   system reaches both at once.
 * - the authoring skills (`resources/personal-workspace/skills/`): how to
 *   write a panel, and one per data source.
 *
 * They are app-owned and SELF-HEALED the way the managed files are
 * (./workspace.ts), only as trees rather than single files: a seed makes
 * each managed skill directory match its source exactly, restoring what was
 * deleted and removing what was added, so the rules cannot be quietly
 * rewritten from inside the workspace. Everything else - the extensions
 * themselves above all - is the workspace's and is never touched.
 *
 * Content, not `mtime`, decides: a copy is made only where the bytes differ,
 * so an untouched workspace costs one read of ~5 MB on each side at boot and
 * writes nothing. The files are compared, copied and removed concurrently -
 * a tree is some hundred and fifty files, and one at a time is hundreds of
 * round trips to the file system queued end to end.
 */

/** Where skills live inside the workspace. */
export const WORKSPACE_SKILLS_DIR = join(".claude", "skills");

/** The app's own design skill, at its one home in the tree. */
export const DESIGN_SKILL_ID = "infinitary-design";
const DESIGN_SKILL_SOURCE = join(".claude", "skills", DESIGN_SKILL_ID);

/**
 * The design skill's folder before the Infinitary rename (step 9): an
 * app-owned copy a seed takes away, so the workspace keeps one design skill.
 */
export const RETIRED_SKILL_IDS = retiredSkillIds as [string, ...string[]];

/** The authoring skills, at theirs. */
export const AUTHORING_SKILL_IDS = [
  "runbooks",
  "personal-panel",
  "github-prs",
  "quota",
  "tasks-and-feed",
  "usage",
  "clock-timer-scratchpad",
] as const;
export const AUTHORING_SKILLS_SOURCE = join("resources", "personal-workspace", "skills");

export type SeedSkillsOptions = {
  /** The self-source root: the checkout in dev, Resources/self-source packaged. */
  sourceDir: string;
  /** The personal workspace root. */
  workspaceDir: string;
};

export type SeedSkillsResult = {
  /** Workspace-relative skill directories written or repaired this time. */
  healed: string[];
  /** Skill ids whose source is missing: reported, never faked. */
  missing: string[];
};

function sourceOf(skillId: string): string {
  return skillId === DESIGN_SKILL_ID ? DESIGN_SKILL_SOURCE : join(AUTHORING_SKILLS_SOURCE, skillId);
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([readFile(a), readFile(b)]);
  return left.equals(right);
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) found.push(relative(root, path));
      }),
    );
  };
  await walk(root);
  return found;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Makes `target` an exact copy of `source`; answers whether anything changed. */
async function syncTree(source: string, target: string): Promise<boolean> {
  const [wanted, present] = await Promise.all([
    filesUnder(source).then((files) => new Set(files)),
    exists(target).then(async (there) => new Set(there ? await filesUnder(target) : [])),
  ]);
  const removed = await Promise.all(
    [...present]
      .filter((file) => !wanted.has(file))
      .map(async (file) => {
        await rm(join(target, file));
        return true;
      }),
  );
  const copied = await Promise.all(
    [...wanted].map(async (file) => {
      const from = join(source, file);
      const to = join(target, file);
      if (present.has(file) && (await sameBytes(from, to))) return false;
      await mkdir(join(to, ".."), { recursive: true });
      await copyFile(from, to);
      return true;
    }),
  );
  return removed.length > 0 || copied.includes(true);
}

/** Every skill the app owns in the workspace, design skill first. */
export function managedSkillIds(): string[] {
  return [DESIGN_SKILL_ID, ...AUTHORING_SKILL_IDS];
}

export async function seedWorkspaceSkills(options: SeedSkillsOptions): Promise<SeedSkillsResult> {
  const healed: string[] = [];
  const missing: string[] = [];
  for (const skillId of RETIRED_SKILL_IDS) {
    const relativePath = join(WORKSPACE_SKILLS_DIR, skillId);
    const retired = join(options.workspaceDir, relativePath);
    if (!(await exists(retired))) continue;
    await rm(retired, { recursive: true, force: true });
    healed.push(relativePath);
  }
  for (const skillId of managedSkillIds()) {
    const source = join(options.sourceDir, sourceOf(skillId));
    if (!(await exists(source))) {
      missing.push(skillId);
      continue;
    }
    const relativePath = join(WORKSPACE_SKILLS_DIR, skillId);
    if (await syncTree(source, join(options.workspaceDir, relativePath))) {
      healed.push(relativePath);
    }
  }
  return { healed, missing };
}
