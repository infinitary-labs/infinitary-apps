import {
  type FolderNoticed,
  type FolderRefreshCause,
  folderRefreshWords,
} from "@shared/folderRefresh";
import { FOLDER_REPAIR_TITLE, PULL_REPAIR_TITLE } from "./intentBrief";

/**
 * The feed's receipt of a settle the captain clicked, in the app's words
 * (`SettleService`): a discard that went through, and a merge that did not,
 * said in what its failure means (`plainProblem`); and the words around
 * the first mate's own sentence when it closes started work without their
 * click. A plain module, so a journey reads the receipt from its owner;
 * `crewSupervisor.test.ts` owns the sentences.
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

/**
 * A merge whose project folder the host could not bring up to date
 * (INF-549): why, in plain words, and the task that does it - filed now, or
 * already standing for the project.
 */
export function folderNotUpdatedText(
  cause: FolderRefreshCause,
  repair: { key: string; filed: boolean } | undefined,
): string {
  const why = `Merged, but your project's folder was not brought up to date: ${folderRefreshWords(cause)}.`;
  if (!repair) return why;
  return repair.filed
    ? `${why} Infinitary started ${repair.key} "${FOLDER_REPAIR_TITLE}" to do it.`
    : `${why} ${repair.key} "${FOLDER_REPAIR_TITLE}" is already doing it.`;
}

/**
 * Work refused because the project's folder is missing (INF-572): the
 * folder, what could not happen, and the task that brings it back - filed
 * now, or already standing for the project.
 */
export function folderMissingText(
  folder: string,
  noticed: FolderNoticed,
  repair: { key: string; filed: boolean } | undefined,
): string {
  const what =
    noticed === "land"
      ? "nothing can be merged into it"
      : noticed === "branch-home"
        ? "the task's branch cannot come to it from the computer it runs on"
        : "this task cannot start on this computer";
  const why = `Your project's folder ${folder} is missing, so ${what}.`;
  if (!repair) return why;
  return repair.filed
    ? `${why} Infinitary started ${repair.key} "${FOLDER_REPAIR_TITLE}" to bring it back.`
    : `${why} ${repair.key} "${FOLDER_REPAIR_TITLE}" is already bringing it back.`;
}

/**
 * The task the host files for a pull request an abandoned task could not
 * close (INF-549's sibling): filed now, or already standing for it. Said
 * after what the host answered.
 */
export function pullLeftOpenText(repair: { key: string; filed: boolean }): string {
  return repair.filed
    ? `Infinitary started ${repair.key} "${PULL_REPAIR_TITLE}" to close it.`
    : `${repair.key} "${PULL_REPAIR_TITLE}" is already closing it.`;
}

/**
 * What became of started work the first mate closed without the captain's
 * click (INF-547), from the close's own reason: the word the first mate's
 * note leads with and the one Activity's line for a drop opens with.
 */
export type ClosedWithoutClick = "merged" | "released" | "dropped";

/** The close reasons a first mate's closing sentence rides, by what they mean. */
export function closedWithoutClick(reason: string): ClosedWithoutClick | undefined {
  if (reason === "merged" || reason === "landed") return "merged";
  if (reason === "released") return "released";
  if (reason === "discarded" || reason === "cancelled") return "dropped";
  return undefined;
}

/** The first mate's note on a task it closed: its key and what became of it. */
export function closingNoteTitle(key: string, outcome: ClosedWithoutClick): string {
  return `${key} ${outcome}`;
}

/** Activity's line for a drop that carries the first mate's sentence. */
export function droppedLine(sentence: string): string {
  return `Dropped: ${sentence}`;
}
