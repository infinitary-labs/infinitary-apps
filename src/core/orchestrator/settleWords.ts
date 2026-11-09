import { MERGE_CLOSES_WORDS } from "@shared/cards";
import {
  type FolderNoticed,
  type FolderRefreshCause,
  folderRefreshWords,
} from "@shared/folderRefresh";
import { forgePlace } from "@shared/forge";
import { POLICY_MERGING_WORDS } from "@shared/taskPolicies";
import type { TaskRecord } from "../storage/taskRecords";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { escapeCardText } from "./cardText";
import { FOLDER_REPAIR_TITLE, PULL_REPAIR_TITLE } from "./intentBrief";

/**
 * The feed's receipt of a settle the captain clicked, in the app's words
 * (`SettleService`): the click itself, a discard that went through, and a
 * merge that did not, said in what its failure means (`plainProblem`). Each
 * is a line on the task's own record, so Activity paints the task's key
 * before it and the words never name the task again (INF-1845); and the words around
 * the first mate's own sentence when it closes started work without their
 * click. A plain module, so a journey reads the receipt from its owner;
 * The settle owners' tests (`settleOwners.discard.test.ts`,
 * `settleOwners.keptMerge.test.ts`) and the card tests that import it own the sentences.
 */

/**
 * The captain's click, until its outcome takes the line's place: the change
 * by its label where it has one ("Merging #709"), and whether it waits for
 * the crewmate's turn to end.
 */
export function settlingText(
  mode: "merge-pr" | "land" | "discard",
  change: string | undefined,
  waitsForTurn: boolean,
): string {
  const action = mode === "discard" ? "Discarding" : change ? `Merging ${change}` : "Merging";
  return waitsForTurn ? `${action} once its crewmate finishes what it is doing` : action;
}

/** A discard that closed the task, then what became of its pull request, when it had one. */
export function discardedText(pullRequest = ""): string {
  return `Discarded.${pullRequest ? ` ${pullRequest}` : ""}`;
}

/** A drop refused because the task is a decision, which holds no crew work to drop. */
export function decisionDropRefusal(key: string): string {
  return `Task ${key} is a decision, not crew work, so there is nothing to drop.`;
}

/** A merge that did not go in, in what its failure means. */
export function cannotMergeText(plain: string): string {
  return `Cannot merge: ${plain}`;
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
export type ClosedWithoutClick = "merged" | "released" | "finished" | "dropped";

/** The close reasons a first mate's closing sentence rides, by what they mean. */
export function closedWithoutClick(reason: string): ClosedWithoutClick | undefined {
  if (reason === "merged" || reason === "landed") return "merged";
  if (reason === "released") return "released";
  if (reason === "finished") return "finished";
  if (reason === "discarded" || reason === "cancelled") return "dropped";
  return undefined;
}

/**
 * The line the app writes on the card that answers the captain's message
 * when its work closes later (INF-1610's at most one closing note): what
 * became of the work and the first mate's sentence, found again by its
 * `data-close-line` mark, never by its words. A merge writes the merge line
 * instead.
 */
export const CLOSE_LINE_MARK = "data-close-line";
const CLOSE_LINE_OPEN = `<p class="inf-panel" ${CLOSE_LINE_MARK}>`;
const CLOSE_LINE = new RegExp(`${CLOSE_LINE_OPEN}[\\s\\S]*?</p>`);

/** The close line: the work's key and what became of it, then the first mate's sentence. */
export function closedLine(key: string, outcome: ClosedWithoutClick, sentence?: string): string {
  const said = sentence?.trim() ? `<br>Your first mate: “${escapeCardText(sentence.trim())}”` : "";
  return `${CLOSE_LINE_OPEN}<strong>${escapeCardText(closingNoteTitle(key, outcome))}</strong>${said}</p>`;
}

/** The body with its close line put first, or the one it had replaced. */
export function withCloseLine(body: string, line: string): string {
  return CLOSE_LINE.test(body) ? body.replace(CLOSE_LINE, () => line) : `${line}${body}`;
}

/** The first mate's note on a task it closed: its key and what became of it. */
export function closingNoteTitle(key: string, outcome: ClosedWithoutClick): string {
  return `${key} ${outcome}`;
}

/** Activity's line for a drop that carries the first mate's sentence. */
export function droppedLine(sentence: string): string {
  return `Dropped: ${sentence}`;
}

/**
 * The line a task that merges on its own opens its story note with
 * (INF-1219, the captain's direction A): before the merge, the app's words
 * from the setting; at the merge, the same line rewritten on the same note
 * with when it merged, its pull request and the first mate's closing
 * sentence. The host writes it after the card lint and finds it again by
 * its `data-merge-line` mark, never by its words.
 */
export const MERGE_LINE_MARK = "data-merge-line";
const MERGE_LINE_OPEN = `<p class="inf-panel" ${MERGE_LINE_MARK}>`;
const MERGE_LINE = new RegExp(`${MERGE_LINE_OPEN}[\\s\\S]*?</p>`);

/** Who set the task to merge on its own, in the app's words. */
export const MERGE_SETTING_WORDS = {
  task: "Set by your first mate for this task.",
  project: "Set in this project's settings.",
} as const;

/** What the line says while the merge is still to come. */
export const MERGES_NEXT_WORDS = "the app merges it once its checks pass.";

/** The merged line's lead: on its own, or by the captain's own click. */
export function mergedWords(at: string, onItsOwn: boolean): string {
  return `${onItsOwn ? "Merged on its own" : "Merged"} at ${at}`;
}

/** The line before the merge. */
export function pendingMergeLine(source: keyof typeof MERGE_SETTING_WORDS): string {
  return `${MERGE_LINE_OPEN}<strong>${POLICY_MERGING_WORDS.on}</strong> · ${MERGES_NEXT_WORDS}<br><span class="inf-muted">${MERGE_SETTING_WORDS[source]}</span></p>`;
}

/** The line after the merge; `change` is the pull request as the card names it ("PR #476"). */
export function mergedLine(input: {
  at: number;
  onItsOwn: boolean;
  change?: { label: string; url?: string };
  sentence?: string;
  /** The merge kept the task open (INF-2533): the line says it continues. */
  continues?: boolean;
}): string {
  const time = new Date(input.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const change = input.change
    ? ` · ${
        input.change.url && /^https:\/\//.test(input.change.url)
          ? `<a class="inf-mono" href="${escapeCardText(input.change.url)}">${escapeCardText(input.change.label)}</a>`
          : `<span class="inf-mono">${escapeCardText(input.change.label)}</span>`
      }`
    : "";
  const sentence = input.sentence?.trim()
    ? `<br>Your first mate: “${escapeCardText(input.sentence.trim())}”`
    : "";
  const continues = input.continues ? `<br>${MERGE_CLOSES_WORDS.continues}.` : "";
  return `${MERGE_LINE_OPEN}<strong>${mergedWords(time, input.onItsOwn)}</strong>${change}${continues}${sentence}</p>`;
}

/**
 * A story note's merge line once its change's receipt says merged
 * (INF-2678): when, who, its pull request, that the task continues while it
 * is open, and the first mate's closing sentence the close recorded.
 */
export function receiptMergedLine(
  record: TaskRecord,
  receipt: { at: number; by?: "captain" },
  close: { actor?: string; sentence?: string } | undefined,
): string {
  const delivery = record.delivery;
  const label =
    delivery?.prNumber !== undefined
      ? `PR ${changeName(record, delivery.prNumber)}`
      : delivery?.changeLabel;
  return mergedLine({
    at: receipt.at,
    onItsOwn: receipt.by !== "captain" && close?.actor !== "captain",
    ...(label ? { change: { label, ...(delivery?.prUrl ? { url: delivery.prUrl } : {}) } } : {}),
    ...(close?.sentence ? { sentence: close.sentence } : {}),
    ...(close ? {} : { continues: true }),
  });
}

/** Whether a body carries the merge line. */
export function hasMergeLine(body: string): boolean {
  return MERGE_LINE.test(body);
}

/** The body with its merge line put first, or the one it had replaced. */
export function withMergeLine(body: string, line: string): string {
  return hasMergeLine(body) ? body.replace(MERGE_LINE, () => line) : `${line}${body}`;
}

/**
 * The id of the note an earlier version put up after a merge click
 * (INF-1275). INF-2913 retired the note: a merge click raises no card of the
 * host's own, and only a task's close still takes one down that a running
 * app put up before it updated.
 */
export function mergePendingCardId(taskId: string): string {
  return `card-merge-pending-${taskId}`;
}

/**
 * Where the task's project lives, in the person's words ("GitHub", "GitLab",
 * a host's address); `unnamed` when its repository names no host.
 */
export function placeOf(
  repos: RepoRegistry,
  record: TaskRecord | undefined,
  unnamed = "the project's host",
): string {
  const repo = record?.repoId ? repos.get(record.repoId) : undefined;
  return (
    (repo?.host ? forgePlace({ kind: repo.host.kind, host: repo.host.name }) : null) ?? unnamed
  );
}

/**
 * The task's pull request by its number, in the host's own words: the
 * label the forge recorded for it (`#N`, `!N`), else `#N`.
 */
export function changeName(record: TaskRecord | undefined, number: number): string {
  const delivery = record?.delivery;
  return delivery?.prNumber === number && delivery.changeLabel
    ? delivery.changeLabel
    : `#${number}`;
}
