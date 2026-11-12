import { ChangeChecks } from "./changeChecks";
import { ChangeContext, type ChangeDeliveryOptions } from "./changeContext";
import { ChangeMerge } from "./changeMerge";
import { ChangePublication } from "./changePublication";
import { CheckChangeTool } from "./checkChangeTool";
import { DraftReadiness } from "./draftReadiness";
import { MergeCardSteps } from "./mergeCardSteps";
import { MergeReviews } from "./mergeReviews";
import { ProjectQueue } from "./projectQueue";
import type { SettleServiceHost } from "./settleHost";

/**
 * A task's change where the project lives, by owner: its checks read, its
 * merge sent, the captain's merge reviews prepared and sent, the crewmate's
 * check_change, and the change story published with the change opened.
 * Every owner shares one context: the task, project and forge it acts on.
 */
export type ChangeDelivery = {
  checks: ChangeChecks;
  merges: ChangeMerge;
  reviews: MergeReviews;
  settleHooks: Pick<SettleServiceHost, "mergePullRequest" | "removeQueuedApproval" | "mergeReview">;
  checkTool: CheckChangeTool;
  publication: ChangePublication;
  /** show_merge_card's steps up to the card: the story, the push, the proof and the publication. */
  mergeCard: MergeCardSteps;
  /** A project's queue facts: its workflows read, and when its queue answered. */
  queue: ProjectQueue;
};

export function createChangeDelivery(options: ChangeDeliveryOptions): ChangeDelivery {
  const context = new ChangeContext(options);
  const readiness = new DraftReadiness(context);
  const queue = new ProjectQueue(options);
  const checks = new ChangeChecks(context, readiness, queue);
  const merges = new ChangeMerge(context, checks, queue);
  const reviews = new MergeReviews(context, checks, merges);
  const publication = new ChangePublication(context, checks, readiness);
  return {
    checks,
    merges,
    reviews,
    settleHooks: {
      mergePullRequest: merges.merge.bind(merges),
      removeQueuedApproval: merges.removeQueuedApproval.bind(merges),
      mergeReview: reviews.mergeReview.bind(reviews),
    },
    checkTool: new CheckChangeTool(context, checks, reviews),
    publication,
    mergeCard: new MergeCardSteps(context, publication),
    queue,
  };
}
