import type { AttachmentRef } from "@shared/attachments";
import type { CardAnswer, CardDecisionContext } from "@shared/cards";
import { reportSummary } from "@shared/feed";
import type { LastTurn, LastTurnReply } from "@shared/lastTurn";
import {
  type AskDelivery,
  type DeliveryEntry,
  type DeliveryFacts,
  JUDGEABLE_DELIVERY,
} from "../orchestrator/answerDelivery";
import type { MessageFile } from "../overflow";
import type { AskAttachedVia, AskImage, AskRecord, AskTurnState } from "../storage/askStore";
import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskCoverageFields, TaskRecord } from "../storage/taskStore";
import {
  ORIGIN_NOTE_KEY,
  originAbout,
  originNoteText,
  type SavedOrigin,
  savedOriginOf,
  type TaskOriginLine,
} from "./taskOrigin";
import type { TaskService } from "./taskService";
import type { TaskWriter } from "./taskWriter";

export type OpenAskInput = {
  /** The turn id. */
  id: string;
  text: string;
  images?: AskImage[];
  /** The message's own copies of `images` (`src/core/attachments.ts`). */
  attachments?: AttachmentRef[];
  messageFiles?: MessageFile[];
  hintTaskId?: string | null;
  at?: number;
  /** The message this one sends again (Ask again on the answer-delivery notice). */
  retryOf?: string;
};

/**
 * A standalone one-off the Firstmate answered (or the host filed at turn
 * end when nothing attached): a `question` task born closed (D1 - it exists
 * only when the ask is about no other work).
 */
export type FileQuestionInput = {
  id: string;
  title: string;
  /** The answer: the card body, or the turn's closing text for a fallback. */
  outcome: string | null;
  repoId?: string | null;
  projectId?: string;
  /** The card that carried the answer, when there was one. */
  cardId?: string;
  actor?: TaskEventActor;
  /** Why the host filed it instead of the agent (fallback provenance). */
  fallback?: "question";
};

/** A fleet/self operation the Firstmate performed: filed done/settled. */
export type FileOperationInput = {
  id: string;
  title: string;
  /** The tool's own result text. */
  outcome: string;
  tool: string;
  repoId?: string | null;
  projectId?: string;
  actor?: TaskEventActor;
};

/**
 * A decision the Firstmate raised that gates no recorded work: an open
 * `decision` task waiting on the captain (its card id is the gate ref, the
 * same shape a parked decision carries).
 */
export type FileDecisionInput = {
  id: string;
  title: string;
  cardId: string;
  repoId?: string | null;
  projectId?: string;
  actor?: TaskEventActor;
};

/**
 * The capture side (design section 6): the `captain_asks` rows each turn
 * opens, attached to tasks with their `ask` event, their answers and
 * delivery, and the question, decision and operation kinds the attaching
 * paths file. Reached as `tasks.capture`.
 */
export class TaskCapture {
  constructor(
    private readonly writer: TaskWriter,
    private readonly tasks: TaskService,
  ) {}

  getAsk(id: string): AskRecord | undefined {
    return this.writer.asks.get(id);
  }

  /** Asks whose turn has not closed - the host's turn scope. */
  listOpenAsks(): AskRecord[] {
    return this.writer.asks.listOpen();
  }

  /** The messages the answer-delivery check holds in one state. */
  listAsksByDelivery(delivery: AskDelivery): AskRecord[] {
    return this.writer.asks.listByDelivery(delivery);
  }

  /** The asks that first attached to this task. */
  asksFor(id: string): AskRecord[] {
    return this.writer.asks.listFor(id);
  }

  /**
   * The tasks whose work this one was handed: the work it took over (a
   * `replaced-by` link into it), the attempt it retries (`retry-of`) and the
   * task whose branch it continues (`branch-source`). The cards' You asked
   * line and what the captain already allowed (`sameWorkLineage`) read it.
   */
  handedOver(taskId: string): string[] {
    return [
      ...this.writer.links.listTo(taskId, "replaced-by").map((link) => link.fromId),
      ...this.writer.references
        .list(taskId)
        .filter((entry) => entry.kind === "retry-of" || entry.kind === "branch-source")
        .flatMap((entry) => this.tasks.graph.referenceTarget(entry)?.id ?? []),
    ];
  }

  /**
   * Where a task's work came from, for its cards' line (INF-1610, INF-2326;
   * docs/card-authoring.md "The You asked line"): read from the saved
   * messages and origins through the task graph, never from any card's
   * words. The walk is `originAbout` in `taskOrigin.ts`.
   */
  originAbout(id: string): TaskOriginLine | undefined {
    return originAbout(
      {
        get: (taskId) => this.writer.store.get(taskId),
        handedOver: (taskId) => this.handedOver(taskId),
        basis: (taskId) => {
          const basis = this.writer.references.list(taskId).find((entry) => entry.kind === "basis");
          return basis ? this.tasks.graph.referenceTarget(basis)?.id : undefined;
        },
        followsUp: (taskId) =>
          this.writer.links.listFrom(taskId, "discovered-from").map((link) => link.toId),
        events: (taskId) =>
          this.writer.events
            .listFor(taskId)
            .filter((event) => event.kind === "ask" || event.kind === "note"),
        ask: (askId) => this.writer.asks.get(askId),
        askReach: (askId) => this.writer.events.taskIdsWithRef("ask", askId).length,
      },
      id,
    );
  }

  /** The task whose crewmate's report this task's work came from, when it saved one (INF-2326). */
  reportOrigin(id: string): string | undefined {
    for (const event of this.writer.events.listFor(id)) {
      const saved = savedOriginOf(event);
      if (saved) return saved.kind === "report" ? saved.taskId : undefined;
    }
    return undefined;
  }

  /**
   * Save where a task's work came from when it was not a message of the
   * captain's (INF-2326): an automation run, a card click or a crewmate's
   * report the first mate answered by filing or starting it. The first one
   * saved stands; a later one adds nothing.
   */
  saveOrigin(taskId: string, origin: SavedOrigin): boolean {
    const run = this.writer.write((): boolean => {
      this.writer.mustGet(taskId);
      if (this.writer.events.listFor(taskId).some((event) => savedOriginOf(event))) return false;
      const reporter = origin.kind === "report" ? this.writer.store.get(origin.taskId) : undefined;
      this.writer.addEvent({
        taskId,
        at: this.writer.now(),
        actor: "host",
        kind: "note",
        text: originNoteText(origin, reporter?.key || reporter?.title),
        data: { [ORIGIN_NOTE_KEY]: origin },
        feed: false,
      });
      return true;
    });
    return run();
  }

  /**
   * The work a captain's messages cover (docs/task-capture.md "How a
   * message ends"): the tasks they attached to, those tasks' parts, the
   * work built on them, and the work handed over from them - a
   * replacement, a stronger model, a retry or a branch taken from one.
   * With `before`, work filed after that time is left out, apart from a
   * task a message attached to itself: work linked after a message was
   * answered belongs to the newer message. `acted` is the part of that
   * work the first mate's own tools attached these messages to: work it
   * filed, started, steered or settled for them - never the host's
   * fallback to the task a message pointed at. Both come from one lookup
   * per message, because the open messages are read before and after
   * every first mate turn and each lookup reads the task events (INF-2059).
   */
  askCoverage(
    askIds: readonly string[],
    before?: number,
  ): { work: TaskCoverageFields[]; acted: Set<string> } {
    const attributions = this.writer.events.askAttributions(askIds);
    const attached = [...new Set(attributions.map((entry) => entry.taskId))];
    const authored = new Set(
      attributions.filter((entry) => entry.via?.startsWith("tool:")).map((entry) => entry.taskId),
    );
    const acted = new Set(attached.filter((taskId) => authored.has(taskId)));
    const found = new Map<string, TaskCoverageFields>();
    const queue = [...attached];
    const seeds = new Set(attached);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (found.has(id)) continue;
      const record = this.writer.store.coverageFields(id);
      if (!record) continue;
      if (before !== undefined && !seeds.has(id) && record.createdAt > before) continue;
      found.set(id, record);
      queue.push(...this.workAfter(record));
    }
    return { work: [...found.values()], acted };
  }

  /** The tasks that carry a task's work on: its parts, what builds on it and its handovers. */
  private workAfter(record: Pick<TaskRecord, "id" | "key">): string[] {
    const known = this.writer.projection?.workAfter.get(record.id);
    if (known) return known;
    const key = record.key || null;
    const next = [
      ...this.writer.store.childIds(record.id),
      ...this.writer.links.listFrom(record.id, "replaced-by").map((link) => link.toId),
      ...(["basis", "retry-of", "branch-source"] as const).flatMap((kind) =>
        this.writer.references.taskIdsNaming(kind, record.id, key),
      ),
      ...this.escalations(record.id, "escalated_to"),
    ];
    this.writer.projection?.workAfter.set(record.id, next);
    return next;
  }

  /** The tasks a task's work came from: the inverse of `workAfter`. */
  private workBefore(record: TaskRecord): string[] {
    return [
      ...(record.parentId ? [record.parentId] : []),
      ...this.writer.links.listTo(record.id, "replaced-by").map((link) => link.fromId),
      ...this.writer.references
        .list(record.id)
        .filter(
          (entry) =>
            entry.kind === "basis" || entry.kind === "retry-of" || entry.kind === "branch-source",
        )
        .flatMap((entry) => this.tasks.graph.referenceTarget(entry)?.id ?? []),
      ...this.escalations(record.id, "escalated_from"),
    ];
  }

  /** The other attempt a stronger-model move names, on the side `side` records. */
  private escalations(id: string, side: "escalated_to" | "escalated_from"): string[] {
    return this.writer.events.escalationRefs(id, side);
  }

  /**
   * The captain's messages whose work includes this task, newest first:
   * those attached to it or to the work it came from. A message answered
   * before the task was filed is left out unless it attached to the task
   * itself (`askCoverage`'s rule, from the other side).
   */
  asksAbove(id: string): AskRecord[] {
    const seen = new Set<string>();
    const asks = new Map<string, AskRecord>();
    const target = this.writer.store.get(id);
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const record = this.writer.store.get(current);
      if (!record) continue;
      for (const ref of this.writer.events.refsOf(current, "ask")) {
        const ask = this.writer.asks.get(ref);
        if (!ask || asks.has(ask.id)) continue;
        const later =
          current !== id &&
          target !== undefined &&
          ask.answeredAt !== null &&
          target.createdAt > ask.answeredAt;
        if (!later) asks.set(ask.id, ask);
      }
      queue.push(...this.workBefore(record));
    }
    return [...asks.values()].sort((a, b) => b.at - a.at);
  }

  /** Complete unfinished chains, with each message decoded once for this read. */
  openAskChains(running = false): { root: AskRecord; members: AskRecord[] }[] {
    return this.writer.asks.openChains(running);
  }

  /** A message and every message that joined its work, oldest first. */
  askMembers(rootId: string): AskRecord[] {
    const root = this.writer.asks.get(rootId);
    return root ? [root, ...this.writer.asks.listContinuing(rootId)] : [];
  }

  /** The captain accepted a card as the answer to these messages. */
  acceptAnswer(askIds: readonly string[], cardId: string): void {
    const at = this.writer.now();
    this.writer.write(() => {
      for (const id of askIds) this.writer.asks.setAccepted(id, cardId, at);
    })();
  }

  /** These messages are answered, on a card or by a reaction: final. */
  markAnswered(askIds: readonly string[], cardId: string | null): void {
    const at = this.writer.now();
    this.writer.write(() => {
      for (const id of askIds) this.writer.asks.setAnswered(id, cardId, at);
    })();
  }

  /** The once a message's last crewmate was asked for its answering card. */
  markCrewmateAsked(askId: string): void {
    const at = this.writer.now();
    this.writer.write(() => this.writer.asks.setCrewmateAsked(askId, at))();
  }

  /** Complete text files the messages attached to this task kept at acceptance. */
  messageFiles(id: string): MessageFile[] {
    return this.writer.events
      .listFor(id)
      .filter((event) => event.kind === "ask" && event.ref)
      .flatMap((event) => this.writer.asks.get(event.ref as string)?.messageFiles ?? []);
  }

  /** The captain's pictures, in message order, each copy once. */
  pictures(id: string): AttachmentRef[] {
    const seen = new Set<string>();
    return this.writer.events
      .listFor(id)
      .filter((event) => event.kind === "ask" && event.ref)
      .flatMap((event) => this.writer.asks.get(event.ref as string)?.attachments ?? [])
      .filter((ref) => {
        if (seen.has(ref.id)) return false;
        seen.add(ref.id);
        return true;
      });
  }

  listAsks(): AskRecord[] {
    return this.writer.asks.list();
  }

  /** The captain's newest message's id: the one a turn's reply line answers. */
  latestAskId(): string | undefined {
    return this.writer.asks.latestId();
  }

  /** The last turn above the input: the newest message and its reply line. */
  lastTurn(): LastTurn | null {
    return this.writer.asks.lastTurn();
  }

  /** The Firstmate's reply line beside a message, kept for the next launch. */
  setAskReply(askId: string, reply: LastTurnReply): void {
    this.writer.write(() => this.writer.asks.setReply(askId, reply))();
  }

  /**
   * The task as it stands right now, as a copy a card choice keeps beside
   * it (docs/card-evidence.md): its identity and state, its gate, what its
   * delivery last read, what it waits on, and the asks it carries. Read
   * before the choice moves the task, so it is the input the choice was
   * made on, never the row it became. Reads only.
   */
  decisionContext(id: string): CardDecisionContext | undefined {
    const record = this.writer.store.get(id);
    if (!record) return undefined;
    const delivery = record.delivery;
    return {
      at: this.writer.now(),
      taskId: record.id,
      key: record.key,
      kind: record.kind,
      status: record.status,
      activity: record.activity,
      parentId: record.parentId,
      gate: record.gate
        ? { kind: record.gate.kind, ...(record.gate.ref ? { ref: record.gate.ref } : {}) }
        : null,
      delivery: delivery
        ? {
            mode: delivery.mode,
            ...(delivery.changeLabel ? { changeLabel: delivery.changeLabel } : {}),
            ...(delivery.headSha ? { headSha: delivery.headSha } : {}),
            ...(delivery.ci ? { checks: delivery.ci } : {}),
            ...(delivery.ciAt !== undefined ? { checksAt: delivery.ciAt } : {}),
            ...(delivery.reviewVerdict ? { review: delivery.reviewVerdict } : {}),
            ...(delivery.reviewSha ? { reviewSha: delivery.reviewSha } : {}),
            ...(delivery.reviewedAt !== undefined ? { reviewedAt: delivery.reviewedAt } : {}),
            settlePending: Boolean(record.pendingSettle),
          }
        : null,
      blockers: this.tasks.graph
        .blockers(id)
        .map((blocker) => ({ id: blocker.id, status: blocker.status })),
      asks: this.asksFor(id).map((ask) => ask.id),
    };
  }

  /**
   * The open decision row a card carries: a decision the Firstmate raised
   * without a task (P1), which keeps the card id as its captain gate's ref
   * and lives exactly as long as the card is on the stack.
   */
  openDecisionFor(cardId: string): TaskRecord | undefined {
    return this.writer.store
      .listByStatus("open")
      .find((record) => record.kind === "decision" && record.gate?.ref === cardId);
  }

  /**
   * The open row that exists only for a card: a Firstmate decision filed
   * without a task, or the operation row a host card with no task files
   * (`fileHostCardTask`). Either keeps the card id as its captain gate's
   * ref and closes when the card leaves the stack.
   */
  openCardTaskFor(cardId: string): TaskRecord | undefined {
    return this.writer.store
      .listByStatus("open")
      .find(
        (record) =>
          (record.kind === "decision" ||
            (record.kind === "operation" && !record.delivery?.captainAction)) &&
          record.gate?.kind === "captain" &&
          record.gate.ref === cardId,
      );
  }

  /**
   * A settled run's later step (docs/orchestrator-contract.md, "Settled
   * runs"): the run's one operation, in its place, says where the setting
   * stands now.
   */
  reviseOperation(id: string, input: { title: string; outcome: string }): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (record.kind !== "operation") throw new Error(`${record.key} is not an operation.`);
      this.writer.patch(id, {
        title: input.title,
        outcome: input.outcome,
        outcomeSummary: reportSummary(input.outcome) || null,
        closedAt: at,
        updatedAt: at,
      });
    });
    run();
  }

  /** A captain turn begins: the ask row exists before the agent runs. */
  openAsk(input: OpenAskInput): AskRecord {
    const record: AskRecord = {
      id: input.id,
      at: input.at ?? this.writer.now(),
      text: input.text,
      images: input.images ?? [],
      attachments: input.attachments ?? [],
      messageFiles: input.messageFiles ?? [],
      hintTaskId: input.hintTaskId ?? null,
      taskId: null,
      attachedVia: null,
      attachedAt: null,
      turnState: "open",
      delivery: "pending",
      deliveryFacts: { entries: [], ...(input.retryOf ? { retryOf: input.retryOf } : {}) },
      noticeCardId: null,
      followed: true,
      continues: null,
      answerCardId: null,
      acceptedAt: null,
      answeredAt: null,
      crewmateAskedAt: null,
    };
    this.writer.asks.insert(record);
    return record;
  }

  /**
   * Attach an ask to a task: the first attachment fills the ask's columns,
   * every attachment writes an `ask` event on the task (one ask may be about
   * several tasks), in one transaction. Idempotent per (ask, task).
   */
  attachAsk(askId: string, taskId: string, via: AskAttachedVia, starts?: boolean): boolean {
    const at = this.writer.now();
    const run = this.writer.write((): boolean => {
      const ask = this.writer.asks.get(askId);
      if (!ask) throw new Error(`Unknown ask "${askId}".`);
      this.writer.mustGet(taskId);
      const already = this.writer.events
        .listFor(taskId)
        .some((event) => event.kind === "ask" && event.ref === askId);
      if (already) return false;
      const first = this.writer.asks.attach(askId, taskId, via, at);
      // A message first attached to work an earlier message's work includes
      // joins that earlier message while it has not ended (docs/task-capture.md
      // "How a message ends"); a later attachment, such as a message named on
      // other work, never moves it.
      if (first && ask.followed && ask.continues === null) {
        const earlier = this.asksAbove(taskId).find(
          (other) =>
            other.id !== askId &&
            other.followed &&
            other.at <= ask.at &&
            other.answeredAt === null &&
            other.delivery !== "unresolved",
        );
        if (earlier) this.writer.asks.setContinues(askId, earlier.continues ?? earlier.id);
      }
      this.writer.patch(taskId, { updatedAt: at });
      this.writer.addEvent({
        taskId,
        at,
        actor: "captain",
        kind: "ask",
        text: ask.text || (ask.images.length > 0 ? "(image attachment)" : "(empty)"),
        data: {
          askId,
          via,
          first,
          // Whether this message filed or started the task (INF-2326), when
          // the caller knows: the line under its cards reads the message
          // that did (`taskOrigin.ts`, `startedBy`).
          ...(starts === undefined ? {} : { starts }),
          ...(ask.images.length > 0 ? { images: ask.images.length } : {}),
        },
        ref: askId,
        feed: false,
      });
      return true;
    });
    return run();
  }

  /**
   * Save one thing that took effect (or was refused) after Firstmate read
   * these messages (answer delivery). Only a message still being judged
   * takes it; a covered, unresolved or legacy one is left as it is.
   */
  noteDelivery(askIds: readonly string[], entry: DeliveryEntry): void {
    const run = this.writer.write(() => {
      for (const id of askIds) {
        const ask = this.writer.asks.get(id);
        if (!ask || !JUDGEABLE_DELIVERY.includes(ask.delivery)) continue;
        this.writer.asks.setDelivery(id, ask.delivery, {
          ...ask.deliveryFacts,
          entries: [...ask.deliveryFacts.entries, entry],
        });
      }
    });
    run();
  }

  /** Move a message to a delivery state, keeping its facts unless new ones are given. */
  setAskDelivery(askId: string, delivery: AskDelivery, facts?: DeliveryFacts): void {
    const run = this.writer.write(() => this.writer.asks.setDelivery(askId, delivery, facts));
    run();
  }

  /** A message the turn never read: it waits for the turn that does, with no facts of this one. */
  releaseAskDelivery(askId: string): void {
    const run = this.writer.write(() => {
      const ask = this.writer.asks.get(askId);
      if (!ask || !JUDGEABLE_DELIVERY.includes(ask.delivery)) return;
      this.writer.asks.setDelivery(askId, ask.delivery === "retrying" ? "retrying" : "pending", {
        ...ask.deliveryFacts,
        entries: [],
      });
    });
    run();
  }

  /** The one notice raised for a message: set once, in the same write that marks it unresolved. */
  markAskUnresolved(askId: string, cardId: string): boolean {
    const run = this.writer.write((): boolean => {
      const ask = this.writer.asks.get(askId);
      // A notice taken back when an answering card went up comes back under its own id.
      if (!ask || ask.delivery === "unresolved") return false;
      if (ask.noticeCardId && ask.noticeCardId !== cardId) return false;
      this.writer.asks.setDelivery(askId, "unresolved");
      this.writer.asks.setNoticeCard(askId, cardId);
      return true;
    });
    return run();
  }

  /** The turn ended; the ask's state is final. */
  closeAsk(askId: string, turnState: Exclude<AskTurnState, "open">): AskRecord | undefined {
    const run = this.writer.write(() => {
      this.writer.asks.setTurnState(askId, turnState);
      const ask = this.writer.asks.get(askId);
      // The ask rides the task's detail; its final state is a change there.
      if (ask?.taskId) this.writer.touch(ask.taskId);
      return ask;
    });
    return run();
  }

  /** A standalone question task, born closed with its answer (D1). */
  fileQuestion(input: FileQuestionInput): TaskRecord {
    const at = this.writer.now();
    const actor = input.actor ?? "firstmate";
    const run = this.writer.write((): TaskRecord => {
      this.tasks.create({
        id: input.id,
        kind: "question",
        title: input.title,
        prompt: "",
        repoId: input.repoId ?? null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        actor,
        createdAt: at,
      });
      const summary = input.outcome ? reportSummary(input.outcome) || null : null;
      this.writer.patch(input.id, {
        outcome: input.outcome,
        outcomeSummary: summary,
        status: "done",
        activity: null,
        closedReason: "answered",
        closedAt: at,
        updatedAt: at,
      });
      if (input.cardId) {
        this.writer.addEvent({
          taskId: input.id,
          at,
          actor,
          kind: "card_raised",
          text: `answered on card "${input.title}"`,
          data: { cardId: input.cardId, kind: "note" },
          ref: input.cardId,
          feed: false,
        });
      }
      this.writer.addEvent({
        taskId: input.id,
        at,
        actor,
        kind: "status",
        text: input.fallback ? "noted (nothing attached this turn)" : "answered",
        data: {
          status: "done",
          reason: "answered",
          ...(input.fallback ? { fallback: input.fallback } : {}),
        },
        feed: false,
      });
      return this.writer.mustGet(input.id);
    });
    return run();
  }

  /** A fleet/self operation the Firstmate performed, filed done/settled. */
  fileOperation(input: FileOperationInput): TaskRecord {
    const at = this.writer.now();
    const actor = input.actor ?? "firstmate";
    const run = this.writer.write((): TaskRecord => {
      this.tasks.create({
        id: input.id,
        kind: "operation",
        title: input.title,
        prompt: "",
        repoId: input.repoId ?? null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        actor,
        createdAt: at,
      });
      this.writer.patch(input.id, {
        outcome: input.outcome,
        outcomeSummary: reportSummary(input.outcome) || null,
        status: "done",
        activity: null,
        closedReason: "settled",
        closedAt: at,
        updatedAt: at,
      });
      this.writer.addEvent({
        taskId: input.id,
        at,
        actor,
        kind: "status",
        text: `settled by ${input.tool}`,
        data: { status: "done", reason: "settled", tool: input.tool },
        feed: false,
      });
      return this.writer.mustGet(input.id);
    });
    return run();
  }

  /**
   * The row a host card with actions and no task files (docs/card-authoring.md,
   * "A card places the gate"): an open `operation` waiting on the captain,
   * its card id the gate ref, so "waiting on you" counts the host's own
   * asks the way it counts every other card. Explicit resolution closes
   * the row; the minus leaves its card and captain gate pending.
   */
  fileHostCardTask(input: { id: string; title: string; cardId: string }): TaskRecord {
    const at = this.writer.now();
    const run = this.writer.write((): TaskRecord => {
      this.tasks.create({
        id: input.id,
        kind: "operation",
        title: input.title,
        prompt: "",
        repoId: null,
        gate: { kind: "captain", ref: input.cardId },
        actor: "host",
        createdAt: at,
      });
      this.writer.addEvent({
        taskId: input.id,
        at,
        actor: "host",
        kind: "card_raised",
        text: `decision raised on card "${input.title}"`,
        data: { cardId: input.cardId, kind: "decision" },
        ref: input.cardId,
        feed: false,
      });
      return this.writer.mustGet(input.id);
    });
    return run();
  }

  /** An open decision task waiting on the captain; its card id is the gate ref. */
  fileDecision(input: FileDecisionInput): TaskRecord {
    const at = this.writer.now();
    const actor = input.actor ?? "firstmate";
    const run = this.writer.write((): TaskRecord => {
      this.tasks.create({
        id: input.id,
        kind: "decision",
        title: input.title,
        prompt: "",
        repoId: input.repoId ?? null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        gate: { kind: "captain", ref: input.cardId },
        actor,
        createdAt: at,
      });
      this.writer.addEvent({
        taskId: input.id,
        at,
        actor,
        kind: "card_raised",
        text: `decision raised on card "${input.title}"`,
        data: { cardId: input.cardId, kind: "decision" },
        ref: input.cardId,
        feed: false,
      });
      return this.writer.mustGet(input.id);
    });
    return run();
  }

  /** The task a card was raised on, if any (a revision keeps its row). */
  taskForCard(cardId: string): TaskRecord | undefined {
    const taskId = this.writer.events.latestTaskForRef("card_raised", cardId);
    return taskId ? this.writer.store.get(taskId) : undefined;
  }

  /**
   * A note card answered a question about this task: the body rides the
   * event. `asOutcome` also makes it the record's outcome (a standalone
   * question revised in place).
   */
  recordAnswer(
    id: string,
    input: {
      cardId: string;
      title: string;
      body: string;
      actor?: TaskEventActor;
      asOutcome?: boolean;
    },
  ): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      this.writer.mustGet(id);
      this.writer.patch(id, {
        updatedAt: at,
        ...(input.asOutcome
          ? { outcome: input.body, outcomeSummary: reportSummary(input.body) || null }
          : {}),
      });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "firstmate",
        kind: "answered",
        text: input.title,
        data: { cardId: input.cardId, body: input.body },
        ref: input.cardId,
        feed: false,
      });
    });
    run();
  }

  /**
   * A card about this task went on the stack. A crewmate's card is recorded
   * when it reaches the stage, with the close-out that released it
   * (`closeOut`), and again when it comes back with an answer to the
   * captain's reply (`returned`) - the moment the replay counts a late
   * return from (docs/card-threads.md "When a card reaches the stage").
   */
  recordCardRaised(
    id: string,
    input: {
      cardId: string;
      kind: string;
      title: string;
      actor?: TaskEventActor;
      closeOut?: string;
      returned?: boolean;
    },
  ): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      if (!this.writer.store.get(id)) return;
      this.writer.patch(id, { updatedAt: at });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "firstmate",
        kind: "card_raised",
        text: `${input.kind} card "${input.title}"${input.returned ? " back with its answer" : ""}`,
        data: {
          cardId: input.cardId,
          kind: input.kind,
          ...(input.closeOut ? { closeOut: input.closeOut } : {}),
          ...(input.returned ? { returned: true } : {}),
        },
        ref: input.cardId,
        feed: false,
      });
    });
    run();
  }

  /** Verified delivery, not a verdict about whether the task is finished (INF-1426). */
  recordResultHandoff(
    id: string,
    handoff: { taskId: string } | { cardId: string; action: string },
  ): void {
    this.tasks.note(id, "Its result was handed on.", {
      news: false,
      feed: false,
      data: { resultHandoff: handoff, journal: true },
      ...("taskId" in handoff ? { about: [handoff.taskId] } : {}),
    });
  }

  resultHandoffOf(id: string): boolean {
    return this.writer.events
      .listFor(id)
      .some((event) => event.kind === "note" && event.data?.resultHandoff !== undefined);
  }

  /** A card about this task left the stack (an action, Later, or a dismiss). */
  recordCardResolved(
    id: string,
    input: {
      cardId: string;
      title: string;
      action: string;
      actor?: TaskEventActor;
      /** The captain's answers to the body's own questions (contract 4.22). */
      answers?: CardAnswer[];
      /**
       * The card evidence's observation of the same choice or close: the
       * explicit alias the unified timeline folds this event into.
       */
      observation?: string;
    },
  ): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      if (!this.writer.store.get(id)) return;
      this.writer.patch(id, { updatedAt: at });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "captain",
        kind: "card_resolved",
        text: `card "${input.title}": ${input.action}`,
        data: {
          cardId: input.cardId,
          action: input.action,
          ...(input.answers ? { answers: input.answers } : {}),
          ...(input.observation ? { observation: input.observation } : {}),
        },
        ref: input.cardId,
        feed: false,
      });
    });
    run();
  }
}
