import type { DecisionQuestion, DecisionState } from "@shared/decisions";
import {
  CLASSIFIABLE_KINDS,
  type Deliverable,
  KINDS_BY_DELIVERABLE,
  type WorkKind,
} from "@shared/routingPolicy";
import type { DecisionModels } from "../decisions/decisionModel";
import {
  buildKindClassifierInstruction,
  KIND_CLASSIFIER_INSTRUCTION_VERSION,
  kindClassifierInstructionSha,
  RESEARCH_CRITERION,
  RETRIEVAL_BOUNDARY,
  RETRIEVAL_CRITERION,
} from "../pi/piResources";
import {
  KIND_SOURCE,
  type KindClassifier,
  type KindInput,
  type KindVerdict,
} from "./kindClassifier";

/**
 * The kind classifier as the decision-model class's FIRST consumer (S7a,
 * design section 7.1). Nothing changes at the `KindClassifier` seam and
 * nothing changes at the call site: `classifyShape` (`workShape.ts`) still
 * skips where the table decides above the kind, still bounds the call, and
 * still stamps `kind` and `kind_source` on the shape.
 *
 * What changed is where the machinery lives. S3's classifier WAS an
 * adapter - it turned a typed question into a chat prompt and parsed a word
 * back - so S7a names the class, moves the walk and the session into
 * `AdaptedDecisionModel`, and leaves this module holding the only thing
 * that was ever specific to the kind question: the question itself, the
 * facts it is asked about, and how an answer becomes a `KindVerdict`.
 *
 * Under the default record (`adapted/auto`) the call is byte-for-byte what
 * S3 made: the same instruction (pinned as `adapterInstruction`, so its sha
 * - and therefore the verdict's `kc1-<sha>` stamp - does not move), the
 * same user message (pinned as `adapterText`), the same low-first walk, the
 * same 64-token session, the same parse. That is what makes S7a a no-op by
 * construction rather than by hope.
 */

/** Hard wall clock per classification: a dispatch waits no longer than this. */
export const CLASSIFY_TIMEOUT_MS = 15_000;

/** The verdict's version stamp: the instruction's number and the proof of its text. */
export function classifierVersion(): string {
  return `kc${KIND_CLASSIFIER_INSTRUCTION_VERSION}-${kindClassifierInstructionSha().slice(0, 12)}`;
}

/** Bounds on what rides the question's state (design: about 1-2k tokens, nothing else). */
const LIMITS = {
  title: 200,
  goal: 1_000,
  userWords: 2_000,
  constraints: 400,
  basis: 800,
} as const;

/**
 * The classifiable kinds as a closed option set. Both instruction paths
 * share the retrieval boundary; neither learns what a verdict buys.
 */
export const KIND_CRITERIA: Record<string, string> = {
  plan: "deciding what to do or how to do it: designing, specifying, sequencing, comparing options",
  research: RESEARCH_CRITERION,
  retrieval: RETRIEVAL_CRITERION,
  reproduce:
    "establishing that a defect really happens and under what conditions, before anything is fixed",
  implement: "building something that does not exist yet",
  fix: "correcting something that exists and is wrong",
  chore: "small mechanical work with no design in it",
};

const KIND_INSTRUCTIONS = `${RETRIEVAL_BOUNDARY} Which kind of software work is this? Judge the work by what it asks for, not by how hard it sounds, and not by how it is to be carried out: a note that the work should be planned first, tested, or kept to a minimal diff says how to work, never what kind of work it is. For non-retrieval work spanning two kinds, answer with the one that dominates the effort: an answer that asks for a plan or a design is plan; a change that asks for a fix once the cause is known is fix. When you cannot tell, abstain rather than guessing.`;

/**
 * The kind question, one per deliverable (INF-1430 piece 1): each offers
 * only its branch's kinds, so a native model's distribution and the
 * adapter's parse both stay inside the branch the host derived, and a word
 * from the other branch is unparsed rather than a verdict. The adapter
 * serves one byte-stable instruction that teaches both branches; the user
 * message names which one applies. The abstention is `unclear`, which R8
 * routes high - a classifier that cannot tell costs nothing but the tier it
 * would have had anyway.
 *
 * It teaches the kinds and nothing else: no tiers, no models, no mention of
 * cost. A decision model must not know what its answer buys, or it would
 * start judging the tier, which is exactly what the redesign took away from
 * the Firstmate.
 */
export const KIND_QUESTIONS: Record<
  Exclude<Deliverable, "operation"> | "undeclared",
  DecisionQuestion
> = {
  answer: branchQuestion("answer"),
  change: branchQuestion("change"),
  undeclared: branchQuestion(undefined),
};

/** The question for a deliverable, or every kind when none was declared. */
export function kindQuestionFor(
  deliverable: Exclude<Deliverable, "operation"> | undefined,
): DecisionQuestion {
  return KIND_QUESTIONS[deliverable ?? "undeclared"];
}

function branchQuestion(
  deliverable: Exclude<Deliverable, "operation"> | undefined,
): DecisionQuestion {
  return {
    type: "choice",
    instructions: `This work delivers ${deliverableWords(deliverable)}. ${KIND_INSTRUCTIONS}`,
    criteria: Object.fromEntries(
      offeredKinds(deliverable).map((kind) => [kind, KIND_CRITERIA[kind] ?? ""]),
    ),
    abstain: "unclear",
    version: `kc${KIND_CLASSIFIER_INSTRUCTION_VERSION}`,
    adapterInstruction: buildKindClassifierInstruction(),
  };
}

function offeredKinds(
  deliverable: Exclude<Deliverable, "operation"> | undefined,
): ReadonlyArray<string> {
  return deliverable ? KINDS_BY_DELIVERABLE[deliverable] : CLASSIFIABLE_KINDS;
}

function deliverableWords(deliverable: Exclude<Deliverable, "operation"> | undefined): string {
  if (!deliverable) return "what its kind makes it, as nothing was declared";
  return deliverable === "answer" ? "an answer" : "a change";
}

/**
 * The work, as a decision model sees it: what it is called, what done looks
 * like, the user's own words, the typed constraints, where it lands, and -
 * when one was named and verified - the task whose report is its spec.
 * Nothing else: no transcript, no repo map, no fleet state. This is also
 * the list the consent copy enumerates, so it is the one place to change
 * when it widens (`DECISION_STATE_VERSION`).
 *
 * `adapterText` pins the message S3 sent, down to the labels its first
 * dogfood scoring earned: the bare word "constraints: plan-first" was read
 * as the kind by six of 21 spawns, so the line says what it IS instead.
 */
export function kindState(input: KindInput): DecisionState {
  return {
    facts: {
      title: clip(input.title, LIMITS.title),
      goal: clip(input.goal, LIMITS.goal),
      user_words: clip(input.userWords, LIMITS.userWords),
      how_to_work: input.constraints?.trim() ? clip(input.constraints, LIMITS.constraints) : null,
      repository: input.repoName
        ? `${input.repoName}${input.delivery ? ` (${input.delivery})` : ""}`
        : null,
      basis: input.basis
        ? `${input.basis.key} "${clip(input.basis.title, LIMITS.title)}": ${clip(
            input.basis.outcomeHead,
            LIMITS.basis,
          )}`
        : null,
    },
    adapterText: buildClassifierPrompt(input),
  };
}

/** The adapter's single user message: S3's, with the deliverable and its kinds (INF-1430). */
export function buildClassifierPrompt(input: KindInput): string {
  const lines = [
    "[work]",
    `title: ${clip(input.title, LIMITS.title)}`,
    `goal: ${clip(input.goal, LIMITS.goal)}`,
  ];
  if (input.constraints?.trim()) {
    // Labelled by what it IS. The typed constraints say how to work, and the
    // first dogfood scoring caught the bare word "constraints: plan-first"
    // being read as the kind - six of 21 spawns came back `plan` on the
    // cheapest model. The instruction says the same thing in its own words.
    lines.push(
      `how to work (not what the work is): ${clip(input.constraints, LIMITS.constraints)}`,
    );
  }
  if (input.repoName || input.delivery) {
    lines.push(
      `repository: ${input.repoName ?? "the default workspace"}${
        input.delivery ? ` (${input.delivery})` : ""
      }`,
    );
  }
  lines.push(
    `delivers: ${input.deliverable ? deliverableWords(input.deliverable) : "not declared"} (one of: ${[
      ...offeredKinds(input.deliverable),
      "unclear",
    ].join(", ")})`,
  );
  lines.push("", "[the user's words, verbatim]", clip(input.userWords, LIMITS.userWords));
  if (input.basis) {
    lines.push(
      "",
      `[an established plan, spec or reproduction this work builds on: ${input.basis.key} "${clip(
        input.basis.title,
        LIMITS.title,
      )}"]`,
      clip(input.basis.outcomeHead, LIMITS.basis),
    );
  }
  lines.push("", "What kind of work is this? Answer with one word.");
  return lines.join("\n");
}

function clip(text: string, limit: number): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}...`;
}

/**
 * The consumer. It owns the question, the state and the mapping back to the
 * seam's vocabulary; it owns no model, no transport and no setting, which
 * is the whole point of the class.
 */
export class DecisionKindClassifier implements KindClassifier {
  constructor(private readonly decisions: DecisionModels) {}

  async classify(input: KindInput, signal: AbortSignal): Promise<KindVerdict> {
    const answers = await this.decisions.decide(
      { purpose: "kind", taskId: input.taskId },
      kindState(input),
      { kind: kindQuestionFor(input.deliverable) },
      signal,
    );
    const answer = answers.kind;
    // The service is contracted to answer every question it was handed;
    // an absent answer would be a bug in it, not a verdict, and `unclear`
    // is the only honest thing to route on either way.
    if (!answer) {
      return { kind: "unclear", source: `${KIND_SOURCE.failed}no-answer`, version: "" };
    }
    const model = answer.source;
    const base = {
      version: answer.version,
      ...(model ? { model } : {}),
      ...(answer.detail ? { detail: answer.detail } : {}),
    };
    if (answer.outcome === "failed") {
      const reason = answer.reason ?? "error";
      return { kind: "unclear", source: `${KIND_SOURCE.failed}${reason}`, ...base };
    }
    if (answer.outcome === "abstained") {
      return { kind: "unclear", source: `${KIND_SOURCE.abstained}${model ?? "unknown"}`, ...base };
    }
    if (!isKind(answer.value)) {
      return { kind: "unclear", source: `${KIND_SOURCE.failed}unparsed`, ...base };
    }
    return {
      kind: answer.value,
      source: `${KIND_SOURCE.classified}${model ?? "unknown"}`,
      ...base,
    };
  }
}

function isKind(value: string): value is WorkKind {
  return (CLASSIFIABLE_KINDS as ReadonlyArray<string>).includes(value);
}
