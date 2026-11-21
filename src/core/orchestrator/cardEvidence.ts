import { createHash, randomUUID } from "node:crypto";
import { withAppDecline } from "@shared/cardDecline";
import {
  CARD_OBSERVATION_NOTE_MAX,
  CARD_QUESTIONS_MAX_BYTES,
  type Card,
  type CardActionSource,
  type CardAnswer,
  type CardAwaiting,
  type CardChanges,
  type CardDecisionContext,
  type CardDisplay,
  type CardMessage,
  type CardObservationActor,
  type CardObservationPayload,
  type CardObservationSource,
  type CardQuestion,
  type CardSubmission,
  type ChoiceCarriedRecord,
  cardPressInputSchema,
  cardQuestionsBytes,
  cardQuestionsSchema,
  cardSubmissionSchema,
} from "@shared/cards";
import { cutText } from "@shared/textCut";
import { z } from "zod";
import { updateSightingId } from "../storage/cardStore";
import { cardChanges } from "./cardChanges";
import type { CardServiceHost, CloseOut } from "./cardStackTypes";

/**
 * The card stack's evidence (docs/card-evidence.md): every observation the
 * record keeps about a card - its offers, what the stage did with them, an
 * interaction with its actions, how a lifecycle ended, a thread line and the
 * captain's sightings - written here, in the same transaction as the card
 * or thread write it describes, and nowhere else. It also reads that
 * evidence back for what changed since the captain last looked.
 */

/**
 * What an interaction carried that the record keeps beside the choice
 * (docs/card-evidence.md): the channel, the shell's submission metadata as
 * it arrived - read leniently here, so metadata that cannot be read never
 * refuses a valid choice - a body script's own value, and the task as it
 * stood before the choice was admitted.
 */
export type CardInteractionEvidence = {
  source: CardActionSource;
  submission?: unknown;
  frameValue?: string;
  context?: CardDecisionContext;
  contextGap?: "no-task" | "task-missing";
  /** What else the card's field sent with the choice (`choice-attachments.md`). */
  carried?: ChoiceCarriedRecord;
};

/** Why an offer came to exist, as its observation says. */
type OfferBasis = CardObservationPayload<"offer">["basis"];
type StageCause = CardObservationPayload<"availability">["cause"];
/** How a lifecycle began, carried by its first availability. */
type Opened = {
  lifecycle: "started" | "reopened" | "legacy-initial-snapshot";
  predecessor?: string;
};

/** A card write with the lifecycle and offer it carries (`CardEvidence.stamp`). */
type Stamped = { card: Card; offer: boolean; opened?: Opened };

export class CardEvidence {
  /**
   * What changed in each card's shown version since the captain last saw
   * it, by card, worked out once per shown offer: a later look cannot move
   * it, because `seen` is recorded only for the version on the stage and the
   * comparison passes over that version. Memory only; a restart recomputes.
   */
  private readonly changes = new Map<
    string,
    { offerId: string; changes: CardChanges | undefined }
  >();

  constructor(
    private readonly host: Pick<CardServiceHost, "now" | "cardStore" | "build">,
    /** The open cards, as the stack holds them. */
    private readonly cards: ReadonlyMap<string, Card>,
  ) {}

  /**
   * The lifecycle and offer a card write carries (docs/card-evidence.md). An
   * open card keeps its lifecycle, and its offer while nothing it shows has
   * changed; a card not on the stack starts a lifecycle - a reopen when its
   * row already exists, linked to the one before.
   */
  stamp(next: Card): Stamped {
    const previous = this.cards.get(next.id);
    if (previous?.lifecycleId && previous.offerId) {
      const same = offerFingerprint(previous) === offerFingerprint(next);
      return {
        card: {
          ...next,
          lifecycleId: previous.lifecycleId,
          offerId: same ? previous.offerId : randomUUID(),
        },
        offer: !same,
      };
    }
    const stored = this.host.cardStore.get(next.id);
    return {
      card: { ...next, lifecycleId: randomUUID(), offerId: randomUUID() },
      offer: true,
      opened: {
        lifecycle: stored ? "reopened" : "started",
        ...(stored?.lifecycleId ? { predecessor: stored.lifecycleId } : {}),
      },
    };
  }

  /**
   * One card write and the evidence it carries, in the caller's
   * transaction: the row - revised in place, keeping the replaced version
   * as the card's history, or put, reopening a row it once had - then its
   * new offer and what the stage does with it. `shown` is the version the
   * stage keeps showing while the newer write waits on its writer.
   */
  write(
    { card, offer, opened }: Stamped,
    how: {
      revise?: boolean;
      basis: OfferBasis;
      source: CardObservationSource;
      cause: StageCause;
      shown?: Card;
    },
  ): void {
    const store = this.host.cardStore;
    if (how.revise) store.revise(card);
    else {
      if (opened?.lifecycle === "reopened") store.reopen(card.id);
      store.upsert(card);
    }
    if (offer) this.noteOffer(card, how.basis, how.source);
    this.noteStage({ head: card, shown: how.shown ?? card }, how.cause, {
      source: how.source,
      ...(opened ? { opened } : {}),
    });
  }

  /** An offer, whole and immutable: its observation id is its offer id. */
  noteOffer(card: Card, basis: OfferBasis, source: CardObservationSource): void {
    const { lifecycleId, offerId } = card;
    if (!lifecycleId || !offerId) return;
    this.host.cardStore.observe({
      id: offerId,
      kind: "offer",
      cardId: card.id,
      lifecycleId,
      taskId: card.taskId,
      at: this.host.now(),
      actor: basis === "emitted" ? card.author : "host",
      source,
      offerId,
      build: this.host.build,
      payload: {
        basis,
        fingerprint: offerFingerprint(card),
        author: card.author,
        title: card.title,
        meta: card.meta,
        ...(card.reviewTaskId ? { reviewTaskId: card.reviewTaskId } : {}),
        ...(card.model ? { model: card.model } : {}),
        ...(card.place ? { place: card.place } : {}),
        body: card.body,
        // What the captain is offered, the app's Decline included (INF-3108),
        // so a past card shows the button its ending names.
        actions: withAppDecline(card).actions,
        ...(card.pictures?.length ? { pictures: card.pictures } : {}),
        ...(card.files?.length ? { files: card.files } : {}),
        ...(card.width ? { width: card.width } : {}),
        ...(card.attachment ? { attachment: card.attachment } : {}),
        ...(card.reads?.length ? { reads: card.reads } : {}),
        ...(card.sql?.length ? { sql: card.sql } : {}),
        ...(card.risk ? { risk: card.risk } : {}),
        ...(card.requiredActions !== undefined ? { requiredActions: card.requiredActions } : {}),
        ...(card.afterMerge?.length ? { afterMerge: card.afterMerge } : {}),
        ...(card.asking ? { asking: true as const } : {}),
        ...(card.designOnly ? { designOnly: true as const } : {}),
        ...(card.continues ? { continues: true as const } : {}),
        ...(card.answering ? { answering: true as const } : {}),
        ...(card.holdsPlace ? { holdsPlace: true as const } : {}),
      },
    });
  }

  /**
   * What the stage does with a card after a write, as availability facts:
   * the offer it shows is `available`, or `waiting` on what the card waits
   * on; a newer head the stage does not show yet waits on its author's
   * close-out. Only a change is recorded, read against the log itself, so a
   * restart or a repeated write never doubles a fact.
   */
  noteStage(
    view: { head: Card; shown: Card },
    cause: StageCause,
    options: {
      source: CardObservationSource;
      actor?: CardObservationActor;
      closeOut?: CloseOut;
      opened?: Opened;
      answer?: boolean;
    },
  ): void {
    const { head, shown } = view;
    const lifecycleId = head.lifecycleId;
    if (!lifecycleId || !head.offerId || !shown.offerId) return;
    const facts: { offerId: string; state: "available" | "waiting"; waitingOn?: CardAwaiting }[] = [
      shown.awaiting
        ? { offerId: shown.offerId, state: "waiting", waitingOn: shown.awaiting }
        : { offerId: shown.offerId, state: "available" },
    ];
    if (head.offerId !== shown.offerId) {
      facts.push({
        offerId: head.offerId,
        state: "waiting",
        waitingOn: head.awaiting ?? "close-out",
      });
    }
    let opened = options.opened;
    const store = this.host.cardStore;
    for (const fact of facts) {
      const last = store.lastAvailabilityOf(head.id, lifecycleId, fact.offerId);
      if (
        last &&
        last.state === fact.state &&
        last.waitingOn === fact.waitingOn &&
        !opened &&
        !options.answer
      ) {
        continue;
      }
      const before =
        fact.state === "available" ? store.lastAvailableOffer(head.id, lifecycleId) : undefined;
      store.observe({
        id: randomUUID(),
        kind: "availability",
        cardId: head.id,
        lifecycleId,
        taskId: head.taskId,
        at: this.host.now(),
        actor: options.actor ?? (options.source === "tool" ? head.author : "host"),
        source: options.source,
        offerId: fact.offerId,
        build: this.host.build,
        payload: {
          state: fact.state,
          ...(fact.waitingOn ? { waitingOn: fact.waitingOn } : {}),
          cause,
          ...(options.closeOut ? { closeOut: options.closeOut } : {}),
          ...(before && before !== fact.offerId ? { replaces: before } : {}),
          ...(opened ? opened : {}),
        },
      });
      opened = undefined;
    }
  }

  /**
   * One interaction with an offer's actions, as the host admitted it:
   * `shown` is the version the click chose from, and the id the click
   * named is kept whether or not that offer declared it.
   */
  noteAction(
    shown: Card,
    actionId: string,
    input: {
      closes: boolean;
      answers?: CardAnswer[] | undefined;
      by: "captain" | "firstmate" | "crewmate";
      evidence?: CardInteractionEvidence | undefined;
    },
  ): string | undefined {
    const { lifecycleId, offerId } = shown;
    if (!lifecycleId || !offerId) return undefined;
    const action = shown.actions.find((entry) => entry.id === actionId);
    const evidence = input.evidence;
    const source = evidence?.source ?? (input.by === "captain" ? "chrome" : "frame");
    const read = readSubmission(evidence?.submission);
    const submission = read.submission;
    const answered = Boolean(input.answers?.length);
    const questions: Pick<
      CardObservationPayload<"action">,
      "questions" | "questionsGap"
    > = read.questions
      ? { questions: read.questions }
      : read.questionsGap
        ? { questionsGap: read.questionsGap }
        : answered
          ? { questionsGap: "absent" }
          : {};
    const id = randomUUID();
    const kept = this.host.cardStore.observe({
      id,
      kind: "action",
      cardId: shown.id,
      lifecycleId,
      taskId: shown.taskId,
      at: this.host.now(),
      actor: source === "chrome" ? "captain" : "frame",
      source,
      offerId,
      interactionId: submission?.id ?? randomUUID(),
      build: this.host.build,
      payload: {
        actionId,
        precedingMessageId: this.host.cardStore.latestMessageId(shown.id),
        recognized: action !== undefined,
        label: action?.label ?? null,
        closes: input.closes,
        keepsOpen: false,
        effect: action?.effect ?? null,
        ...(evidence?.frameValue !== undefined ? { frameValue: evidence.frameValue } : {}),
        ...(answered ? { answers: input.answers } : {}),
        display: displayOf(read, shown),
        ...(submission?.reading ? { reading: submission.reading } : {}),
        ...(submission?.remounted ? { remounted: true as const } : {}),
        ...questions,
        ...(evidence?.context ? { context: evidence.context } : {}),
        ...(evidence?.contextGap ? { contextGap: evidence.contextGap } : {}),
        interactionSource: submission ? "shell" : "host",
        ...(submission?.input ? { input: submission.input } : {}),
        ...(evidence?.carried ? { carried: evidence.carried } : {}),
      },
    });
    return kept ? id : undefined;
  }

  /** How a lifecycle ended without a declared action. */
  noteExit(
    card: Card,
    actor: CardObservationActor,
    source: CardObservationSource,
    payload: CardObservationPayload<"exit">,
  ): string | undefined {
    const { lifecycleId, offerId } = card;
    if (!lifecycleId) return undefined;
    const id = randomUUID();
    const kept = this.host.cardStore.observe({
      id,
      kind: "exit",
      cardId: card.id,
      lifecycleId,
      taskId: card.taskId,
      at: this.host.now(),
      actor,
      source,
      offerId,
      build: this.host.build,
      payload: {
        ...payload,
        ...(payload.note ? { note: cutText(payload.note, CARD_OBSERVATION_NOTE_MAX) } : {}),
      },
    });
    return kept ? id : undefined;
  }

  /**
   * A thread line on a card, as the version it was written about: the
   * captain's about the version the stage showed, an author's about its
   * newest write. A card with no lifecycle keeps no evidence.
   */
  noteMessage(
    about: Card,
    message: CardMessage,
    by: { actor: CardObservationActor; source: CardObservationSource },
    line: { interim: boolean; answers?: CardAnswer[]; submission?: unknown },
  ): void {
    if (!about.lifecycleId) return;
    const read = readSubmission(line.submission);
    this.host.cardStore.observe({
      id: randomUUID(),
      kind: "message_ref",
      cardId: message.cardId,
      lifecycleId: about.lifecycleId,
      taskId: about.taskId,
      at: message.at,
      ...by,
      offerId: about.offerId,
      messageId: message.id,
      build: this.host.build,
      payload: {
        messageId: message.id,
        who: message.who,
        ...(line.interim ? { interim: true as const } : {}),
        ...(line.answers ? { answers: line.answers } : {}),
        ...(read.questions
          ? { questions: read.questions }
          : read.questionsGap
            ? { questionsGap: read.questionsGap }
            : line.answers?.length
              ? { questionsGap: "absent" as const }
              : {}),
        ...(line.submission !== undefined ? { display: displayOf(read, about) } : {}),
      },
    });
  }

  /**
   * The window had a card's version in front of the captain
   * (`CardService.seen`): recorded once per offer as its `seen` observation,
   * what the card's next revision is compared with.
   */
  noteSeen(shown: Card, lifecycleId: string, offerId: string): void {
    const store = this.host.cardStore;
    if (store.lastSeenOffer(shown.id, lifecycleId) === offerId) return;
    store.observe({
      id: randomUUID(),
      kind: "seen",
      cardId: shown.id,
      lifecycleId,
      taskId: shown.taskId,
      at: this.host.now(),
      actor: "captain",
      source: "stage",
      offerId,
      build: this.host.build,
      payload: {},
    });
  }

  /**
   * The captain saw the current update of the version on the stage
   * (`CardService.seenUpdate`): once, and only the update released for that
   * offer. Returns whether it was recorded.
   */
  noteUpdateSeen(shown: Card, lifecycleId: string, offerId: string, updateId: string): boolean {
    const store = this.host.cardStore;
    if (
      store.currentUpdate(shown.id, lifecycleId, offerId) !== updateId ||
      store.updateSeen(shown.id, lifecycleId, updateId)
    )
      return false;
    store.observe({
      id: updateSightingId(updateId),
      kind: "seen",
      cardId: shown.id,
      lifecycleId,
      taskId: shown.taskId,
      at: this.host.now(),
      actor: "captain",
      source: "stage",
      offerId,
      build: this.host.build,
      payload: { updateId },
    });
    return true;
  }

  /** Current-update sightings are independent of lifecycle-wide historical offer sightings. */
  updateState(card: Card): Pick<Card, "currentUpdateId" | "currentUpdateSeen"> {
    if (!card.lifecycleId || !card.offerId) return {};
    const store = this.host.cardStore;
    const currentUpdateId = store.currentUpdate(card.id, card.lifecycleId, card.offerId);
    return currentUpdateId
      ? {
          currentUpdateId,
          currentUpdateSeen: store.updateSeen(card.id, card.lifecycleId, currentUpdateId),
        }
      : {};
  }

  /** What changed is kept only for cards still on the stack. */
  pruneChanges(): void {
    for (const id of this.changes.keys()) {
      if (!this.cards.has(id)) this.changes.delete(id);
    }
  }

  /**
   * The version on the stage with what changed in it since the captain last
   * saw the card (docs/card-authoring.md "What changed since you looked"):
   * compared with the newest version the window reported seen on this
   * lifecycle, so revisions that landed unseen accumulate, and a card never
   * seen before it changed carries nothing.
   */
  withChanges(shown: Card): Card {
    const { lifecycleId, offerId } = shown;
    if (!lifecycleId || !offerId) return shown;
    let known = this.changes.get(shown.id);
    if (known?.offerId !== offerId) {
      known = { offerId, changes: this.changesSinceSeen(shown, lifecycleId, offerId) };
      this.changes.set(shown.id, known);
    }
    return known.changes ? { ...shown, changes: known.changes } : shown;
  }

  /** The comparison of one version with the newest other version seen on its lifecycle. */
  changesSinceSeen(shown: Card, lifecycleId: string, offerId: string): CardChanges | undefined {
    const store = this.host.cardStore;
    const seenId = store.lastSeenOffer(shown.id, lifecycleId, offerId);
    const seen = seenId ? store.offer(shown.id, seenId) : undefined;
    if (!seen) return undefined;
    return cardChanges(seen.payload, shown, store.offer(shown.id, offerId)?.at ?? shown.createdAt);
  }
}

/**
 * What an offer shows, fingerprinted: the words, the body with every fact
 * the host appended, the actions in footer order, the pictures, the width,
 * the live attachment, where its task runs and its risk. Status, stage and
 * position are not what a card offers. A card with no attachment, no place,
 * no risk and no live reads fingerprints as it always did.
 */
function offerFingerprint(card: Card): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        card.author,
        card.title,
        card.meta,
        card.model ?? null,
        card.body,
        card.actions,
        card.pictures ?? [],
        card.width ?? null,
        ...(card.attachment ? [card.attachment] : []),
        ...(card.place ? [{ place: card.place }] : []),
        ...(card.risk ? [{ risk: card.risk }] : []),
        ...(card.requiredActions !== undefined ? [{ requiredActions: card.requiredActions }] : []),
        ...(card.afterMerge?.length ? [{ afterMerge: card.afterMerge }] : []),
        ...(card.asking ? [{ asking: true }] : []),
        ...(card.designOnly ? [{ designOnly: true }] : []),
        ...(card.continues ? [{ continues: true }] : []),
        ...(card.answering ? [{ answering: true }] : []),
        ...(card.holdsPlace ? [{ holdsPlace: true }] : []),
        ...(card.reviewTaskId ? [{ reviewTaskId: card.reviewTaskId }] : []),
        ...(card.files?.length ? [{ files: card.files }] : []),
        ...(card.reads?.length ? [{ reads: card.reads }] : []),
        ...(card.sql?.length ? [{ sql: card.sql }] : []),
      ]),
    )
    .digest("hex");
}

/** The shell's submission metadata, read so that nothing it says can refuse a choice. */
type SubmissionReading = {
  submission?: CardSubmission;
  /** Something arrived, and it could not be read. */
  malformed: boolean;
  questions?: CardQuestion[];
  questionsGap?: "no-fresh-reading" | "too-large" | "invalid";
};

const submissionEnvelopeSchema = cardSubmissionSchema.extend({
  questions: z.unknown().optional(),
  input: z.unknown().optional(),
});

function readSubmission(raw: unknown): SubmissionReading {
  if (raw === undefined) return { malformed: false };
  const envelope = submissionEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { malformed: true };
  const { questions: rawQuestions, input: rawInput, ...rest } = envelope.data;
  // What pressed the button is kept only as the shell said it; an input
  // that cannot be read is left out, never a reason to doubt the rest.
  const input = cardPressInputSchema.safeParse(rawInput);
  const submission: CardSubmission = {
    ...rest,
    ...(rawInput !== undefined && input.success ? { input: input.data } : {}),
  };
  if (rawQuestions === undefined) {
    return {
      submission,
      malformed: false,
      ...(rest.questionsGap ? { questionsGap: rest.questionsGap } : {}),
    };
  }
  const questions = cardQuestionsSchema.safeParse(rawQuestions);
  if (!questions.success) return { submission, malformed: false, questionsGap: "invalid" };
  if (cardQuestionsBytes(questions.data) > CARD_QUESTIONS_MAX_BYTES) {
    return { submission, malformed: false, questionsGap: "too-large" };
  }
  return { submission, malformed: false, questions: questions.data };
}

/**
 * Whether the offer the shell said it showed is the one the core
 * dispatched. A mismatch is kept as a mismatch, never repaired with the
 * newest head.
 */
function displayOf(read: SubmissionReading, dispatched: Card): CardDisplay {
  if (read.malformed) return { fidelity: "unavailable" };
  const submission = read.submission;
  if (!submission) return { fidelity: "legacy-missing" };
  const reported = {
    ...(submission.offerId ? { reportedOfferId: submission.offerId } : {}),
    ...(submission.lifecycleId ? { reportedLifecycleId: submission.lifecycleId } : {}),
  };
  if (!submission.offerId || !dispatched.offerId) return { fidelity: "unavailable", ...reported };
  return {
    fidelity: submission.offerId === dispatched.offerId ? "matched" : "mismatched",
    ...reported,
  };
}

/** Whether the shell's submission named the offer a card dispatched, read leniently. */
export function submissionDisplay(submission: unknown, dispatched: Card): CardDisplay {
  return displayOf(readSubmission(submission), dispatched);
}
