import type {
  DecisionAnswer,
  DecisionCaller,
  DecisionQuestion,
  DecisionState,
} from "@shared/decisions";
import type { DecisionUseId } from "@shared/decisionUses";
import { providerLabel, type Slot } from "@shared/modelSlots";
import type { Deliverable } from "@shared/routingPolicy";
import type { StandingDirections } from "../knowledge/directions";
import { directionsThatFit, NO_DIRECTION } from "../placed/computerChoice";

/**
 * The reviewer question (INF-5021; docs/delivery-rigor.md, "Which model
 * reviews"): before an independent review starts with no model named for
 * it, the decision model reads the person's standing directions beside the
 * builder's task and answers usual, or a model a direction calls for. The
 * app works out the usual pick first by its ordinary routing, so the
 * difficulty and allowance logic stays the app's; the model only says
 * whether a direction asks for another. Its pick is a preference routing
 * tries first while it passes the ladder's own checks, never a pin.
 */

/** One model the question may name: one a person placed at a level that the builder's computer serves. */
export type ReviewerChoiceModel = {
  /** `provider/model`. */
  key: string;
  /** Its Settings → Models name. */
  name: string;
  levels: readonly Slot[];
  /** Why it cannot take this review now, by the ladder's own checks; absent when it can. */
  miss?: string;
};

export type ReviewStart = "first-mate" | "click" | "repair";

export type ReviewerChoiceInput = {
  builder: {
    title: string;
    goal: string;
    delivers: Deliverable;
    project: string;
    /** The model the builder ran on, by name and `provider/model` key; absent when it never ran. */
    model?: string;
    /** How carefully it ships, by the name the person sees: Quick, Default or Careful. */
    rigor?: string;
  };
  started: ReviewStart;
  /** The usual pick by name, or null when routing found none. */
  usual: string | null;
  /** The standing directions that apply to the builder's project, each whole. */
  directions: readonly string[];
  models: readonly ReviewerChoiceModel[];
};

/**
 * What the question picked: prefer a model, or wait for one that cannot
 * take the review now. A preferred model that cannot review now carries
 * why (`why`), so routing passes it over and the record says so.
 */
export type ReviewerPick =
  | { mode: "prefer"; key: string; why?: string; source?: string }
  | { mode: "wait"; key: string; why: string; source?: string };

export const REVIEWER_QUESTION_VERSION = "rv4";

const UNSURE = "unsure";

/** What the second question's answers do once the first named a model that cannot take the review now. */
const IF_NOT_NOW = { wait: "wait" } as const;

const STARTED: Record<ReviewStart, string> = {
  "first-mate": "the first mate started it; nobody pressed the Review carefully button",
  click: "the person pressed the Review carefully button on the task's merge card",
  repair:
    "the app started it on its own, to check that bringing an approved change up to date kept it; nobody pressed the Review carefully button",
};

const DELIVERS: Record<Deliverable, string> = {
  change: "a code change: it changes the project's code or files, headed for a pull request",
  answer: "a plan or an answer only; it changes no code",
  operation: "an operation such as merging, releasing or setting something up",
};

const LEVEL_WORDS: Record<Slot, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  premium: "premium",
};

function words(name: string): string[] {
  return name.toLowerCase().match(/[a-z]+/g) ?? [];
}

/** 0 is a, 25 is z, 26 is aa. */
function letters(n: number): string {
  return (n >= 26 ? letters(Math.floor(n / 26) - 1) : "") + String.fromCharCode(97 + (n % 26));
}

/**
 * A short id for each model: the last word of its name no other model has,
 * else of its id, so an answer reads `onsol` or `onopus`. Letters only,
 * because a chat model's one-word answer is parsed as letters
 * (docs/decision-models.md).
 */
function shortNames(models: readonly ReviewerChoiceModel[]): string[] {
  const used = new Set<string>();
  const wordsOf = (model: ReviewerChoiceModel) => [
    ...new Set([...words(model.name), ...words(model.key.split("/").slice(1).join("/"))]),
  ];
  return models.map((model, index) => {
    const others = new Set(models.flatMap((other, at) => (at === index ? [] : wordsOf(other))));
    const unique = wordsOf(model).filter(
      (word) => !others.has(word) && !used.has(word) && word !== NO_DIRECTION && word !== UNSURE,
    );
    // The name's last distinct word, the most particular: "sol" of GPT-6.2 Sol.
    const fromName = unique.filter((word) => words(model.name).includes(word)).at(-1);
    let id = fromName ?? unique.at(-1) ?? "model";
    for (let n = 0; used.has(id); n += 1) id = `model${letters(n)}`;
    used.add(id);
    return id;
  });
}

/** The models the first question may name, with their option ids. */
export function reviewerChoiceOptions(
  models: readonly ReviewerChoiceModel[],
): { id: string; key: string; meaning: string }[] {
  const names = shortNames(models);
  return models.map((model, index) => ({
    id: `on${names[index] as string}`,
    key: model.key,
    meaning: `A standing direction calls for ${model.name} (${model.key}) to review this change.`,
  }));
}

const WHICH =
  "A direction calls for a model when it says which model reviews, or independently reviews, work like this, by its name, a shortened name or its provider and line (for example GPT-6.2 Sol, Sol, Opus 5.5 or Claude Opus). Check each condition it sets against the facts: the project against project, plans, answers or code changes against task_delivers, how carefully it ships (Quick, Default or Careful) against care, a press of the Review carefully button against review_started only, never against care, which model or provider built it against built_on_model, and how the review started against review_started. When every condition holds, the direction calls for its model even though the usual pick is another, and even when it says other reviews use the usual model. A direction that keeps a review off the model or provider that built the work never calls for that model.";
const NOT_THIS =
  "Directions about which model builds work, which computer runs it, how work merges or anything other than which model reviews do not decide this.";

/**
 * The questions, asked together: which model reviews, and, when any model
 * cannot take the review now, what the directions say for that case.
 */
export function reviewerChoiceQuestions(
  models: readonly ReviewerChoiceModel[],
): Record<string, DecisionQuestion> {
  const which: DecisionQuestion = {
    type: "choice",
    version: REVIEWER_QUESTION_VERSION,
    instructions: [
      "An app is about to start an independent review of a task's change. It has a usual model for the review, chosen by its own rules for difficulty and allowance. Answer whether a standing direction calls for another model to review this change.",
      `1. ${WHICH}`,
      "2. Name that model when it is one of the listed models, whether or not it can review now; another question handles a model that cannot.",
      `3. Answer usual when no direction says which model reviews this change, or the direction's conditions do not hold for it. ${NOT_THIS}`,
    ].join("\n"),
    criteria: {
      ...Object.fromEntries(
        reviewerChoiceOptions(models).map((option) => [option.id, option.meaning]),
      ),
      [NO_DIRECTION]:
        "No standing direction says which model reviews this change, so the app's usual pick reviews it.",
      [UNSURE]: "The facts given do not make the answer clear.",
    },
    abstain: UNSURE,
  };
  if (models.every((model) => !model.miss)) return { reviewer: which };
  const notNow: DecisionQuestion = {
    type: "choice",
    version: REVIEWER_QUESTION_VERSION,
    instructions: [
      "An app is about to start an independent review of a task's change.",
      `First find the model a standing direction calls for to review it. ${WHICH} ${NOT_THIS}`,
      "Then answer what should happen when that model cannot review now, for the reason its line gives.",
    ].join("\n"),
    criteria: {
      [IF_NOT_NOW.wait]:
        "Wait: a direction says in words not to review on another model, to wait or hold until that model can, or to ask the person first. A direction that only says which model reviews, even every review, does not say to wait.",
      [NO_DIRECTION]:
        "Review on the usual model: no direction says to wait for that model, or no direction calls for a model at all.",
      [UNSURE]: "The facts given do not make the answer clear.",
    },
    abstain: UNSURE,
  };
  return { reviewer: which, ifNotNow: notNow };
}

/** A model by name, the subscription it comes from and its key: "Opus 5.5, a Claude model (anthropic-claude/claude-opus-5-5)". */
export function modelWords(name: string, key: string): string {
  const provider = key.split("/")[0] ?? key;
  return `${name}, a ${providerLabel(provider)} model (${key})`;
}

function modelLine(model: ReviewerChoiceModel): string {
  const levels = model.levels.map((level) => LEVEL_WORDS[level]).join(" and ");
  return [
    modelWords(model.name, model.key),
    `placed at ${levels}`,
    model.miss ? `cannot review now: ${model.miss}` : "can review now",
  ].join("; ");
}

export function reviewerChoiceState(input: ReviewerChoiceInput): DecisionState {
  const { kept, leftOut } = directionsThatFit(input.directions);
  return {
    facts: {
      task_title: input.builder.title,
      task_goal: input.builder.goal,
      task_delivers: DELIVERS[input.builder.delivers],
      project: input.builder.project,
      ...(input.builder.model ? { built_on_model: input.builder.model } : {}),
      ...(input.builder.rigor ? { care: input.builder.rigor } : {}),
      review_started: STARTED[input.started],
      usual_pick: input.usual ?? "none: no model can review now by the usual rules",
      standing_directions: kept.length ? kept.map((text) => `- ${text}`).join("\n") : "None.",
      ...(leftOut ? { directions_left_out: leftOut } : {}),
      ...Object.fromEntries(
        input.models.map((model, index) => [`model_${index + 1}`, modelLine(model)]),
      ),
    },
  };
}

/**
 * The pick the answers name, or undefined where the usual pick reviews: a
 * model a direction calls for is preferred, and one that cannot review now
 * is waited for only when the second answer says so; otherwise it stays a
 * preference with why, which routing passes over and the record names.
 * Usual, unsure, a failure or an unknown option picks nothing.
 */
export function readReviewerPick(
  models: readonly ReviewerChoiceModel[],
  answers: Record<string, DecisionAnswer | undefined>,
): ReviewerPick | undefined {
  const which = answers.reviewer;
  if (which?.outcome !== "answered") return undefined;
  const option = reviewerChoiceOptions(models).find((each) => each.id === which.value);
  const model = models.find((each) => each.key === option?.key);
  if (!model) return undefined;
  const source = which.source ? { source: which.source } : {};
  if (!model.miss) return { mode: "prefer", key: model.key, ...source };
  const notNow = answers.ifNotNow;
  if (notNow?.outcome === "answered" && notNow.value === IF_NOT_NOW.wait)
    return { mode: "wait", key: model.key, why: model.miss, ...source };
  return { mode: "prefer", key: model.key, why: model.miss, ...source };
}

/** The decision service as the reviewer question reaches it. */
export type ReviewerChoiceModels = {
  decide(
    caller: DecisionCaller & { use: DecisionUseId },
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<Record<string, DecisionAnswer>>;
  allowsUse(id: DecisionUseId): boolean;
};

/**
 * Asks the question once. Nothing is asked while the use is off, no model
 * is listed or no direction applies, since none can then call for a model.
 * The service bounds the call and never throws, so a failure is no pick.
 */
export async function askReviewerChoice(
  models: ReviewerChoiceModels,
  taskId: string,
  input: ReviewerChoiceInput,
  signal: AbortSignal,
): Promise<ReviewerPick | undefined> {
  if (input.models.length === 0 || input.directions.length === 0) return undefined;
  if (!models.allowsUse("reviewer")) return undefined;
  const answers = await models.decide(
    { purpose: "reviewer", use: "reviewer", taskId },
    reviewerChoiceState(input),
    reviewerChoiceQuestions(input.models),
    signal,
  );
  return readReviewerPick(input.models, answers);
}

/** The reviewer question as a review start reaches it. */
export type ReviewerChooser = {
  pick(
    taskId: string,
    repoId: string,
    input: Omit<ReviewerChoiceInput, "directions">,
  ): Promise<ReviewerPick | undefined>;
};

export function reviewerChooser(
  models: ReviewerChoiceModels,
  directions: Pick<StandingDirections, "applying">,
): ReviewerChooser {
  return {
    pick: (taskId, repoId, input) =>
      askReviewerChoice(
        models,
        taskId,
        { ...input, directions: directions.applying(repoId).map((row) => row.text) },
        new AbortController().signal,
      ),
  };
}

/** The models a review start reads before it asks: `TaskPlacement.reviewerModels`. */
export type ReviewerModelsReading = {
  usual: { result: { choice?: { provider: string; id: string } } };
  models: { ref: { provider: string; id: string }; slots: Slot[]; miss?: string }[];
};

/**
 * One review start's pick, with the picked model's name: the usual pick
 * and the models are read where the review would run, then the question
 * is asked. Undefined, the usual pick reviews.
 */
export async function chooseReviewModel(args: {
  chooser: ReviewerChooser | undefined;
  reviewId: string;
  repoId: string | null | undefined;
  builder: ReviewerChoiceInput["builder"];
  started: ReviewStart;
  models: () => Promise<ReviewerModelsReading | undefined>;
  name: (ref: { provider: string; id: string }) => string;
}): Promise<(ReviewerPick & { name: string; usual: string | null }) | undefined> {
  if (!args.chooser || !args.repoId) return undefined;
  const reading = await args.models();
  if (!reading) return undefined;
  const listed: ReviewerChoiceModel[] = reading.models.map((model) => ({
    key: `${model.ref.provider}/${model.ref.id}`,
    name: args.name(model.ref),
    levels: model.slots,
    ...(model.miss ? { miss: model.miss } : {}),
  }));
  const choice = reading.usual.result.choice;
  const usual = choice ? args.name(choice) : null;
  const pick = await args.chooser.pick(args.reviewId, args.repoId, {
    builder: args.builder,
    started: args.started,
    usual: choice ? `${usual} (${choice.provider}/${choice.id})` : null,
    models: listed,
  });
  const named = listed.find((model) => model.key === pick?.key);
  // The usual pick by its key, which override_model_id takes; a display name does not match.
  const usualKey = choice ? `${choice.provider}/${choice.id}` : null;
  return pick && named ? { ...pick, name: named.name, usual: usualKey } : undefined;
}
