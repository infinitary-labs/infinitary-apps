import { formatList } from "@shared/i18n/format";
import { type Said, said } from "@shared/i18n/said";

/** The words a batch puts on the Activity feed and its tasks, from one owner. */
export const BATCH_WORDS = {
  formed: (project: string, label: string, count: number): Said =>
    count === 1
      ? said("feedBatchFormedOne", { project, label })
      : said("feedBatchFormedMany", { project, label, count }),
  merged: (project: string, label: string, count: number): Said =>
    count === 1
      ? said("feedBatchMergedOne", { project, label })
      : said("feedBatchMergedMany", { project, label, count }),
  held: (project: string, label: string, checks: readonly string[]): Said =>
    checks.length
      ? said("feedBatchHeldChecks", { project, label, checks: checks.join(", ") })
      : said("feedBatchHeldUnnamed", { project, label }),
  noWay: (project: string, label: string): Said => said("feedBatchHeldNoWay", { project, label }),
  /** The host's own words on a refused merge, kept as it gave them. */
  refused: (project: string, label: string, detail: string): Said =>
    said("feedBatchHeldRefused", { project, label, detail }),
  /** A merge the host never answered, whose pull request is still open: held, never called refused. */
  unanswered: (project: string, label: string, place: string | null | undefined): Said =>
    place
      ? said("feedBatchHeldUnanswered", { project, label, place })
      : said("feedBatchHeldUnansweredHost", { project, label }),
  /** The host's merge queue removed the batch without merging it. */
  removedHeld: (project: string, label: string, place: string | null | undefined): Said =>
    place
      ? said("feedBatchHeldRemoved", { project, label, place })
      : said("feedBatchHeldRemovedHost", { project, label }),
  queued: (project: string, label: string, place: string | null | undefined): Said =>
    place
      ? said("feedBatchQueued", { project, label, place })
      : said("feedBatchQueuedHost", { project, label }),
  /** A merge the host took and still reads as running: said once, and never sent again. */
  mergeRunning: (project: string, label: string, place: string | null | undefined): Said =>
    place
      ? said("feedBatchMergeRunning", { project, label, place })
      : said("feedBatchMergeRunningHost", { project, label }),
  /**
   * Try again on a wait whose pull request the host did not close: its merge
   * may still finish, so nothing new was sent and the wait stays.
   */
  stillOpen: (label: string, place: string | null | undefined): Said =>
    place
      ? said("settingsProjectsBatchWaitingStillOpen", { label, place })
      : said("settingsProjectsBatchWaitingStillOpenHost", { label }),
  /** A hold detail's name for a host that names no place of its own. */
  host: "The project's host",
  /** The hold's saved detail, which the batch's status reads in English. */
  removed: (place: string) =>
    `${place} removed the pull request from its merge queue without merging it; its page there says why.`,
  /** The hold's saved detail for a merge the host took and then did not make. */
  // i18n-exempt: a hold's saved detail is English text shown beside the host's own refusals (docs/i18n.md, "Saved facts")
  notMerged: (place: string) =>
    `${place} took the merge and did not make it; its page there says why. Nothing was sent again: Try again sends a new merge.`,
  /** The hold's saved detail for a merge whose answer never came and that has not happened. */
  // i18n-exempt: a hold's saved detail is English text shown beside the host's own refusals (docs/i18n.md, "Saved facts")
  unconfirmed: (place: string) =>
    `${place} did not confirm the merge and the pull request is still open there. Nothing was sent again: Try again sends a new merge.`,
  blocked: (project: string, label: string, place: string | null | undefined): Said =>
    place
      ? said("feedBatchBlocked", { project, label, place })
      : said("feedBatchBlockedHost", { project, label }),
  /** The repair a held batch waited for, after it sent changes back beside its fix, closed first. */
  fixClosed: (project: string, label: string): Said =>
    said("feedBatchFixClosed", { project, label }),
  retried: (project: string, label: string): Said => said("feedBatchRetried", { project, label }),
  /** A held batch runs its checks early with its declared fix, before the fix is approved. */
  trial: (project: string, label: string): Said => said("feedBatchTrial", { project, label }),
  /** That early run failed: the hold stays, and the fix's crewmate hears it. */
  trialFailed: (project: string, label: string, checks: readonly string[]): Said =>
    checks.length
      ? said("feedBatchTrialFailed", { project, label, checks: checks.join(", ") })
      : said("feedBatchTrialFailedUnnamed", { project, label }),
  /** The fix's own task line as its batch's checks start with it. */
  // i18n-exempt: a task line beside the batch's other English task lines here
  trialTask: (label: string) =>
    `The checks of ${label} now run with this fix, before it is approved. Approved at this version once they pass, the batch merges as it is, with nothing combined again.`,
  noStory: (project: string, label: string, titles: readonly string[]): Said =>
    said("feedBatchNoStory", {
      project,
      label,
      titles: formatList(titles.map((title) => `"${title}"`)),
    }),
  sentBack: (project: string, title: string, reason: string): Said =>
    said("feedBatchSentBack", { project, title, reason }),
  leftOut: (reason: string) =>
    `This change was left out of its batch because ${reason}. Bring the branch up to date and show a new version; the other changes went on.`,
  /** Left out for a clash with a change ahead only: the default branch does not hold that change yet. */
  leftOutAhead: (reason: string) =>
    `This change was left out of its batch because ${reason}. Nothing can be done yet, since the default branch does not hold that change: its merge goes on once that batch merges or that change leaves it.`,
  /**
   * Its crewmate was told to rebuild the change on the open batch's version
   * (docs/forge.md, "A change rebuilt on an open batch"), as a line on its task.
   */
  // i18n-exempt: a task line beside the left-out lines here, which carry the batch's English reasons
  rebuild: (reason: string, head: string) =>
    `This change clashes with the open batch: ${reason}. Its crewmate was told to rebuild it on the batch's version ${head} now, so it goes in line right behind that batch's changes.`,
  /** The change ahead that a left-out change clashed with merged with its batch. */
  clashMerged:
    "The change this one clashed with merged with its batch, so this change can be brought up to date with the default branch now.",
  /** The change ahead that a left-out change clashed with left its batch. */
  clashLeft:
    "The change this one clashed with left its batch, so this change goes back in line at the version approved.",
  sentBackTask: (reason: string) => `This change was sent back from its batch: ${reason}`,
  superseded: (label: string, link: string | null) =>
    `This change merged as part of ${label}${link ? ` (${link})` : ""}, so this pull request is closed.`,
  ended:
    "That batch is no longer held or waiting at that version, so nothing was done; Settings shows it as it is now.",
  // i18n-exempt: a refusal served to the first mate's tool, never shown to a person
  noRepairHeld: "No batch of this project is held, so there is no repair to record.",
  notMember: (task: string) => `${task} is not in the held batch, so nothing was sent back.`,
  namedTwice: (task: string) =>
    `${task} is named more than once, so nothing was sent back: name each change once, with one reason.`,
} as const;
