import { type Card, isReadyDecision } from "@shared/cards";
import { overridePasses } from "@shared/holds";
import type { Slot } from "@shared/modelSlots";
import { captainActionResult } from "@shared/requiredActions";
import { cardMerges, taskMovesOf } from "@shared/taskMoves";
import { BOARD_RECENT_MS, type ProjectView, type TaskPlace, type TaskView } from "@shared/tasks";
import type { WorkPosture } from "@shared/workPosture";
import { reviewCoversHead } from "../orchestrator/reviewCarry";
import type { ProjectRecord } from "../storage/projectStore";
import type { TaskLink } from "../storage/taskLinkStore";
import type { PartCounts, TaskRecord } from "../storage/taskRecords";
import { deliveryViewOf } from "./deliveryView";
import { standingDependencyWaits } from "./dependencyWaits";
import { holdingWaits, waitsSince } from "./holdingWaits";
import { queueWaitOf } from "./queueWait";
import { reportHeadline } from "./recordActivity";
import type { TaskProtocolOptions } from "./taskProtocolOptions";
import { TaskService } from "./taskService";
import { type TaskWaitFacts, taskWaitsOf } from "./taskWaits";

/**
 * One row's view as the task protocol reads it (`TaskProtocol`,
 * `taskProtocol.ts`): the graph around the rows a read shows, each row's
 * view from that graph and the live host facts, and each project's counts.
 * Every view is derived at read time from the records and the facts, never
 * stored (principle 4).
 */

/** The host's own facts a view reads, which no write of the row reports. */
export type LiveFacts = {
  waits: TaskWaitFacts | undefined;
  repo: ReturnType<TaskProtocolOptions["repos"]["get"]>;
  posture: WorkPosture | undefined;
  place: TaskPlace | undefined;
  computerMove: Pick<TaskView, "movable" | "computerMove"> | undefined;
  startAttempt: { phase: "preparing" | "checking"; since: number } | undefined;
};

export type Graph = {
  byId: Map<string, TaskRecord>;
  /** Each row's children among `byId`, in the rows' order: the parts a start wait reads. */
  parts: Map<string, TaskRecord[]>;
  links: TaskLink[];
  /** Row-local edges: wait dates and queue waits never walk the whole board. */
  linksInto: Map<string, TaskLink[]>;
  blockersOf: Map<string, TaskRecord[]>;
  blockingOf: Map<string, TaskRecord[]>;
  children: Map<string, PartCounts>;
  filedFrom: Map<string, TaskLink>;
  decisionCards: Map<string, Card>;
  openCardIds: Set<string>;
  durableDecisions: Set<string>;
  /** What carries each dropped or superseded row's work on (`TaskService.graph.replacementsOf`). */
  replacedBy: Map<string, string>;
};

/** A project's counts while it has no tasks. */
const NO_COUNTS = { needsYou: 0, waitingOnYou: 0, open: 0, active: 0, doneRecent: 0 } as const;

export function factsKey(facts: LiveFacts): string {
  return JSON.stringify([
    facts.repo?.name,
    facts.posture,
    facts.waits,
    facts.place,
    facts.computerMove,
    facts.startAttempt,
  ]);
}

/**
 * The card facts a view reads: the decision card it waits on and whether
 * that card merges, a durable decision on it, and whether its gate's card
 * is up. Read from the cards at each read, so a card raised or resolved
 * with no write of the row still rebuilds it.
 */
export function cardFactsOf(record: TaskRecord, graph: Graph): string {
  const card = TaskService.isClosed(record) ? undefined : graph.decisionCards.get(record.id);
  const gateUp =
    record.gate?.kind === "captain" && record.gate.ref
      ? graph.openCardIds.has(record.gate.ref)
      : false;
  return `${card?.id ?? ""}\0${card ? cardMerges(card) : false}\0${graph.durableDecisions.has(record.id)}\0${gateUp}`;
}

// ---- view building ------------------------------------------------------

/**
 * The graph around these rows, read from them alone: the edges touching
 * them, the rows at those edges' other ends, and each row's child counts.
 * Holds every fact `viewOf` reads for these rows while they include the
 * whole live set (a gate, a ready decision and a standing wait name live
 * work), or the rows' own standing waits (`detail`) or none (closed rows).
 */
export function graphFor(
  options: Pick<TaskProtocolOptions, "tasks" | "cards">,
  rows: readonly TaskRecord[],
  cards: readonly Card[] = options.cards.snapshot(),
): Graph {
  const { tasks } = options;
  const ids = rows.map((record) => record.id);
  const known = new Set(ids);
  const links = tasks.graph.linksTouching(ids);
  const ends = new Set<string>();
  for (const link of links) {
    if (!known.has(link.fromId)) ends.add(link.fromId);
    if (!known.has(link.toId)) ends.add(link.toId);
  }
  const all = [...rows, ...tasks.getMany([...ends])];
  // What replaced each dropped row, read for all of them at once; one at
  // a time, each read its task's whole timeline (INF-2070).
  const replacedBy = tasks.graph.replacementsOf(rows.filter(replaced).map((record) => record.id));
  return graphOf(options, all, links, replacedBy, tasks.childCounts(ids), cards);
}

export function graphOf(
  options: Pick<TaskProtocolOptions, "tasks" | "cards">,
  all: readonly TaskRecord[],
  links: TaskLink[],
  replacedBy: Map<string, string>,
  childCounts: Map<string, PartCounts> | undefined,
  cards: readonly Card[],
): Graph {
  // The graph owns these current records, including the other tasks a posture reads.
  options.tasks.readProjection(() => undefined, all);
  const byId = new Map(all.map((record) => [record.id, record]));
  // Each row's children among these rows, in their order: the parts a
  // start wait reads, found once rather than by a walk of every row per view.
  const parts = new Map<string, TaskRecord[]>();
  for (const record of all) if (record.parentId) push(parts, record.parentId, record);
  const linksInto = new Map<string, TaskLink[]>();
  const blockersOf = new Map<string, TaskRecord[]>();
  const blockingOf = new Map<string, TaskRecord[]>();
  for (const link of links) {
    const incoming = linksInto.get(link.toId);
    if (incoming) incoming.push(link);
    else linksInto.set(link.toId, [link]);
    if (link.type !== "blocks") continue;
    const from = byId.get(link.fromId);
    const to = byId.get(link.toId);
    if (!from || !to) continue;
    push(blockersOf, link.toId, from);
    push(blockingOf, link.fromId, to);
  }
  const children = childCounts ?? new Map<string, PartCounts>();
  if (!childCounts) {
    for (const record of all) {
      if (!record.parentId) continue;
      const entry = children.get(record.parentId) ?? { total: 0, closed: 0 };
      entry.total += 1;
      if (TaskService.isClosed(record)) entry.closed += 1;
      children.set(record.parentId, entry);
    }
  }
  // Each task's first crewmate-filed discovered-from edge, read once per view build.
  const filedFrom = new Map<string, TaskLink>();
  for (const link of links) {
    if (link.type !== "discovered-from" || link.actor !== "crewmate") continue;
    if (!filedFrom.has(link.fromId)) filedFrom.set(link.fromId, link);
  }
  const decisionCards = new Map<string, Card>();
  const gateTasks = new Map<string, TaskRecord[]>();
  for (const record of all) {
    if (TaskService.isClosed(record) || record.gate?.kind !== "captain" || !record.gate.ref)
      continue;
    push(gateTasks, record.gate.ref, record);
  }
  const durableDecisions = new Set<string>();
  const openCardIds = new Set<string>();
  for (const card of options.cards.listOpen()) {
    openCardIds.add(card.id);
    if (card.actions.length > 0 && card.taskId) durableDecisions.add(card.taskId);
  }
  // Snapshot is already in stage priority/newest order. Hidden siblings
  // never mask a reachable ready choice.
  for (const card of cards) {
    if (!isReadyDecision(card)) continue;
    const direct = card.taskId ? byId.get(card.taskId) : undefined;
    if (card.taskId && (!direct || TaskService.isClosed(direct))) continue;
    for (const task of [...(direct ? [direct] : []), ...(gateTasks.get(card.id) ?? [])]) {
      if (!decisionCards.has(task.id)) decisionCards.set(task.id, card);
    }
  }
  return {
    byId,
    parts,
    links,
    linksInto,
    blockersOf,
    blockingOf,
    children,
    filedFrom,
    decisionCards,
    durableDecisions,
    openCardIds,
    replacedBy,
  };
}

/** The served slot of each work row among these (a crewmate only exists for work). */
export function tiersOf(
  options: Pick<TaskProtocolOptions, "tiers">,
  records: readonly TaskRecord[],
): ReadonlyMap<string, Slot> {
  const ids = records.filter((record) => record.kind === "work").map((record) => record.id);
  return ids.length > 0 && options.tiers ? options.tiers(ids) : new Map();
}

export function viewOf(
  options: Pick<TaskProtocolOptions, "tasks" | "cards">,
  record: TaskRecord,
  graph: Graph,
  tiers: ReadonlyMap<string, Slot>,
  facts: LiveFacts,
): TaskView {
  const blockers = graph.blockersOf.get(record.id) ?? [];
  const waiting = blockers.filter((blocker) => !TaskService.blockerCleared(blocker));
  const liveBlockers = blockers.filter(TaskService.blockerHoldsClose);
  const { repo, posture, place, startAttempt, computerMove } = facts;
  const baseline = TaskService.isClosed(record)
    ? []
    : standingDependencyWaits(graph.byId, record.delivery, options.tasks);
  // Blocked by names only the waits that hold the task now, by the one
  // rule the tasks reader shares (./holdingWaits.ts, INF-999). Dropped
  // edges remain in the graph and still gate STARTING, but closed work is
  // never presented as something still underway.
  const holding = holdingWaits({ record, blockers, tasks: graph.byId, baseline });
  const blockedSince = waitsSince({
    record,
    holding,
    links: graph.linksInto.get(record.id) ?? [],
    tasks: graph.byId,
    baseline,
  });
  const startHolding =
    record.status === "open" && waiting.length !== holding.length ? waiting : holding;
  const waitSince =
    startHolding === holding
      ? blockedSince
      : waitsSince({
          record,
          holding: startHolding,
          links: graph.linksInto.get(record.id) ?? [],
          tasks: graph.byId,
          baseline,
        });
  const open = record.status === "open";
  // An active row shows the blockers that still hold its CLOSE: every live
  // blocker, since a recorded wait holds the merge until that work closes
  // (INF-3167; TaskService.graph.flagsOf), unless the captain's recorded
  // override passed that hold (`overridePasses`, as Blocked by reads it).
  // A dropped blocker holds no close, so it is no dead wait there either.
  const blocked = open
    ? waiting.length > 0
    : record.status === "active" &&
      liveBlockers.length > 0 &&
      !overridePasses(record.delivery, "waits", record.delivery?.headSha);
  // A gate holds an active row as it holds an open one (TaskService.graph.flagsOf).
  const held = (open || record.status === "active") && record.gate !== null;
  const deadBlocker = open && waiting.some((blocker) => blocker.status === "dropped");
  // The decision card the captain must answer: one raised on this task,
  // or the card its captain gate names - a decision row's own card, a
  // host card's operation row, or the card holding a crewmate's task.
  const gateCard =
    record.gate?.kind === "captain" && record.gate.ref && graph.openCardIds.has(record.gate.ref)
      ? record.gate.ref
      : null;
  const waitingCard = TaskService.isClosed(record) ? undefined : graph.decisionCards.get(record.id);
  const waitingCardId = waitingCard?.id ?? null;
  const answerNote = options.cards.answerNoteForTask?.(record.id);
  // A declaration remains an operational hold, not proof that a ready
  // decision is available to the captain (FI3-702).
  const captainWait = record.status === "active" && Boolean(record.delivery?.captainWait);
  const needsYou =
    !TaskService.isClosed(record) &&
    (answerNote !== undefined ||
      waitingCardId !== null ||
      captainWait ||
      graph.durableDecisions.has(record.id) ||
      gateCard !== null ||
      (open && record.gate?.kind === "captain") ||
      deadBlocker);
  const delivery = deliveryViewOf(record.delivery);
  // Whether a pass covers the version on offer, so a screen that shows
  // "passed" can say when it covers only an earlier one (INF-3141).
  if (delivery?.reviewVerdict === "pass" && delivery.reviewSha && delivery.headSha)
    delivery.reviewCovers = reviewCoversHead(delivery, delivery.headSha);
  return withMoves({
    id: record.id,
    key: record.key,
    projectId: record.projectId,
    parentId: record.parentId,
    ...(record.kind === "work"
      ? { reviewOf: reviewBuilderOf(record), executionDeviceId: record.deviceId }
      : {}),
    ...(record.shape?.program ? { program: true as const } : {}),
    ...(place ? { place } : {}),
    ...computerMove,
    kind: record.kind,
    title: record.title,
    goal: record.goal,
    priority: record.priority,
    status: record.status,
    activity: record.activity,
    workPosture: posture,
    waits: taskWaitsOf({
      record,
      holding: startHolding,
      since: waitSince,
      posture,
      facts: facts.waits,
      decision:
        waitingCardId !== null || gateCard !== null || graph.durableDecisions.has(record.id),
    }),
    closedReason: record.closedReason,
    ...(replaced(record) ? { replacedBy: graph.replacedBy.get(record.id) } : {}),
    startPolicy: record.startPolicy,
    queueWait: startAttempt
      ? undefined
      : queueWaitOf(
          record,
          blockers,
          graph.linksInto.get(record.id) ?? [],
          graph.parts.get(record.id) ?? [],
        ),
    flags: {
      blocked,
      held,
      needsYou,
      ready: open && record.kind === "work" && !blocked && !held,
    },
    blockedBy: holding.map((blocker) => blocker.key || blocker.id),
    ...(Object.keys(blockedSince).length > 0 ? { blockedSince } : {}),
    blocks: (graph.blockingOf.get(record.id) ?? []).map((blocked) => blocked.key || blocked.id),
    children: graph.children.get(record.id) ?? { total: 0, closed: 0 },
    assignee: record.assignee,
    model: record.model,
    tier: tiers.get(record.id) ?? null,
    repo: repo ? { name: repo.name, branch: record.branch } : null,
    delivery,
    // A summary stored before reports skipped their Intent section reads
    // again from the report (the popup audit, A2).
    outcomeSummary: record.outcome
      ? reportHeadline(record.outcome, record.outcomeSummary)
      : record.outcomeSummary,
    waitingCardId,
    ...(answerNote ? { answerNoteId: answerNote.id, answerSince: answerNote.createdAt } : {}),
    ...(record.delivery?.captainAction
      ? {
          requiredAction: {
            cardId: record.delivery.captainAction.cardId,
            state: record.delivery.captainAction.state,
            result: captainActionResult(record.delivery.captainAction),
          },
        }
      : {}),
    ...(cardMerges(waitingCard) ? { waitingCardMerges: true as const } : {}),
    ...(captainWait ? { captainWait } : {}),
    ...startMarksOf(record, startAttempt),
    ...(record.status === "active" && record.backlogSince != null
      ? { backlogSince: record.backlogSince }
      : {}),
    ...(record.pinnedAt != null ? { pinnedAt: record.pinnedAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    closedAt: record.closedAt,
    ...filingMarks(record, graph),
  });
}

/**
 * Each project's counts (the project index); `viewed` answers each live
 * row's view, from the views already built for this read where it can.
 */
export function projectViews(
  options: Pick<TaskProtocolOptions, "tasks" | "repos">,
  all: readonly TaskRecord[],
  now: number,
  viewed: (record: TaskRecord) => TaskView,
): ProjectView[] {
  const cutoff = now - BOARD_RECENT_MS;
  const counts = new Map<string, ProjectView["counts"]>();
  for (const record of all) {
    const entry = counts.get(record.projectId) ?? {
      needsYou: 0,
      waitingOnYou: 0,
      open: 0,
      active: 0,
      doneRecent: 0,
    };
    counts.set(record.projectId, entry);
    if (record.status === "open") entry.open += 1;
    else if (record.status === "active") entry.active += 1;
    else if (record.status === "done" && (record.closedAt ?? 0) >= cutoff) entry.doneRecent += 1;
    // Closed work never needs the captain or waits on him (viewOf), so only
    // live rows are viewed: a long record is mostly closed rows.
    if (TaskService.isClosed(record)) continue;
    const view = viewed(record);
    if (view.flags.needsYou) entry.needsYou += 1;
    if (view.answerNoteId || view.waitingCardId || (view.requiredAction && view.status === "open"))
      entry.waitingOnYou += 1;
  }
  // Scratch first, then repo projects oldest first: a stable order a
  // panel can rely on (the store orders by creation, where Scratch and a
  // repo registered in the same millisecond would tie).
  return options.tasks.projects
    .list()
    .sort(
      (a, b) =>
        Number(b.kind === "scratch") - Number(a.kind === "scratch") ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    )
    .map((project) => projectView(options, project, counts));
}

function projectView(
  options: Pick<TaskProtocolOptions, "tasks" | "repos">,
  project: ProjectRecord,
  counts: Map<string, ProjectView["counts"]>,
): ProjectView {
  const repos = options.tasks.projects.repositoriesOf(project.id).flatMap((member) => {
    const repo = options.repos.get(member.id);
    return repo
      ? [
          {
            id: member.id,
            name: repo.name,
            delivery: repo.delivery,
            autonomy: repo.autonomy,
            kind: repo.kind,
          },
        ]
      : [];
  });
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    repo: repos[0] ?? null,
    ...(repos.length > 0 ? { repos } : {}),
    archived: project.archivedAt !== null,
    counts: counts.get(project.id) ?? NO_COUNTS,
  };
}

// ---- a row's marks ------------------------------------------------------

export function reviewBuilderOf(record: TaskRecord): string | null {
  return record.shape?.kind === "review" && record.shape.kind_source === "host:review"
    ? record.parentId
    : null;
}

/**
 * A live work row with the moves it allows now, by the task record's own
 * rule (src/shared/taskMoves.ts); any other row carries none.
 */
export function withMoves(view: TaskView): TaskView {
  const moves = taskMovesOf(view);
  return moves ? { ...view, moves } : view;
}

/** A row whose view names what replaced it: dropped work, or work superseded. */
export function replaced(record: TaskRecord): boolean {
  return record.status === "dropped" || record.closedReason === "superseded";
}

/** A crewmate-authored discovered-from edge, and the origin it names. */
export function crewFilingOrigin(record: TaskRecord, graph: Graph): TaskRecord | undefined {
  const link = graph.filedFrom.get(record.id);
  return link ? graph.byId.get(link.toId) : undefined;
}

function filingMarks(
  record: TaskRecord,
  graph: Graph,
): { foundOn: string; filingNew: boolean } | undefined {
  const origin = crewFilingOrigin(record, graph);
  if (!origin) return undefined;
  return {
    foundOn: origin.key || origin.id,
    filingNew: record.captainOpenedAt == null && !TaskService.isClosed(record),
  };
}

function push(map: Map<string, TaskRecord[]>, key: string, value: TaskRecord): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function startMarksOf(
  record: TaskRecord,
  attempt: { phase: "preparing" | "checking"; since: number } | undefined,
): Pick<TaskView, "startAttempt" | "startNotice"> {
  const notice = parseStartNotice(record.startNotice);
  return {
    ...(attempt ? { startAttempt: attempt } : {}),
    ...(notice && record.status === "open" ? { startNotice: notice } : {}),
  };
}

function parseStartNotice(raw: string | null | undefined): { reason: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.length > 0
      ? { reason: parsed.reason }
      : undefined;
  } catch {
    return undefined;
  }
}
