/**
 * The feed's receipt of a settle the captain clicked, in the app's words
 * (`SettleService`): a discard that went through, and a merge that did not,
 * said in what its failure means (`plainProblem`). A plain module, so a
 * journey reads the receipt from its owner; `crewSupervisor.test.ts` owns
 * the sentences.
 */

/** A discard that closed the task, then what became of its pull request, when it had one. */
export function discardedText(title: string, pullRequest = ""): string {
  return `Discarded "${title}".${pullRequest ? ` ${pullRequest}` : ""}`;
}

/** A merge that did not go in, in what its failure means. */
export function cannotMergeText(title: string, plain: string): string {
  return `Cannot merge "${title}": ${plain}`;
}

/**
 * A discard refused because it would destroy work that was never merged:
 * the commits and uncommitted edits the task's working copy holds, and the
 * two ways on - confirm the discard, or merge the work (`keepMode`).
 */
export function unlandedWorkText(
  task: { key: string; title: string },
  work: { dirty: boolean; unlandedCommits: number },
  keepMode: "merge-pr" | "land",
): string {
  const parts = [
    work.unlandedCommits > 0
      ? `${work.unlandedCommits} ${work.unlandedCommits === 1 ? "commit" : "commits"}`
      : "",
    work.dirty ? "uncommitted edits" : "",
  ].filter(Boolean);
  return `Cannot discard ${task.key} "${task.title}" without confirm: ${parts.join(" and ")} that were never merged. Discard with confirm to abandon ${parts.length === 1 ? "it" : "them"}, or ${keepMode === "merge-pr" ? "merge the pull request" : "merge the branch"} instead.`;
}
