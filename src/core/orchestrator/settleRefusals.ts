import { HERE } from "@shared/deviceNames";
import { fixedHoldWords, overridePasses, softHoldWords } from "@shared/holds";
import { opensPullRequest } from "@shared/repos";
import { MERGE_WORDS } from "@shared/vocabulary";
import { signInRefusal } from "../forge";
import type { TaskRecord } from "../storage/taskStore";
import type { SettleRefusal, SettleWay } from "../tasks/taskService";
import { mergeHold } from "./mergeAuthorization";
import type { SettleServiceHost } from "./settleHost";
import { unlandedWorkText } from "./settleWords";

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
 * waits passes a `blocks_me` promise.
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
    const children = host.tasks.closeRefusal(taskId);
    if (children) {
      const refusal = withProceedWay(children, taskId, mode);
      return { ...refusal, text: `${refusal.text} ${softHoldWords("parts", "firstmate")}` };
    }
  }
  if (mode === "discard") return undefined;
  const waits = host.tasks.blockerRefusal(taskId);
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
): SettleRefusal {
  const verb = mode === "discard" ? "Discard" : MERGE_WORDS[mode];
  const them = refusal.tasks.length === 1 ? "it" : "them";
  const way: SettleWay = {
    label: `${verb}, keeping ${them} planned`,
    tool: "settle_task",
    args: { task_id: taskId, mode, proceed_with_open: true },
  };
  return { ...refusal, ways: [way, ...refusal.ways] };
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
      label: `${MERGE_WORDS[keepMode]} instead`,
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

/**
 * The autonomy hold, as a structured refusal (captain ruling 2026-09-20:
 * "this should actually be the same - repo default, per-task ask
 * allowed"). Autonomy off means a green result is the captain's call, and
 * until now only the Firstmate's own prompt said so - a rule an
 * instruction can lose, on the one move that cannot be taken back. So the
 * HOST refuses it: a Firstmate merge or land on a task whose effective
 * autonomy is off settles nothing.
 *
 * The captain is never refused: his click arrives as `actor: "captain"`,
 * from the card's settle effect or the shell, and this rule does not read
 * it. Autonomy off means the merge is his to make, so his click IS the
 * way out - not a relay of it through the Firstmate, which is the move
 * the hold exists to stop.
 *
 * The one way out is that click, so the refusal names the button it is
 * already sitting on rather than a tool: the completion card's merge
 * action, by card id and action id. With no such card open there is
 * nothing to point at, and the text says whose card is owed instead.
 */
export function autonomyRefusal(
  host: RefusalHost,
  record: TaskRecord,
  mode: "merge-pr" | "land",
  actor: "captain" | "firstmate",
): SettleRefusal | undefined {
  if (actor === "captain") return undefined;
  // His own words to the first mate are his consent too: an override on
  // asking first lets the first mate's merge through.
  if (overridePasses(record.delivery, "asks-first", record.delivery?.headSha)) return undefined;
  // A withdrawn or outgrown merge approval holds the task for the captain
  // whatever the project's autonomy says (FI3-304): only his new click
  // merges it.
  const hold = mergeHold(record.delivery);
  if (!hold && host.taskAutonomy(record.id)) return undefined;
  const task = { id: record.id, key: record.key || record.id, title: record.title };
  const verb = mode === "merge-pr" ? "Merging the pull request for" : "Merging";
  const repo = record.repoId ? host.repos.get(record.repoId) : undefined;
  const standing = repo ? `${repo.name} asks before merging` : "this task has no repository";
  const open = host.cards.openMergeAction(record.id);
  const ways: SettleWay[] = open
    ? [{ label: open.label, card: { id: open.cardId, action: open.actionId } }]
    : [];
  const pointer = open
    ? `The completion card "${open.cardTitle}" is on the stack with its "${open.label}" button: that click is the merge, and it is the captain's to make. Nothing further is needed from you.`
    : "The captain merges it from the crewmate's completion card; steer the crewmate to emit one if it has not.";
  const why = hold
    ? `the captain's merge approval ended because ${hold}, so the merge is theirs again`
    : `autonomy is off for this task (${standing})`;
  return {
    refused: "autonomy-off",
    task,
    tasks: [],
    ways,
    text: `${verb} ${task.key} "${record.title}" is not yours to do: ${why}. ${pointer} ${softHoldWords("asks-first", "firstmate")}`,
  };
}
