import { changeNumberLabel, type ForgeKind } from "@shared/forge";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import { QUEUE_STATUS, type RepoView } from "@shared/repos";
import { AUTONOMY_WORDS, PROJECT_DELIVERY_WORDS, RIGOR_WORDS } from "@shared/vocabulary";

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
 * project has it and runs no queue Infinitary ships (INF-2887, the
 * captain's "Explain in Settings what the choice needs and link to the
 * how-to"): the app only marks an approved version waiting, and the
 * project's queue must pass or fail it (docs/forge.md, "A project's queue").
 * The first way is the queue Infinitary ships, planned with the first mate.
 */
export const QUEUE_HOW_TO_WORDS = {
  needs:
    "A batched pull request merges only once your project's queue passes it. Until your project has one, an approved merge waits.",
  label: "How to set one up",
  steps: [
    "Ask your first mate to set up the queue Infinitary ships. It plans with you which of your project's checks each batch runs, and a batch that fails pauses until a fix is approved.",
    `Or write your own workflow that finds pull requests whose ${QUEUE_STATUS} status is pending and tests them, together or one at a time.`,
    `Have it set ${QUEUE_STATUS} to success or failure on each version, with the reason in its description. Infinitary merges a version once it reads success, with no second click.`,
  ],
  firstMate:
    "Your first mate can plan the queue with you: ask it to set up a queue for this project.",
  guide: "Open GitHub's guide to commit statuses",
  guideLink: "https://docs.github.com/en/rest/commits/statuses#create-a-commit-status",
  /**
   * On GitLab a waiting status cannot be set waiting again, so the waiting
   * mark is a finished status whose description says it waits
   * (docs/forge.md, "The shipped queue on GitLab").
   */
  gitlab: {
    steps: [
      "Ask your first mate to set up the queue Infinitary ships. It plans with you which of your project's checks each batch runs, and a batch that fails pauses until a fix is approved.",
      `Or write your own pipeline that finds merge requests whose newest ${QUEUE_STATUS} status says Waiting for the batch check, and tests them, together or one at a time.`,
      `Have it set ${QUEUE_STATUS} to success or failed on each version, with the reason in its description. Infinitary merges a version once it reads success, with no second click.`,
    ],
    guide: "Open GitLab's guide to commit statuses",
    guideLink: "https://docs.gitlab.com/api/commits/#set-the-pipeline-status-of-a-commit",
  },
} as const;

/** The how-to's steps and guide for a project's host. */
export function queueHowTo(kind: ForgeKind | undefined): {
  steps: readonly string[];
  guide: string;
  guideLink: string;
} {
  return kind === "gitlab" ? QUEUE_HOW_TO_WORDS.gitlab : QUEUE_HOW_TO_WORDS;
}

/**
 * The key the shipped queue writes with on GitLab, under "Where changes go"
 * (docs/forge.md, "The shipped queue on GitLab"; the plan's "one click
 * creates its project token"). GitLab hands a pipeline no key that may
 * write a status, so the queue keeps its own in the project's CI settings.
 */
export const QUEUE_KEY_WORDS = {
  title: "The queue's key",
  missing: (place: string) =>
    `Your project's queue needs its own key on ${place} to write each change's batch check. Infinitary makes it with your sign-in and keeps it in the project's CI settings, where only the queue's own jobs can read it.`,
  ready: (date: string) =>
    `The queue's key is in place until ${date}. Making a new one replaces it at once.`,
  unreadable: (place: string) =>
    `Your sign-in cannot read this project's keys on ${place}. Making one needs the Maintainer role on the project, and on gitlab.com a Premium or Ultimate plan.`,
  make: "Make the queue's key",
  remake: "Make a new key",
  made: "Made the queue's key. It stays in your project's CI settings, never on your computers.",
} as const;

/**
 * What "Where changes go" says on a project that runs the queue Infinitary
 * ships (docs/forge.md, "The shipped queue"): the project decides for
 * everyone working on it, so the choice is fixed here.
 */
export const QUEUE_SHIPPED_WORDS = {
  set: (version: number) =>
    `Set by your project: it runs Infinitary's queue (version ${version}), so its changes go as batched pull requests for everyone working on it.`,
} as const;

/**
 * A project's paused batch in Settings (docs/forge.md, "A paused batch";
 * the captain's quiet choice: no card, Settings shows the pause with its
 * Resume).
 */
export const QUEUE_PAUSE_WORDS = {
  title: "Batch paused",
  summary: (run: number, changes: readonly number[], since: string, kind?: ForgeKind) =>
    `Paused since ${since}: batch run ${run} failed its checks, so ${changes.length === 1 ? "one approved change waits" : `${changes.length} approved changes wait`} for a fix: ${changes.map((number) => changeNumberLabel(kind, number)).join(", ")}.`,
  claimed: (who: string) => `${who} is repairing it.`,
  unclaimed:
    "Nobody has taken the repair yet. A crewmate starts it when one of your changes is paused.",
  unread:
    "This project's issues could not be read, so who repairs it is not known, and only the paused changes this app saw are listed.",
  issue: "Open the issue",
  run: "Open the batch run",
  reason: "Why the queue may go on",
  resume: "Resume",
  sendBack: "Send back",
  sendBackWhich: "Change to send back",
  needsReason: "Say why the queue may go on first.",
  sent: "Asked the queue to go on. The pause ends once its next batch starts.",
} as const;

/** What "Where changes go" says on a project whose host runs no queue Infinitary can use. */
export const QUEUE_NO_HOST_WORDS =
  "Batched pull requests are not offered here: this project's host has no CI that can run Infinitary's queue.";

/**
 * What "Where changes go" says while a project's batched choice waits for
 * its queue workflow (INF-2885 direction B, docs/forge.md "Choosing batched
 * pull requests before a queue exists"): the choice applies by itself once
 * a workflow that mentions the batch check merges.
 */
export function queueWaitingWords(delivery: RepoView["delivery"]): string {
  return `Batched pull requests turn on once a workflow in this project that mentions its batch check merges. Until then, changes go as ${PROJECT_DELIVERY_WORDS[delivery]}.`;
}

/**
 * The quiet words after a closed project row's name (INF-1495, the captain's
 * direction A): each names one way the project differs from a new one, which
 * is offered as pull requests where it lives, asks first, takes Default rigor
 * and runs on a computer chosen automatically.
 */
export const PROJECT_ROW_WORDS = {
  personal: "builds in place",
  linked: "linked",
  localMerge: PROJECT_DELIVERY_WORDS["local-only"],
  mergesOnItsOwn: AUTONOMY_WORDS.putsInItself.toLowerCase(),
  quick: `${RIGOR_WORDS.quick} rigor`,
  careful: `${RIGOR_WORDS.reviewed} rigor`,
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
