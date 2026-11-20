import { hasChangeRequests } from "@shared/forge";
import { hostedPresentation } from "@shared/presentationDestination";
import { type Forge, type ForgePull, isForkReview } from "../forge";
import { currentChange } from "../storage/changeProjection";
import type { TaskService } from "../tasks/taskService";
import { numberLabel } from "./changeContext";

/**
 * The merge card of a story pull request merged outside the app (FI3-213,
 * INF-3799): the published story it merged with and the pull request read
 * merged, or why it has none in words, since a merged pull request takes no
 * new story. That card declares the merge closes the task, and its click
 * closes it as merged with nothing sent.
 */
export type MergedStory =
  | { pull: ForgePull; revision: number; refreshOf?: number }
  | { refused: string };

/**
 * The pull request a published story went to, by number, when it is the
 * task's current change on `branch` where the host keeps pull requests: the
 * one whose merge outside the app a merged-story card could show.
 */
function storyPullNumber(
  tasks: TaskService,
  taskId: string,
  forge: Forge,
  branch: string,
): number | undefined {
  const record = tasks.get(taskId);
  if (!record?.branch || !hasChangeRequests(forge.kind)) return undefined;
  const target = record.delivery?.checkTarget;
  if (target && isForkReview(target)) return undefined;
  const current = currentChange(record.delivery, record.branch);
  if (current.number === undefined || current.branch !== branch) return undefined;
  const ledger = tasks.delivery.changePresentation(taskId, branch);
  const newest = ledger?.revisions.at(-1);
  if (!ledger?.published || !newest || !hostedPresentation(newest.destination)) return undefined;
  return (ledger.published.number ?? current.number) === current.number
    ? current.number
    : undefined;
}

/**
 * The merge card `pull` can show, read merged by its number: one verdict
 * for show_merge_card, emit_card with presentation and check_change's merged
 * words, so check_change never asks for a card the other two refuse.
 * Undefined when `pull` is not the merged pull request of the task's
 * published story.
 */
export function mergedStoryOf(
  tasks: TaskService,
  taskId: string,
  forge: Forge,
  branch: string,
  pull: ForgePull,
): MergedStory | undefined {
  const number = storyPullNumber(tasks, taskId, forge, branch);
  const ledger = tasks.delivery.changePresentation(taskId, branch);
  const published = ledger?.published;
  const newest = ledger?.revisions.at(-1);
  if (number === undefined || !pull.merged || pull.number !== number || !published || !newest)
    return undefined;
  const label = numberLabel(forge, pull.number);
  const report =
    "A merged pull request takes no new story, so it has no merge card: report the merge and any remaining work, and the first mate closes the task.";
  if (newest.revision !== published.revision)
    return {
      refused: `${label} was merged outside the app carrying story revision ${published.revision}, and story revision ${newest.revision} was prepared after it and never published. ${report}`,
    };
  if (published.head !== pull.headSha)
    return {
      refused: `${label} was merged outside the app at ${pull.headSha}, a version its published story revision ${published.revision} at ${published.head} never reached. ${report}`,
    };
  return {
    pull,
    revision: published.revision,
    ...(published.refreshOf !== undefined ? { refreshOf: published.refreshOf } : {}),
  };
}

/**
 * `mergedStoryOf` for the task's story pull request, read by its number
 * once the branch has no open pull request.
 */
export async function mergedStory(
  tasks: TaskService,
  taskId: string,
  forge: Forge,
  branch: string,
): Promise<MergedStory | undefined> {
  const number = storyPullNumber(tasks, taskId, forge, branch);
  if (number === undefined || !forge.pull) return undefined;
  return mergedStoryOf(tasks, taskId, forge, branch, await forge.pull(number));
}

/**
 * The refusal when the committed version is not the one that merged: the
 * merge card shows the merged version, and later commits are a new change.
 */
export function mergedAheadWords(forge: Forge, pull: ForgePull, committed: string): string {
  return `${numberLabel(forge, pull.number)} was merged outside the app at ${pull.headSha}, and the committed version here is ${committed}, which did not merge. Its merge card shows the version that merged: check that version out to show it. Commits after that merge need a change of their own.`;
}
