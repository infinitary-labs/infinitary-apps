import { HERE } from "@shared/deviceNames";
import { fixedHoldWords, overridePasses, softHoldWords } from "@shared/holds";
import { opensPullRequest } from "@shared/repos";
import { MERGE_WORDS, mergeWordsFor } from "@shared/vocabulary";
import { signInRefusal } from "../forge";
import type { MergeAuthorization, TaskRecord } from "../storage/taskRecords";
import type { SettleRefusal, SettleWay } from "../tasks/taskGraph";
import {
  candidateHead,
  KEPT_APPROVAL_WORDS,
  mergeHold,
  standingApprovals,
} from "./mergeAuthorization";
import type { OpenMergeAction, SettleServiceHost } from "./settleHost";
import { unlandedWorkText } from "./settleWords";
import { mergesInOwnBatch } from "./workShape";

/**
 * A settle's structured refusals (WI-12): the close gate, unlanded or
 * unreadable work, a missing sign-in and the autonomy hold, each with the
 * ways out the Firstmate turns into effect buttons.
 */

type RefusalHost = Pick<
  SettleServiceHost,
  "tasks" | "taskDelivery" | "taskAutonomy" | "repos" | "cards"
>;

/**
 * What forbids this task's record from closing (WI-12): an open child (the
 * parent close rule) or live work it waits on (the blocks rule), as a
 * structured refusal whose ways the Firstmate turns into effect buttons. A
 * discard abandons the work rather than completing it, so a wait on other
 * work cannot forbid it - only containment can. `proceed_with_open` is the
 * captain's leave to settle the task and keep its open children planned,
 * and so is his recorded override on the open parts; his override on the
 * waits passes every wait, whoever recorded it (`TaskGraph.holdingClose`).
 */
export function closeGateRefusal(
  host: RefusalHost,
  taskId: string,
  mode: "merge-pr" | "land" | "discard",
  proceedWithOpen: boolean,
): SettleRefusal | undefined {
  const delivery = host.tasks.get(taskId)?.delivery;
  // The captain's override on the open parts is his leave to settle
  // keeping them planned, the same as `proceed_with_open`.
  if (!proceedWithOpen && !overridePasses(delivery, "parts", delivery?.headSha)) {
    const children = host.tasks.graph.closeRefusal(taskId);
    if (children) {
      const refusal = withProceedWay(children, taskId, mode, inOwnBatch(host, taskId));
      return { ...refusal, text: `${refusal.text} ${softHoldWords("parts", "firstmate")}` };
    }
  }
  if (mode === "discard") return undefined;
  const waits = host.tasks.graph.blockerRefusal(taskId);
  return waits ? { ...waits, text: `${waits.text} ${softHoldWords("waits", "firstmate")}` } : waits;
}

/**
 * The mode's `proceed_with_open` way, first (its default), on a children-open
 * refusal. The refusal's own text already names "settle keeping them
 * planned", so only the runnable way is added here.
 */
function withProceedWay(
  refusal: SettleRefusal,
  taskId: string,
  mode: "merge-pr" | "land" | "discard",
  batched: boolean,
): SettleRefusal {
  const verb =
    mode === "discard"
      ? "Discard"
      : mode === "merge-pr"
        ? MERGE_WORDS[batched ? "batch" : "merge-pr"]
        : MERGE_WORDS.land;
  const them = refusal.tasks.length === 1 ? "it" : "them";
  const way: SettleWay = {
    label: `${verb}, keeping ${them} planned`,
    tool: "settle_task",
    args: { task_id: taskId, mode, proceed_with_open: true },
  };
  return { ...refusal, ways: [way, ...refusal.ways] };
}

/** Whether the task's change joins the person's own batch (docs/forge.md, "Batches of your own"). */
function inOwnBatch(host: RefusalHost, taskId: string): boolean {
  const record = host.tasks.get(taskId);
  return mergesInOwnBatch(record, record?.repoId ? host.repos.get(record.repoId) : undefined);
}

/** A discard that would destroy unlanded work, as a structured refusal (WI-12). */
export function unlandedWorkRefusal(
  host: RefusalHost,
  record: TaskRecord,
  work: { dirty: boolean; unlandedCommits: number },
): SettleRefusal {
  const task = { id: record.id, key: record.key || record.id, title: record.title };
  const keepMode = opensPullRequest(host.taskDelivery(record.id)) ? "merge-pr" : "land";
  const ways: SettleWay[] = [
    {
      label: "Discard anyway",
      tool: "settle_task",
      args: { task_id: record.id, mode: "discard", confirm: true },
    },
    {
      label: `${keepMode === "merge-pr" ? mergeWordsFor(host.taskDelivery(record.id), inOwnBatch(host, record.id)) : MERGE_WORDS.land} instead`,
      tool: "settle_task",
      args: { task_id: record.id, mode: keepMode },
    },
  ];
  const text = unlandedWorkText(task, work, keepMode);
  return { refused: "unlanded-work", task, tasks: [], ways, text };
}

/**
 * A discard of a task whose working copy is on a computer that is out of
 * reach: nobody can read what it holds. Its work still comes here before
 * that computer deletes it, so confirming loses nothing.
 */
export function unreadableWorkRefusal(record: TaskRecord): SettleRefusal {
  const task = { id: record.id, key: record.key || record.id, title: record.title };
  const ways: SettleWay[] = [
    {
      label: "Discard anyway",
      tool: "settle_task",
      args: { task_id: record.id, mode: "discard", confirm: true },
    },
  ];
  const text = `Cannot discard ${task.key} "${record.title}" without confirm: its working copy is on a computer that is out of reach, so nobody can tell whether it holds unmerged work. Its work comes to ${HERE.this} before that computer deletes its copy; discard with confirm to go ahead.`;
  return { refused: "unlanded-work", task, tasks: [], ways, text };
}

/** The not-signed-in refusal on a task's settle, with the sign-in's two ways. */
export function notSignedInRefusal(
  record: TaskRecord,
  fact: { host: string; name: string; repoId?: string },
): SettleRefusal {
  const refusal = signInRefusal({
    ...fact,
    context: `merging "${record.title}" needs the captain's ${fact.name} sign-in, or the project kept on ${HERE.this}.`,
  });
  return {
    refused: "not-signed-in",
    task: { id: record.id, key: record.key || record.id, title: record.title },
    tasks: [],
    ways: refusal.ways,
    text: `${refusal.text} ${fixedHoldWords("sign-in")}`,
  };
}

/** Who asks for a merge: the captain's click, the first mate's merge call, or the app on autonomy. */
export type MergeActor = "captain" | "firstmate" | "app";

/**
 * The merge gate (INF-2744: "autonomy control should all be consistent"),
 * the one reader of autonomy for a merge, whoever asks and whichever pull
 * request it merges. Undefined lets the merge through; otherwise it is a
 * structured refusal (captain ruling 2026-09-20: "this should actually be
 * the same - repo default, per-task ask allowed").
 *
 * - The captain's click passes by itself: autonomy off means the merge is
 *   his to make, so his click IS the way out.
 * - The first mate's merge call passes with autonomy on, or with his own
 *   words passing the asks-first hold as a recorded override.
 * - The app passes with autonomy on, unless the crewmate declared on the
 *   merge card that the captain decides this one (`asksFirst`, citing the
 *   standing direction whose exception it is). It authorizes the merge
 *   when the card goes up and merges once the checks pass.
 *
 * A withdrawn or outgrown merge approval holds the task for the captain
 * whatever autonomy says (FI3-304): only his new click merges it. The one
 * way out the refusal names is the button it is already sitting on: the
 * merge card's merge action, by card id and action id. With no such card
 * open, the text says whose card is owed instead - or, when the captain's
 * click already approved this merge and that approval stands, that the
 * host merges it once the gates pass and that the click is no override
 * (INF-4525, INF-3284): nothing is owed and no way is named.
 */
export function mergeGate(
  host: RefusalHost,
  record: TaskRecord,
  mode: "merge-pr" | "land",
  actor: MergeActor,
  asksFirst?: string,
  scope?: { review?: string },
): SettleRefusal | undefined {
  if (actor === "captain") return undefined;
  // His own words to the first mate are his consent too: an override on
  // asking first lets the first mate's merge through.
  if (
    actor === "firstmate" &&
    overridePasses(record.delivery, "asks-first", record.delivery?.headSha)
  )
    return undefined;
  const hold = mergeHold(record.delivery);
  // The merge card for the pull request this merge sends (INF-2746).
  const open = scope
    ? host.cards.openMergeAction(record.id, scope)
    : openCurrentMerge(host, record);
  // The merge card's own declaration that the captain decides this one.
  const asks = asksFirst ?? open?.asksFirst;
  if (!hold && !asks && host.taskAutonomy(record.id)) return undefined;
  const task = { id: record.id, key: record.key || record.id, title: record.title };
  const verb = mode === "merge-pr" ? "Merging the pull request for" : "Merging";
  const repo = record.repoId ? host.repos.get(record.repoId) : undefined;
  const standing = repo ? `${repo.name} asks before merging` : "this task has no repository";
  // A held Merge is no button to point at (INF-4031): its card waits for
  // its author to bring it to the current version.
  const ways: SettleWay[] =
    open && !open.held
      ? [{ label: open.label, card: { id: open.cardId, action: open.actionId } }]
      : [];
  const why = hold
    ? `the captain's merge approval ended because ${hold}, so the merge is theirs again`
    : asks
      ? `its crewmate asked the captain to decide this merge: ${asks}`
      : `autonomy is off for this task (${standing})`;
  // The captain's click already approved this merge (INF-4525): the host
  // runs it, so no card is owed, and the click passes no hold.
  const kept = !hold && !open && actor === "firstmate" ? keptByCaptain(record, scope) : undefined;
  if (kept) {
    const waits = kept.waiting
      ? ` Its merge waits on ${kept.waiting.on} at ${kept.waiting.head ?? candidateHead(kept)}: the host's note on that wait says who moves next, and that is never the captain's click or a merge of yours.`
      : "";
    return {
      refused: "autonomy-off",
      task,
      tasks: [],
      ways: [],
      text: `${verb} ${task.key} "${record.title}" is not yours to do: ${why}. ${KEPT_APPROVAL_WORDS}${waits} Their merge click approves that change at that version and is not an override, so declare no update_task override from it.`,
    };
  }
  const pointer = open?.held
    ? `The merge card "${open.cardTitle}" is on the stack without its "${open.label}" button, because its change moved on after it went up; it waits for its crewmate to bring it to the current change, and that click will be the captain's to make. Nothing further is needed from you.`
    : open
      ? `The merge card "${open.cardTitle}" is on the stack with its "${open.label}" button: that click is the merge, and it is the captain's to make. Nothing further is needed from you.`
      : "The captain merges it from the crewmate's merge card; steer the crewmate to emit one if it has not.";
  return {
    refused: "autonomy-off",
    task,
    tasks: [],
    ways,
    text: `${verb} ${task.key} "${record.title}" is not yours to do: ${why}. ${pointer} ${softHoldWords("asks-first", "firstmate")}`,
  };
}

/**
 * The open merge card for the task's current change (INF-2490, INF-2746):
 * the card that names its review, when another branch's pull request is
 * current, else the card for the task's own change.
 */
export function openCurrentMerge(
  host: Pick<SettleServiceHost, "cards">,
  record: TaskRecord,
): OpenMergeAction | undefined {
  const review = currentReview(record);
  return (
    (review ? host.cards.openMergeAction(record.id, { review }) : undefined) ??
    host.cards.openMergeAction(record.id, { review: undefined })
  );
}

/**
 * The captain's own approval standing on the merge the gate is asked about
 * (INF-4525): the pull request `scope` names, else the task's current
 * change, picked as `openCurrentMerge` picks its card. An approval the app
 * kept under autonomy is left out: autonomy off ends it on its next run.
 */
function keptByCaptain(
  record: TaskRecord,
  scope?: { review?: string },
): MergeAuthorization | undefined {
  const kept = standingApprovals(record.delivery).filter((item) => item.issuer === "captain");
  const about = (review: string | undefined) => kept.find((item) => item.review?.id === review);
  if (scope) return about(scope.review);
  const review = currentReview(record);
  return (review ? about(review) : undefined) ?? about(undefined);
}

/** The stored review of the pull request the task reads now, when another branch's is current (INF-2490). */
function currentReview(record: TaskRecord): string | undefined {
  const target = record.delivery?.checkTarget;
  return target
    ? record.delivery?.mergeReviews?.find(
        (item) => item.number === target.number && item.branch === target.branch,
      )?.id
    : undefined;
}
