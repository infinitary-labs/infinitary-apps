import { AUTOMATIC_COMPUTER } from "@shared/placement";
import { QUEUE_STATUS, type RepoView } from "@shared/repos";
import { AUTONOMY_WORDS, CARE_WORDS, PROJECT_DELIVERY_WORDS } from "@shared/vocabulary";

/**
 * Words of a project's policy rows in Settings -> Projects (`ProjectsTab`),
 * in a plain module so an e2e spec reads them from their owner
 * (docs/e2e-contracts.md, "Words come from their owner").
 */
export const PROJECT_POLICY_WORDS = {
  /** What "Where changes go" says on every project but the personal workspace. */
  delivery:
    "Offered as a pull request where the project lives, as a batched pull request your project's own queue tests before it merges, or merged locally with no pull request.",
} as const;

/**
 * What the batched choice needs, shown under "Where changes go" while a
 * project has it (INF-2887, the captain's "Explain in Settings what the
 * choice needs and link to the how-to"): the app only marks an approved
 * version waiting, and a workflow of the project's own must pass or fail it
 * (docs/forge.md, "A project's queue").
 */
export const QUEUE_HOW_TO_WORDS = {
  needs:
    "A batched pull request merges only once a queue workflow in your project on GitHub passes it. Until your project has one, an approved merge waits.",
  label: "How to set one up",
  steps: [
    `Add a GitHub Actions workflow to your project that finds pull requests whose ${QUEUE_STATUS} status is pending.`,
    "Have it test those versions, together or one at a time.",
    `Have it set ${QUEUE_STATUS} to success or failure on each version, with the reason in its description. Infinitary merges a version once it reads success, with no second click.`,
  ],
  firstMate:
    "Your first mate can write this workflow for you: ask it to set up a queue for this project.",
  guide: "Open GitHub's guide to commit statuses",
  guideLink: "https://docs.github.com/en/rest/commits/statuses#create-a-commit-status",
} as const;

/**
 * The quiet words after a closed project row's name (INF-1495, the captain's
 * direction A): each names one way the project differs from a new one, which
 * is offered as pull requests where it lives, asks first, takes Default care
 * and runs on a computer chosen automatically.
 */
export const PROJECT_ROW_WORDS = {
  personal: "builds in place",
  linked: "linked",
  localMerge: PROJECT_DELIVERY_WORDS["local-only"],
  mergesOnItsOwn: AUTONOMY_WORDS.putsInItself.toLowerCase(),
  quick: `${CARE_WORDS.quick} care`,
  careful: `${CARE_WORDS.reviewed} care`,
  runs: (where: string) => `runs ${where}`,
} as const;

/** Whether `path` is the projects folder or inside it. */
export function inProjectsFolder(path: string, folder: string): boolean {
  const root = folder.replace(/\/+$/, "");
  return path === root || path.startsWith(`${root}/`);
}

/**
 * What a closed project row says after its name, in order: only what differs
 * from a new project. `folder` is the projects folder, or null while it is
 * unread; a project outside it reads `linked` and its row shows its path.
 * `runsWhere` places the project's chosen computer ("on Mac mini"), or is
 * null when Runs on is not drawn.
 */
export function projectRowWords(
  repo: Pick<RepoView, "kind" | "path" | "delivery" | "autonomy" | "rigor" | "runsOn">,
  folder: string | null,
  runsWhere: string | null,
): string[] {
  if (repo.kind === "personal") return [PROJECT_ROW_WORDS.personal];
  const words: string[] = [];
  if (folder !== null && !inProjectsFolder(repo.path, folder)) words.push(PROJECT_ROW_WORDS.linked);
  if (repo.delivery === "local-only") words.push(PROJECT_ROW_WORDS.localMerge);
  if (repo.autonomy) words.push(PROJECT_ROW_WORDS.mergesOnItsOwn);
  if (repo.rigor === "quick") words.push(PROJECT_ROW_WORDS.quick);
  if (repo.rigor === "reviewed") words.push(PROJECT_ROW_WORDS.careful);
  if (runsWhere && repo.runsOn && repo.runsOn !== AUTOMATIC_COMPUTER)
    words.push(PROJECT_ROW_WORDS.runs(runsWhere));
  return words;
}
