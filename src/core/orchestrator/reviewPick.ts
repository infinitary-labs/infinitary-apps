import type { WorkShape } from "@shared/routingPolicy";
import type { RouteOptions, RouteResult, Router } from "../routing/router";
import type { TaskRecord } from "../storage/taskRecords";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import {
  chooseReviewModel,
  modelWords,
  type ReviewerPick,
  type ReviewStart,
} from "./reviewerChoice";
import type { TaskPlacement } from "./taskPlacement";

/** How carefully the builder ships, in the names the person sees. */
const RIGOR_WORDS: Record<string, string> = {
  quick: "Quick",
  standard: "Default",
  reviewed: "Careful",
};

/** A pick by its model's name, beside the usual pick's provider/model key (null when none routes). */
export type ReviewPick = ReviewerPick & { name: string; usual: string | null };

/**
 * The reviewer question for one review start (INF-5021): the builder's
 * facts, the usual pick and the models where the review would run, read
 * by the app; the answer is the decision model's. Undefined, the usual
 * pick reviews.
 */
export function reviewPick(
  options: Pick<CrewSupervisorOptions, "reviewerChooser" | "router" | "repos" | "tasks">,
  placement: Pick<TaskPlacement, "reviewerModels">,
  args: {
    builder: TaskRecord;
    reviewId: string;
    brief: string;
    shape: WorkShape;
    route: Pick<RouteOptions, "avoidProvider" | "images">;
    started: ReviewStart;
  },
): Promise<ReviewPick | undefined> {
  const { builder } = args;
  const { router } = options;
  const name = (ref: { provider: string; id: string }) => router?.modelLabel(ref) ?? ref.id;
  const built = router?.servedChoice(builder.id)?.model;
  const rigor = options.tasks.policiesOf(builder)?.rigor.value;
  return chooseReviewModel({
    chooser: options.reviewerChooser,
    reviewId: args.reviewId,
    repoId: builder.repoId,
    builder: {
      title: builder.title,
      goal: builder.intent?.goal?.trim() || builder.title,
      delivers: builder.shape?.deliverable ?? "change",
      project: (builder.repoId && options.repos.get(builder.repoId)?.name) || "",
      ...(built ? { model: modelWords(name(built), `${built.provider}/${built.id}`) } : {}),
      ...(rigor ? { rigor: RIGOR_WORDS[rigor] ?? rigor } : {}),
    },
    started: args.started,
    models: () =>
      placement.reviewerModels(args.brief, args.shape, builder.deviceId ?? null, args.route),
    name,
  }).catch((caught: unknown) => {
    // A failed reading is no pick: the usual start decides, as before.
    console.warn("[crew] the reviewer question could not be asked:", caught);
    return undefined;
  });
}

/**
 * The review's record line: which model a direction called for, which
 * decision model picked it, and whether it took the review; when it did
 * not, why - routing's reason (a saved pin, or a check it missed), else
 * the miss the question read - and which model reviews instead.
 */
export function reviewPickLine(
  pick: ReviewPick,
  routed: RouteResult | undefined,
  router: Pick<Router, "modelLabel"> | undefined,
): string {
  const by = pick.source
    ? `the decision model's pick, answered by ${pick.source}`
    : "the decision model's pick";
  const took = routed?.choice;
  if (took && `${took.provider}/${took.id}` === pick.key)
    return `${pick.name} reviews: a standing direction calls for it (${by})`;
  const why = routed?.preferPassed ?? pick.why ?? "it could not take the review when it started";
  const instead = took ? (router?.modelLabel(took) ?? took.id) : "the usual pick";
  return `${pick.name}, the model a standing direction calls for (${by}), did not review: ${why}; ${instead} reviews instead`;
}
