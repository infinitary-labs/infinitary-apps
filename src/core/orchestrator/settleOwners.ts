import { DeclaredCloses } from "./declaredCloses";
import { DoneClose } from "./doneClose";
import { KeptApproval } from "./keptApproval";
import { KeptMerge } from "./keptMerge";
import type { SettleServiceHost } from "./settleHost";
import { SettleLocks } from "./settleLocks";
import { SettleService } from "./settleService";
import { TaskClosing } from "./taskClose";
import { TaskDrop } from "./taskDrop";

/**
 * Settling and closing a task, composed from its owners (the primitives
 * review's P4 and P6, docs/task-record.md, docs/delivery-rigor.md). Each
 * owner takes only the ones below it:
 *
 * - `locks`: one settle owns a task at a time, and a settle asked for
 *   mid-turn waits for the turn's boundary (`./settleLocks.ts`).
 * - `approvals`: the captain's kept merge approval
 *   (`./keptApproval.ts`).
 * - `closing`: how a task closes, its cards, worktree and delivery children
 *   (`./taskClose.ts`).
 * - `drops`: the one drop - Discard and the captain's Drop task, on started
 *   and on never-started work (`./taskDrop.ts`).
 * - `settle`: land and merge-pr, a discard through the one drop, and a
 *   merge made outside the app (`./settleService.ts`).
 * - `kept`: merges run under a kept approval (`./keptMerge.ts`).
 * - `declared`: closes declared on a typed fact (`./declaredCloses.ts`).
 * - `done`: the one close as done, with its holds and delivery facts
 *   (`./doneClose.ts`).
 */
export type SettleOwners = {
  locks: SettleLocks;
  approvals: KeptApproval;
  closing: TaskClosing;
  drops: TaskDrop;
  settle: SettleService;
  kept: KeptMerge;
  declared: DeclaredCloses;
  done: DoneClose;
};

/** Compose the settle owners over one host. */
export function createSettleOwners(host: SettleServiceHost): SettleOwners {
  const locks = new SettleLocks(host);
  const approvals = new KeptApproval(host, locks);
  const closing = new TaskClosing(host, locks, approvals);
  const drops = new TaskDrop(host, locks, closing);
  const settle = new SettleService(host, locks, approvals, closing, drops);
  const kept = new KeptMerge(host, locks, approvals, closing, settle);
  const declared = new DeclaredCloses(host, closing);
  const done = new DoneClose(host, locks, closing, settle, declared);
  locks.runKept = (taskId) => {
    void kept.runMergeAuthorization(taskId).catch((caught: unknown) => {
      console.warn("[settle] a kept merge approval could not run:", caught);
    });
  };
  return { locks, approvals, closing, drops, settle, kept, declared, done };
}
