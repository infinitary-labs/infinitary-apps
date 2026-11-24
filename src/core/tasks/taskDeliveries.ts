import { createHash, randomUUID } from "node:crypto";
import {
  AFTER_MERGE_TITLE_PREFIX,
  type AfterMergeShown,
  type AfterMergeStep,
  afterMergeShapeRefusal,
  type FiledAfterMergeStep,
  type FirstmateAfterMergeStep,
} from "@shared/afterMerge";
import {
  type AllowanceOffer,
  allowanceRowWords,
  type CaptainAllowance,
} from "@shared/captainAllowances";
import type { ChangePresentationRecord } from "@shared/changePresentation";
import {
  checkYesCovers,
  type KeptValidationInput,
  validationConsentWords,
} from "@shared/liveValidation";
import { isForkReview } from "@shared/mergeReview";
import { storyAtOrigin } from "@shared/presentationDestination";
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
import { shortTaskTitle } from "@shared/taskTitle";
import { cutText } from "@shared/textCut";
import {
  type IntegrationAllowance,
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
  storyNeverSent,
} from "../storage/changeProjection";
import {
  HISTORY_FIELDS,
  PERMISSION_COLUMNS,
  type PermissionField,
} from "../storage/taskDeliveryFields";
import { TURN_DECLARATION_FIELDS } from "../storage/taskExecutionStore";
import type {
  CardRefusal,
  PendingSettleIntent,
  TaskDelivery,
  TaskRecord,
} from "../storage/taskRecords";
import { decideValidation, recordValidation } from "./liveValidation";
import { TaskGraphRefusal } from "./taskGraph";
import { TaskService } from "./taskService";
import { type DeliveryObservation, keyOrId, type TaskWriter } from "./taskWriter";
import { liveWaitCycle } from "./waitCycles";

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
      const approvals =
        input.kind === "run"
          ? liveValidation.runs.find(({ id }) => id === input.id)?.checkApprovals
          : undefined;
      const requestId =
        input.kind === "request"
          ? input.request.id
          : input.kind === "effect-state" && input.state === "started"
            ? input.request
            : undefined;
      const permissions = liveValidation.permissions.filter(
        ({ request }) => request.id === requestId || approvals?.includes(request.id),
      );
      const sources = [
        ...new Set(permissions.flatMap((permission) => (permission.yes ? [permission.yes] : []))),
      ];
      const words = [...new Set(permissions.map(validationConsentWords).filter(Boolean))];
      this.writer.writeDeliveryRecords(
        id,
        { liveValidation },
        {
          kind: "note",
          text: `Live validation: ${input.kind}${words.length ? ` · ${words.join("; ")}` : ""}`,
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
              ...(requestId ? { request: requestId } : {}),
              ...(sources.length ? { consent: sources } : {}),
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

  /**
   * The captain's answer on a validation card. INF-4446: a yes to a check is
   * kept in the one record of their yeses, as the check's card showed what
   * it covers, so it is served on the Already allowed list and taken back
   * like any other yes; the check's approval rests on it. True when it kept one.
   */
  decideLiveValidation(
    id: string,
    input: Omit<Parameters<typeof decideValidation>[1], "at"> & {
      /** The captain's click as words (`choiceWords`), which a kept yes quotes; the label otherwise. */
      words?: string;
    },
  ): boolean {
    return this.writer.write(() => {
      const task = this.writer.mustGet(id);
      if (!task.delivery?.liveValidation) return false;
      const at = this.writer.now();
      const { words, ...decision } = input;
      const liveValidation = decideValidation(task.delivery.liveValidation, { ...decision, at });
      const approved = liveValidation.permissions.find(
        (permission) =>
          permission.request.kind === "check" &&
          permission.state === "approved" &&
          permission.yes === input.card &&
          permission.answer?.at === at,
      );
      const kept = task.delivery.captainAllowances ?? [];
      const captainAllowances = approved
        ? [
            ...kept.filter((entry) => entry.card !== input.card),
            {
              words: words ?? decision.label,
              covers: checkYesCovers(approved.scenario),
              card: input.card,
              at,
            },
          ]
        : kept;
      this.writer.writeDeliveryRecords(
        id,
        { liveValidation, ...(approved ? { captainAllowances } : {}) },
        {
          kind: "note",
          text: "The captain answered a live-validation request",
          feed: false,
          data: { validationDecision: decision },
        },
      );
      return approved !== undefined;
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
  selectOwnChange(
    id: string,
    own?: { number?: number; headSha?: string; base?: string; url?: string | null },
  ): void {
    const record = this.tasks.get(id);
    if (!record || (!record.delivery?.checkTarget && own?.url === undefined)) return;
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
      prUrl: own?.url === null ? undefined : (own?.url ?? kept?.url),
      changeLabel: own?.url === undefined ? kept?.label : undefined,
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
   * A request number binds an explicit read independently of that selection.
   */
  changePresentation(
    id: string,
    branch?: string,
    number?: number,
  ): ChangePresentationRecord | undefined {
    const record = this.writer.mustGet(id);
    // An explicit request keeps its fork ledger even after another card or
    // check selected a different change. The selection is only the default.
    if (number !== undefined) {
      const target = branch ?? currentChange(record.delivery, record.branch).branch;
      const numbered = storyLedgers(record.delivery).find(
        (ledger) =>
          (!branch || (ledger.branch ?? record.branch) === branch) &&
          (ledger.forkNumber ??
            ledger.published?.number ??
            ledger.publication?.number ??
            ledger.reconciled?.number) === number,
      );
      if (numbered) return numbered;
      const unbound = storyLedgerOf(record.delivery, record.branch, target);
      return unbound &&
        !unbound.published?.number &&
        !unbound.publication?.number &&
        !unbound.reconciled?.number
        ? unbound
        : undefined;
    }
    return storyLedgerOf(
      record.delivery,
      record.branch,
      branch ?? currentChange(record.delivery, record.branch).branch,
      record.delivery?.checkTarget &&
        isForkReview(record.delivery.checkTarget) &&
        (!branch || branch === record.delivery.checkTarget.branch)
        ? record.delivery.checkTarget.number
        : undefined,
    );
  }

  /** Retire active ledgers only; the change record keeps its historical versions. */
  retirePresentationsAtOrigin(repoId: string, former: string, next: string | null): void {
    for (const task of this.tasks.listLive()) {
      if (task.repoId !== repoId) continue;
      const ledgers = storyLedgers(task.delivery);
      const kept = ledgers.filter((ledger) => {
        const story = ledger.revisions.at(-1);
        return (
          !story ||
          !storyAtOrigin(story.destination, former) ||
          storyAtOrigin(story.destination, next) ||
          (task.delivery?.publicationOrigin != null &&
            storyAtOrigin(story.destination, task.delivery.publicationOrigin))
        );
      });
      const retired = ledgers.filter((ledger) => !kept.includes(ledger));
      const offers = task.delivery?.completionOffers;
      const completionOffers = offers?.map((offer) => {
        const { destination: bound, presentationRevision } = offer;
        const moved = bound
          ? bound.repoId === repoId &&
            bound.origin === former &&
            task.delivery?.publicationOrigin !== former
          : presentationRevision !== undefined &&
            retired.some(
              (ledger) =>
                (ledger.branch ?? task.branch) ===
                  currentChange(task.delivery, task.branch).branch &&
                (ledger.revisions.at(-1)?.revision ?? 0) >= presentationRevision,
            );
        return moved && !offer.retired ? { ...offer, retired: true as const } : offer;
      });
      if (!retired.length && !completionOffers?.some((offer, i) => offer !== offers?.[i])) continue;
      this.writer.writeDeliveryRecords(task.id, {
        presentation: undefined,
        presentations: kept.length ? kept : undefined,
        completionOffers,
      });
    }
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
      const forkNumber =
        record.delivery?.checkTarget &&
        isForkReview(record.delivery.checkTarget) &&
        target === record.delivery.checkTarget.branch
          ? record.delivery.checkTarget.number
          : undefined;
      const previous = storyLedgerOf(record.delivery, record.branch, target, forkNumber);
      const next = {
        ...update(previous),
        branch: target,
        ...(forkNumber !== undefined ? { forkNumber } : {}),
      };
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(
          record,
          placeStories(
            [...ledgers.filter((ledger) => ledger !== previous), next],
            record.branch,
            currentChange(record.delivery, record.branch).branch,
            forkNumber,
          ),
        ),
        updatedAt: this.writer.now(),
      });
    })();
  }

  /**
   * Move the story of the change on `from`, never sent anywhere, to the
   * existing branch `to` (INF-3995): open_change names that branch at the
   * very version the story was prepared for while the working copy has
   * another branch checked out. Refused when `to` keeps a story of its own
   * or anything of the story left this computer.
   */
  carryChangePresentation(id: string, from: string, to: string): void {
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (record.status === "done" || record.status === "dropped")
        throw new Error("A closed task cannot publish another story.");
      const source = storyLedgerOf(record.delivery, record.branch, from);
      if (!source) throw new Error(`${from} has no prepared story.`);
      if (storyLedgerOf(record.delivery, record.branch, to))
        throw new Error(`${to} keeps a story of its own.`);
      if (!storyNeverSent(source))
        throw new Error(`The story of ${from} was sent where the project lives and stays with it.`);
      const target = record.delivery?.checkTarget;
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(
          record,
          placeStories(
            [
              ...storyLedgers(record.delivery).filter((ledger) => ledger !== source),
              { ...source, branch: to },
            ],
            record.branch,
            currentChange(record.delivery, record.branch).branch,
            target && isForkReview(target) ? target.number : undefined,
          ),
        ),
        updatedAt: this.writer.now(),
      });
    })();
  }

  /**
   * Keep a write the crewmate asked to send (FI3-1571 piece 4), newest
   * first, at most `WRITE_ASK_CAP`. Past it the oldest answered ask drops
   * first, and a waiting one only when no answered one is left (INF-2993
   * piece 2); it answers the waiting asks it dropped, which their owner
   * refuses at once. A closed task keeps none.
   */
  keepWriteAsk(id: string, ask: WriteAsk): WriteAsk[] {
    const at = this.writer.now();
    let dropped: WriteAsk[] = [];
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (TaskService.isClosed(record)) {
        throw new TaskGraphRefusal(`Refused: ${keyOrId(record)} is closed.`);
      }
      const writeAsks = [
        ask,
        ...(record.delivery?.writeAsks ?? []).filter((kept) => kept.id !== ask.id),
      ];
      dropped = [];
      for (const answered of [true, false]) {
        for (let index = writeAsks.length - 1; index >= 0; index--) {
          if (writeAsks.length <= WRITE_ASK_CAP) break;
          const kept = writeAsks[index] as WriteAsk;
          if ((kept.sentAt !== undefined) !== answered) continue;
          writeAsks.splice(index, 1);
          if (!answered) dropped.push(kept);
        }
      }
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(record, { writeAsks }),
        updatedAt: at,
      });
    });
    run();
    return dropped;
  }

  /**
   * Name the approval card that lists a crewmate's waiting integration ask
   * (INF-2993 piece 2), or an unsafe data reader's waiting write. An ask already
   * taken, or no longer kept, changes nothing.
   */
  listWriteAsk(id: string, askId: string, card: string): void {
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      const asks = record?.delivery?.writeAsks;
      const ask = asks?.find((kept) => kept.id === askId);
      if (!record || !asks || !ask || ask.sentAt !== undefined) return;
      if (ask.card === card) return;
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(record, {
          writeAsks: asks.map((kept) => (kept.id === askId ? { ...ask, card } : kept)),
        }),
        updatedAt: this.writer.now(),
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

  /**
   * Keep the captain's Allow for the rest of this task (INF-2993) on an open
   * task; one for the same connection, action and scope replaces the older.
   * A closed task keeps none.
   */
  allowIntegration(id: string, allowance: IntegrationAllowance): void {
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (TaskService.isClosed(record)) {
        throw new TaskGraphRefusal(`Refused: ${keyOrId(record)} is closed.`);
      }
      const integrationAllowances = [
        ...(record.delivery?.integrationAllowances ?? []).filter(
          (kept) =>
            kept.connection !== allowance.connection ||
            kept.action !== allowance.action ||
            kept.scope !== allowance.scope,
        ),
        allowance,
      ];
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(record, { integrationAllowances }),
        updatedAt: allowance.at,
      });
    });
    run();
  }

  /**
   * The card this task's crewmate just showed (INF-3170 piece 2): with a
   * marked yes it becomes the card's one allowance offer, replacing what an
   * earlier offer of the same card declared; without one, the card offers
   * no yes any more.
   */
  offerAllowance(id: string, card: string, offer?: Omit<AllowanceOffer, "card">): void {
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      const kept = record.delivery?.allowanceOffers ?? [];
      const others = kept.filter((entry) => entry.card !== card);
      if (!offer && others.length === kept.length) return;
      const allowanceOffers = offer ? [...others, { card, ...offer }] : others;
      this.writer.writeDeliveryRecords(id, {
        allowanceOffers: allowanceOffers.length > 0 ? allowanceOffers : undefined,
      });
    })();
  }

  /**
   * The captain's own click on a merge card of the task's own change
   * (`MergeClick`), kept so a merge with no kept approval knows which card's
   * after-merge steps they saw. Each click replaces the last.
   */
  recordMergeClick(id: string, cardId: string, offerId: string): void {
    this.writer.writeDeliveryRecords(id, {
      mergeClick: { cardId, offerId, at: this.writer.now() },
    });
  }

  /** The yes this card's offer declares on this action, if it declares one. */
  allowanceOffer(id: string, card: string, offer: string | undefined, action: string) {
    return this.writer.store
      .get(id)
      ?.delivery?.allowanceOffers?.find(
        (entry) => entry.card === card && entry.offer === offer && entry.action === action,
      );
  }

  /**
   * Keep the captain's yes (INF-3170 piece 2): their own click on a marked
   * action, with a timeline row quoting it. A second yes from the same card
   * replaces the first, so a revised ask keeps one entry.
   */
  recordAllowance(id: string, entry: CaptainAllowance): void {
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      const captainAllowances = [
        ...(record.delivery?.captainAllowances ?? []).filter((kept) => kept.card !== entry.card),
        entry,
      ];
      this.writer.writeDeliveryRecords(
        id,
        { captainAllowances },
        {
          kind: "note",
          actor: "captain",
          feed: true,
          text: allowanceRowWords(entry),
          data: { news: true },
        },
      );
    })();
  }

  /** Take back the yes given on this card, on the captain's words through the first mate; a row says so. */
  withdrawAllowance(id: string, card: string): CaptainAllowance | undefined {
    let taken: CaptainAllowance | undefined;
    this.writer.write(() => {
      const record = this.writer.mustGet(id);
      const kept = record.delivery?.captainAllowances ?? [];
      taken = kept.find((entry) => entry.card === card);
      if (!taken) return;
      const rest = kept.filter((entry) => entry.card !== card);
      this.writer.writeDeliveryRecords(
        id,
        { captainAllowances: rest.length > 0 ? rest : undefined },
        {
          kind: "note",
          actor: "firstmate",
          feed: true,
          text: `You took back your yes: "${taken.words}"`,
          data: { news: true, allowanceWithdrawn: taken },
        },
      );
    })();
    return taken;
  }

  /** The task's allowances while it is open; a closed or unknown task has none. */
  integrationAllowances(id: string): readonly IntegrationAllowance[] {
    const record = this.writer.store.get(id);
    if (!record || TaskService.isClosed(record)) return [];
    return record.delivery?.integrationAllowances ?? [];
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
        text: `merge card "${refusal.title}" refused: ${refusal.why}`,
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
      // Only the rows that hold a requirement from this source or for this
      // shared action, never every task (INF-4224); read again per action,
      // since an earlier action of the same offer may have filed one.
      const holding = this.tasks.listWithRequirementFrom(
        sourceId,
        action.sharedId ? [action.sharedId] : [],
      );
      const existing = holding.find((row) =>
        row.delivery?.captainAction?.requirements.some(
          (requirement) =>
            `${requirement.source}:${requirement.offer}:${requirement.action.id}` === receipt,
        ),
      );
      if (existing) continue;
      const outstanding = holding.find(
        (row) =>
          row.status === "open" &&
          row.delivery?.captainAction?.requirements.some(
            (requirement) => requirement.source === sourceId && requirement.action.id === action.id,
          ),
      );
      const shared =
        outstanding ??
        (action.sharedId
          ? holding.find(
              (row) =>
                row.status === "open" &&
                row.delivery?.captainAction?.requirements.some(
                  (requirement) => requirement.action.sharedId === action.sharedId,
                ),
            )
          : undefined);
      const id = shared?.id ?? randomUUID().slice(0, 8);
      if (!shared)
        this.tasks.create({
          id,
          kind: "operation",
          title: shortTaskTitle(action.title),
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
          title: shortTaskTitle(first.title),
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
   * start. A step may not wait on its own origin, whose merge it follows,
   * and each task a step holds must wait on the origin now (`holdsRefusal`).
   */
  afterMergeRefusal(sourceId: string, steps: readonly AfterMergeStep[]): string | undefined {
    const held = new Set<string>();
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
      const placing = this.stepRepository(sourceId, step, at);
      if ("refused" in placing) return placing.refused;
      for (const ref of step.blockedBy ?? []) {
        const blocker = this.tasks.resolve(ref);
        if (!blocker) return `${at} waits for no task "${ref}".`;
        if (blocker.id === sourceId) return `${at} waits for this task, which it already follows.`;
        const named = step.task ? this.tasks.resolve(step.task) : undefined;
        if (named && this.waitCycle(blocker.id, named.id))
          return `${at} waits for ${keyOrId(blocker)}, which already waits for ${keyOrId(named)}; nothing could ever start.`;
      }
      const holding = this.holdsRefusal(sourceId, step, at, held);
      if (holding) return holding;
    }
    return undefined;
  }

  /**
   * Where a new step works (INF-4220): its project's repository it names,
   * else the origin's in the origin's project, else the step's project's
   * only one. A step filed in another project of several repositories must
   * name one, and is refused with their names, so nothing is guessed.
   */
  private stepRepository(
    sourceId: string,
    step: AfterMergeStep,
    at: string,
  ): { projectId: string; repoId: string | null } | { refused: string } {
    const source = this.tasks.get(sourceId);
    const named = step.project
      ? (this.tasks.projects.byKey(step.project) ?? this.tasks.projects.get(step.project))
      : undefined;
    const project =
      named && named.archivedAt === null
        ? named
        : source && this.tasks.projects.get(source.projectId);
    if (!project) return { projectId: source?.projectId ?? "", repoId: source?.repoId ?? null };
    const repositories = this.tasks.projects.repositoriesOf(project.id);
    const names = repositories.map((repository) => repository.name).join(", ");
    if (step.repository) {
      const wanted = step.repository.trim().toLowerCase();
      const found = repositories.find(
        (repository) =>
          repository.id === step.repository?.trim() || repository.name.toLowerCase() === wanted,
      );
      return found
        ? { projectId: project.id, repoId: found.id }
        : {
            refused: repositories.length
              ? `${at} names no repository "${step.repository}" in ${project.name}; its repositories are ${names}.`
              : `${at} names a repository, and ${project.name} holds none.`,
          };
    }
    if (source && project.id === source.projectId)
      return { projectId: project.id, repoId: source.repoId };
    if (repositories.length > 1)
      return {
        refused: `${at} is filed in ${project.name}, which holds several repositories (${names}): name the one it works in with repository.`,
      };
    return { projectId: project.id, repoId: repositories[0]?.id ?? null };
  }

  /**
   * Why a step's `holds` cannot stand (INF-3846 piece 4): each key must name
   * live work that waits on this task now, held by one step only, and never
   * the step's own task or work the step waits for, whose wait on the step
   * would close a cycle. Which waiters still need the rest is the
   * crewmate's judgment; the host checks only that the move can be made.
   */
  private holdsRefusal(
    sourceId: string,
    step: AfterMergeStep,
    at: string,
    held: Set<string>,
  ): string | undefined {
    const named = step.task ? this.tasks.resolve(step.task) : undefined;
    const waitsFor = new Set(
      (step.blockedBy ?? []).flatMap((ref) => this.tasks.resolve(ref)?.id ?? []),
    );
    for (const ref of step.holds ?? []) {
      const waiter = this.tasks.resolve(ref);
      if (!waiter) return `${at} holds no task "${ref}".`;
      if (waiter.id === sourceId) return `${at} holds this task itself.`;
      if (named && waiter.id === named.id) return `${at} holds its own task ${keyOrId(waiter)}.`;
      if (TaskService.isClosed(waiter))
        return `${at} holds ${keyOrId(waiter)}, which is closed and waits for nothing.`;
      if (!this.tasks.graph.blockers(waiter.id).some((blocker) => blocker.id === sourceId))
        return `${at} holds ${keyOrId(waiter)}, which does not wait for this task; only a task waiting for this task can keep waiting for the rest.`;
      if (held.has(waiter.id))
        return `${at} holds ${keyOrId(waiter)}, which another step already holds; one step carries each wait.`;
      const cycle =
        [...waitsFor].some((blocker) => this.waitCycle(blocker, waiter.id)) ||
        (named && this.waitCycle(named.id, waiter.id));
      if (cycle)
        return `${at} holds ${keyOrId(waiter)}, which the step already waits for, directly or through other tasks; nothing could ever start.`;
      held.add(waiter.id);
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
      const drawn = {
        ...(waitsFor.length ? { waitsFor } : {}),
        ...(step.uses?.trim() ? { uses: step.uses.trim() } : {}),
      };
      // The first mate's change in the app files no task, so it has no Continue title.
      if (step.doer === "firstmate")
        return {
          title: (step.title ?? "").trim(),
          ...(step.goal ? { goal: step.goal } : {}),
          doer: "firstmate",
        };
      const named = step.task ? this.tasks.resolve(step.task) : undefined;
      if (named)
        return {
          key: keyOrId(named),
          title: named.title,
          ...(named.goal ? { goal: named.goal } : {}),
          ...drawn,
        };
      return {
        title: `${AFTER_MERGE_TITLE_PREFIX}${(step.title ?? step.task ?? "").trim()}`,
        ...(step.goal ? { goal: step.goal } : {}),
        ...drawn,
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
   * second activation answers the task already filed. A first-mate step
   * files nothing: the settled wake hands it over (`firstmateAfterMergeSteps`).
   * `closedBy` is who settled the merge, which says whether a merge with no
   * kept approval was the captain's own click (`captainMergeClick`).
   */
  activateAfterMergeSteps(sourceId: string, closedBy?: string): FiledAfterMergeStep[] {
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
    // Each task the step holds keeps waiting, now for the step that does the
    // rest of the work (INF-3846 piece 4), before the close's sweep reads it:
    // it is never told to carry on at this merge. A move that would close a
    // cycle since the card was shown is skipped and noted on the waiter.
    const holdOn = (carrier: TaskRecord, step: AfterMergeStep) => {
      if (TaskService.isClosed(carrier)) return;
      for (const ref of step.holds ?? []) {
        const waiter = this.tasks.resolve(ref);
        if (!waiter || waiter.id === carrier.id || TaskService.isClosed(waiter)) continue;
        if (this.tasks.graph.carryWait(sourceId, waiter.id, carrier.id, "host", at)) continue;
        if (!this.tasks.graph.blockers(waiter.id).some((blocker) => blocker.id === sourceId))
          continue;
        note(
          waiter.id,
          `could not keep waiting for the rest of "${source.title}" (${keyOrId(source)}) in "${carrier.title}" (${keyOrId(carrier)}), as its merge card listed: the wait would close a cycle`,
          undefined,
        );
      }
    };
    // The captain's own click on the merge card allows what each step there
    // named it would use (INF-4574, the captain's yes to
    // merge_click_allows_listed_step): the yes is recorded on the task the
    // step starts. A merge the app made on its own records nothing.
    // Only steps read from the revision the clicked card showed: a yes never
    // covers words the captain did not see on that card.
    const clicked = captainMergeClick(source, closedBy);
    const seen = clicked !== undefined && clicked.revision === mergedStoryRevision(source);
    const allow = (taskId: string, step: AfterMergeStep) => {
      const covers = step.uses?.trim();
      if (!clicked || !seen || !covers) return;
      this.recordAllowance(taskId, {
        words: `Merge, on the merge card of "${source.title}" (${keyOrId(source)}), which listed this step`,
        covers,
        card: clicked.card,
        at,
      });
    };
    const listed = this.crewmateAfterMergeSteps(sourceId);
    // What the brief of a step the app files says about its merge's other steps.
    const stepName = (step: AfterMergeStep): string => {
      const named = step.task ? this.tasks.resolve(step.task) : undefined;
      if (named) return `${keyOrId(named)} "${named.title}"`;
      return `"${AFTER_MERGE_TITLE_PREFIX}${(step.title ?? step.task ?? "").trim()}"`;
    };
    return listed.map(({ id, step }): FiledAfterMergeStep => {
      const why = step.why?.trim();
      if (step.task) {
        const named = this.tasks.resolve(step.task);
        if (!named) return { key: step.task, title: step.task };
        const filed = { key: keyOrId(named), title: named.title };
        holdOn(named, step);
        // Started or closed since the card was shown, or on an earlier
        // activation of this merge: there is nothing left to start.
        if (named.status !== "open" || named.startedAt !== null) return filed;
        waitOn(named.id, step);
        allow(named.id, step);
        // The same link a filed step carries: the named task does the rest
        // of this work, so the message this task served covers it and its
        // brief reads this task's report and card (INF-3846 piece 4). Its line
        // says the merge did not file it, so its own origin stays its line's.
        this.tasks.graph.linkMergeStep(named.id, sourceId, at, false);
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
      // Checked when the story was prepared; a repository removed since
      // leaves the step in the origin's place.
      const placed = this.stepRepository(sourceId, step, "");
      const waitsFor = (step.blockedBy ?? []).flatMap((ref) => {
        const blocker = this.tasks.resolve(ref);
        return blocker ? [`${keyOrId(blocker)} "${blocker.title}"`] : [];
      });
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
            merged: {
              siblings: listed
                .filter((other) => other.id !== id)
                .map((other) => stepName(other.step)),
              waitsFor,
            },
          },
          undefined,
        ),
        ...("refused" in placed ? { repoId: source.repoId, projectId: source.projectId } : placed),
        // The app filed it, so the captain did not ask for its result
        // (INF-4574 change 2): the same typed mark the first mate's own work
        // carries. Its kind is still the classifier's to establish.
        shape: { kind: "unclear", kind_source: "none", internal_step: true },
        startPolicy: "when-ready",
        actor: "host",
        createdAt: at,
      });
      this.tasks.graph.linkMergeStep(record.id, sourceId, at, true);
      waitOn(record.id, step);
      holdOn(record, step);
      allow(record.id, step);
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
    return this.crewmateAfterMergeSteps(sourceId).flatMap(({ id, step }) => {
      const record = step.task ? this.tasks.resolve(step.task) : this.tasks.get(id);
      if (!record) return [];
      const closed = step.task && (record.status === "done" || record.status === "dropped");
      // The held tasks whose wait the merge moved onto this step.
      const holds = (step.holds ?? []).flatMap((ref) => {
        const waiter = this.tasks.resolve(ref);
        return waiter &&
          this.tasks.graph.blockers(waiter.id).some((blocker) => blocker.id === record.id)
          ? [keyOrId(waiter)]
          : [];
      });
      return [
        {
          key: keyOrId(record),
          title: record.title,
          ...(closed ? { skipped: "closed" } : {}),
          ...(holds.length ? { holds } : {}),
        },
      ];
    });
  }

  /**
   * The merged story's steps that are the first mate's change in the app
   * (finding 4 of INF-3060): no task is filed or started for them, and the
   * merge's settled wake hands them to the first mate.
   */
  firstmateAfterMergeSteps(sourceId: string): FirstmateAfterMergeStep[] {
    return this.afterMergeSteps(sourceId).flatMap(({ step }) =>
      step.doer === "firstmate"
        ? [
            {
              title: (step.title ?? "").trim(),
              goal: (step.goal ?? "").trim(),
              ...(step.why?.trim() ? { why: step.why.trim() } : {}),
            },
          ]
        : [],
    );
  }

  private crewmateAfterMergeSteps(sourceId: string): { id: string; step: AfterMergeStep }[] {
    return this.afterMergeSteps(sourceId).filter(({ step }) => step.doer !== "firstmate");
  }

  /** The merged story's after-merge steps, each with the id its filing takes. */
  private afterMergeSteps(sourceId: string): { id: string; step: AfterMergeStep }[] {
    const record = this.tasks.get(sourceId);
    const ledger = record?.delivery?.presentation;
    const shown = record && mergedStoryRevision(record);
    const story =
      shown === undefined
        ? undefined
        : ledger?.revisions?.find((entry) => entry.revision === shown);
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
        reason: cutText(reason, 500),
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
          title: shortTaskTitle(first.title),
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

/**
 * The captain's own click that merged a task's change, and the story
 * revision its card showed. A kept approval says it when the merge spent
 * one: the captain's, never the app's autonomy. A merge with no kept
 * approval - a local branch, or a host with no checks to keep one for - is
 * the captain's when the captain's own settle closed it, from the merge card
 * their click recorded (`TaskDelivery.mergeClick`). Absent for a merge the
 * app or the first mate made, or a click whose card offer was not recorded.
 */
function captainMergeClick(
  record: TaskRecord,
  closedBy: string | undefined,
): { card: string; revision: number } | undefined {
  const approval = record.delivery?.mergeAuthorization;
  const spent = approval?.status === "consumed" && approval.receipt ? approval : undefined;
  const card = spent
    ? spent.issuer === "captain"
      ? spent.card
      : undefined
    : closedBy === "captain" && record.delivery?.mergeClick
      ? { id: record.delivery.mergeClick.cardId, offerId: record.delivery.mergeClick.offerId }
      : undefined;
  if (!card) return undefined;
  const revision = spent
    ? clickedStoryRevision(record)
    : record.delivery?.completionOffers?.find(
        (offer) => offer.cardId === card.id && offer.offerId === card.offerId,
      )?.presentationRevision;
  return revision === undefined ? undefined : { card: card.id, revision };
}

/**
 * The story revision whose after-merge steps a merge carries: the one the
 * clicked merge card showed, or without a kept click, the revision
 * published where the destination keeps a description, otherwise the
 * completion this app keeps.
 */
function mergedStoryRevision(record: TaskRecord): number | undefined {
  const ledger = record.delivery?.presentation;
  return clickedStoryRevision(record) ?? (ledger?.published ?? ledger?.completion)?.revision;
}

/**
 * The story revision the clicked merge card showed (INF-3623): a story
 * revised after the click merges, but its steps stay the card's until a new
 * merge card shows them. Only an approval that stands or that its own merge
 * spent: one that ended another way names a card the task no longer merges
 * by. Undefined for a review approval, another branch's approval, or a click
 * whose card offer was not recorded.
 */
function clickedStoryRevision(record: TaskRecord): number | undefined {
  const approval = record.delivery?.mergeAuthorization;
  if (approval?.status !== "standing" && approval?.status !== "consumed") return undefined;
  if (approval.review) return undefined;
  const ledger = record.delivery?.presentation;
  if (approval.target.branch !== (ledger?.branch ?? record.branch)) return undefined;
  return record.delivery?.completionOffers?.find(
    (offer) => offer.cardId === approval.card.id && offer.offerId === approval.card.offerId,
  )?.presentationRevision;
}
