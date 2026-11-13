import { changeNumberLabel, type ForgeKind } from "@shared/forge";
import * as m from "@shared/i18n/messages.generated";
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
  get delivery() {
    return m.settingsProjectsDelivery();
  },
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
  get needs() {
    return m.settingsProjectsQueueNeeds();
  },
  get label() {
    return m.settingsProjectsQueueHowToLabel();
  },
  get steps(): readonly string[] {
    return [
      m.settingsProjectsQueueStepAsk(),
      m.settingsProjectsQueueStepWorkflow({ status: QUEUE_STATUS }),
      m.settingsProjectsQueueStepSet({ status: QUEUE_STATUS }),
    ];
  },
  get firstMate() {
    return m.settingsProjectsQueueFirstMate();
  },
  get guide() {
    return m.settingsProjectsQueueGuideGithub();
  },
  guideLink: "https://docs.github.com/en/rest/commits/statuses#create-a-commit-status",
  /**
   * On GitLab a waiting status cannot be set waiting again, so the waiting
   * mark is a finished status whose description says it waits
   * (docs/forge.md, "The shipped queue on GitLab").
   */
  gitlab: {
    get steps(): readonly string[] {
      return [
        m.settingsProjectsQueueStepAsk(),
        m.settingsProjectsQueueStepPipelineGitlab({ status: QUEUE_STATUS }),
        m.settingsProjectsQueueStepSetGitlab({ status: QUEUE_STATUS }),
      ];
    },
    get guide() {
      return m.settingsProjectsQueueGuideGitlab();
    },
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
  get title() {
    return m.settingsProjectsQueueKeyTitle();
  },
  missing: (place: string) => m.settingsProjectsQueueKeyMissing({ place }),
  ready: (date: string) => m.settingsProjectsQueueKeyReady({ date }),
  unreadable: (place: string) => m.settingsProjectsQueueKeyUnreadable({ place }),
  get make() {
    return m.settingsProjectsQueueKeyMake();
  },
  get remake() {
    return m.settingsProjectsQueueKeyRemake();
  },
  get made() {
    return m.settingsProjectsQueueKeyMade();
  },
} as const;

/**
 * What "Where changes go" says on a project that runs the queue Infinitary
 * ships (docs/forge.md, "The shipped queue"): the project decides for
 * everyone working on it, so the choice is fixed here.
 */
export const QUEUE_SHIPPED_WORDS = {
  set: (version: number) => m.settingsProjectsQueueShipped({ version: String(version) }),
} as const;

/**
 * A project's paused batch in Settings (docs/forge.md, "A paused batch";
 * the captain's quiet choice: no card, Settings shows the pause with its
 * Resume).
 */
export const QUEUE_PAUSE_WORDS = {
  get title() {
    return m.settingsProjectsPauseTitle();
  },
  summary: (run: number, changes: readonly number[], since: string, kind?: ForgeKind) =>
    m.settingsProjectsPauseSummary({
      count: changes.length,
      since,
      run: String(run),
      // A plain comma join, as the summary always wrote it.
      changes: changes.map((number) => changeNumberLabel(kind, number)).join(", "),
    }),
  claimed: (who: string) => m.settingsProjectsPauseClaimed({ who }),
  get unclaimed() {
    return m.settingsProjectsPauseUnclaimed();
  },
  get unread() {
    return m.settingsProjectsPauseUnread();
  },
  get issue() {
    return m.settingsProjectsPauseIssue();
  },
  get run() {
    return m.settingsProjectsPauseRun();
  },
  get reason() {
    return m.settingsProjectsPauseReason();
  },
  get resume() {
    return m.settingsProjectsPauseResume();
  },
  get sendBack() {
    return m.settingsProjectsPauseSendBack();
  },
  get sendBackWhich() {
    return m.settingsProjectsPauseSendBackWhich();
  },
  get needsReason() {
    return m.settingsProjectsPauseNeedsReason();
  },
  get sent() {
    return m.settingsProjectsPauseSent();
  },
} as const;

/** What "Where changes go" says on a project whose host runs no queue Infinitary can use. */
export function queueNoHostWords(): string {
  return m.settingsProjectsQueueNoHost();
}

/**
 * What "Where changes go" says while a project's batched choice waits for
 * its queue workflow (INF-2885 direction B, docs/forge.md "Choosing batched
 * pull requests before a queue exists"): the choice applies by itself once
 * a workflow that mentions the batch check merges.
 */
export function queueWaitingWords(delivery: RepoView["delivery"]): string {
  return m.settingsProjectsQueueWaiting({ delivery: PROJECT_DELIVERY_WORDS[delivery] });
}

/**
 * The quiet words after a closed project row's name (INF-1495, the captain's
 * direction A): each names one way the project differs from a new one, which
 * is offered as pull requests where it lives, asks first, takes Default rigor
 * and runs on a computer chosen automatically.
 */
export const PROJECT_ROW_WORDS = {
  get personal() {
    return m.settingsProjectsRowPersonal();
  },
  get linked() {
    return m.settingsProjectsRowLinked();
  },
  localMerge: PROJECT_DELIVERY_WORDS["local-only"],
  mergesOnItsOwn: AUTONOMY_WORDS.putsInItself.toLowerCase(),
  get quick() {
    return m.settingsProjectsRowCare({ care: RIGOR_WORDS.quick });
  },
  get careful() {
    return m.settingsProjectsRowCare({ care: RIGOR_WORDS.reviewed });
  },
  runs: (where: string) => m.settingsProjectsRowRuns({ where }),
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
