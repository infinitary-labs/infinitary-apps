import { cardPictureFiles } from "@shared/cardPictures";
import {
  cardAnswerLines,
  cardAnswersSchema,
  cardMessageText,
  replyWithSettings,
} from "@shared/cards";
import { type ContributionRoute, contributesUpstream } from "@shared/contributions";
import { softHoldWords } from "@shared/holds";
import { deliveryForRecord, opensPullRequest, type RepoView } from "@shared/repos";
import {
  type Deliverable,
  type Escalation,
  isFolderWork,
  type WorkShape,
  type WorkShapeAsk,
} from "@shared/routingPolicy";
import { CLASSIFY_TIMEOUT_MS } from "../routing/decisionKindClassifier";
import { KIND_SOURCE, type KindInput, resolveKind } from "../routing/kindClassifier";
import { escalationFloor } from "../routing/policy";
import type { TaskRecord } from "../storage/taskRecords";
import { resultSchemaRefusal } from "../tasks/taskResult";
import type { TaskService } from "../tasks/taskService";
import { keptRefFor } from "../workspace/workspaceService";
import type { CardService } from "./cardService";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import {
  assertDeliverableConstraints,
  type BasisBriefFacts,
  deliverableFor,
  type EscalationBriefFacts,
  type SpawnIntent,
} from "./intentBrief";

/** The task's prepared routing wins; local-only delivery never contributes to a host. */
export function contributionForTask(
  record: TaskRecord | undefined,
  repo: RepoView | undefined,
): ContributionRoute | undefined {
  if (!record || !opensPullRequest(deliveryForRecord(record, repo?.delivery))) return undefined;
  if (record.delivery?.publicationOrigin !== undefined) return record.delivery.contribution;
  return record.delivery?.contribution ?? repo?.contribution;
}

export function taskContributesUpstream(
  record: TaskRecord | undefined,
  repo: RepoView | undefined,
): boolean {
  return contributesUpstream(contributionForTask(record, repo));
}

/**
 * A resolved escalation (S4): the attempt the captain rejected, the stamp
 * the tier table reads for R1b, and the facts the fresh crewmate's brief
 * is rendered from. Built once, before anything is created, so every
 * refusal happens before a row exists.
 */
export type EscalationPlan = {
  previous: TaskRecord;
  stamp: Escalation;
  facts: EscalationBriefFacts;
};

/** What a source's facts read: its record, its card's saved answers and where pictures live. */
type SourceOptions = Pick<CrewSupervisorOptions, "tasks" | "cardStore" | "paths">;

/** The card stack's reads of a source's answer card and its thread. */
type SourceCards = Pick<
  CardService,
  "newestAnswerForTask" | "newestResolutionForTask" | "messages"
>;

/**
 * The escalation an `escalate_from` asks for (S4, report section 4).
 * Every check that can refuse runs here, before a row exists, and every
 * refusal is a loud tool error the Firstmate reads in conversation:
 *
 * - the named task must exist and be crewmate work;
 * - it must really have run (Q1's "never on first dispatch"): a row that
 *   never started produced no result for the captain to reject;
 * - the lineage may spend `maxEscalations` rungs, and nothing sits above
 *   premium - both refusals come from the policy, not from here.
 */
export function resolveEscalation(
  resolveTaskRef: (ref: string, param: string) => TaskRecord,
  ref: string | undefined,
  premiumAsk = false,
): EscalationPlan | undefined {
  const named = ref?.trim();
  if (!named) return undefined;
  const previous = resolveTaskRef(named, "escalate_from");
  const handle = previous.key || previous.id;
  if (previous.kind !== "work") {
    throw new Error(
      `${handle} is not crewmate work, so there is no attempt to escalate. Name the task whose result the captain rejected.`,
    );
  }
  if (!previous.startedAt && !previous.outcome) {
    throw new Error(
      `${handle} has never run, so there is no result to reject. Escalation is for an attempt the captain has seen; start it, or spawn the work plainly.`,
    );
  }
  const attempt = (previous.shape?.escalation?.attempt ?? 0) + 1;
  // A row that never routed (dynamic routing off, or a pre-S2 record)
  // is read at the engine's own default so the ladder still has a rung
  // to climb from.
  const floor = escalationFloor(previous.difficulty ?? "medium", attempt);
  if ("refused" in floor) {
    throw new Error(
      `Cannot escalate ${handle}: ${floor.refused}. Ask the captain which model to try instead and pass it as override_model_id. ${softHoldWords("escalation", "firstmate")}`,
    );
  }
  // R1a outranks R1b: the captain's premium click still spends a bounded
  // escalation, but its brief, record and feed name the tier it serves.
  const servedFloor = premiumAsk ? "premium" : floor.floor;
  return {
    previous,
    stamp: { from: handle, attempt: floor.attempt, floor: servedFloor },
    facts: {
      attempt: floor.attempt,
      previousKey: handle,
      tier: servedFloor,
      ...(previous.model ? { previousModel: previous.model } : {}),
      ...(previous.outcome ? { previousOutcome: previous.outcome } : {}),
      // The attempt's worktree and branch go when it is superseded; what
      // it did is saved on its kept ref first (`supersedeAttempt`).
      ...(previous.worktreeDir && previous.workspaceState === "present"
        ? { previousWork: keptRefFor(previous.id) }
        : {}),
    },
  };
}

/**
 * The shape the tier is computed from (S2). The Firstmate supplies the
 * facts only it can see; the host adds the two it must not be trusted
 * for:
 *
 * - the KIND, which a classifier establishes (S3). Until then every
 *   shape is `unclear`, which R8 routes high - the captain's own call
 *   (Q5 A) that an unknown piece of work is worth the stronger model.
 * - the BASIS verdict. A named basis buys a cheaper tier only when it
 *   resolves to a real task that is done or has reported something; an
 *   unnamed, unknown or still-running basis reads unverified and is
 *   treated as absent, so a claimed spec can never talk the router down
 *   on its own. The verdict rides the shape to the router and is derived
 *   again at every read; the record never stores it.
 */
export function workShape(
  tasks: TaskService,
  ask: WorkShapeAsk | undefined,
  escalation?: EscalationPlan,
): WorkShape {
  const basis = ask?.basis?.trim();
  if (escalation) {
    // An escalation is the SAME work at a higher tier (S4): the kind and
    // the basis are inherited rather than re-established, because nothing
    // about the work changed - only the model that will attempt it. So
    // `classifyShape` skips the call and stamps `skipped:escalation` over
    // the placeholder below; the inherited kind's own provenance, and the
    // confidence its classification carried, stay on the row the lineage
    // edge points at rather than being restated here as if this row had
    // measured them. The previous row's `premium_ask` is deliberately NOT
    // inherited either: R1a outranks R1b, so a stale ask would decide this
    // attempt's tier in place of the ladder. A premium ask the captain
    // repeats in the rejection arrives on this spawn as its own fact.
    const inherited = escalation.previous.shape;
    const basisRef = basis ?? inherited?.basis;
    const deliveryAsk = ask?.delivery_ask ?? inherited?.delivery_ask;
    // The captain's word on who merges this work is a property of the
    // work, not of the attempt that failed, so it rides the lineage the
    // way the posture does.
    const autonomyAsk = ask?.autonomy_ask ?? inherited?.autonomy_ask;
    // So is the captain's word on where it runs (docs/helper.md, "A
    // task's own Runs on").
    const runsOnAsk = ask?.runs_on_ask ?? inherited?.runs_on_ask;
    // Whether the work is one of the Firstmate's own steps does not change
    // with the attempt either.
    const internalStep = ask?.internal_step ?? inherited?.internal_step;
    // So does working in the project's folder (INF-567).
    const inFolder = ask?.in_folder || isFolderWork(inherited?.in_place);
    return {
      ...(inherited?.deliverable === "operation" ? { deliverable: "operation" as const } : {}),
      ...((ask?.ongoing ?? inherited?.ongoing) !== undefined
        ? { ongoing: ask?.ongoing ?? inherited?.ongoing }
        : {}),
      ...((ask?.intelligence ?? inherited?.intelligence)
        ? { intelligence: ask?.intelligence ?? inherited?.intelligence }
        : {}),
      kind: inherited?.kind ?? "unclear",
      kind_source: "none",
      ...(ask?.premium_ask ? { premium_ask: true as const } : {}),
      ...(ask?.override_model_id ? { override_model_id: ask.override_model_id } : {}),
      ...(ask?.override_speed ? { override_speed: ask.override_speed } : {}),
      ...(ask?.override_reasoning ? { override_reasoning: ask.override_reasoning } : {}),
      ...(basisRef ? { basis: basisRef, basis_verified: tasks.graph.basisHolds(basisRef) } : {}),
      ...(ask?.rigor_ask ? { rigor_ask: ask.rigor_ask } : {}),
      ...(deliveryAsk ? { delivery_ask: deliveryAsk } : {}),
      ...(autonomyAsk !== undefined ? { autonomy_ask: autonomyAsk } : {}),
      ...(runsOnAsk ? { runs_on_ask: runsOnAsk } : {}),
      ...((ask?.placement_requirements ?? inherited?.placement_requirements)
        ? {
            placement_requirements:
              ask?.placement_requirements ?? inherited?.placement_requirements,
          }
        : {}),
      ...(internalStep ? { internal_step: true } : {}),
      ...(inFolder ? { in_place: { folder: true as const } } : {}),
      ...(ask?.skipped_plan_because ? { skipped_plan_because: ask.skipped_plan_because } : {}),
      escalate_from: escalation.stamp.from,
      escalation: escalation.stamp,
    };
  }
  return {
    ...(ask?.ongoing !== undefined ? { ongoing: ask.ongoing } : {}),
    ...(ask?.intelligence ? { intelligence: ask.intelligence } : {}),
    kind: ask?.kind ?? "unclear",
    kind_source: ask?.kind ? "firstmate:declared" : "none",
    ...(ask?.premium_ask ? { premium_ask: true as const } : {}),
    ...(ask?.override_model_id ? { override_model_id: ask.override_model_id } : {}),
    ...(ask?.override_speed ? { override_speed: ask.override_speed } : {}),
    ...(ask?.override_reasoning ? { override_reasoning: ask.override_reasoning } : {}),
    ...(basis ? { basis, basis_verified: tasks.graph.basisHolds(basis) } : {}),
    ...(ask?.rigor_ask ? { rigor_ask: ask.rigor_ask } : {}),
    ...(ask?.delivery_ask ? { delivery_ask: ask.delivery_ask } : {}),
    ...(ask?.autonomy_ask !== undefined ? { autonomy_ask: ask.autonomy_ask } : {}),
    ...(ask?.runs_on_ask?.trim() ? { runs_on_ask: ask.runs_on_ask.trim() } : {}),
    ...(ask?.placement_requirements ? { placement_requirements: ask.placement_requirements } : {}),
    ...(ask?.internal_step ? { internal_step: true } : {}),
    ...(ask?.in_folder ? { in_place: { folder: true as const } } : {}),
    ...(ask?.skipped_plan_because ? { skipped_plan_because: ask.skipped_plan_because } : {}),
  };
}

/**
 * Establish the shape's KIND (S3). Three shapes are never classified,
 * because the table decides them ABOVE the kind and a call could only
 * cost quota without changing the outcome: the captain named a model
 * (R0), the captain asked for premium (R1a), or this is an escalation
 * rung (R1b). Each records WHY it was skipped rather than leaving the
 * stopgap `none`, so the audit row never has to guess.
 *
 * Everything else asks the classifier, which cannot throw: its failures
 * and its abstentions both come back `unclear`, carrying their reason as
 * `kind_source`, and R8 routes them high exactly as S2 did.
 *
 * `declared` says the intent is the Firstmate's own, whose `read-only`
 * constraint decides the deliverable, so the classifier picks only within
 * that branch (INF-1430 piece 1). A crewmate's filed follow-up declares
 * nothing: its kind decides its deliverable, so every kind is offered.
 */
export async function classifyShape(
  options: Pick<CrewSupervisorOptions, "classifier" | "repos" | "tasks">,
  taskId: string,
  title: string,
  intent: SpawnIntent,
  repoId: string | null,
  shape: WorkShape,
  declared: boolean,
): Promise<WorkShape> {
  if (shape.deliverable === "operation" || deliverableFor(intent, undefined) === "operation")
    return { ...shape, kind: "unclear", kind_source: `${KIND_SOURCE.skipped}operation` };
  if (shape.kind_source === "firstmate:declared") return shape;
  const skip = shape.override_model_id
    ? "override"
    : shape.premium_ask
      ? "premium-ask"
      : shape.escalation
        ? "escalation"
        : undefined;
  if (skip) return { ...shape, kind_source: `${KIND_SOURCE.skipped}${skip}` };
  // A review's kind is the host's (delivery rigor phase 2), never asked.
  if (shape.kind === "review") return shape;
  const classifier = options.classifier;
  if (!classifier) return shape;
  const verdict = await classifier.classify(
    classifierInput(options, taskId, title, intent, repoId, shape, declared),
    AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
  );
  return {
    ...shape,
    kind: resolveKind(verdict),
    kind_source: verdict.source,
    ...(verdict.detail ? { kind_detail: verdict.detail } : {}),
  };
}

/** The bounded facts the classifier is given: no transcript, no repo map. */
function classifierInput(
  options: Pick<CrewSupervisorOptions, "repos" | "tasks">,
  taskId: string,
  title: string,
  intent: SpawnIntent,
  repoId: string | null,
  shape: WorkShape,
  declared: boolean,
): KindInput {
  const repo = repoId ? options.repos.get(repoId) : undefined;
  const constraints = (intent.constraints ?? [])
    .map((constraint) =>
      constraint.text ? `${constraint.kind}: ${constraint.text}` : constraint.kind,
    )
    .join("; ");
  // Only a VERIFIED basis is shown. An unverified one buys no cheaper
  // tier (R3/R5), so letting it colour the classification would smuggle
  // a claimed spec back in through the other door.
  const basis =
    shape.basis && options.tasks.graph.basisHolds(shape.basis)
      ? options.tasks.resolve(shape.basis)
      : undefined;
  return {
    taskId,
    title,
    goal: intent.goal,
    userWords: intent.userWords,
    // The branch the classifier picks within: the read-only declaration,
    // never the kind it is about to give (INF-1430 piece 1).
    ...(declared ? { deliverable: deliverableFor(intent, undefined) as "answer" | "change" } : {}),
    ...(constraints ? { constraints } : {}),
    ...(repo
      ? {
          repoName: repo.name,
          ...(repo.kind === "personal"
            ? {}
            : {
                delivery: deliveryForRecord({ shape }, repo.delivery),
              }),
        }
      : {}),
    ...(basis
      ? {
          basis: {
            key: basis.key,
            title: basis.title,
            outcomeHead: basis.outcomeSummary ?? basis.outcome ?? "",
          },
        }
      : {}),
  };
}

/**
 * Stamp what the work DELIVERS on its shape (Task B). Derived by the host
 * from the typed `read-only` constraint the Firstmate declared
 * (`deliverableFor`), or from the kind for a crewmate's follow-up, which
 * carries no declaration, and re-derived wherever the kind moves. A
 * `review` task keeps whatever the derivation says; it is ungated for its
 * kind either way.
 */
export function withDeliverable(shape: WorkShape, intent: SpawnIntent | undefined): WorkShape {
  assertDeliverableConstraints(
    intent,
    isFolderWork(shape.in_place) || shape.deliverable === "operation",
  );
  return {
    ...shape,
    deliverable:
      isFolderWork(shape.in_place) || shape.deliverable === "operation"
        ? "operation"
        : deliverableFor(intent, shape.kind),
  };
}

/** What a record's shape says it delivers; a pre-axis row shipped a change. */
export function deliverableOf(record: TaskRecord | undefined): Deliverable {
  return record?.shape?.deliverable ?? "change";
}

/**
 * A shape with its basis verdict derived now, for the routing table. The
 * record never stores the verdict (`TaskService.graph.basisHolds`): a step
 * planned behind the task it builds on names a basis that has not
 * answered yet, and the verdict that counts is the one at the moment the
 * work routes.
 */
export function withBasisVerdict(tasks: TaskService, shape: WorkShape): WorkShape {
  if (!shape.basis) return shape;
  return { ...shape, basis_verified: tasks.graph.basisHolds(shape.basis) };
}

/**
 * The answer a change is built on (Task B, F3 A). A verified basis is a
 * task whose answer the host can hand over verbatim - its report and the
 * card the captain read - so the builder starts from the finding instead
 * of being told to go and repeat it. Nothing here judges: `basisHolds`
 * decides the basis counts, and an unverified one buys neither a cheaper
 * tier nor this section.
 */
export function basisFacts(
  options: SourceOptions,
  cards: SourceCards,
  record: TaskRecord | undefined,
): BasisBriefFacts | undefined {
  const ref = record?.shape?.basis;
  if (!ref || !options.tasks.graph.basisHolds(ref)) return undefined;
  const basis = options.tasks.resolve(ref);
  if (!basis || basis.id === record.id) return undefined;
  return sourceFacts(options, cards, basis);
}

/** Read a declared source; its existence alone is never approval. */
export function sourceFacts(
  options: SourceOptions,
  cards: SourceCards,
  basis: TaskRecord,
): BasisBriefFacts {
  const timeline = options.tasks.timeline(basis.id);
  const card = cards.newestAnswerForTask(basis.id);
  // Only a change's working copy holds its work: an answer task commits
  // nothing and its scratch copy goes with it, so its answer is the report
  // and the card below, never a branch to start from.
  const change = deliverableOf(basis) === "change";
  // A branch on another computer is read here only once its work is home,
  // on the kept ref.
  const branch =
    change && basis.workspaceState === "present" && basis.branch && !basis.deviceId
      ? basis.branch
      : undefined;
  const keptRef = change && !branch ? keptRefOf(options.tasks, basis.id) : undefined;
  // Each reply reaches the builder with the settings it was sent with, as
  // its author read it then; the thread shows them apart (FI3-617).
  const thread = card
    ? cards
        .messages(card.id)
        .filter((message) => message.text.trim() || message.notes?.length)
        .map((message) => ({
          who: message.who,
          text: replyWithSettings(cardMessageText(message), message.answers),
        }))
    : [];
  // The choice, the answers and the body all come off that one card, so a
  // later card on the task never lends the builder its choice instead.
  const resolution = card ? cards.newestResolutionForTask(basis.id, card.id) : undefined;
  const offer = resolution?.offer ?? resolution?.card;
  const choice = offer?.actions.find((entry) => entry.id === resolution?.action)?.label;
  // Current submissions on that card (actions or replies) supersede
  // legacy resolution-only answers, including Firstmate-authored replies.
  const submitted = card
    ? options.cardStore
        .observations(card.id)
        .filter(
          (event) =>
            (event.kind === "action" || event.kind === "message_ref") && event.actor === "captain",
        )
        .map((event) =>
          cardAnswersSchema.safeParse((event.payload as { answers?: unknown }).answers),
        )
        .filter((parsed) => parsed.success)
        .at(-1)
    : undefined;
  const latest = submitted?.success ? submitted.data : resolution?.answers;
  const answers = latest ? cardAnswerLines(latest) : undefined;
  const result = options.tasks.latestResult(basis.id);
  const rawBody = offer?.body ?? card?.body;
  const cardBody = rawBody ? cardPictureFiles(rawBody, options.paths.crewmatesDir) : undefined;
  return {
    key: basis.key || basis.id,
    taskId: basis.id,
    title: basis.title,
    ...(basis.intent?.userWords ? { userWords: basis.intent.userWords } : {}),
    ...(basis.outcome ? { outcome: basis.outcome } : {}),
    ...(result ? { result: result.value } : {}),
    reports: timeline
      .filter((event) => event.kind === "report")
      .map((event) => ({ event_id: event.id, text: event.text })),
    ...(cardBody ? { card: cardBody.body } : {}),
    ...(cardBody?.pictures.length ? { pictures: cardBody.pictures } : {}),
    ...(cardBody?.recordings.length ? { recordings: cardBody.recordings } : {}),
    ...(branch ? { branch } : {}),
    ...(keptRef ? { keptRef } : {}),
    ...(thread.length > 0 ? { thread } : {}),
    ...(choice ? { choice } : {}),
    ...(answers ? { answers } : {}),
  };
}

/**
 * Where a task that branches from another starts (INF-799 piece 1,
 * `branch_from`): that task's branch head while its working copy is
 * present on this Mac, else the kept ref its work was saved on. Answers a
 * refusal in words when the named task is unknown, is this task, is in
 * another project, or has neither, so a tool call reads it as text and a
 * start fails with it.
 */
export function branchFromSource(
  tasks: TaskService,
  ref: string,
  repoId: string | null,
  selfId?: string,
): { task: TaskRecord; ref: string } | { refused: string } {
  const source = tasks.resolve(ref.trim());
  if (!source) return { refused: `Unknown branch_from "${ref}": name a task by its key.` };
  const key = source.key || source.id;
  if (source.id === selfId) return { refused: "A task cannot branch from itself." };
  if (source.repoId !== repoId)
    return {
      refused: `branch_from ${key} is in another project; a task branches only from work in its own project.`,
    };
  if (source.workspaceState === "present" && source.branch && !source.deviceId)
    return { task: source, ref: source.branch };
  const kept = keptRefOf(tasks, source.id);
  if (kept) return { task: source, ref: kept };
  if (source.workspaceState === "present" && source.deviceId)
    return {
      refused: `branch_from ${key}'s working copy is on another computer; branch from it once its work is home and saved.`,
    };
  return {
    refused: `branch_from ${key} has no branch or saved work to start from: name a task that has started work in this project.`,
  };
}

/**
 * The typed hand-off a new task declares (INF-799 piece 1): its result
 * shape, checked to be a JSON Schema with an object at its root, and the
 * task it branches from, checked to hold a branch or saved work in the
 * same project and stored by key. A refusal is words, nothing filed.
 */
export function handOffShape(
  tasks: TaskService,
  ask: Pick<WorkShapeAsk, "result_schema" | "branch_from"> | undefined,
  repoId: string | null,
  selfId?: string,
): Pick<WorkShape, "result_schema" | "branch_from"> | { refused: string } {
  const refused = ask?.result_schema ? resultSchemaRefusal(ask.result_schema) : undefined;
  if (refused) return { refused };
  const ref = ask?.branch_from?.trim();
  const source = ref ? branchFromSource(tasks, ref, repoId, selfId) : undefined;
  // A step filed behind the step it continues names work that has not
  // started yet: its branch is checked again when this one starts.
  const named = ref ? tasks.resolve(ref) : undefined;
  const unstarted = named?.status === "open" && named.workspaceState === "none";
  if (
    source &&
    "refused" in source &&
    !(unstarted && named.repoId === repoId && named.id !== selfId)
  )
    return source;
  return {
    ...(ask?.result_schema ? { result_schema: ask.result_schema } : {}),
    ...(named ? { branch_from: named.key || named.id } : {}),
  };
}

/**
 * The hidden ref a task's unlanded work was saved on when its working
 * copy went, read off the timeline's save note (`retireWorktreeOf`); none
 * when nothing was saved - an answer task, or work that was all in.
 */
function keptRefOf(tasks: TaskService, taskId: string): string | undefined {
  const saves = tasks
    .timeline(taskId)
    .map((event) => (event.data as { saved?: { ref?: unknown } } | null)?.saved?.ref)
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  return saves.at(-1);
}
