import { mergeEffectOf } from "@shared/cards";
import { cardWords } from "@shared/cardWords";
import { deliveryFactsOf } from "@shared/deliveryFacts";
import { liveValidationSummary } from "@shared/liveValidationSummary";
import { providerLabel, slotSchema } from "@shared/modelSlots";
import { personalReadOf } from "@shared/personalSet";
import { crewProblem, typedFailureOf } from "@shared/plainProblem";
import { isAllowanceProvider, servedProviderOf } from "@shared/quota";
import { type Reasoning, reasoningSchema } from "@shared/reasoning";
import { type TaskHold, taskHoldWords } from "@shared/taskHold";
import { planOf } from "@shared/taskPlan";
import { effectiveTaskPolicies } from "@shared/taskPolicies";
import { isUnstartedWork, type TaskDetail, type TaskEventView } from "@shared/tasks";
import { askReceipt } from "../storage/askStore";
import { currentChange, taskPullRequestsOf } from "../storage/changeProjection";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import { standingDependencyWaits } from "./dependencyWaits";
import { type ConcernedEventView, condenseActivity } from "./recordActivity";
import type { TaskProtocolOptions } from "./taskProtocolOptions";
import { TaskService } from "./taskService";
import { crewFilingOrigin, graphFor, type LiveFacts, tiersOf, viewOf } from "./taskView";

/**
 * One record's detail as the task protocol reads it (`TaskProtocol.detail`,
 * `taskProtocol.ts`; `inf:tasks:detail`): the row's view and everything the
 * record card shows beside it - its events and the other tasks' events that
 * concern it, its cards, asks, plan, closing, problem and hold. Read from
 * SQLite and the live host facts at each read, from the graph around the
 * record and the rows it names, never the whole history (INF-939).
 */

export function taskDetailOf(
  options: TaskProtocolOptions,
  id: string,
  liveFacts: (record: TaskRecord) => LiveFacts,
): TaskDetail {
  const { tasks } = options;
  const record = tasks.get(id);
  if (!record) throw new Error(`Unknown task "${id}".`);
  // The graph around the record and the rows it names - those its
  // concerning events were written by or name, those its standing waits
  // name, and the task of the card its gate names - never the whole
  // history (INF-939).
  const concerning = tasks.concerning(id);
  const named = new Set<string>();
  for (const event of concerning) {
    named.add(event.taskId);
    if (event.via) named.add(event.via);
  }
  for (const wait of standingDependencyWaits(tasks, record.delivery)) named.add(wait.task.id);
  const gateRef = record.gate?.kind === "captain" ? record.gate.ref : undefined;
  const gateTask = gateRef
    ? options.cards.snapshot().find((card) => card.id === gateRef)?.taskId
    : undefined;
  if (gateTask) named.add(gateTask);
  // Its parts, in filing order: the record lists each as its Tasks row
  // reads it (INF-6805's plan, item 1).
  const partRows = tasks.graph.children(id);
  for (const part of partRows) named.delete(part.id);
  named.delete(id);
  const graph = graphFor(options, [record, ...partRows, ...tasks.getMany([...named])]);
  const view = viewOf(options, record, graph, tiersOf(options, [record]), liveFacts(record));
  const partTiers = tiersOf(options, partRows);
  const parts = partRows.map((part) => viewOf(options, part, graph, partTiers, liveFacts(part)));
  const origin = crewFilingOrigin(record, graph);
  const timeline = tasks.timeline(id);
  const why = timeline.find((event) => typeof event.data?.why === "string")?.data?.why;
  const events: TaskEventView[] = timeline
    .filter((event) => !isProvenanceOnly(event))
    .map((event) => ({
      id: event.id,
      at: event.at,
      actor: event.actor,
      kind: event.kind,
      // A receipt reads as the brief it served, not its stored references.
      text: event.kind === "briefed" ? tasks.servedBrief(event) : tasks.capture.eventReceipt(event),
      data: event.data,
      ref: event.ref,
      feed: event.feed,
    }));
  // One read names each model once: the lookup reads the Settings rows.
  const names = new Map<string, string>();
  const modelLabel = (model: string) => {
    let name = names.get(model);
    if (name === undefined) {
      name = options.modelLabel?.(model) ?? model.slice(model.indexOf("/") + 1);
      names.set(model, name);
    }
    return name;
  };
  const modelReason = options.modelReason?.(record);
  const modelChoice = options.modelChoice?.(record);
  const runsOn = options.runsOn?.(record);
  const personal = personalReadOf(timeline);
  const reasoning = reasoningOf(record, timeline);
  const browser = options.browser?.(id);
  const cost = options.cost?.(record);
  const hold = holdOf(record);
  const cards = options.cards.forTask?.(id, cardIdsOf(timeline)) ?? [];
  const cardTitle = (cardId: string) => cards.find((card) => card.id === cardId)?.title;
  // Other tasks' events that concern this one, each naming the task that
  // wrote it (docs/task-record.md, "Whom an event concerns").
  // A row the graph does not hold, such as a replacement a closing names,
  // is read once on its own.
  const elsewhere = new Map<string, TaskRecord | undefined>();
  const rowOf = (taskId: string) => {
    const row = graph.byId.get(taskId);
    if (row || elsewhere.has(taskId)) return row ?? elsewhere.get(taskId);
    const read = tasks.get(taskId);
    elsewhere.set(taskId, read);
    return read;
  };
  const keyOf = (taskId: string) => {
    const row = rowOf(taskId);
    return row ? row.key || row.id : undefined;
  };
  const concerned = concerning.flatMap((event): ConcernedEventView[] => {
    const from = rowOf(event.taskId);
    if (!from) return [];
    const change =
      from.delivery?.changeLabel ??
      (from.delivery?.prNumber ? `#${from.delivery.prNumber}` : undefined);
    const changeUrl = from.delivery?.prUrl;
    const via = event.via ? keyOf(event.via) : undefined;
    return [
      {
        id: event.id,
        at: event.at,
        actor: event.actor,
        kind: event.kind,
        text: tasks.capture.eventReceipt(event),
        data: event.data,
        ref: event.ref,
        feed: event.feed,
        from: {
          id: from.id,
          key: from.key || from.id,
          ...(change ? { change } : {}),
          ...(changeUrl ? { changeUrl } : {}),
        },
        relation: event.relation,
        ...(via ? { via } : {}),
      },
    ];
  });
  const proof = liveValidationSummary(
    record.delivery?.liveValidation,
    record.delivery?.headSha ?? record.delivery?.validationHead,
    Boolean(record.delivery?.prUrl || record.delivery?.changeLabel),
  );
  if (proof && options.validationEvidence) {
    for (const row of proof.rows) row.evidence = options.validationEvidence(id, row.evidence);
  }
  // Every pull request on the task, from the changes its record keeps,
  // listed only on the record's read (INF-2490).
  const pullRequests = taskPullRequestsOf(tasks.changesFor(id), finishingChange(options, record));
  return {
    ...view,
    ...(view.delivery && pullRequests.length > 0
      ? { delivery: { ...view.delivery, pullRequests } }
      : {}),
    ...(record.shape?.issue
      ? { issue: { number: record.shape.issue.number, url: record.shape.issue.url } }
      : {}),
    ...(origin
      ? {
          filing: {
            why: typeof why === "string" ? why : "",
            originKey: origin.key || origin.id,
            verdict: record.verdict ?? null,
          },
        }
      : {}),
    ...(cost ? { cost } : {}),
    ...(parts.length > 0 ? { parts } : {}),
    intent: record.intent,
    liveValidation: proof,
    // The rigor the host derived at dispatch (delivery rigor phase 2), off
    // the shape it was stamped on; null on a row dispatched before it.
    policies: effectiveTaskPolicies(
      record,
      record.repoId ? options.repos.get(record.repoId) : undefined,
    ),
    ...(runsOn ? { runsOn } : {}),
    ...(record.placement ? { placement: record.placement.snapshot } : {}),
    ...(personal ? { personal } : {}),
    rigor: record.shape?.rigor ?? null,
    // What the host derived the task DELIVERS (Task B); null on a row
    // shaped before the axis existed, which shipped as a change.
    deliverable: record.shape?.deliverable ?? null,
    // The basis as the record names it, its verdict derived now.
    basis: tasks.graph.basisOf(record),
    skippedPlanBecause: record.shape?.skipped_plan_because ?? null,
    brief: record.prompt,
    outcome: readableOutcome(record, timeline),
    modelLabel: record.model ? modelLabel(record.model) : null,
    ...(modelReason ? { modelReason } : {}),
    ...(modelChoice ? { modelChoice } : {}),
    ...(reasoning ? { reasoning } : {}),
    cards,
    events,
    ...(options.timeline ? { timeline: options.timeline.history(id) } : {}),
    activityLog: condenseActivity(events, modelLabel, {
      cardTitle,
      concerned,
      keyOf,
      actions: options.actions?.(record) ?? [],
    }),
    said: options.said?.(record) ?? null,
    plan: planOf(timeline),
    closing: closingOf(record, events, tasks.graph.carriedOn(id)),
    problem: problemOf(events),
    ...(hold ? { hold: taskHoldWords(hold) } : {}),
    asks: tasks.capture.asksFor(id).flatMap((ask) => {
      const text = askReceipt(ask);
      // Preserve the window's verbatim-word match when projection changes the wording.
      if (text !== ask.text && ask.text === record.intent?.userWords) return [];
      return [
        {
          id: ask.id,
          at: ask.at,
          text,
          images: ask.images.length,
          attachedVia: ask.attachedVia,
          turnState: ask.turnState,
        },
      ];
    }),
    ...(isUnstartedWork(record) ? { dropEffects: tasks.dropEffects(id) } : {}),
    ...(browser ? { browser } : {}),
  };
}

/**
 * The change whose merge closes the task (INF-2490, INF-2744): the current
 * change, when the task's open merge card for it declared that its merge
 * closes the task. None otherwise.
 */
function finishingChange(
  options: Pick<TaskProtocolOptions, "cards">,
  record: TaskRecord,
): number | undefined {
  const current = currentChange(record.delivery, record.branch).number;
  if (current === undefined) return undefined;
  const card = options.cards
    .listOpen()
    .filter(
      (open) =>
        open.taskId === record.id &&
        open.actions.some((action) => {
          const merge = mergeEffectOf(action);
          return merge?.after === "close" && merge.review === undefined;
        }),
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!card) return undefined;
  const offer = record.delivery?.completionOffers?.find(
    (entry) => entry.cardId === card.id && entry.offerId === card.offerId,
  );
  return (offer?.shownFor ?? offer?.prNumber) === current ? current : undefined;
}

/**
 * The outcome as the record reads it. An answer given on a card is kept as
 * that card's body - a standalone note's question (`FileQuestionInput`), or
 * the body a revised note recorded (`recordAnswer`) - and the record paints
 * text, so it reads the card's words (FI3-904); its Cards row keeps the card.
 */
function readableOutcome(record: TaskRecord, timeline: readonly TaskEvent[]): string | null {
  const outcome = record.outcome;
  if (!outcome) return outcome;
  const onCard = timeline.some(
    (event) =>
      (event.kind === "answered" && event.data?.body === outcome) ||
      (record.kind === "question" && event.kind === "card_raised"),
  );
  return onCard ? cardWords(outcome) : outcome;
}

/** The ids of the cards a timeline names, raised or resolved: a Firstmate decision's card has no task id of its own. */
function cardIdsOf(timeline: readonly TaskEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of timeline) {
    if ((event.kind === "card_raised" || event.kind === "card_resolved") && event.ref)
      ids.add(event.ref);
  }
  return [...ids];
}

/**
 * The reasoning the crewmate's session opened at (`TaskDetail.reasoning`,
 * FI3-439): what its newest dispatch recorded beside the model, while the
 * record still names that model. A resume keeps its opening level and
 * records no dispatch, so the newest one still holds.
 */
function reasoningOf(record: TaskRecord, timeline: readonly TaskEvent[]): Reasoning | undefined {
  const dispatched = timeline.findLast((event) => event.kind === "dispatched");
  if (!dispatched?.data || !record.model || dispatched.data.model !== record.model)
    return undefined;
  const reasoning = reasoningSchema.safeParse(dispatched.data.reasoning);
  return reasoning.success ? reasoning.data : undefined;
}

/**
 * A `decided` event is capture machinery (R2): it rides the export and the
 * offline readers, never a client surface - the record pane stays the
 * captain's history of the work, not of the agents' bookkeeping.
 */
export function isProvenanceOnly(event: TaskEvent): boolean {
  return event.kind === "decided";
}

/**
 * How a closed row closed: its closing event's time, and the words recorded
 * with it beyond the reason's own word - a drop's reason (`dropped - <why>`,
 * as `dropWithChildren` writes it) or a supersede's line. Work carried on
 * reads where its work stands now (INF-1825): carried on by the task at the
 * end of its replacements while that runs, done through it once it is done.
 * Null while open.
 */
function closingOf(
  record: TaskRecord,
  events: readonly TaskEventView[],
  carried?: ReturnType<TaskService["graph"]["carriedOn"]>,
): TaskDetail["closing"] {
  if (!TaskService.isClosed(record)) return null;
  const close = events.findLast(
    (event) => event.data?.status === record.status && event.data?.reason === record.closedReason,
  );
  const at = close?.at ?? record.closedAt;
  if (at == null) return null;
  // A close as done's facts, and whether the captain's word asked it
  // (INF-3169's plan, piece 3): the record lists them in its Delivered row.
  const facts = deliveryFactsOf(close?.data ?? undefined).map(({ basis, text }) => ({
    basis,
    text,
  }));
  const onWord = close?.data?.onWord === true;
  const done = {
    ...(facts.length > 0 ? { facts } : {}),
    ...(onWord ? { onWord: true as const } : {}),
  };
  if (carried) return { at, note: carriedOnWords(carried), ...done };
  // The line already says the reason's word: the note keeps only what it adds.
  let words = (close?.text ?? "").replace(/^(?:dropped|superseded) - /, "").trim();
  for (const lead of [`${record.closedReason}: `, `${record.closedReason} - `])
    if (words.startsWith(lead)) words = words.slice(lead.length);
  const note = words && words !== record.closedReason ? words : null;
  return { at, note, ...done };
}

/** Where the work of a task closed as carried on stands, in the record's words (INF-1825). */
export function carriedOnWords(
  carried: NonNullable<ReturnType<TaskService["graph"]["carriedOn"]>>,
): string {
  if (carried.state === "done") return `Done through ${carried.key}`;
  if (carried.state === "dropped") return `Carried on by ${carried.key}, which was dropped`;
  return `Carried on by ${carried.key}`;
}

/**
 * What a gate holding open work waits on, from the gate and the work's own
 * ask alone (`TaskHold`): a level's gate that is the level the work asked
 * for - a premium ask, or a stronger-model retry's rung - is that ask's
 * wait (`requiresReasoningWait`), with the gate's cause when no allowance
 * reset can end it (`TaskGate.cause`); any other gate on queued work is one
 * Firstmate set with start_after. The captain's own gate says nothing here.
 */
function holdOf(record: TaskRecord): TaskHold | undefined {
  const gate = record.gate;
  if (record.status !== "open" || !gate) return undefined;
  if (gate.kind === "at-time")
    return gate.until !== undefined ? { kind: "time", until: gate.until } : undefined;
  if (gate.kind !== "quota-reset" || !gate.ref) return undefined;
  if (!gate.ref.startsWith("bucket:")) {
    return isAllowanceProvider(gate.ref)
      ? { kind: "plan", provider: providerLabel(servedProviderOf(gate.ref)) }
      : undefined;
  }
  const level = slotSchema.safeParse(gate.ref.slice("bucket:".length));
  if (!level.success) return undefined;
  const shape = record.shape;
  const cause = gate.cause ? { cause: gate.cause } : {};
  if (shape?.premium_ask && level.data === "premium") return { kind: "premium", ...cause };
  if (shape?.escalation?.floor === level.data)
    return { kind: "retry", level: level.data, from: shape.escalation.from, ...cause };
  return { kind: "level", level: level.data };
}

/**
 * The newest failure or interruption, as a sentence: a failed turn in the
 * vocabulary's words for its error (never the raw text), an interruption as
 * the stop it was.
 */
function problemOf(events: readonly TaskEventView[]): string | null {
  const last = events.findLast((event) => event.kind === "failed" || event.kind === "interrupted");
  if (!last) return null;
  if (last.kind === "interrupted") return "Its turn was stopped before it finished.";
  const error = typeof last.data?.error === "string" ? last.data.error : last.text;
  const words = crewProblem(error, typedFailureOf(last.data ?? {}));
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}
