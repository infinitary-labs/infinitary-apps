import { createHash, randomUUID } from "node:crypto";
import {
  AFTER_MERGE_TITLE_PREFIX,
  type AfterMergeShown,
  type AfterMergeStep,
  afterMergeShapeRefusal,
  type FiledAfterMergeStep,
} from "@shared/afterMerge";
import type { ChangePresentationRecord } from "@shared/changePresentation";
import type { KeptValidationInput } from "@shared/liveValidation";
import {
  type CaptainAction,
  captainActionResult,
  REQUIRED_ACTION_TEXT_FIELDS,
  type RequiredAction,
  type RequiredActionCorrection,
  type RequiredActionOffer,
  type RequiredActionText,
  requiredActionSchema,
} from "@shared/requiredActions";
import { type FirstReleaseReport, firstReleaseReportSchema } from "@shared/taskRelease";
import {
  NEVER_SENT_AGAIN,
  WRITE_ASK_CAP,
  type WriteAsk,
  type WriteAskOutcome,
} from "@shared/writeAsk";
import { renderFollowupBrief } from "../orchestrator/intentBrief";
import {
  currentChange,
  placeStories,
  storyLedgerOf,
  storyLedgers,
} from "../storage/changeProjection";
import {
  HISTORY_FIELDS,
  PERMISSION_COLUMNS,
  type PermissionField,
} from "../storage/taskDeliveryFields";
import { TURN_DECLARATION_FIELDS } from "../storage/taskExecutionStore";
import type { CardRefusal, PendingSettleIntent, TaskDelivery } from "../storage/taskStore";
import { decideValidation, recordValidation } from "./liveValidation";
import { TaskGraphRefusal } from "./taskGraph";
import { TaskService } from "./taskService";
import { type DeliveryObservation, keyOrId, type TaskWriter } from "./taskWriter";
import { liveWaitCycle } from "./waitCycles";

/** The editable fields (update_task); every one optional. */
/** What a required-action correction did (`TaskService.delivery.reviseRequiredAction`). */
export type RequiredActionRevision =
  | {
      effect: "refused";
      refusal: string;
      taskId?: string;
      cardId?: string;
      generation?: number;
      state?: CaptainAction["state"];
    }
  | {
      effect: "revised" | "unchanged" | "repeated";
      taskId: string;
      cardId: string;
      generation: number;
      state: CaptainAction["state"];
      source: string;
      actionId: string;
      changed?: string[];
      correction?: RequiredActionCorrection;
    };
export type ChangeEvidenceUpdate = Partial<
  Omit<
    TaskDelivery,
    | PermissionField
    | (typeof TURN_DECLARATION_FIELDS)[number]
    | (typeof HISTORY_FIELDS)[number]
    | "liveValidation"
  >
>;

/**
 * The delivery records of a task's change: its evidence and presentation,
 * live validation, write asks, a pending settle, releases, and the required
 * actions the captain completes. Reached as `tasks.delivery`.
 */
export class TaskDeliveries {
  constructor(
    private readonly writer: TaskWriter,
    private readonly tasks: TaskService,
  ) {}

  /** A verified release report writes all its same-project attributions together, with provenance. */
  recordFirstRelease(reporterId: string, input: FirstReleaseReport): number {
    const report = firstReleaseReportSchema.parse(input);
    const { tasks: refs, corrects, ...release } = report;
    const at = this.writer.now();
    let recorded = 0;
    const run = this.writer.write(() => {
      const reporter = this.writer.mustGet(reporterId);
      if (!reporter.repoId) throw new TaskGraphRefusal("Release attribution needs a project.");
      const targets = [
        ...new Set(
          refs.map((ref) => {
            const target = this.tasks.resolve(ref);
            if (!target) throw new TaskGraphRefusal(`Unknown release task "${ref}".`);
            return target.id;
          }),
        ),
      ].map((id) => this.writer.mustGet(id));
      // Check the entire batch before writing any attribution.
      for (const target of targets) {
        if (target.repoId !== reporter.repoId || target.projectId !== reporter.projectId)
          throw new TaskGraphRefusal("Release tasks must belong to your own project.");
        if (
          target.status !== "done" ||
          (target.closedReason !== "merged" && target.closedReason !== "landed")
        )
          throw new TaskGraphRefusal(`Release task ${keyOrId(target)} is not merged work.`);
        if (corrects !== undefined && target.delivery?.firstRelease?.version !== corrects)
          throw new TaskGraphRefusal(
            `Release task ${keyOrId(target)} no longer records ${corrects}. Read it before correcting it.`,
          );
      }
      for (const target of targets) {
        const previous = target.delivery?.firstRelease;
        if (previous && corrects === undefined) continue;
        if (JSON.stringify(previous) === JSON.stringify(release)) continue;
        this.writer.patch(target.id, {
          delivery: this.writer.mergeDelivery(target, { firstRelease: release }),
          updatedAt: at,
        });
        this.writer.addEvent({
          taskId: target.id,
          at,
          actor: "crewmate",
          kind: "note",
          text: `First verified release: ${release.version}`,
          data: {
            firstRelease: release,
            ...(previous ? { previousFirstRelease: previous } : {}),
            reportedBy: reporter.id,
          },
        });
        recorded += 1;
      }
    });
    run();
    return recorded;
  }

  recordLiveValidation(
    id: string,
    input: KeptValidationInput,
    context: Omit<Parameters<typeof recordValidation>[2], "at" | "deviceId">,
  ): void {
    this.writer.write(() => {
      const task = this.writer.mustGet(id);
      const liveValidation = recordValidation(task.delivery?.liveValidation, input, {
        ...context,
        at: this.writer.now(),
        deviceId: task.deviceId ?? null,
      });
      this.writer.writeDeliveryRecords(
        id,
        { liveValidation },
        {
          kind: "note",
          text: `Live validation: ${input.kind}`,
          feed: false,
          data: {
            validation: {
              kind: input.kind,
              scenarioRevision: liveValidation.scenarioRevision,
              stateRevision: liveValidation.stateRevision ?? 0,
              ...("head" in input ? { head: input.head } : {}),
              ...(input.kind === "run"
                ? {
                    run: input.id,
                    revision: liveValidation.runs.at(-1)?.revision,
                    evidence: input.evidence.map(({ id, digest, file, bytes }) => ({
                      id,
                      digest,
                      file,
                      bytes,
                    })),
                  }
                : {}),
              ...(input.kind === "request" ? { request: input.request.id } : {}),
            },
          },
        },
      );
    })();
  }

  expireValidationDecision(id: string, card: string, offer: string, reason: string): void {
    this.writer.write(() => {
      const task = this.writer.mustGet(id);
      if (!task.delivery?.liveValidation) return;
      const liveValidation = structuredClone(task.delivery.liveValidation);
      for (const item of liveValidation.permissions) {
        if (
          item.state !== "requested" ||
          item.decision?.card !== card ||
          item.decision.offer !== offer
        )
          continue;
        item.state = "expired";
        liveValidation.stateRevision = (liveValidation.stateRevision ?? 0) + 1;
      }
      this.writer.writeDeliveryRecords(
        id,
        { liveValidation },
        { kind: "note", text: reason, data: { validationDecisionExpired: { card, offer } } },
      );
    })();
  }

  decideLiveValidation(
    id: string,
    input: Omit<Parameters<typeof decideValidation>[1], "at">,
  ): void {
    this.writer.write(() => {
      const task = this.writer.mustGet(id);
      if (!task.delivery?.liveValidation) return;
      const liveValidation = decideValidation(task.delivery.liveValidation, {
        ...input,
        at: this.writer.now(),
      });
      this.writer.writeDeliveryRecords(
        id,
        { liveValidation },
        {
          kind: "note",
          text: "The captain answered a live-validation request",
          feed: false,
          data: { validationDecision: input },
        },
      );
    })();
  }

  /**
   * Delivery facts as they become known: a CI read, an opened PR. The mode
   * comes from the repo posture when the row has none yet.
   */
  recordChangeEvidence(id: string, facts: ChangeEvidenceUpdate, event?: DeliveryObservation): void {
    const elsewhere = [
      ...Object.keys(PERMISSION_COLUMNS),
      ...TURN_DECLARATION_FIELDS,
      ...HISTORY_FIELDS,
      "liveValidation",
    ];
    if (elsewhere.some((field) => Object.hasOwn(facts, field)))
      throw new Error("Change evidence cannot write permissions, turn declarations or history.");
    this.writer.writeDeliveryRecords(id, facts, event);
  }

  /**
   * The task's own change is its current one again (INF-2490): the
   * selection of another pull request goes with every fact the slot read
   * of it - its number, page, label, base, head and readings - and the slot
   * names the own pull request given, at its head and base, with the page
   * and label its change record keeps. Given none, it names none until the
   * next reading or opening notes the own one.
   */
  selectOwnChange(id: string, own?: { number?: number; headSha?: string; base?: string }): void {
    const record = this.tasks.get(id);
    if (!record?.delivery?.checkTarget) return;
    const kept =
      own?.number === undefined
        ? undefined
        : this.tasks
            .changesFor(id)
            .find(
              (change) =>
                change.head.branch === record.branch && change.handle?.number === own.number,
            )?.handle;
    this.recordPermissionRecords(id, { checkTarget: undefined });
    this.recordChangeEvidence(id, {
      prNumber: own?.number,
      prUrl: kept?.url,
      changeLabel: kept?.label,
      prBase: own?.base,
      headSha: own?.headSha,
      checks: undefined,
      ci: undefined,
      ciAt: undefined,
      ciStartedAt: undefined,
      ciFinishedAt: undefined,
      mainChecks: undefined,
    });
  }

  /** The permission owner's typed records; no evidence or execution patch can travel with them. */
  recordPermissionRecords(
    id: string,
    records: Partial<Pick<TaskDelivery, PermissionField>>,
    event?: DeliveryObservation,
  ): void {
    if (Object.keys(records).some((field) => !Object.hasOwn(PERMISSION_COLUMNS, field)))
      throw new Error("A permission write can only replace permission records.");
    this.writer.writeDeliveryRecords(id, records, event);
  }

  /** Bind the reading to the exact approval and version in the same transaction. */
  recordApprovedChangeReading(
    id: string,
    reading: Pick<TaskDelivery, "mergeAuthorization" | "versionReadings">,
  ): void {
    this.writer.writeDeliveryRecords(id, reading);
  }

  /** A resolved wait ends in execution, never in a historical report. */
  clearCaptainWait(id: string): void {
    this.writer.writeDeliveryRecords(id, { captainWait: undefined });
  }

  /**
   * The publication ledger's one writer; a claim is committed before any
   * external write. Each change keeps its own ledger (INF-2490): `branch`
   * names the change's branch, and none means the current change.
   */
  changePresentation(id: string, branch?: string): ChangePresentationRecord | undefined {
    const record = this.writer.mustGet(id);
    return storyLedgerOf(
      record.delivery,
      record.branch,
      branch ?? currentChange(record.delivery, record.branch).branch,
    );
  }

  updateChangePresentation(
    id: string,
    update: (current: ChangePresentationRecord | undefined) => ChangePresentationRecord,
    branch?: string,
  ): void {
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (record.status === "done" || record.status === "dropped")
        throw new Error("A closed task cannot publish another story.");
      const target = branch ?? currentChange(record.delivery, record.branch).branch;
      const ledgers = storyLedgers(record.delivery);
      const previous = storyLedgerOf(record.delivery, record.branch, target);
      const next = { ...update(previous), branch: target };
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(
          record,
          placeStories(
            [...ledgers.filter((ledger) => ledger !== previous), next],
            record.branch,
            currentChange(record.delivery, record.branch).branch,
          ),
        ),
        updatedAt: this.writer.now(),
      });
    })();
  }

  /**
   * Keep a write the crewmate asked to send (FI3-1571 piece 4), newest
   * first, at most `WRITE_ASK_CAP`: an older one drops, sent or not. A
   * closed task keeps none.
   */
  keepWriteAsk(id: string, ask: WriteAsk): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (TaskService.isClosed(record)) {
        throw new TaskGraphRefusal(`Refused: ${keyOrId(record)} is closed.`);
      }
      const writeAsks = [
        ask,
        ...(record.delivery?.writeAsks ?? []).filter((kept) => kept.id !== ask.id),
      ].slice(0, WRITE_ASK_CAP);
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(record, { writeAsks }),
        updatedAt: at,
      });
    });
    run();
  }

  /**
   * The captain's click takes one kept write, once (FI3-1571 piece 4): in one
   * transaction it checks the task is open and the ask was never taken, and
   * marks it taken before anything is sent, so a second click, a restart or
   * a revised card never sends it again. The refusal says why, in the
   * host's words.
   */
  takeWriteAsk(id: string, askId: string): { ask: WriteAsk } | { refused: string } {
    const at = this.writer.now();
    let result: { ask: WriteAsk } | { refused: string } = { refused: "" };
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (!record || TaskService.isClosed(record)) {
        result = { refused: "its task has closed, so it was not sent." };
        return;
      }
      const asks = record.delivery?.writeAsks ?? [];
      const ask = asks.find((kept) => kept.id === askId);
      if (!ask) {
        result = { refused: `ask ${askId} is not on this task, so nothing was sent.` };
        return;
      }
      if (ask.sentAt !== undefined) {
        result = { refused: `ask ${askId} was already sent once and is ${NEVER_SENT_AGAIN}.` };
        return;
      }
      const taken = { ...ask, sentAt: at };
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(record, {
          writeAsks: asks.map((kept) => (kept.id === askId ? taken : kept)),
        }),
        updatedAt: at,
      });
      result = { ask: taken };
    });
    run();
    return result;
  }

  /** What came of a taken write: the host's answer, unknown, or nothing sent. */
  recordWriteAskOutcome(id: string, askId: string, outcome: WriteAskOutcome): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      const asks = record?.delivery?.writeAsks;
      if (!record || !asks?.some((kept) => kept.id === askId)) return;
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(record, {
          writeAsks: asks.map((kept) => (kept.id === askId ? { ...kept, outcome } : kept)),
        }),
        updatedAt: at,
      });
    });
    run();
  }

  /**
   * The host refused this task's completion card (FI3-401): the refusal
   * stands on the delivery facts until a completion card goes up, and the
   * timeline keeps it as a host note.
   */
  recordCardRefusal(id: string, refusal: Omit<CardRefusal, "at">): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
      const cardRefusal: CardRefusal = { at, ...refusal };
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(record, { cardRefusal }),
        updatedAt: at,
      });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "note",
        text: `completion card "${refusal.title}" refused: ${refusal.why}`,
        data: { cardRefusal, news: false },
        feed: false,
      });
    });
    run();
  }

  /** A completion card went up: the refusal before it no longer stands. */
  clearCardRefusal(id: string): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (!record?.delivery?.cardRefusal) return;
      const { cardRefusal: _cleared, ...delivery } = record.delivery;
      this.writer.patch(id, { delivery, updatedAt: at });
    });
    run();
  }

  /** Persist or clear a settle intent captured while a crewmate turn is active. */
  setPendingSettle(id: string, intent: PendingSettleIntent | null): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      this.writer.mustGet(id);
      this.writer.patch(id, { pendingSettle: intent, updatedAt: at });
    });
    run();
  }

  validateRequiredActions(sourceId: string, actions: readonly RequiredAction[]): RequiredAction[] {
    const ids = new Set<string>();
    return actions.map((action) => {
      if (ids.has(action.id))
        throw new TaskGraphRefusal(`Required action ${action.id} is declared twice.`);
      ids.add(action.id);
      const prerequisites = action.prerequisites.map((ref) => {
        const row = this.tasks.resolve(ref);
        if (!row || row.id === sourceId)
          throw new TaskGraphRefusal(
            `Required action prerequisite ${ref} must name another existing task.`,
          );
        return row.id;
      });
      const shared = this.tasks
        .listOpen()
        .find((row) =>
          row.delivery?.captainAction?.requirements.some(
            (entry) =>
              (entry.source === sourceId && entry.action.id === action.id) ||
              (action.sharedId && entry.action.sharedId === action.sharedId),
          ),
        );
      if (
        shared &&
        prerequisites.some(
          (prerequisite) =>
            prerequisite === shared.id || this.tasks.graph.blocksReaches(shared.id, prerequisite),
        )
      )
        throw new TaskGraphRefusal("The required action's prerequisites would form a cycle.");
      const incompatible = (other: RequiredAction) =>
        other.target !== action.target ||
        other.completion.kind !== action.completion.kind ||
        (other.completion.kind === "device-version" &&
          action.completion.kind === "device-version" &&
          other.completion.deviceId !== action.completion.deviceId);
      if (
        (action.sharedId &&
          actions.some(
            (other) =>
              other.id !== action.id && other.sharedId === action.sharedId && incompatible(other),
          )) ||
        shared?.delivery?.captainAction?.requirements.some(
          (entry) =>
            (entry.source !== sourceId || entry.action.id !== action.id) &&
            incompatible(entry.action),
        )
      )
        throw new TaskGraphRefusal(
          "A shared action must keep the same target and completion mode. Declare separate actions instead.",
        );
      return { ...action, prerequisites };
    });
  }

  /** The declaration and source version are kept before the merge, never inferred from prose. */
  declareRequiredActions(id: string, offer: RequiredActionOffer, immediate = false): void {
    this.writer.write(() => {
      const actions = this.validateRequiredActions(id, offer.actions);
      this.writer.writeDeliveryRecords(id, { requiredActionOffer: { ...offer, actions } });
      if (immediate) this.activateRequiredActions(id);
    })();
  }

  /** Called inside successful close's transaction; receipts make restart/retry recovery idempotent. */
  activateRequiredActions(sourceId: string): void {
    const source = this.writer.mustGet(sourceId);
    const offer = source.delivery?.requiredActionOffer;
    if (!offer) return; // Historical offers are unknown, not an empty declaration.
    for (const action of offer.actions) {
      const receipt = `${sourceId}:${offer.offerId}:${action.id}`;
      const existing = this.tasks
        .list()
        .find((row) =>
          row.delivery?.captainAction?.requirements.some(
            (requirement) =>
              `${requirement.source}:${requirement.offer}:${requirement.action.id}` === receipt,
          ),
        );
      if (existing) continue;
      const outstanding = this.tasks
        .listOpen()
        .find((row) =>
          row.delivery?.captainAction?.requirements.some(
            (requirement) => requirement.source === sourceId && requirement.action.id === action.id,
          ),
        );
      const shared =
        outstanding ??
        (action.sharedId
          ? this.tasks.list().find((row) => {
              const state = row.delivery?.captainAction;
              return (
                row.status === "open" &&
                state &&
                state.requirements.some(
                  (requirement) => requirement.action.sharedId === action.sharedId,
                )
              );
            })
          : undefined);
      const id = shared?.id ?? randomUUID().slice(0, 8);
      if (!shared)
        this.tasks.create({
          id,
          kind: "operation",
          title: action.title.slice(0, 64),
          goal: action.criterion,
          prompt: "",
          repoId: null,
          projectId: source.projectId,
          actor: "host",
          startPolicy: "on-request",
          gate: { kind: "captain", ref: `card-fm-required-action-${id}` },
        });
      const prior = shared?.delivery?.captainAction;
      const previous = prior?.requirements.find(
        (requirement) => requirement.source === sourceId && requirement.action.id === action.id,
      );
      const changed =
        !previous ||
        previous.head !== offer.head ||
        JSON.stringify(previous.action) !== JSON.stringify(action);
      const state: CaptainAction = {
        requirements: [
          ...(prior?.requirements ?? []).filter(
            (requirement) =>
              !(requirement.source === sourceId && requirement.action.id === action.id),
          ),
          {
            source: sourceId,
            offer: offer.offerId,
            ...(offer.head ? { head: offer.head } : {}),
            action,
          },
        ],
        generation: (prior?.generation ?? 0) + (changed ? 1 : 0),
        state: changed ? "blocked" : (prior?.state ?? "blocked"),
        cardId: `card-fm-required-action-${id}`,
        presentedGeneration: prior?.presentedGeneration ?? 0,
        activatedAt: prior?.activatedAt ?? this.writer.now(),
      };
      this.writer.writeDeliveryRecords(id, { captainAction: state });
      const first = state.requirements[0]?.action;
      if (first)
        this.writer.patch(id, {
          title: first.title.slice(0, 64),
          goal: first.criterion,
          updatedAt: this.writer.now(),
        });
      const needed = new Set(state.requirements.flatMap((entry) => entry.action.prerequisites));
      for (const blocker of this.tasks.graph.blockers(id))
        if (!needed.has(blocker.id)) this.tasks.graph.unlink(blocker.id, id, "blocks", "host");
      this.tasks.graph.insertLink(sourceId, id, "related", "host", this.writer.now());
      for (const prerequisite of action.prerequisites) {
        if (!this.tasks.get(prerequisite))
          throw new Error(`Required action prerequisite ${prerequisite} does not exist.`);
        this.tasks.graph.insertLink(prerequisite, id, "blocks", "host", this.writer.now(), true);
      }
      this.writer.addEvent({
        taskId: id,
        at: this.writer.now(),
        actor: "host",
        kind: "note",
        text: `Required action from ${source.key}: ${action.title}`,
        data: { source: sourceId, offer: offer.offerId },
        feed: false,
      });
    }
  }

  /**
   * Why a story's after-merge steps cannot stand (INF-2796), read when the
   * story is prepared: a step's shape (`afterMergeShapeRefusal`), and each
   * task and project it names. An existing task the merge would start must
   * be open and not yet started: a running or closed task has nothing to
   * start. A step may not wait on its own origin, whose merge it follows.
   */
  afterMergeRefusal(sourceId: string, steps: readonly AfterMergeStep[]): string | undefined {
    for (const [index, step] of steps.entries()) {
      const shape = afterMergeShapeRefusal(step, index);
      if (shape) return shape;
      const at = `afterMerge step ${index + 1}`;
      if (step.task) {
        const named = this.tasks.resolve(step.task);
        if (!named) return `${at} names no task "${step.task}".`;
        if (named.id === sourceId) return `${at} names this task itself.`;
        if (named.status !== "open" || named.startedAt !== null)
          return `${at} names ${keyOrId(named)}, which is ${named.status === "open" || named.status === "active" ? "already running" : "closed"}; only an unstarted open task can start at the merge.`;
        // Already set to start on its own, it could start before this merges.
        if (
          named.startPolicy === "when-ready" &&
          !this.tasks.graph.blockers(named.id).some((blocker) => blocker.id === sourceId)
        )
          return `${at} names ${keyOrId(named)}, which is already set to start on its own and could start before this merges.`;
      }
      if (step.project) {
        const project =
          this.tasks.projects.byKey(step.project) ?? this.tasks.projects.get(step.project);
        if (!project || project.archivedAt !== null)
          return `${at} names no project "${step.project}".`;
      }
      for (const ref of step.blockedBy ?? []) {
        const blocker = this.tasks.resolve(ref);
        if (!blocker) return `${at} waits for no task "${ref}".`;
        if (blocker.id === sourceId) return `${at} waits for this task, which it already follows.`;
        const named = step.task ? this.tasks.resolve(step.task) : undefined;
        if (named && this.waitCycle(blocker.id, named.id))
          return `${at} waits for ${keyOrId(blocker)}, which already waits for ${keyOrId(named)}; nothing could ever start.`;
      }
    }
    return undefined;
  }

  /** Whether `waiter` waiting for `blocker` would close a cycle, the test `insertLink` refuses. */
  private waitCycle(blocker: string, waiter: string): boolean {
    return (
      blocker === waiter ||
      !!this.tasks.graph.blocksReaches(waiter, blocker) ||
      !!liveWaitCycle(this.tasks, waiter, blocker, TaskService.blockerHoldsClose)
    );
  }

  /** The steps as the merge card draws them, each existing task and wait read now. */
  afterMergeShown(steps: readonly AfterMergeStep[]): AfterMergeShown[] {
    return steps.map((step): AfterMergeShown => {
      // A wait on work already closed holds nothing, so the card leaves it out.
      const waitsFor = (step.blockedBy ?? []).flatMap((ref) => {
        const blocker = this.tasks.resolve(ref);
        return blocker && TaskService.isClosed(blocker)
          ? []
          : [keyOrId(blocker ?? { id: ref, key: ref })];
      });
      const waits = waitsFor.length ? { waitsFor } : {};
      const named = step.task ? this.tasks.resolve(step.task) : undefined;
      if (named)
        return {
          key: keyOrId(named),
          title: named.title,
          ...(named.goal ? { goal: named.goal } : {}),
          ...waits,
        };
      return {
        title: `${AFTER_MERGE_TITLE_PREFIX}${(step.title ?? step.task ?? "").trim()}`,
        ...(step.goal ? { goal: step.goal } : {}),
        ...waits,
      };
    });
  }

  /**
   * The after-merge steps of the story the merge carried (INF-2796): called
   * inside a merged close's transaction, beside the required actions. A new
   * step is filed once as a Continue task of its own, in the project it
   * names or the origin's; an existing task the step names is set to start
   * on its own, unless it started or closed since the card was shown, which
   * the answer says instead. Each step's `blockedBy` becomes `blocks` links
   * into its task, so it starts only once those merge. A story that declared
   * none does nothing, the same as before. A new step's id is derived from
   * the story's change, revision and the step's place, so a restart or a
   * second activation answers the task already filed.
   */
  activateAfterMergeSteps(sourceId: string): FiledAfterMergeStep[] {
    const source = this.writer.mustGet(sourceId);
    const at = this.writer.now();
    const note = (taskId: string, text: string, why: string | undefined) =>
      this.writer.addEvent({
        taskId,
        at,
        actor: "host",
        kind: "note",
        text,
        data: { ...(why ? { why } : {}), originId: sourceId, afterMerge: true, news: true },
        ref: sourceId,
        feed: false,
      });
    const waitOn = (taskId: string, step: AfterMergeStep) => {
      for (const ref of step.blockedBy ?? []) {
        const blocker = this.tasks.resolve(ref);
        if (!blocker || blocker.id === taskId) continue;
        // Inside the merged close's transaction: a wait that closes a cycle
        // since the card was shown is skipped and noted, never thrown, so the
        // merge is still recorded.
        try {
          this.tasks.graph.insertLink(blocker.id, taskId, "blocks", "host", at);
        } catch (caught) {
          if (!(caught instanceof TaskGraphRefusal)) throw caught;
          note(
            taskId,
            `could not wait for "${blocker.title}" (${keyOrId(blocker)}) as its merge card listed: ${caught.message}`,
            undefined,
          );
        }
      }
    };
    return this.afterMergeSteps(sourceId).map(({ id, step }): FiledAfterMergeStep => {
      const why = step.why?.trim();
      if (step.task) {
        const named = this.tasks.resolve(step.task);
        if (!named) return { key: step.task, title: step.task };
        const filed = { key: keyOrId(named), title: named.title };
        // Started or closed since the card was shown, or on an earlier
        // activation of this merge: there is nothing left to start.
        if (named.status !== "open" || named.startedAt !== null) return filed;
        waitOn(named.id, step);
        if (named.startPolicy !== "when-ready") {
          this.writer.patch(named.id, { startPolicy: "when-ready", updatedAt: at });
          note(
            named.id,
            `set to start on its own when "${source.title}" (${keyOrId(source)}) merged, as its merge card listed${why ? `: ${why}` : ""}`,
            why,
          );
        }
        return filed;
      }
      const existing = this.tasks.get(id);
      if (existing) return { key: keyOrId(existing), title: existing.title };
      const goal = (step.goal ?? "").trim();
      const project = step.project
        ? (this.tasks.projects.byKey(step.project) ?? this.tasks.projects.get(step.project))
        : undefined;
      const elsewhere = project && project.archivedAt === null && project.id !== source.projectId;
      const record = this.tasks.create({
        id,
        kind: "work",
        title: `${AFTER_MERGE_TITLE_PREFIX}${(step.title ?? "").trim()}`,
        goal,
        // The posture is written at its start (`withDeliveryLine`), and the
        // origin's report and card reach it through the discovered-from link.
        prompt: renderFollowupBrief(
          {
            goal,
            why: why ?? "",
            filedBy: "its crewmate's merge card",
            originTitle: source.title,
            originKey: keyOrId(source),
          },
          undefined,
        ),
        repoId: elsewhere ? project.repoId : source.repoId,
        projectId: elsewhere ? project.id : source.projectId,
        startPolicy: "when-ready",
        actor: "host",
        createdAt: at,
      });
      this.tasks.graph.insertLink(record.id, sourceId, "discovered-from", "host", at);
      waitOn(record.id, step);
      note(
        record.id,
        `filed when "${source.title}" (${keyOrId(source)}) merged, as its merge card listed: ${why}`,
        why,
      );
      return { key: keyOrId(record), title: record.title };
    });
  }

  /** The tasks a merge filed from its story's after-merge steps, as the settled wake names them. */
  filedAfterMergeSteps(sourceId: string): FiledAfterMergeStep[] {
    return this.afterMergeSteps(sourceId).flatMap(({ id, step }) => {
      const record = step.task ? this.tasks.resolve(step.task) : this.tasks.get(id);
      if (!record) return [];
      const closed = step.task && (record.status === "done" || record.status === "dropped");
      return [
        { key: keyOrId(record), title: record.title, ...(closed ? { skipped: "closed" } : {}) },
      ];
    });
  }

  /** The merged story's after-merge steps, each with the id its filing takes. */
  private afterMergeSteps(sourceId: string): { id: string; step: AfterMergeStep }[] {
    const ledger = this.tasks.get(sourceId)?.delivery?.presentation;
    // The revision the merge card showed: published where the destination
    // keeps a description, otherwise the completion this app keeps.
    const shown = ledger?.published ?? ledger?.completion;
    const story = shown && ledger?.revisions?.find((entry) => entry.revision === shown.revision);
    if (!ledger || !story?.afterMerge?.length) return [];
    return story.afterMerge.map((step, index) => ({
      id: createHash("sha256")
        .update(`${sourceId}:${ledger.branch ?? ""}:${story.revision}:${index}`)
        .digest("hex")
        .slice(0, 8),
      step,
    }));
  }

  /**
   * Correct the words of one requirement of an outstanding required action
   * (docs/required-actions.md, "Correcting the words"). The caller names the
   * requirement by its source task and action id, the generation it read,
   * the words to replace, why, and an operation identity; it declares that
   * this is still the same intended action, and a different one is a
   * cancellation and a new declaration instead. Only title, consequence,
   * instructions and criterion change; the original filing, target, ids,
   * prerequisites and completion mode stay. A real change moves the
   * generation, so an older confirmation offer no longer completes it, and
   * keeps its blocked, ready or deferred state. A completed or closed action
   * refuses, and nothing is written on any refusal. The same operation
   * identity answers its earlier result again.
   */
  reviseRequiredAction(
    ref: string,
    input: {
      source: string;
      actionId: string;
      expectedGeneration: number;
      patch: RequiredActionText;
      reason: string;
      operationId: string;
      sameAction: boolean;
      by: Pick<RequiredActionCorrection, "actor" | "taskId" | "label">;
      /** The action's card is on the captain's stack, so the new words are what it offers. */
      presented: boolean;
    },
  ): RequiredActionRevision {
    return this.writer.write((): RequiredActionRevision => {
      const cardRef = ref.startsWith("card-fm-required-action-")
        ? ref.slice("card-fm-required-action-".length)
        : ref;
      const row = this.tasks.resolve(cardRef);
      const action = row?.delivery?.captainAction;
      if (!row || !action) {
        return { effect: "refused", refusal: `No required action is filed as ${ref}.` };
      }
      const current = { taskId: row.id, cardId: action.cardId, generation: action.generation };
      const earlier = action.requirements.find((entry) =>
        entry.corrections?.some((correction) => correction.operationId === input.operationId),
      );
      if (earlier) {
        const kept = earlier.corrections?.find(
          (correction) => correction.operationId === input.operationId,
        );
        return {
          effect: "repeated",
          ...current,
          state: action.state,
          source: earlier.source,
          actionId: earlier.action.id,
          ...(kept ? { correction: kept } : {}),
        };
      }
      const refuse = (refusal: string): RequiredActionRevision => ({
        effect: "refused",
        refusal,
        ...current,
        state: action.state,
      });
      if (row.status !== "open" || ["confirmed", "checked", "cancelled"].includes(action.state)) {
        return refuse(
          action.state === "cancelled" || row.status === "dropped"
            ? "This required action was cancelled, so its words stay as they were."
            : "This required action is already completed, so its words stay as the captain confirmed them. Clarify the history in its card's thread instead.",
        );
      }
      if (input.expectedGeneration !== action.generation) {
        return refuse(
          `You read generation ${input.expectedGeneration}, and the action is now at generation ${action.generation}. Read it again before correcting it.`,
        );
      }
      if (!input.sameAction) {
        return refuse(
          "A correction keeps the same intended action. For a different action, cancel this one and declare the new one from its source task.",
        );
      }
      const reason = input.reason.replace(/\s+/g, " ").trim();
      if (!reason) return refuse("A correction needs its reason.");
      const sourceId = this.tasks.resolve(input.source)?.id ?? input.source;
      const index = action.requirements.findIndex(
        (entry) => entry.source === sourceId && entry.action.id === input.actionId,
      );
      const requirement = action.requirements[index];
      if (!requirement) {
        const named = action.requirements
          .map(
            (entry) => `${this.tasks.get(entry.source)?.key ?? entry.source} / ${entry.action.id}`,
          )
          .join(", ");
        return refuse(
          `No requirement of this action was filed by ${input.source} as ${input.actionId}. Its requirements: ${named}.`,
        );
      }
      const patch = Object.fromEntries(
        REQUIRED_ACTION_TEXT_FIELDS.flatMap((field) =>
          input.patch[field] !== undefined ? [[field, input.patch[field]]] : [],
        ),
      ) as RequiredActionText;
      const parsed = requiredActionSchema.safeParse({ ...requirement.action, ...patch });
      if (!parsed.success) {
        return refuse(
          `The corrected words do not fit a required action: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
        );
      }
      const next: RequiredAction = parsed.data;
      const changed = REQUIRED_ACTION_TEXT_FIELDS.filter(
        (field) => JSON.stringify(next[field]) !== JSON.stringify(requirement.action[field]),
      );
      if (changed.length === 0) {
        return {
          effect: "unchanged",
          ...current,
          state: action.state,
          source: sourceId,
          actionId: input.actionId,
        };
      }
      const generation = action.generation + 1;
      const correction: RequiredActionCorrection = {
        operationId: input.operationId,
        actor: input.by.actor,
        ...(input.by.taskId ? { taskId: input.by.taskId } : {}),
        label: input.by.label,
        at: this.writer.now(),
        reason: reason.slice(0, 500),
        generation,
        previous: Object.fromEntries(
          changed.map((field) => [field, requirement.action[field]]),
        ) as RequiredActionText,
      };
      const requirements = action.requirements.map((entry, at) =>
        at === index
          ? { ...entry, action: next, corrections: [...(entry.corrections ?? []), correction] }
          : entry,
      );
      const state: CaptainAction = {
        ...action,
        requirements,
        generation,
        ...(input.presented ? { presentedGeneration: generation } : {}),
      };
      this.writer.writeDeliveryRecords(row.id, { captainAction: state });
      const first = requirements[0]?.action;
      if (
        first &&
        index === 0 &&
        changed.some((field) => field === "title" || field === "criterion")
      )
        this.writer.patch(row.id, {
          title: first.title.slice(0, 64),
          goal: first.criterion,
          updatedAt: this.writer.now(),
        });
      this.writer.addEvent({
        taskId: row.id,
        at: correction.at,
        actor: input.by.actor === "firstmate" ? "firstmate" : "crewmate",
        kind: "note",
        text: `${correction.label} corrected the required action's ${changed.join(", ")}: ${correction.reason}`,
        data: {
          source: sourceId,
          action: input.actionId,
          generation,
          operationId: input.operationId,
          previous: correction.previous,
          ...(input.by.taskId ? { contributor: input.by.taskId } : {}),
        },
        feed: false,
      });
      return {
        effect: "revised",
        ...current,
        generation,
        state: state.state,
        source: sourceId,
        actionId: input.actionId,
        changed,
        correction,
      };
    })();
  }

  captainActionReady(id: string): boolean {
    const row = this.tasks.get(id);
    return (
      row?.status === "open" &&
      Boolean(row.delivery?.captainAction) &&
      this.tasks.graph.blockers(id).every((blocker) => blocker.status === "done")
    );
  }

  presentCaptainAction(id: string): CaptainAction | undefined {
    const action = this.tasks.get(id)?.delivery?.captainAction;
    if (!action || !this.captainActionReady(id)) return undefined;
    const next: CaptainAction = {
      ...action,
      state: "ready",
      presentedGeneration: action.generation,
    };
    this.writer.writeDeliveryRecords(id, { captainAction: next });
    return next;
  }

  deferCaptainAction(id: string): void {
    const action = this.tasks.get(id)?.delivery?.captainAction;
    if (!action || this.tasks.get(id)?.status !== "open") return;
    this.writer.writeDeliveryRecords(id, { captainAction: { ...action, state: "deferred" } });
  }

  /** Only the host's human button or a fresh typed observation can finish this operation. */
  completeCaptainAction(id: string, generation: number, mode: "confirmed" | "checked"): boolean {
    return this.writer.write(() => {
      const action = this.tasks.get(id)?.delivery?.captainAction;
      if (!action || !this.captainActionReady(id) || action.generation !== generation) return false;
      if (
        mode === "confirmed" &&
        (action.presentedGeneration !== generation ||
          action.requirements.some(
            (requirement) => requirement.action.completion.kind !== "manual",
          ))
      )
        return false;
      if (
        mode === "checked" &&
        action.requirements.some(
          (requirement) => requirement.action.completion.kind !== "device-version",
        )
      )
        return false;
      const next: CaptainAction = { ...action, state: mode, completedAt: this.writer.now() };
      this.writer.writeDeliveryRecords(id, { captainAction: next });
      this.tasks.close(id, {
        status: "done",
        reason: "answered",
        actor: mode === "confirmed" ? "captain" : "host",
        text: captainActionResult(next),
        data: { generation, requirements: action.requirements },
      });
      return true;
    })();
  }
}
