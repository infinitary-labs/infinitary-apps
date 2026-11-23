import { type Card, mergeEffectOf } from "@shared/cards";
import { heldMerges } from "@shared/mergeHeld";
import type { CardStore } from "../storage/cardStore";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import type { Witnesses } from "./reportSort";

/**
 * The typed fact that keeps a reworked merge card in its close-out wait
 * (INF-6241; docs/card-threads.md, "A reworked merge card"):
 *
 * - `job`: a background job of the crewmate's runs, so a push from it is
 *   not known until it ends and the turn it wakes is read;
 * - `read`: the change has not been read since the crewmate's turn ended,
 *   so a push from its shell is not known yet;
 * - `checks`: a check watch or a run watch stands on the task;
 * - `turn`: the crewmate's turn is running;
 * - `wake`: a wake waits for the crewmate on a lane that can deliver it.
 */
export type ReworkHold = "job" | "read" | "checks" | "turn" | "wake";

export type ReworkHoldHost = {
  tasks: Pick<TaskService, "get">;
  cardStore: Pick<CardStore, "lastAvailableOffer">;
  /** The read after the crewmate's newest turn has not finished (`CheckWatcher.afterTurnReadOwed`). */
  readOwed(record: TaskRecord): boolean;
  witnesses(
    taskId: string,
  ): Pick<Witnesses, "deliverable" | "accountHeld" | "outOfReach" | "jobsRunning"> | undefined;
  /** The lane is stuck at its provider until the first mate answers. */
  stuck(taskId: string): boolean;
  /** The task's computer must be updated before it takes a turn. */
  waitsForUpdate(taskId: string): boolean;
};

/**
 * What holds a crewmate's merge card back at its close-out, or undefined
 * when it returns as every other card does. Only a merge card of the task's
 * own change, under a captain's reply, whose change is at a newer version
 * than the one the card showed, is ever held; every fact is read from the
 * record, never from anyone's words, so a restart derives the same hold.
 */
export function reworkHold(card: Card, host: ReworkHoldHost): ReworkHold | undefined {
  if (card.author !== "crewmate" || !card.taskId || !card.lifecycleId) return undefined;
  if (card.sentBackAt === undefined || !ownMerge(card)) return undefined;
  const record = host.tasks.get(card.taskId);
  if (!record || TaskService.isClosed(record)) return undefined;
  const delivery = record.delivery;
  if (!delivery || delivery.checkTarget) return undefined;
  // The version the stage showed the captain: a revision written since
  // reaches the stage only with the card's return.
  const shownOffer = host.cardStore.lastAvailableOffer(card.id, card.lifecycleId) ?? card.offerId;
  const offer = delivery.completionOffers?.find(
    (entry) => entry.cardId === card.id && entry.offerId === shownOffer,
  );
  if (!offer || offer.retired) return undefined;
  if (offer.destination && offer.destination.branch !== record.branch) return undefined;
  // Read before the version: a job still running may push after any read.
  const lane = host.witnesses(record.id);
  if (lane?.jobsRunning) return "job";
  if (host.readOwed(record)) return "read";
  if (!delivery.headSha || delivery.headSha === offer.headSha) return undefined;
  if (delivery.ciWatch || (delivery.runWatches?.length ?? 0) > 0) return "checks";
  if (record.activity === "running") return "turn";
  // A wake the lane cannot deliver holds nothing: the card returns showing
  // what it can, and the thread says what holds the crewmate.
  if (
    lane?.deliverable &&
    !lane.accountHeld &&
    !lane.outOfReach &&
    !host.stuck(record.id) &&
    !host.waitsForUpdate(record.id)
  )
    return "wake";
  return undefined;
}

/**
 * A Merge of the task's own change, offered or taken off while the card is
 * behind (INF-4031); a merge of a pull request the task reviews is not one.
 */
function ownMerge(card: Card): boolean {
  const merges = [...card.actions, ...(heldMerges(card.body) ?? [])]
    .map(mergeEffectOf)
    .filter((effect) => effect !== undefined);
  return merges.length > 0 && merges.every((effect) => effect.review === undefined);
}
