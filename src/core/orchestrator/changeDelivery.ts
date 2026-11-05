import { ChangeChecks } from "./changeChecks";
import { ChangeContext, type ChangeDeliveryOptions } from "./changeContext";
import { ChangeMerge } from "./changeMerge";
import { ChangePublication } from "./changePublication";
import { CheckChangeTool } from "./checkChangeTool";
import { DraftReadiness } from "./draftReadiness";
import { MergeReviews } from "./mergeReviews";

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
  checkTool: CheckChangeTool;
  publication: ChangePublication;
};

export function createChangeDelivery(options: ChangeDeliveryOptions): ChangeDelivery {
  const context = new ChangeContext(options);
  const readiness = new DraftReadiness(context);
  const checks = new ChangeChecks(context, readiness);
  const merges = new ChangeMerge(context, checks);
  const reviews = new MergeReviews(context, checks, merges);
  return {
    checks,
    merges,
    reviews,
    checkTool: new CheckChangeTool(context, checks, reviews),
    publication: new ChangePublication(context, checks, readiness),
  };
}
