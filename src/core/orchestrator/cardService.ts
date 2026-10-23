import { createHash, randomUUID } from "node:crypto";
import type { CardRevisionLinks } from "@shared/cards";
import {
  CARD_OBSERVATION_NOTE_MAX,
  CARD_QUESTIONS_MAX_BYTES,
  CARD_REPLY_MAX_CHARS,
  type Card,
  type CardAction,
  type CardActionSource,
  type CardAnswer,
  type CardAwaiting,
  type CardChanges,
  type CardDecisionContext,
  type CardDisplay,
  type CardMessage,
  type CardMessageWho,
  type CardObservation,
  type CardObservationActor,
  type CardObservationPayload,
  type CardObservationSource,
  type CardQuestion,
  type CardSubmission,
  type CardThread,
  type CardWidth,
  cardQuestionsBytes,
  cardQuestionsSchema,
  cardSubmissionSchema,
  cardWord,
  compareStack,
  FIRSTMATE_CARD_META,
  isPreviewBody,
  onStage,
  type PastCard,
  settleEffectOf,
  splitSettleFacts,
} from "@shared/cards";
import { NEEDS_REAUTH_CONSEQUENCE, restoreAccountEffect } from "@shared/credentialHealth";
import { HERE } from "@shared/deviceNames";
import {
  deviceForgeSignInBody,
  deviceForgeSignInCardId,
  deviceForgeSignInTitle,
} from "@shared/deviceSetup";
import type { FmEvent } from "@shared/events";
import { forgeRefusedText, forgeSignInTitle, LOCAL_PROJECTS_UNAFFECTED } from "@shared/forges";
import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import { z } from "zod";
import { parseStableCardId, resolveFirstmateCardId } from "../pi/cardTool";
import { decidedCardWidth } from "../pi/cardWidth";
import type { EmittedCardInput } from "../session/tools";
import type { CardResolution, CardStore, DuplicateResult } from "../storage/cardStore";
import { TaskService } from "../tasks/taskService";
import { cardChanges } from "./cardChanges";
import { resolveRevisionTargets, revisionLinks } from "./cardNavigation";
import { requiredActionCard } from "./requiredActionCard";
import type { SeatPauseClass } from "./seat";
import { type WakeCard, waitingCardWords } from "./wakes";

/**
 * The card stack (the primitives review's P4 and P6, docs/card-threads.md):
 * the cards on the captain's screen and every write to them. It holds the
 * open cards in memory over `CardStore` - the one place a card goes up, is
 * revised, is resolved, takes a thread message or comes down - and pushes
 * the stack and each thread to the window after every change.
 *
 * - An agent's card goes up through `addFirstmateCard` or
 *   `emitCrewmateCard`; the host's own through `put` and the named host
 *   cards. A card with actions places the captain gate on its task, and a
 *   host decision card with no task files an operation row to gate.
 * - A card leaves on the captain's answer (`resolve`), its author's
 *   withdrawal (`close`), a duplicate stamp, or its task settling
 *   (`retireTaskCards`); a card whose question is gone comes down
 *   unanswered (`takeDown`).
 *
 * The supervisor composes it and decides WHICH card and WHEN; what a card
 * decision does - a settle, a steer, a host op - stays its routing. The
 * ladder's gate, an answer task's close and a settle card's facts come in
 * through `CardServiceHost`.
 *
 * It also owns what the STAGE shows (docs/card-threads.md "When a card
 * reaches the stage"; the captain's "ship it" of 2026-09-27): a crewmate's
 * card - new, revised or answered in its thread - reaches the stage at the
 * crewmate's close-out after its last write, and a captain reply keeps a
 * card off it while his line is the newest on the thread. Every write in
 * between lands on the record and paints the thread; `snapshot()` - the
 * stage - does not move until the author closes out.
 */

type CardActor = "captain" | "firstmate" | "crewmate";

/**
 * The author whose close-out releases its cards to the stage: a crewmate by
 * its task, or the Firstmate.
 */
export type CardAuthorRef = { kind: "crewmate"; taskId: string } | { kind: "firstmate" };

/**
 * What closed the author out: a crewmate's `report` or its idle (a turn
 * end, or the task ending), the Firstmate's turn end, or a restart, which
 * ended every author's turn.
 */
export type CloseOut = "report" | "idle" | "turn-end" | "restart";

/**
 * Who owes the captain an answer on a card's thread now (docs/card-threads.md
 * "How the first mate learns"): `author` or `firstmate` while the open card's
 * current lifecycle holds for an answer (`CardStore.awaitingAuthor`), `none`
 * on an open card without that hold, `closed` once the card is resolved.
 * Never read from who wrote last: a captain message an earlier lifecycle
 * kept survives the card's resolution and reopening and owes nothing.
 */
export type ThreadOwed = "author" | "firstmate" | "none" | "closed";

/** One card whose thread moved, as the Firstmate's context section reads it. */
export type ThreadActivity = { card: Card; count: number; last: CardMessage; owed: ThreadOwed };

/** What the card stack needs from the supervisor that composes it. */
export type CardServiceHost = {
  /** The host's one clock (the ticker's). */
  now: () => number;
  tasks: TaskService;
  cardStore: CardStore;
  /** A card placed, revised or gone on a task: the ladder's captain gate follows. */
  syncCaptainGate(taskId: string, now: number): void;
  /** A card answered: a round cap it carried hears the answer. */
  noteCapAnswered(card: Card, action: string, by: CardActor, firstmateCard: boolean): void;
  /** An answer task closes on its card's resolution (Task B); whether it did. */
  closeAnsweredTask(card: Card, action: string, by: CardActor): boolean;
  /** The fact strip and the follow-ups a settle card carries (HTML fragments). */
  settleFacts(taskId: string): string | undefined;
  /** The words a settle card's merge reads now, when the host names it; undefined leaves it. */
  mergeLabel?(card: Card): string | undefined;
  followupNotice(taskId: string): string | undefined;
  broadcastCrewCounts(): void;
  broadcastEvent: (event: FmEvent) => void;
  broadcastCards: (cards: Card[]) => void;
  presentationChanged?: () => void;
  /** One card's thread, whole, after any message lands on it (phase 1). */
  broadcastThread?: (thread: CardThread) => void;
  /** The app build every observation is stamped with (docs/card-evidence.md). */
  build?: string;
};

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
};

/** Why an offer came to exist, as its observation says. */
type OfferBasis = CardObservationPayload<"offer">["basis"];
type StageCause = CardObservationPayload<"availability">["cause"];
/** How a lifecycle began, carried by its first availability. */
type Opened = {
  lifecycle: "started" | "reopened" | "legacy-initial-snapshot";
  predecessor?: string;
};

/** A decision (a card with actions) shows before a note; the host's own cards sit above both. */
function cardPriority(input: Pick<EmittedCardInput, "actions">): number {
  return input.actions.length > 0 ? 30 : 15;
}
const HOST_CARD_PRIORITY = 40;
const HOST_NOTE_PRIORITY = 25;

/** Firstmate-agent cards are id-prefixed so `CrewSupervisor.act` can route their answers. */
export const FIRSTMATE_CARD_PREFIX = "card-fm-";

/** The paused seat's cards (W1 S9): the move offer, the refusal, and the rest. */
export const FIRSTMATE_MOVE_CARD_ID = "card-fm-flagship-move";
export const FIRSTMATE_REFUSED_CARD_ID = "card-fm-refused";
export const FIRSTMATE_BENCH_CARD_ID = "card-fm-no-headroom";
export const FIRSTMATE_MOVE_BACK_CARD_ID = "card-fm-move-back";
/** The Firstmate failure card (the agent-down set): Retry, until a turn ends clean. */
export const FIRSTMATE_FAILURE_CARD_ID = "card-fm-turn-failure";
/** The failure card's title. */
export const FIRSTMATE_FAILURE_TITLE = "Your first mate hit a problem";
const FIRSTMATE_PAUSE_CARD_IDS = [
  FIRSTMATE_MOVE_CARD_ID,
  FIRSTMATE_REFUSED_CARD_ID,
  FIRSTMATE_BENCH_CARD_ID,
] as const;

/** A paused seat's card, as the Firstmate agent asks for it. */
export type FirstmatePauseCard = {
  pause: SeatPauseClass;
  /** What stopped the seat and what happens now, in the user's words. */
  body: string;
  /** The paused account, for its way back (sign in again, try again). */
  accountId?: string;
  /** The paused account's provider, by name. */
  providerName: string;
  /** Rung 2: where the seat could move, asked on the card. */
  move?: { providerId: string; providerName: string };
  /** A spent allowance is being read again: no second recheck is offered. */
  checking?: boolean;
};

/** The spent-allowance card's way back: read the allowance again. */
export const RECHECK_ALLOWANCE_LABEL = "Recheck allowance";

/** A crewmate's sign-in card's title, and the Firstmate's own on a 401. */
export const PROVIDER_SIGN_IN_TITLE = "A provider needs sign in";

/** A move's button: a paused seat's names a provider, a crewmate's sign-in card the model. */
export function moveLabel(to: string): string {
  return `Move to ${to}`;
}

/** A paused seat's card title: what stopped it, never how. */
export function firstmatePauseTitle(pause: SeatPauseClass, providerName: string): string {
  switch (pause) {
    case "no_headroom":
      return "Your first mate has used up its allowance";
    case "signed_out":
      return "Your first mate needs you to sign in again";
    case "refused":
      return `${providerName} is not answering your first mate right now`;
    case "client":
      return `Your first mate cannot run on ${HERE.this} right now`;
    case "unavailable":
      return "Your first mate needs an account";
  }
}

export class CardService {
  /** The open cards as their authors last wrote them: the record. */
  private readonly cards = new Map<string, Card>();
  /**
   * The version the stage still shows of a card on it whose author has
   * written it again and not yet closed out (a revision waiting on its
   * author's turn end). Memory only: a restart closes every author out.
   */
  private readonly staged = new Map<string, Card>();
  /**
   * Cards the captain put aside that their crewmate has since written on,
   * by card, with the lifecycle written on (INF-926): the head no longer
   * says aside, so the card comes back, but the stage keeps it aside until
   * that crewmate's turn ends. Memory only: a restart closes every author
   * out, and the card comes back with it.
   */
  private readonly asideUntilTurnEnd = new Map<string, string>();
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
  /** The newest `sentBackAt` handed out: stamps stay distinct inside one millisecond. */
  private lastSentBack = 0;
  /**
   * Crewmate cards the captain closed while they waited on the answer to his
   * reply, by card id, with the task whose crewmate owes it: that answer, a
   * revision under the same id, would open the card again, so it is refused
   * until the crewmate closes out. Memory only: a restart closes everyone out.
   */
  private readonly closedAwaitingAnswer = new Map<string, string>();
  private presentation = "";
  private readonly threadOffers = new Map<string, string | undefined>();
  private cardSeq = 0;
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribeTasks: () => void;

  constructor(private readonly host: CardServiceHost) {
    host.cardStore.markCaptureEpoch(host.now(), host.build);
    // Unresolved cards survive restarts (D-9). Migration 73 has retired
    // their keep-open actions and streaming state. A card with a lifecycle
    // resumes it; one written before the capture is seeded as a snapshot
    // whose start is unknown, never given a history it did not have.
    for (const card of host.cardStore.listOpen()) {
      const ready = card;
      if (ready.lifecycleId && ready.offerId) {
        this.cards.set(ready.id, ready);
        continue;
      }
      const seeded: Card = { ...ready, lifecycleId: randomUUID(), offerId: randomUUID() };
      host.cardStore.transaction(() => {
        host.cardStore.upsert(seeded);
        this.noteOffer(seeded, "legacy-initial-snapshot", "restore");
        this.noteStage({ head: seeded, shown: seeded }, "restore", {
          source: "restore",
          opened: { lifecycle: "legacy-initial-snapshot" },
        });
      });
      this.cards.set(seeded.id, seeded);
    }
    // The dead process ended every author's turn, which is a close-out: a
    // card that waited on one reaches the stage now. One the captain's
    // reply holds stays off it until its author answers.
    for (const card of [...this.cards.values()]) {
      if (card.awaiting === "close-out") this.release(card, "restart");
      if (card.awaiting !== "answer" && card.lifecycleId)
        host.cardStore.releaseRevisions(card.id, card.lifecycleId);
    }
    this.refreshSettleFacts();
    this.unsubscribeTasks = host.tasks.onChange(({ taskIds }) => this.refreshSettleFacts(taskIds));
    if (this.cards.size > 0) this.scheduleBroadcast();
  }

  dispose(): void {
    this.unsubscribeTasks();
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = undefined;
  }

  /**
   * Host facts follow the record, not an author's revision or close-out:
   * the fact strip, and the words of the merge it names (INF-23).
   */
  refreshSettleFacts(taskIds?: readonly string[]): void {
    let changed = false;
    const relabeled = (card: Card): Card => {
      const label = this.host.mergeLabel?.(card);
      const merges = (action: Card["actions"][number]) =>
        action.effect?.kind === "settle" && action.effect.mode === "merge";
      if (!label || !card.actions.some((action) => merges(action) && action.label !== label))
        return card;
      return {
        ...card,
        actions: card.actions.map((action) => (merges(action) ? { ...action, label } : action)),
      };
    };
    const refreshed = (card: Card): Card => {
      if (!card.taskId || (taskIds && !taskIds.includes(card.taskId))) return card;
      if (!card.reviewTaskId && !card.actions.some((action) => action.effect?.kind === "settle"))
        return card;
      const facts = this.host.settleFacts(card.taskId);
      const split = facts ? splitSettleFacts(card.body) : undefined;
      if (!facts || !split) return relabeled(card);
      const body = split.body.slice(0, split.at) + facts + split.body.slice(split.at);
      return relabeled(body === card.body ? card : { ...card, body });
    };
    for (const [id, card] of this.cards) {
      const next = refreshed(card);
      if (next !== card) {
        this.cards.set(id, next);
        this.host.cardStore.upsert(next);
        changed = true;
      }
      const staged = this.staged.get(id);
      if (staged) {
        const nextStage = refreshed(staged);
        if (nextStage !== staged) {
          this.staged.set(id, nextStage);
          changed = true;
        }
      }
    }
    if (changed) this.scheduleBroadcast();
  }

  /** The open card under an id. */
  get(id: string): Card | undefined {
    return this.cards.get(id);
  }

  /** The cards on the stack now. */
  values(): IterableIterator<Card> {
    return this.cards.values();
  }

  /** A card's row, open or resolved. */
  stored(id: string): Card | undefined {
    return this.host.cardStore.get(id);
  }

  /** The action that resolved a card, while it stays resolved (`CardStore.chosenAction`). */
  chosenAction(id: string): string | undefined {
    return this.host.cardStore.chosenAction(id);
  }

  /** A task's newest card, open or resolved. */
  newestForTask(taskId: string): Card | undefined {
    return this.host.cardStore.newestForTask(taskId);
  }

  /** The crewmate's card the captain answered, never a merge decision: what a basis answered. */
  newestAnswerForTask(taskId: string): Card | undefined {
    return this.host.cardStore.newestAnswerForTask(taskId);
  }

  /** A card's thread messages, oldest first. */
  messages(cardId: string): CardMessage[] {
    return this.host.cardStore.messages(cardId);
  }

  /** Whether a task's crewmate has emitted its completion card. */
  hasCompletionCard(taskId: string): boolean {
    return this.host.cardStore.hasCompletionCard(taskId);
  }

  /**
   * A card emitted by a crewmate through its emit_card tool (D-9, Q3), once
   * the supervisor's holds, completion actions, lint and CI gate passed it.
   * `place` is where its task runs when that is a computer that runs work.
   */
  emitCrewmateCard(
    taskId: string,
    input: EmittedCardInput,
    meta: string,
    model?: string,
    place?: string,
  ): string {
    return this.upsertEmitted(input, {
      taskId,
      author: "crewmate",
      meta,
      ...(model ? { model } : {}),
      ...(place ? { place } : {}),
      mintId: () => {
        this.cardSeq += 1;
        return `card-${taskId}-${this.cardSeq}`;
      },
      resolveId: (stableId) => crewmateCardId(taskId, stableId),
    });
  }

  /**
   * The open completion card a crewmate's emit would revise in place: the
   * card its declared id names on this task's stack, still carrying a merge.
   * Undefined for a new card, another task's card or one already answered.
   */
  openCompletionCard(taskId: string, declaredId: string | undefined): Card | undefined {
    let stableId: string | undefined;
    try {
      stableId = parseStableCardId(declaredId);
    } catch {
      return undefined;
    }
    if (!stableId) return undefined;
    const card = this.cards.get(crewmateCardId(taskId, stableId));
    if (card?.taskId !== taskId || card.author !== "crewmate") return undefined;
    return card.actions.some((action) => settleEffectOf(action)?.mode === "merge")
      ? card
      : undefined;
  }

  /**
   * A card was answered: a Chrome choice (`action` is its id, the row's
   * resolution too), a script action (`script:<id>` on the row, not a captain
   * resolution), or the Chrome close (resolution `close`, action `dismissed`).
   * The card leaves the stack before any work its choice starts; returns
   * whether its answer task closed on it (Task B). The
   * answers to the body's own questions, when the click carried any, go on
   * the row and the task's `card_resolved` event with the choice.
   */
  resolve(
    card: Card,
    resolution: string,
    action: string,
    answers?: CardAnswer[],
    by: "captain" | "firstmate" | "crewmate" = "captain",
    evidence?: CardInteractionEvidence,
    alongside?: () => void,
  ): boolean {
    // The row and the action it records commit together, before the stack
    // moves: a choice that could not be kept is never shown as made. What
    // the choice grants (`alongside`: a merge approval, FI3-304) commits in
    // the same transaction.
    this.host.cardStore.transaction(() => {
      // A script-fired action may close a card, but it is not a captain
      // resolution in the next context block or a replayed human click.
      this.host.cardStore.resolve(
        card.id,
        by === "captain" ? resolution : `script:${resolution}`,
        answers,
      );
      this.noteAction(card, action, { closes: true, answers, by, evidence });
      alongside?.();
    });
    this.cards.delete(card.id);
    this.staged.delete(card.id);
    const closedAnswer = this.recordResolution(card, action, by, answers);
    this.scheduleBroadcast();
    return closedAnswer;
  }

  /**
   * The captain's close control: the card leaves the stack without a
   * declared action. Its row resolves `close`, and the record says it was a
   * dismissal of the offer he was looking at, never a choice.
   */
  dismiss(card: Card, submission?: unknown): void {
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(card.id, "close");
      if (card.taskId && this.host.tasks.get(card.taskId)?.delivery?.captainAction)
        this.host.tasks.deferCaptainAction(card.taskId);
      this.noteExit(card, "captain", "close-control", {
        reason: "dismissed",
        display: displayOf(readSubmission(submission), card),
      });
    });
    // A kept card he replied under stays closed through the answer its
    // crewmate is still writing (docs/card-threads.md "The record").
    const head = this.cards.get(card.id);
    if (
      head?.author === "crewmate" &&
      head.taskId &&
      head.awaiting &&
      head.sentBackAt !== undefined
    ) {
      this.closedAwaitingAnswer.set(card.id, head.taskId);
    }
    this.cards.delete(card.id);
    this.staged.delete(card.id);
    this.recordResolution(card, "dismissed", "captain");
    this.scheduleBroadcast();
  }

  /** A task that never started leaves no card rows behind. */
  deleteRowsForTask(taskId: string): void {
    this.host.cardStore.deleteForTask(taskId);
  }

  /**
   * The purge's share for cards with no task of their own: the evidence of
   * each one no longer on the stack goes with the row that stood for it.
   */
  purgeEvidence(cardIds: readonly string[]): void {
    this.host.cardStore.deleteEvidenceFor(cardIds.filter((id) => !this.cards.has(id)));
  }

  /** The purge (D-13): a task's card rows and its cards on the stack go. */
  purgeTask(taskId: string): void {
    this.host.cardStore.deleteForTask(taskId);
    for (const [cardId, card] of this.cards) {
      if (card.taskId !== taskId) continue;
      this.cards.delete(cardId);
      this.staged.delete(cardId);
    }
    this.scheduleBroadcast();
  }

  /**
   * The cards a crewmate has on the captain's screen, as its report wake
   * names them (WI-12): the fact the Firstmate's steer-not-answer rule
   * turns on. The rule itself lives in its prompt (contract v2.0: a wake
   * carries facts, never a restatement of policy).
   */
  shownCards(taskId: string): WakeCard[] {
    return [...this.cards.values()]
      .filter((card) => card.taskId === taskId && cardEmitter(card.id, taskId) === "crewmate")
      .map((card) => ({ id: card.id, word: cardWord(card), title: card.title }));
  }

  /**
   * The cards on the captain's screen about a task, oldest first: what
   * supervision needs to tell "waiting on the captain's choice" from a stall
   * (WI-6). Read-only.
   */
  openCardsFor(taskId: string): Pick<Card, "id" | "title" | "actions" | "createdAt">[] {
    return [...this.cards.values()]
      .filter((card) => card.taskId === taskId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, title, actions, createdAt }) => ({ id, title, actions, createdAt }));
  }

  /**
   * A task's open cards with what an emitter needs to revise one in place
   * or decide a card is distinct (interaction P1, WI-8 and WI-12): body and
   * actions, oldest first, and who emitted it. Read-only.
   */
  openCardDigests(taskId: string): Array<
    Pick<Card, "id" | "title" | "body" | "actions" | "createdAt"> & {
      emitter: "firstmate" | "crewmate" | "host";
    }
  > {
    return [...this.cards.values()]
      .filter((card) => card.taskId === taskId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, title, body, actions, createdAt }) => ({
        id,
        title,
        body,
        actions,
        createdAt,
        emitter: cardEmitter(id, taskId),
      }));
  }

  /**
   * The stage: every open card as the stage shows it - the version on it
   * while its author's newer write waits on a close-out, and a card still
   * waiting on its author carrying what it waits on (`awaiting`), so the
   * window, the notifier, Observe and the tests all read one fact. A card
   * the captain kept shown after a reply sorts after new arrivals (`compareStack`).
   */
  snapshot(): Card[] {
    for (const id of this.changes.keys()) {
      if (!this.cards.has(id)) this.changes.delete(id);
    }
    for (const [id, lifecycleId] of this.asideUntilTurnEnd) {
      if (this.cards.get(id)?.lifecycleId !== lifecycleId) this.asideUntilTurnEnd.delete(id);
    }
    return [...this.cards.values()]
      .map((card) => {
        const shown = this.withChanges(this.onTheStage(card));
        const task = shown.taskId ? this.host.tasks.get(shown.taskId) : undefined;
        return shown.author === "firstmate" && task ? { ...shown, meta: task.title } : shown;
      })
      .sort(compareStack);
  }

  /**
   * The version on the stage with what changed in it since the captain last
   * saw the card (docs/card-authoring.md "What changed since you looked"):
   * compared with the newest version the window reported seen on this
   * lifecycle, so revisions that landed unseen accumulate, and a card never
   * seen before it changed carries nothing.
   */
  private withChanges(shown: Card): Card {
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
  private changesSinceSeen(
    shown: Card,
    lifecycleId: string,
    offerId: string,
  ): CardChanges | undefined {
    const store = this.host.cardStore;
    const seenId = store.lastSeenOffer(shown.id, lifecycleId, offerId);
    const seen = seenId ? store.offer(shown.id, seenId) : undefined;
    if (!seen) return undefined;
    return cardChanges(seen.payload, shown, store.offer(shown.id, offerId)?.at ?? shown.createdAt);
  }

  /**
   * What the stage will mark when the card's newest write reaches it: the
   * same comparison `withChanges` makes, on the head rather than the version
   * on the stage. It tells a crewmate author what its revision did; undefined
   * for a card the captain has not seen or a write that changed nothing.
   * Previews carry no marks, and the notice says so by `preview`.
   */
  revisionChanges(cardId: string): (CardChanges & { preview: boolean }) | undefined {
    const head = this.cards.get(cardId);
    if (!head?.lifecycleId || !head.offerId) return undefined;
    const changes = this.changesSinceSeen(head, head.lifecycleId, head.offerId);
    return changes && { ...changes, preview: isPreviewBody(head.body) };
  }

  /**
   * The window had a card's version in front of the captain: on the stage,
   * the window visible and focused. Recorded once per offer as its `seen`
   * observation - what the card's next revision is compared with. A report
   * about a version the stage no longer shows is stale and changes nothing.
   */
  seen(cardId: string, offerId: string): void {
    const card = this.cards.get(cardId);
    const shown = card && this.onTheStage(card);
    if (!shown?.lifecycleId || shown.offerId !== offerId || !onStage(shown)) return;
    const store = this.host.cardStore;
    if (store.lastSeenOffer(cardId, shown.lifecycleId) === offerId) return;
    store.observe({
      id: randomUUID(),
      kind: "seen",
      cardId,
      lifecycleId: shown.lifecycleId,
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
   * The card as the stage shows it: the version on it while a newer write
   * waits, under the head's own hold (what it awaits, where it was sent),
   * and still aside while its author's answer to that waits on its turn end.
   */
  private onTheStage(card: Card): Card {
    const aside = !card.minimized && this.heldAside(card);
    const version = this.staged.get(card.id);
    if (!version) return aside ? { ...card, minimized: true } : card;
    const {
      awaiting: _awaiting,
      sentBackAt: _sentBackAt,
      minimized: _minimized,
      ...shown
    } = version;
    return {
      ...shown,
      ...(card.minimized || aside ? { minimized: true as const } : {}),
      ...(card.awaiting ? { awaiting: card.awaiting } : {}),
      ...(card.sentBackAt !== undefined ? { sentBackAt: card.sentBackAt } : {}),
    };
  }

  /** Whether the stage keeps a card aside until its author's turn ends (`asideUntilTurnEnd`). */
  private heldAside(card: Card): boolean {
    return (
      card.lifecycleId !== undefined && this.asideUntilTurnEnd.get(card.id) === card.lifecycleId
    );
  }

  /**
   * The version of an open card the captain is looking at: the stage's,
   * which is what a click on it chose from.
   */
  shown(id: string): Card | undefined {
    const card = this.cards.get(id);
    return card && this.onTheStage(card);
  }

  /**
   * A task's newest card body (Task B): what a `tasks` fetch by key hands
   * back, and the way the Firstmate reads an investigation's answer without
   * a second store of its own. An answer task's card IS its deliverable.
   */
  newestBody(taskId: string): string | undefined {
    return this.host.cardStore.newestForTask(taskId)?.body;
  }

  /**
   * A card emitted by the Firstmate agent - its only user-facing output
   * channel (report section 4a). Decision answers route back to the agent
   * as [fm-op] messages through `CrewSupervisor.act`.
   */
  addFirstmateCard(input: EmittedCardInput): string {
    return this.upsertEmitted(input, {
      ...(input.taskId ? { taskId: input.taskId } : {}),
      author: "firstmate",
      meta:
        (input.taskId ? this.host.tasks.get(input.taskId)?.title : undefined) ??
        FIRSTMATE_CARD_META,
      mintId: () => {
        this.cardSeq += 1;
        return `${FIRSTMATE_CARD_PREFIX}${this.cardSeq}-${randomUUID().slice(0, 6)}`;
      },
      resolveId: resolveFirstmateCardId,
    });
  }

  /**
   * A host-presented Firstmate note with its completed answer and caller's
   * durable record in the same commit. No model turn or close-out hold.
   * The stack changes only after all writers have committed successfully.
   * `onTop` places it above every card on the stack now, where a note
   * otherwise sorts behind every decision and every older note. The host
   * may also present it as taking no reply, or at the width its body was
   * drawn for (the welcome: its picture is the regular card's width).
   */
  addRecordedFirstmateNote(
    input: Pick<EmittedCardInput, "title" | "body" | "pictures"> & {
      /** What the record keeps as its answer when the body is more than words (the welcome). */
      answer?: string;
    },
    record: (cardId: string) => void,
    presentation: { onTop?: boolean; replies?: false; width?: CardWidth } = {},
  ): string {
    const id = `${FIRSTMATE_CARD_PREFIX}${randomUUID()}`;
    const emitted = buildEmittedCard(
      id,
      {
        title: input.title,
        body: input.body,
        actions: [],
        ...(input.pictures ? { pictures: input.pictures } : {}),
      },
      { author: "firstmate", meta: FIRSTMATE_CARD_META },
      this.host.now(),
    );
    // How the host presents it: the welcome takes no reply and keeps the
    // regular width its picture was drawn for.
    const built = {
      ...emitted,
      ...(presentation.replies === false ? { replies: false as const } : {}),
      ...(presentation.width ? { width: presentation.width } : {}),
    };
    const { card, opened } = this.stamp(
      presentation.onTop ? { ...built, priority: this.topPriority(built.priority) } : built,
    );
    return this.host.tasks.atomic(
      () => {
        this.host.cardStore.upsert(card);
        this.noteOffer(card, "emitted", "host");
        this.noteStage({ head: card, shown: card }, "emit", {
          source: "host",
          ...(opened ? { opened } : {}),
        });
        this.host.tasks.fileQuestion({
          id: randomUUID().slice(0, 8),
          title: input.title,
          outcome: input.answer ?? input.body,
          cardId: id,
        });
        record(id);
        return id;
      },
      () => {
        this.cards.set(id, card);
        this.placed(card);
        // The note is in the same published ready state, not waiting on the
        // ordinary buffered card broadcast (or any model work).
        this.broadcastSnapshot();
      },
    );
  }

  /**
   * Create or revise an agent-emitted card. A still-open card with the same
   * stable id is updated in place (same stack position); otherwise a new
   * card is minted.
   */
  private upsertEmitted(
    raw: EmittedCardInput,
    context: {
      taskId?: string;
      author: "crewmate" | "firstmate";
      meta: string;
      model?: string;
      place?: string;
      mintId: () => string;
      resolveId: (stableId: string) => string;
    },
  ): string {
    let input = raw;
    // The two structural checks every emit boundary holds (P1): the host's
    // own effect is no agent's to declare, and a settle effect must know
    // its task or the button can settle nothing. Each lint already refuses
    // both with corrective text; this is the last line behind them.
    const hostEffect = input.actions.find((action) => action.effect?.kind === "host");
    if (hostEffect) {
      throw new Error(
        `Action "${hostEffect.id}" carries a host effect, which only the app's own cards may.`,
      );
    }
    // A kept write is its crewmate's to ask about, on its own task (FI3-1571 piece 4).
    const write = input.actions.find((action) => action.effect?.kind === "request_write");
    if (write && (context.author !== "crewmate" || !context.taskId)) {
      throw new Error(
        `Action "${write.id}" asks to send a crewmate's write, which only that crewmate's card may.`,
      );
    }
    const settle = input.actions.find((action) => settleEffectOf(action));
    if (settle && !context.taskId) {
      throw new Error(
        `Action "${settle.id}" carries a settle effect, so the card must pass task_id; without it the host cannot tell which task to settle and the button does nothing.`,
      );
    }
    // The click refuses every choice on a closed task's card
    // (`CrewSupervisor.act`), so a card with actions on one never goes up.
    const task = context.taskId ? this.host.tasks.get(context.taskId) : undefined;
    if (task && input.actions.length > 0 && TaskService.isClosed(task)) {
      throw new Error(
        `Task ${task.id} is closed, so a choice on a card about it cannot be taken; a card with actions needs an open task.`,
      );
    }
    if (input.reviewTaskId) {
      const review = this.host.tasks.resolve(input.reviewTaskId);
      if (
        context.author !== "firstmate" ||
        !task ||
        review?.shape?.kind !== "review" ||
        review.shape.kind_source !== "host:review" ||
        review.parentId !== task.id
      ) {
        throw new Error(
          "Card refused: review_task_id must name an independent review of task_id. The card is unchanged.",
        );
      }
      input = { ...input, reviewTaskId: review.id };
    }
    // A settle card carries the facts the host holds about its task -
    // project, crewmate model, posture, PR link, CI state (contract v2.0,
    // captain ruling D4; the fact strip at v2.7) - on add and on every
    // in-place revision, so no prompt asks an agent to write them.
    if (
      context.taskId &&
      (input.reviewTaskId || input.actions.some((action) => settleEffectOf(action)))
    ) {
      const facts = this.host.settleFacts(context.taskId);
      if (facts) input = { ...input, body: `${input.body}${facts}` };
    }
    // A settle card says what the crew filed under this task's name
    // (captain, 2026-09-14). Deciding whether to land is the one moment
    // those follow-ups bear on the captain's choice, so they are named
    // here rather than met later as a refusal.
    if (
      context.taskId &&
      input.actions.some((action) => settleEffectOf(action)?.mode === "merge")
    ) {
      const notice = this.host.followupNotice(context.taskId);
      if (notice) input = { ...input, body: `${input.body}${notice}` };
    }
    let stableId: string | undefined;
    try {
      stableId = parseStableCardId(input.id);
    } catch {
      stableId = undefined;
    }
    const resolved = stableId ? context.resolveId(stableId) : undefined;
    const existing = resolved ? this.cards.get(resolved) : undefined;
    const owner =
      existing?.taskId ?? (resolved ? this.host.cardStore.get(resolved)?.taskId : undefined);
    if ([owner, input.taskId].some((id) => id && this.host.tasks.get(id)?.delivery?.captainAction))
      throw new Error(
        "This required-action card keeps its app-owned instructions and confirmation. Use reply for help, update_task drop with a reason to cancel, or revise the declaration on its source card.",
      );
    if (!existing && resolved && this.closedAwaitingAnswer.has(resolved)) {
      throw new Error(
        `Card refused: the captain closed card "${resolved}" while it waited on your answer to their reply, so that answer does not open it again. Give the answer in your report instead.`,
      );
    }
    if (existing && resolved) {
      // An update is never the whole answer: while the captain's reply waits
      // on its author, the revision carries the author's short answer too.
      const answer = input.reply?.trim();
      const waiting = this.host.cardStore.awaitingAuthor(resolved);
      if (waiting) {
        if (!answer) {
          throw new Error(
            `Card refused: the captain's reply under card "${resolved}" waits on your answer, and a revision alone does not give it. Call emit_card again with the same id and the same card plus reply: one to three sentences answering them and saying what changed. The card and its thread are unchanged.`,
          );
        }
        if (answer.length > CARD_REPLY_MAX_CHARS) {
          throw new Error(
            `Card refused: reply is at most ${CARD_REPLY_MAX_CHARS} characters; say it shorter. The card and its thread are unchanged.`,
          );
        }
      }
      const revised = buildEmittedCard(resolved, input, context, existing.createdAt);
      const changed =
        existing.title !== revised.title ||
        existing.body !== revised.body ||
        JSON.stringify(existing.actions) !== JSON.stringify(revised.actions) ||
        JSON.stringify(existing.attachment) !== JSON.stringify(revised.attachment) ||
        JSON.stringify(existing.risk) !== JSON.stringify(revised.risk) ||
        JSON.stringify(existing.requiredActions) !== JSON.stringify(revised.requiredActions);
      // A card off the stage stays off it; one on it keeps showing what it
      // showed until its crewmate author's turn ends (the one rule), and so
      // does one still waiting on its author after the captain's reply,
      // whoever its author is. The Firstmate's own revision of any other
      // card on the stage redraws at once.
      const { card: updated, offer } = this.stamp({
        ...revised,
        ...(existing.awaiting ? { awaiting: existing.awaiting } : {}),
        ...(existing.sentBackAt !== undefined ? { sentBackAt: existing.sentBackAt } : {}),
      });
      const staged =
        this.staged.get(resolved) ??
        (onStage(existing) && (context.author === "crewmate" || existing.awaiting !== undefined)
          ? existing
          : undefined);
      this.host.cardStore.transaction(() => {
        // Revise in place keeps the replaced version as the card's history (WI-12).
        this.host.cardStore.revise(updated);
        if (offer) this.noteOffer(updated, "emitted", "tool");
        this.noteStage({ head: updated, shown: staged ?? updated }, "revise", {
          source: "tool",
        });
      });
      if (staged) this.staged.set(resolved, staged);
      this.cards.set(resolved, updated);
      // A crewmate's revision of a card the captain put aside brings it back
      // when that crewmate's turn ends, never mid-turn (INF-926).
      if (existing.minimized && context.author === "crewmate" && updated.lifecycleId)
        this.asideUntilTurnEnd.set(resolved, updated.lifecycleId);
      this.placed(updated);
      // The preferred answer to a thread message is a revision of the head
      // (cards-as-threads phase 1): the card re-renders above, and the
      // thread says so in one host line, so a small change is never
      // invisible - the captain's own "it's not clear where the update is".
      if (changed && this.host.cardStore.messages(resolved).length > 0) {
        this.addMessage(
          resolved,
          "host",
          `revised: ${updated.title}`,
          undefined,
          undefined,
          revisionLinks(existing, updated),
        );
      }
      if (answer && waiting) {
        this.addMessage(resolved, context.author, answer);
      }
      this.scheduleBroadcast();
      return resolved;
    }
    // A reply rides a revision of the card the captain wrote under. A new
    // card carrying one would drop it and leave that card waiting on an
    // answer nobody gives (INF-990 friction 4), so it names that card.
    const waiting =
      input.reply?.trim() && context.author === "crewmate" && context.taskId
        ? this.threadsAwaitingAuthor(context.taskId)
        : [];
    if (waiting.length > 0) {
      throw new Error(
        `Card refused: reply answers the captain's reply under ${waitingCardWords(waiting)}, and ${stableId ? `id "${stableId}" names a new card` : "a card without that card's id is a new card"}, so that answer would be lost. Revise that card under its own id with reply, or answer it with reply(card_id, text) and emit this card without reply. Nothing was shown.`,
      );
    }
    const id = resolved && !this.cards.has(resolved) ? resolved : context.mintId();
    const built = buildEmittedCard(id, input, context, this.host.now());
    // A crewmate's new card waits for its close-out, and lands on its
    // task's timeline (P1) when it reaches the stage (`release`). The
    // Firstmate's own cards go up at once - its emits end a short turn -
    // and are recorded by the agent at its emit_card boundary, where it
    // also knows which task a task-less card files.
    const { card, opened } = this.stamp(
      context.author === "crewmate" ? { ...built, awaiting: "close-out" } : built,
    );
    this.host.cardStore.transaction(() => {
      if (opened?.lifecycle === "reopened") this.host.cardStore.reopen(id);
      this.host.cardStore.upsert(card);
      this.noteOffer(card, "emitted", "tool");
      this.noteStage({ head: card, shown: card }, "emit", {
        source: "tool",
        ...(opened ? { opened } : {}),
      });
    });
    this.cards.set(id, card);
    this.staged.delete(id);
    this.placed(card);
    this.scheduleBroadcast();
    return id;
  }

  /**
   * The lifecycle and offer a card write carries (docs/card-evidence.md). An
   * open card keeps its lifecycle, and its offer while nothing it shows has
   * changed; a card not on the stack starts a lifecycle - a reopen when its
   * row already exists, linked to the one before.
   */
  private stamp(next: Card): { card: Card; offer: boolean; opened?: Opened } {
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

  /** An offer, whole and immutable: its observation id is its offer id. */
  private noteOffer(card: Card, basis: OfferBasis, source: CardObservationSource): void {
    const { lifecycleId, offerId } = card;
    if (!lifecycleId || !offerId) return;
    this.host.cardStore.observe({
      id: offerId,
      kind: "offer",
      cardId: card.id,
      lifecycleId,
      taskId: card.taskId,
      at: this.host.now(),
      actor: basis === "emitted" ? authorActor(card) : "host",
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
        actions: card.actions,
        ...(card.pictures?.length ? { pictures: card.pictures } : {}),
        ...(card.width ? { width: card.width } : {}),
        ...(card.attachment ? { attachment: card.attachment } : {}),
        ...(card.risk ? { risk: card.risk } : {}),
        ...(card.requiredActions !== undefined ? { requiredActions: card.requiredActions } : {}),
        ...(card.asking ? { asking: true as const } : {}),
        ...(card.designOnly ? { designOnly: true as const } : {}),
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
  private noteStage(
    view: { head: Card; shown: Card },
    cause: StageCause,
    options: {
      source: CardObservationSource;
      actor?: CardObservationActor;
      closeOut?: CloseOut;
      opened?: Opened;
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
      if (last && last.state === fact.state && last.waitingOn === fact.waitingOn && !opened) {
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
        actor: options.actor ?? (options.source === "tool" ? authorActor(head) : "host"),
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
  private noteAction(
    shown: Card,
    actionId: string,
    input: {
      closes: boolean;
      answers?: CardAnswer[] | undefined;
      by: "captain" | "firstmate" | "crewmate";
      evidence?: CardInteractionEvidence | undefined;
    },
  ): void {
    const { lifecycleId, offerId } = shown;
    if (!lifecycleId || !offerId) return;
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
    this.host.cardStore.observe({
      id: randomUUID(),
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
      },
    });
  }

  /** How a lifecycle ended without a declared action. */
  private noteExit(
    card: Card,
    actor: CardObservationActor,
    source: CardObservationSource,
    payload: CardObservationPayload<"exit">,
  ): void {
    const { lifecycleId, offerId } = card;
    if (!lifecycleId) return;
    this.host.cardStore.observe({
      id: randomUUID(),
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
        ...(payload.note ? { note: payload.note.slice(0, CARD_OBSERVATION_NOTE_MAX) } : {}),
      },
    });
  }

  /**
   * An author closed out (docs/card-threads.md "When a card reaches the
   * stage"): a crewmate's `report` or its idle, the Firstmate's turn end.
   * Each of its cards that waited on it reaches the stage - a card off it
   * comes up, one on it redraws in place with the newer write, one put
   * aside that its author wrote on comes back - and a card the captain's
   * reply holds stays off it. A report releases only a crewmate's new
   * cards: one the captain already had on the stage waits for its turn's
   * end, so it comes back once, with the crewmate's last word (INF-926).
   */
  closeOut(author: CardAuthorRef, reason: CloseOut): void {
    if (author.kind === "crewmate") {
      for (const [id, taskId] of this.closedAwaitingAnswer) {
        if (taskId === author.taskId) this.closedAwaitingAnswer.delete(id);
      }
    }
    let moved = false;
    const released: string[] = [];
    for (const card of [...this.cards.values()]) {
      const mine =
        author.kind === "firstmate"
          ? this.firstmateAnswers(card)
          : card.author === "crewmate" && card.taskId === author.taskId;
      if (!mine) continue;
      if (reason === "report" && this.reachedStage(card)) continue;
      if (this.asideUntilTurnEnd.delete(card.id)) moved = true;
      if (card.awaiting !== "answer" && card.lifecycleId) {
        if (this.host.cardStore.releaseRevisions(card.id, card.lifecycleId)) {
          moved = true;
          released.push(card.id);
        }
      }
      const staged = this.staged.has(card.id);
      if (card.awaiting === "close-out") this.release(card, reason);
      else if (card.awaiting === "answer") continue;
      else if (staged) {
        // The stage moves from the version it held to the author's newest.
        this.host.cardStore.transaction(() =>
          this.noteStage({ head: card, shown: card }, "close-out", {
            source: "host",
            closeOut: reason,
          }),
        );
      } else continue;
      this.staged.delete(card.id);
      moved = true;
    }
    if (moved) {
      this.scheduleBroadcast();
      for (const id of released) this.host.broadcastThread?.(this.thread(id));
    }
  }

  /** Whether the stage has shown the captain this lifecycle of a card. */
  private reachedStage(card: Card): boolean {
    return (
      card.lifecycleId !== undefined &&
      this.host.cardStore.lastAvailableOffer(card.id, card.lifecycleId) !== undefined
    );
  }

  /**
   * A card off the stage reaches it. A crewmate's card records the moment
   * and the close-out that released it on its task's timeline: its first
   * arrival is the `card_raised` it always was, and a return after the
   * captain's reply says so, so the replay can count a late return.
   */
  private release(card: Card, reason: CloseOut): void {
    const { awaiting: _awaiting, sentBackAt: _sentBackAt, ...shown } = card;
    this.host.cardStore.transaction(() => {
      this.host.cardStore.upsert(shown);
      this.noteStage({ head: shown, shown }, "close-out", { source: "host", closeOut: reason });
    });
    this.cards.set(card.id, shown);
    if (card.author !== "crewmate" || !card.taskId) return;
    const returned = this.host.cardStore
      .messages(card.id)
      .some((message) => message.who === "captain");
    this.host.tasks.recordCardRaised(card.taskId, {
      cardId: card.id,
      kind: cardWord(card),
      title: card.title,
      actor: "crewmate",
      closeOut: reason,
      ...(returned ? { returned } : {}),
    });
  }

  /**
   * Hold a card, waiting on `awaiting`. A captain's reply (`answer`) takes it
   * off the stack unless the view kept it shown at send time. Kept replies
   * carry `sentBackAt`, as do legacy waiting cards, until close-out. The write runs in the
   * caller's transaction; the stack moves once it committed (`applyHold`).
   */
  private writeHold(
    id: string,
    awaiting: CardAwaiting,
    by: { actor: CardObservationActor; source: CardObservationSource },
    leavesStack = false,
  ): Card | undefined {
    const card = this.cards.get(id);
    // A second reply settles its send-time visibility again; any other
    // repeat of a hold changes nothing.
    if (!card || (card.awaiting === awaiting && awaiting !== "answer")) return undefined;
    const { sentBackAt, ...rest } = card;
    const held: Card = {
      ...rest,
      awaiting,
      ...(awaiting === "answer"
        ? !leavesStack || card.holdsPlace
          ? { sentBackAt: this.sentBackStamp() }
          : {}
        : sentBackAt !== undefined
          ? { sentBackAt }
          : {}),
    };
    this.host.cardStore.upsert(held);
    this.noteStage({ head: held, shown: held }, awaiting === "answer" ? "reply" : "answered", by);
    return held;
  }

  /** A reply's place at the back: after every stamp so far, even in one millisecond. */
  private sentBackStamp(): number {
    const stamp = Math.max(this.host.now(), this.lastSentBack + 1);
    this.lastSentBack = stamp;
    return stamp;
  }

  private applyHold(id: string, held: Card | undefined): void {
    if (!held) return;
    this.cards.set(id, held);
    this.scheduleBroadcast();
    // The window marks a replied-under card news when it sees the wait end,
    // so the reply's wait goes out at once: an author answering inside the
    // coalescing window must not fold it into one push that never waited.
    if (held.awaiting === "answer") this.flushBroadcast();
  }

  /**
   * Dismiss an open card the same way Done does: resolve the row, drop it
   * from the stack, broadcast. Does not decommission a crewmate.
   */
  close(
    cardId: string,
    actor: { kind: "firstmate" } | { kind: "crewmate"; taskId: string },
    reason?: string,
  ): string {
    const id = cardId.trim();
    if (!id) throw new Error("card_id is required.");
    const card = this.cards.get(id);
    if (!card) {
      if (this.host.cardStore.get(id)) {
        throw new Error(`Card "${id}" is already closed.`);
      }
      throw new Error(`Unknown card "${id}".`);
    }
    if (actor.kind === "firstmate" && !card.id.startsWith(FIRSTMATE_CARD_PREFIX)) {
      // Retired with the close rule (cards-as-threads phase 1, captain's Q3
      // A): the Firstmate no longer closes a card on the captain's behalf.
      // A card leaves on a button, a settle, the captain's own close, or
      // its AUTHOR's withdrawal - so words about someone else's card are a
      // steer to that author, and the captain's × is the only dismissal.
      throw new Error(
        `Card "${id}" is not yours to close: steer task ${card.taskId ?? "it"} to revise it under the same id, or to withdraw it. Only the captain dismisses a card they are looking at.`,
      );
    }
    if (actor.kind === "crewmate" && card.taskId !== actor.taskId) {
      throw new Error(`Crewmate cannot close card "${id}" (not emitted by this task).`);
    }
    const why = reason?.trim() || "closed";
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(id, why);
      this.noteExit(card, actor.kind, "tool", {
        reason: "author-withdrawal",
        ...(reason?.trim() ? { note: why } : {}),
      });
    });
    this.cards.delete(id);
    this.staged.delete(id);
    this.recordResolution(card, "closed", actor.kind);
    this.scheduleBroadcast();
    return `Closed card "${card.title}" (${id}).`;
  }

  /** A closed card as the captain last saw it, read-only (FI3-579); never changes anything. */
  past(cardId: string): PastCard | undefined {
    if (this.cards.has(cardId)) return undefined;
    return this.host.cardStore.past(cardId);
  }

  /**
   * A card's thread as it stands (cards-as-threads phase 1), oldest first.
   * Reading one never changes it.
   */
  thread(cardId: string): CardThread {
    const shown = this.shown(cardId);
    const messages = this.host.cardStore.messages(cardId);
    if (!shown?.offerId) return { cardId, messages };
    const offers = this.host.cardStore
      .observations(cardId)
      .filter(
        (o): o is Extract<CardObservation, { kind: "offer" }> =>
          o.kind === "offer" && o.lifecycleId === shown.lifecycleId,
      );
    const shownAt = offers.findIndex((o) => o.offerId === shown.offerId);
    return {
      cardId,
      messages: messages.map((message) => {
        const revision = message.revision;
        if (!revision?.released || revision.lifecycleId !== shown.lifecycleId) return message;
        const sourceAt = offers.findIndex((o) => o.offerId === revision.offerId);
        if (sourceAt < 0 || shownAt < sourceAt) return message;
        const versions = offers.slice(sourceAt, shownAt + 1).map((o) => o.payload);
        return {
          ...message,
          revisionShown: {
            offerId: shown.offerId!,
            targets: resolveRevisionTargets(revision.targets, versions),
          },
        };
      }),
    };
  }

  /**
   * One message onto a card's thread, pushed to the window. The single
   * writer: the captain's reply, an author's prose answer, and the host's
   * own "revised" line all land here, so nothing writes a thread row
   * without the push that paints it.
   */
  addMessage(
    cardId: string,
    who: CardMessageWho,
    text: string,
    submission?: unknown,
    answers?: CardAnswer[],
    revision?: CardRevisionLinks,
    leavesStack = false,
  ): CardMessage {
    // The captain's line takes an ordinary card off the stack until its
    // author answers and closes out; any other line - the author's answer, or the
    // host's "revised:" for a revision - ends his line being the newest.
    // An author's line brings back a card the captain put aside: the
    // Firstmate's at once, a crewmate's when its turn ends (INF-926).
    if (who === "firstmate") this.setMinimized(cardId, false);
    if (who === "crewmate") this.backAtTurnEnd(cardId);
    const card = this.cards.get(cardId);
    // The captain writes about the version the stage shows him; an author,
    // or the host's line for its revision, about the newest one it wrote.
    const about =
      (who === "captain" ? this.shown(cardId) : card) ?? this.host.cardStore.get(cardId);
    const by: { actor: CardObservationActor; source: CardObservationSource } = {
      actor: who,
      source: who === "host" ? "host" : "thread",
    };
    let held: Card | undefined;
    const message = this.host.cardStore.transaction(() => {
      const message = this.host.cardStore.appendMessage({
        cardId,
        who,
        text,
        ...(revision ? { revision } : {}),
      });
      if (about?.lifecycleId) {
        this.host.cardStore.observe({
          id: randomUUID(),
          kind: "message_ref",
          cardId,
          lifecycleId: about.lifecycleId,
          taskId: about.taskId,
          at: message.at,
          ...by,
          offerId: about.offerId,
          messageId: message.id,
          build: this.host.build,
          payload: {
            messageId: message.id,
            who,
            ...(answers ? { answers } : {}),
            ...(submission !== undefined
              ? { display: displayOf(readSubmission(submission), about) }
              : {}),
          },
        });
      }
      if (who === "captain") held = this.writeHold(cardId, "answer", by, leavesStack);
      else if (card?.awaiting === "answer") held = this.writeHold(cardId, "close-out", by);
      return message;
    });
    if (who === "captain" || card?.awaiting === "answer") this.applyHold(cardId, held);
    this.host.broadcastThread?.(this.thread(cardId));
    // An author's answer is a row on the card's task too (FI3-1189's rule
    // 1); the captain's reply already is one, through its steer or its ask.
    if ((who === "crewmate" || who === "firstmate") && about) {
      const task = about.taskId
        ? this.host.tasks.get(about.taskId)
        : (this.host.tasks.openCardTaskFor(cardId) ?? this.host.tasks.taskForCard(cardId));
      if (task) {
        this.host.tasks.recordReply(task.id, { cardId, title: about.title, text, actor: who });
      }
    }
    return message;
  }

  /**
   * Whether the Firstmate is the one that answers a card's thread: its own
   * card, or a note a task closed done kept, whose crewmate is gone.
   */
  private firstmateAnswers(card: Card): boolean {
    if (card.author === "firstmate") return true;
    if (card.author !== "crewmate" || !card.taskId) return false;
    const task = this.host.tasks.get(card.taskId);
    return task !== undefined && TaskService.isClosed(task);
  }

  /**
   * Capture the Firstmate's closing words as its answer in one of its own
   * cards' threads (phase 2). No-op without a current answer hold - a
   * revision may have answered it, or the old lifecycle may have closed.
   * Returns whether the answer was written.
   */
  recordFirstmateThreadAnswer(cardId: string, text: string): boolean {
    const card = this.cards.get(cardId);
    if (!card || !this.firstmateAnswers(card)) return false;
    if (!this.host.cardStore.awaitingAuthor(cardId)) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    this.addMessage(cardId, "firstmate", trimmed);
    return true;
  }

  /**
   * Open cards on this session that have a thread, for Observe. The
   * Firstmate session lists firstmate-authored cards; a crewmate session
   * lists that task's cards. Empty threads stay off the pane.
   */
  observeThreads(
    sessionId: string,
  ): Array<{ cardId: string; title: string; messages: CardMessage[] }> {
    const cards =
      sessionId === FIRSTMATE_SESSION_ID
        ? this.snapshot().filter((card) => card.author === "firstmate")
        : this.snapshot().filter((card) => card.taskId === sessionId);
    return cards
      .map((card) => ({
        cardId: card.id,
        title: card.title,
        messages: this.host.cardStore.messages(card.id),
      }))
      .filter((thread) => thread.messages.length > 0);
  }

  /**
   * A crewmate answering in one of its own card's threads (the `reply`
   * output, contract v4.1). Prose only, and never a second card: the host
   * renders it as a message. Refusals are tool text, not throws, except the
   * ownership one - a crewmate must not be able to write into another
   * task's conversation.
   */
  replyFromCrewmate(taskId: string, input: { cardId: string; text: string }): string {
    const id = input.cardId.trim();
    if (!id) return "reply needs card_id: the id emit_card returned.";
    const card = this.cards.get(id) ?? this.host.cardStore.get(id);
    if (!card) return `Unknown card "${id}". Only a card you emitted has a thread.`;
    if (card.taskId !== taskId) {
      return `Card "${id}" is not yours: only the card's own author answers in its thread.`;
    }
    const text = input.text.trim();
    if (!text) return "reply needs some words.";
    if (text.length > CARD_REPLY_MAX_CHARS) {
      return `A reply is at most ${CARD_REPLY_MAX_CHARS} characters; say it shorter, or revise the card.`;
    }
    this.addMessage(id, "crewmate", text);
    const replied = `Replied in the thread on "${card.title}" (${id}).`;
    // An answer under another card leaves the captain's reply waiting
    // (INF-990 friction 4): the receipt names the card that still waits.
    const still = this.threadsAwaitingAuthor(taskId).filter((other) => other.id !== id);
    return still.length > 0 ? `${replied} ${stillWaitingWords(still)}` : replied;
  }

  /**
   * Whether any of a task's open cards currently waits on an author answer.
   * The sort and idle ladder share this persisted lifecycle-aware witness;
   * retained thread history alone does not mean the author owes an answer.
   */
  threadAwaitingAuthor(taskId: string): boolean {
    return this.threadsAwaitingAuthor(taskId).length > 0;
  }

  /**
   * The task's open cards whose current lifecycle waits on an author answer,
   * oldest first: what a reminder names, so its author answers the card the
   * captain wrote under rather than another of its cards (INF-990 friction 4).
   */
  threadsAwaitingAuthor(taskId: string): { id: string; title: string }[] {
    return [...this.cards.values()]
      .filter((card) => card.taskId === taskId && this.host.cardStore.awaitingAuthor(card.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((card) => ({ id: card.id, title: card.title }));
  }

  /**
   * What a task's crew line says about its threads (`thread:`): how many
   * messages sit on its open cards and who wrote the newest, so the
   * Firstmate reads the state of a conversation it was never woken for.
   */
  threadFact(taskId: string): string | undefined {
    let count = 0;
    let last: CardMessage | undefined;
    for (const card of this.cards.values()) {
      if (card.taskId !== taskId) continue;
      const stat = this.host.cardStore.threadStat(card.id);
      if (!stat) continue;
      count += stat.count;
      if (!last || stat.last.at >= last.at) last = stat.last;
    }
    if (!last || count === 0) return undefined;
    return `thread: ${count} message${count === 1 ? "" : "s"}, last from ${last.who}`;
  }

  /**
   * The captain confirmed a card repeats an earlier one (WI-14,
   * flag_duplicate): the label is stamped write-once, and a duplicate still
   * on the stack closes with resolution `duplicate` and one feed line. No
   * card and no setting: the label is data for the duplicate metric.
   */
  flagDuplicate(input: { cardId: string; duplicateOf: string; note: string }): DuplicateResult {
    const open = this.cards.get(input.cardId);
    const result = this.host.cardStore.transaction(() => {
      const result = this.host.cardStore.flagDuplicate(input);
      if (result.status === "flagged" && open) {
        this.host.cardStore.resolve(open.id, "duplicate");
        // The Firstmate's tool stamps the label the captain confirmed.
        this.noteExit(open, "firstmate", "tool", {
          reason: "duplicate",
          duplicateOf: input.duplicateOf,
          ...(input.note.trim() ? { note: input.note.trim() } : {}),
        });
      }
      return result;
    });
    if (result.status !== "flagged") return result;
    if (open) {
      this.cards.delete(open.id);
      this.staged.delete(open.id);
      this.recordResolution(open, "closed", "captain");
      this.scheduleBroadcast();
    }
    this.host.broadcastEvent({
      type: "firstmate_note",
      text: `Closed "${result.card.title}" as a duplicate of "${result.original.title}".`,
    });
    return result;
  }

  /**
   * A card left the stack (P1): the task it is about hears `card_resolved`,
   * and a decision task the Firstmate raised without a task closes with the
   * choice - answered on an action, cancelled on a dismiss, superseded when
   * the agent withdrew it.
   *
   * On an ANSWER task the captain's choice is also the CLOSE (Task B,
   * captain F2 A): the card was the deliverable, and answering it closes
   * the row `done/answered`. His close control is not a choice: it reaches
   * the crewmate, which judges whether the task is finished (FI3-435).
   * Returns whether it closed, because the click's ordinary round-trip to a
   * still-running crewmate has nowhere to go once the task is closed.
   */
  private recordResolution(
    card: Card,
    action: string,
    by: "captain" | "firstmate" | "crewmate" = "captain",
    answers?: CardAnswer[],
  ): boolean {
    const tasks = this.host.tasks;
    let closedAnswer = false;
    if (card.taskId && tasks.get(card.taskId)?.delivery?.captainAction) {
      if (action === "dismissed" || action === "defer") tasks.deferCaptainAction(card.taskId);
      tasks.recordCardResolved(card.taskId, {
        cardId: card.id,
        title: card.title,
        action,
        actor: by,
      });
      return false;
    }
    if (card.taskId && tasks.get(card.taskId)) {
      tasks.recordCardResolved(card.taskId, {
        cardId: card.id,
        title: card.title,
        action,
        actor: by,
        ...(answers ? { answers } : {}),
      });
      this.host.noteCapAnswered(card, action, by, card.author === "firstmate");
      // The card leaving releases the captain gate it held (the owner's
      // call 3): with the action as the reason on the timeline above, and
      // the captain's close as an act that restarts the idle clock.
      this.host.syncCaptainGate(card.taskId, this.host.now());
      closedAnswer = this.host.closeAnsweredTask(card, action, by);
    }
    const row = tasks.openCardTaskFor(card.id);
    if (!row) return closedAnswer;
    // A host card's row is the host's bookkeeping: its close is not news.
    const quiet = row.kind === "operation" ? { feed: false as const } : {};
    if (action === "dismissed") {
      tasks.close(row.id, {
        status: "dropped",
        reason: "cancelled",
        actor: "captain",
        text: "dismissed without a choice",
        ...quiet,
      });
    } else if (action === "closed") {
      tasks.close(row.id, {
        status: "dropped",
        reason: "superseded",
        actor: by,
        text: "withdrawn as obsolete",
        ...quiet,
      });
    } else {
      const label = card.actions.find((entry) => entry.id === action)?.label ?? action;
      tasks.close(row.id, {
        status: "done",
        reason: "answered",
        actor: by,
        text: `chose "${label}"`,
        ...quiet,
      });
    }
    this.host.broadcastCrewCounts();
    return closedAnswer;
  }

  /**
   * The Firstmate's pause card (W1 S9; docs/architecture.md §16 "A paused
   * seat"): one card for one pause, titled for what stopped the seat. With
   * a place to move (rung 2) it asks to move - a cross-provider move is a
   * model change, so it always asks - under `card-fm-flagship-move`;
   * without one (rung 3) it says the seat waits, under `card-fm-refused`
   * for a refusal and `card-fm-no-headroom` for the rest. Either way it
   * carries the class's own way back: "Sign in" for a lost sign-in (a
   * captain click only; nothing signs in on its own) and "Try again" for a
   * refusal (`try-again`, the only way a refusal clears on the captain's
   * word). Nothing moves or retries until a click. Its one primary is its
   * default, so the footer draws it at the right edge. A card already up
   * under the id is revised in place when its words or actions differ;
   * `reviseOnly` leaves a card the captain dismissed down.
   */
  addFirstmatePauseCard(input: FirstmatePauseCard, options: { reviseOnly?: boolean } = {}): void {
    const id = input.move
      ? FIRSTMATE_MOVE_CARD_ID
      : input.pause === "refused"
        ? FIRSTMATE_REFUSED_CARD_ID
        : FIRSTMATE_BENCH_CARD_ID;
    const previous = this.cards.get(id);
    if (!previous && options.reviseOnly) return;
    // A spent allowance is read again on the captain's word - after a switch
    // to another login elsewhere, say - and that is the card's default; a
    // move or Settings stays beside it.
    if (input.pause === "no_headroom" && input.accountId && !input.checking) {
      this.putFirstmatePauseCard(id, input, [
        {
          id: "recheck-allowance",
          label: RECHECK_ALLOWANCE_LABEL,
          variant: "primary",
          default: true,
          effect: { kind: "host", op: "try-again", arg: input.accountId },
        },
        input.move
          ? {
              id: "move-flagship",
              label: moveLabel(input.move.providerName),
              variant: "secondary",
              effect: { kind: "host", op: "move-flagship", arg: input.move.providerId },
            }
          : {
              id: "open-settings",
              label: "Open settings",
              variant: "secondary",
              effect: { kind: "open", target: "settings" },
            },
      ]);
      return;
    }
    const wayBack: CardAction[] =
      input.pause === "refused" && input.accountId
        ? [
            {
              id: "try-again",
              label: `Try ${input.providerName} again`,
              variant: input.move ? "secondary" : "primary",
              ...(input.move ? {} : { default: true }),
              effect: { kind: "host", op: "try-again", arg: input.accountId },
            },
          ]
        : input.pause === "signed_out" && input.accountId
          ? [
              {
                id: "sign-in",
                label: "Sign in",
                variant: input.move ? "secondary" : "primary",
                ...(input.move ? {} : { default: true }),
                effect: restoreAccountEffect(input.accountId),
              },
            ]
          : [];
    const actions: CardAction[] = input.move
      ? [
          {
            id: "move-flagship",
            label: moveLabel(input.move.providerName),
            variant: "primary",
            default: true,
            effect: { kind: "host", op: "move-flagship", arg: input.move.providerId },
          },
          ...wayBack,
        ]
      : [
          ...wayBack,
          ...(wayBack.length === 0 || input.pause === "refused"
            ? [
                {
                  id: "open-settings",
                  label: "Open settings",
                  variant: wayBack.length === 0 ? ("primary" as const) : ("secondary" as const),
                  ...(wayBack.length === 0 ? { default: true } : {}),
                  effect: { kind: "open" as const, target: "settings" as const },
                },
              ]
            : []),
        ];
    this.putFirstmatePauseCard(id, input, actions);
  }

  /** Put a pause card under `id`, unless the one up already says the same. */
  private putFirstmatePauseCard(
    id: string,
    input: FirstmatePauseCard,
    actions: CardAction[],
  ): void {
    const previous = this.cards.get(id);
    const title = firstmatePauseTitle(input.pause, input.providerName);
    if (
      previous &&
      previous.title === title &&
      previous.body === input.body &&
      JSON.stringify(previous.actions) === JSON.stringify(actions)
    ) {
      return;
    }
    this.put({
      id,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title,
      meta: FIRSTMATE_CARD_META,
      body: input.body,
      actions,
      status: "ready",
      createdAt: previous?.createdAt ?? this.host.now(),
    });
  }

  /**
   * The way back for a seat the captain moved (W1 S9): the account it left
   * serves again, so ask - never move on its own. The action reuses the
   * move, pointed back at the provider the seat left.
   */
  addFirstmateMoveBackCard(input: {
    providerId: string;
    providerName: string;
    body: string;
  }): void {
    if (this.cards.has(FIRSTMATE_MOVE_BACK_CARD_ID)) return;
    this.put({
      id: FIRSTMATE_MOVE_BACK_CARD_ID,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: `Move your first mate back to ${input.providerName}?`,
      meta: FIRSTMATE_CARD_META,
      body: input.body,
      actions: [
        {
          id: "move-flagship",
          label: `Move back to ${input.providerName}`,
          variant: "primary",
          effect: { kind: "host", op: "move-flagship", arg: input.providerId },
        },
      ],
      status: "ready",
      createdAt: this.host.now(),
    });
  }

  /** The seat serves again, or moved: every pause card's question is gone. */
  withdrawFirstmatePauseCards(reason: string): void {
    for (const id of FIRSTMATE_PAUSE_CARD_IDS) this.takeDown(id, reason);
  }

  /**
   * An app-raised auth decision card (also used by the Firstmate agent). A
   * crewmate's own sign-in card carries its task, so it holds that task's
   * turn through the gate like any card; an account's files its own row.
   * With `move`, its default moves the task to the model the app picked,
   * by that model's name (INF-849), `arg` being the task, the provider it
   * moves off and the model offered; Open settings stays beside it.
   */
  addAuthDecisionCard(
    id: string,
    meta: string,
    body: string,
    options?: {
      restoreAccountId?: string;
      taskId?: string;
      move?: { arg: string; modelName: string };
    },
  ): void {
    if (this.cards.has(id)) return;
    const restoreAccountId = options?.restoreAccountId;
    const card: Card = {
      id,
      ...(options?.taskId ? { taskId: options.taskId } : {}),
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: restoreAccountId ? body : PROVIDER_SIGN_IN_TITLE,
      meta,
      body: restoreAccountId ? NEEDS_REAUTH_CONSEQUENCE : body,
      actions: [
        ...(options?.move && !restoreAccountId
          ? [
              {
                id: "move-task",
                label: moveLabel(options.move.modelName),
                variant: "primary" as const,
                default: true,
                effect: { kind: "host" as const, op: "move-task" as const, arg: options.move.arg },
              },
            ]
          : []),
        restoreAccountId
          ? {
              id: "sign-in",
              label: "Sign in",
              variant: "primary",
              effect: restoreAccountEffect(restoreAccountId),
            }
          : {
              id: "open-settings",
              label: "Open settings",
              variant: options?.move ? "secondary" : "primary",
              // Sign-in lives on the Intelligence tab, so that is where the
              // card lands - never the General tab one click short of it.
              effect: { kind: "open", target: "subscriptions" },
            },
      ],
      status: "ready",
      createdAt: this.host.now(),
    };
    this.put(card);
  }

  /**
   * The one host card for a sign-in where projects live that the host
   * refused (git integration PR 1.2): "Sign in to GitHub again", whose one
   * action lands on Settings -> Projects with the sign-in already started.
   * Raised only on the host's own refusal (needs_reauth) and cleared by
   * `clearAuthDecisionCard` once the host answers again. A body names what
   * waits on it; it never suggests the host is required.
   */
  addForgeSignInCard(
    id: string,
    host: string,
    name: string,
    waitingChanges: number,
    options: { reauth?: boolean } = {},
  ): void {
    if (this.cards.has(id)) return;
    const reauth = options.reauth ?? true;
    const waiting =
      waitingChanges === 0
        ? ""
        : waitingChanges === 1
          ? " One pull request is waiting on it."
          : ` ${waitingChanges} pull requests are waiting on it.`;
    const card: Card = {
      id,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: forgeSignInTitle(name, reauth),
      meta: name,
      body: reauth
        ? `<p>${forgeRefusedText(name)}${waiting}</p><p>${LOCAL_PROJECTS_UNAFFECTED}</p>`
        : `<p>A task for a project on ${name} is waiting for your sign-in.${waiting}</p><p>Once you sign in, your first mate will retry starting the task. ${LOCAL_PROJECTS_UNAFFECTED}</p>`,

      actions: [
        {
          id: "sign-in",
          label: reauth ? "Sign in again" : `Sign in to ${name}`,
          variant: "primary",
          effect: { kind: "open", target: "projects", signIn: host },
        },
      ],
      status: "ready",
      createdAt: this.host.now(),
    };
    this.put(card);
  }

  /**
   * The one host card for a computer that runs a project living on a host
   * it holds no sign-in for (design skill `components/devices/SignInOnAMac`,
   * "GitHub on another device"; docs/forge.md, "A computer's own sign-in"):
   * "Sign in to GitHub on Mac mini", whose one action lands on Settings ->
   * Projects with that computer's sign-in started under its row. Raised
   * when Runs on names such a computer, or when its clone there is refused
   * for want of the sign-in; cleared once the computer reports one. Not
   * raised while the computer's setup card already asks for it.
   */
  addDeviceForgeSignInCard(input: {
    deviceId: string;
    host: string;
    name: string;
    project: string;
    place: { label: string; where: string; who: string };
  }): void {
    const id = deviceForgeSignInCardId(input.host, input.deviceId);
    if (this.cards.has(id)) return;
    const card: Card = {
      id,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: deviceForgeSignInTitle(input.place.where, input.name),
      meta: input.place.label,
      body: deviceForgeSignInBody(input.project, input.place, input.name),
      actions: [
        {
          id: "sign-in",
          label: deviceForgeSignInTitle(input.place.where, input.name),
          variant: "primary",
          effect: {
            kind: "open",
            target: "projects",
            forgeSignInOn: { deviceId: input.deviceId, host: input.host },
          },
        },
      ],
      status: "ready",
      createdAt: this.host.now(),
    };
    this.put(card);
  }

  /**
   * Drop a recovered needs_reauth card without waking the Firstmate. The
   * credential came back; the question is gone.
   */
  clearAuthDecisionCard(id: string): void {
    this.takeDown(id, "recovered");
  }

  /**
   * A card the host itself authors, put up (or revised in place under the
   * same id) by a core service that owns the question - the plugin consent
   * card is the one caller (Phase A, A2a). The host stamps the author and
   * the priority; the caller's actions carry host effects only the
   * captain's click can run.
   */
  raiseHostCard(card: Omit<Card, "author" | "priority" | "status" | "createdAt">): void {
    const previous = this.cards.get(card.id);
    const raised: Card = {
      ...card,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      status: "ready",
      createdAt: previous?.createdAt ?? this.host.now(),
    };
    this.put(raised);
  }

  /** Takes a host card down without an answer: the question it asked is gone. */
  withdrawHostCard(id: string, reason: string): void {
    if (this.cards.get(id)?.author !== "host") return;
    this.takeDown(id, reason);
  }

  /** Presentation state and the card commit together, so a crash cannot lose its first offer. */
  presentRequiredAction(taskId: string): boolean {
    if (!this.host.tasks.captainActionReady(taskId)) return false;
    this.host.tasks.atomic(
      () => {
        const action = this.host.tasks.presentCaptainAction(taskId);
        if (!action) throw new Error("The required action is no longer ready.");
        const next = requiredActionCard(taskId, action, this.host.now());
        const { card, offer, opened } = this.stamp({
          ...next,
          width: decidedCardWidth({ body: next.body }),
        });
        if (opened?.lifecycle === "reopened") this.host.cardStore.reopen(card.id);
        this.host.cardStore.upsert(card);
        if (offer) this.noteOffer(card, "put", "host");
        this.noteStage({ head: card, shown: card }, "put", {
          source: "host",
          ...(opened ? { opened } : {}),
        });
        return card;
      },
      (card) => {
        this.cards.set(card.id, card);
        this.placed(card);
        this.scheduleBroadcast();
      },
    );
    return true;
  }

  /**
   * INF-476: saved presentation only, not a close, reply, gate or ladder
   * interaction. It reads and moves what the stage shows, so bringing a card
   * back also ends a wait for its author's turn end (`asideUntilTurnEnd`).
   */
  setMinimized(cardId: string, minimized: boolean): void {
    const card = this.cards.get(cardId);
    if (!card || Boolean(card.minimized || this.heldAside(card)) === minimized) return;
    this.asideUntilTurnEnd.delete(cardId);
    if (Boolean(card.minimized) !== minimized) {
      const { minimized: _previous, ...rest } = card;
      const updated: Card = { ...rest, ...(minimized ? { minimized: true } : {}) };
      this.host.cardStore.upsert(updated);
      this.cards.set(cardId, updated);
    }
    this.scheduleBroadcast();
    this.flushBroadcast();
  }

  /**
   * A crewmate wrote on a card the captain put aside: the saved card is no
   * longer aside, so a restart - a close-out - brings it back, while the
   * stage keeps it aside until that crewmate's turn ends (INF-926).
   */
  private backAtTurnEnd(cardId: string): void {
    const card = this.cards.get(cardId);
    if (!card?.minimized || !card.lifecycleId) return;
    const { minimized: _aside, ...rest } = card;
    this.host.cardStore.upsert(rest);
    this.cards.set(cardId, rest);
    this.asideUntilTurnEnd.set(cardId, card.lifecycleId);
  }

  /** Publish a newly reopened card before asking either the local or paired view to focus it. */
  showOpenCard(cardId: string): void {
    this.setMinimized(cardId, false);
    this.broadcastSnapshot();
    this.host.broadcastEvent({ type: "open_card_shown", cardId });
  }

  /**
   * Put a card the host authors on the stack: a new one, or a revision under
   * its id. A card raised again under an id it once had reopens its row, so
   * the stack and the row agree and it survives a restart like any other.
   */
  put(next: Card): void {
    const { card, offer, opened } = this.stamp({
      ...next,
      width: decidedCardWidth({
        body: next.body,
        pictures: next.pictures,
        width: next.width === "regular" ? undefined : next.width,
      }),
    });
    this.host.cardStore.transaction(() => {
      if (opened?.lifecycle === "reopened") this.host.cardStore.reopen(card.id);
      this.host.cardStore.upsert(card);
      if (offer) this.noteOffer(card, "put", "host");
      this.noteStage({ head: card, shown: card }, "put", {
        source: "host",
        ...(opened ? { opened } : {}),
      });
    });
    this.cards.set(card.id, card);
    this.placed(card);
    this.scheduleBroadcast();
  }

  /** Take a card down unanswered: the question it asked is gone. */
  takeDown(id: string, resolution: string): void {
    const card = this.cards.get(id);
    if (!card) return;
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(id, resolution);
      this.noteExit(card, "host", "host", { reason: "host-withdrawal", note: resolution });
    });
    this.cards.delete(id);
    this.staged.delete(id);
    this.left(card);
    this.scheduleBroadcast();
  }

  /**
   * A card went up or was revised (the owner's call 3 on the primitives
   * review, docs/card-authoring.md): a card with actions on a task places
   * the captain gate there, naming the card; a host card with actions and
   * no task files an operation row to gate, so "waiting on you" counts the
   * host's own asks too. A note places nothing.
   */
  private placed(card: Card): void {
    if (card.taskId) {
      this.host.syncCaptainGate(card.taskId, this.host.now());
      return;
    }
    if (card.author !== "host" || cardWord(card) !== "decision") return;
    if (this.host.tasks.openCardTaskFor(card.id)) return;
    this.host.tasks.fileHostCardTask({
      id: randomUUID().slice(0, 8),
      title: card.title.trim().slice(0, 64),
      cardId: card.id,
    });
  }

  /** A card left the stack unanswered: the gate it placed, or its row, goes with it. */
  private left(card: Card): void {
    if (card.taskId) {
      this.host.syncCaptainGate(card.taskId, this.host.now());
      return;
    }
    const row = this.host.tasks.openCardTaskFor(card.id);
    if (row?.kind !== "operation") return;
    this.host.tasks.close(row.id, {
      status: "dropped",
      reason: "superseded",
      actor: "host",
      text: "its card is gone",
      feed: false,
    });
  }

  /**
   * A host card with actions restored from a version that filed no row for
   * it: its row is filed at the next sweep, as it would have been on raise.
   */
  fileMissingHostCardTasks(): void {
    for (const card of this.cards.values()) {
      if (!card.taskId) this.placed(card);
    }
  }

  /**
   * A priority one past the highest on the stack now (`compareStack` sorts
   * by priority first), so a card given it is the stack's top. Saved with the
   * card, so it is still the top after a restart.
   */
  private topPriority(floor: number): number {
    let top = floor - 1;
    for (const card of this.cards.values()) top = Math.max(top, card.priority);
    return top + 1;
  }

  /** Whether a card is on the stack right now. */
  has(id: string): boolean {
    return this.cards.has(id);
  }

  /**
   * The open completion card's merge action on a task, when one is up: the
   * card, the action the host itself attached (`withCompletionActions`),
   * and the label the captain is reading. Found by the declared EFFECT, the
   * way every other host dispatch is, never by an action id.
   */
  openMergeAction(
    taskId: string,
  ): { cardId: string; cardTitle: string; actionId: string; label: string } | undefined {
    for (const card of this.cards.values()) {
      if (card.taskId !== taskId) continue;
      const merge = card.actions.find((action) => settleEffectOf(action)?.mode === "merge");
      if (merge) {
        return { cardId: card.id, cardTitle: card.title, actionId: merge.id, label: merge.label };
      }
    }
    return undefined;
  }

  /**
   * A settled task's open cards resolve out of the stack; the rows stay. A
   * close that delivered (`keepNotes`) keeps a crewmate's notes and the
   * Firstmate's notes: a fact outlives the task, and only a question the
   * close made moot comes down (FI3-419, FI3-1581). A host card is the
   * host's own and still comes down.
   */
  retireTaskCards(taskId: string, reason: string, options: { keepNotes?: boolean } = {}): void {
    for (const [cardId, card] of [...this.cards]) {
      if (card.taskId !== taskId) continue;
      if (options.keepNotes && card.author !== "host" && card.actions.length === 0) {
        // The crewmate is gone: a note still waiting on it reaches the stage
        // now. The Firstmate is not, so a reply on its note keeps its wait.
        if (card.author === "crewmate" && card.awaiting !== undefined) this.release(card, "idle");
        this.staged.delete(cardId);
        this.asideUntilTurnEnd.delete(cardId);
        continue;
      }
      this.host.cardStore.transaction(() => {
        this.host.cardStore.resolve(cardId, reason);
        this.noteExit(card, "host", "host", { reason: "task-retired", note: reason });
      });
      this.cards.delete(cardId);
      this.staged.delete(cardId);
    }
    this.scheduleBroadcast();
  }

  /**
   * The Firstmate's own quiet card (P4 extension): informational only - the
   * orchestrator is steer-only, so there is no interrupt to offer. A later
   * escalation may re-raise over a dismissed one.
   */
  addFirstmateQuietCard(body: string): void {
    const id = "card-fm-quiet";
    const card: Card = {
      id,
      author: "host",
      priority: HOST_NOTE_PRIORITY,
      title: "Your first mate has gone quiet",
      meta: FIRSTMATE_CARD_META,
      body,
      actions: [],
      status: "ready",
      createdAt: this.host.now(),
    };
    this.put(card);
  }

  /** Activity resumed or the turn ended: the quiet question answered itself. */
  clearFirstmateQuietCard(): void {
    this.takeDown("card-fm-quiet", "activity-resumed");
  }

  /**
   * The Firstmate failure card (the agent-down set, ruling D6): the turn
   * failed and no agent can answer, so the host offers the one way out -
   * Retry, a host effect. One card under a stable id: a repeated failure
   * (a provider outage across several turns) revises it in place rather
   * than stacking copies.
   */
  addFirstmateFailureCard(body: string): void {
    const id = FIRSTMATE_FAILURE_CARD_ID;
    const existing = this.cards.get(id);
    const card: Card = {
      id,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: FIRSTMATE_FAILURE_TITLE,
      meta: FIRSTMATE_CARD_META,
      body,
      actions: [
        {
          id: "retry-firstmate",
          label: "Retry",
          variant: "primary",
          default: true,
          effect: { kind: "host", op: "retry-firstmate" },
        },
      ],
      status: "ready",
      createdAt: existing?.createdAt ?? this.host.now(),
    };
    const {
      card: stamped,
      offer,
      opened,
    } = this.stamp({
      ...card,
      width: decidedCardWidth({ body: card.body, pictures: card.pictures }),
    });
    this.host.cardStore.transaction(() => {
      if (existing) this.host.cardStore.revise(stamped);
      else {
        if (opened?.lifecycle === "reopened") this.host.cardStore.reopen(id);
        this.host.cardStore.upsert(stamped);
      }
      if (offer) this.noteOffer(stamped, "put", "host");
      this.noteStage({ head: stamped, shown: stamped }, "put", {
        source: "host",
        ...(opened ? { opened } : {}),
      });
    });
    this.cards.set(id, stamped);
    this.placed(stamped);
    this.scheduleBroadcast();
  }

  /** An app-raised note card (for example the mic permission primer). */
  addSystemNoteCard(id: string, title: string, body: string): void {
    if (this.cards.has(id)) return;
    const card: Card = {
      id,
      author: "host",
      priority: HOST_NOTE_PRIORITY,
      title,
      meta: FIRSTMATE_CARD_META,
      body,
      actions: [],
      status: "ready",
      createdAt: this.host.now(),
    };
    this.put(card);
  }

  /**
   * Every card whose thread has moved since `since`, newest first, with its
   * message count, newest message and who owes an answer now: what the
   * Firstmate's context-block section is rendered from (phase 1, captain's
   * C9 A). A card whose row is gone is skipped rather than named as an id
   * nobody can look up.
   */
  threadActivitySince(since: number, limit = 8): ThreadActivity[] {
    return this.host.cardStore.threadSummaries(since, limit).flatMap((summary) => {
      const open = this.cards.get(summary.cardId);
      const card = open ?? this.host.cardStore.get(summary.cardId);
      if (!card) return [];
      return [{ card, count: summary.count, last: summary.last, owed: this.threadOwed(open) }];
    });
  }

  /** The current lifecycle's answer hold, the witness the sort and idle ladder read (`ThreadOwed`). */
  private threadOwed(open: Card | undefined): ThreadOwed {
    if (!open) return "closed";
    if (!this.host.cardStore.awaitingAuthor(open.id)) return "none";
    return this.firstmateAnswers(open) ? "firstmate" : "author";
  }

  /**
   * The cards the captain resolved since `since`, newest first, at most
   * `limit`: a dismissal (`close`) or one of the card's own actions.
   * Everything else that resolves a card - an emitter's close_card reason,
   * a duplicate stamp, a settled task retiring its cards - is the app or an
   * agent, not the captain.
   */
  captainResolutionsSince(since: number, limit: number): CardResolution[] {
    return this.host.cardStore.resolvedSince(
      since,
      limit,
      ({ card, offer, action }) =>
        action === "close" || (offer?.actions ?? card.actions).some((entry) => entry.id === action),
    );
  }

  /**
   * Persisted closing offer and submitted answers for a single task read;
   * with `cardId`, only the captain's resolution of that one card.
   */
  newestResolutionForTask(taskId: string, cardId?: string): CardResolution | undefined {
    return this.host.cardStore.resolvedSince(
      0,
      1,
      ({ card, offer, action }) =>
        (cardId === undefined || card.id === cardId) &&
        (action === "close" ||
          (offer?.actions ?? card.actions).some((entry) => entry.id === action)),
      taskId,
    )[0];
  }

  /** Flush before task delivery, rather than relying on relative timers. */
  flushBroadcast(): void {
    if (!this.broadcastTimer) return;
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = undefined;
    this.broadcastSnapshot();
  }

  private broadcastSnapshot(): void {
    const snapshot = this.snapshot();
    this.host.broadcastCards(snapshot);
    for (const card of snapshot) {
      if (this.threadOffers.get(card.id) === card.offerId) continue;
      this.threadOffers.set(card.id, card.offerId);
      if (this.host.cardStore.threadStat(card.id))
        this.host.broadcastThread?.(this.thread(card.id));
    }
    for (const id of this.threadOffers.keys())
      if (!this.cards.has(id)) this.threadOffers.delete(id);
  }

  scheduleBroadcast(): void {
    const presentation = JSON.stringify(this.snapshot());
    if (presentation !== this.presentation) {
      this.presentation = presentation;
      this.host.presentationChanged?.();
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => this.flushBroadcast(), 60);
  }
}

/** The author of a card as the actor its own writes are stamped with. */
function authorActor(card: Pick<Card, "author">): CardObservationActor {
  return card.author;
}

/**
 * What an offer shows, fingerprinted: the words, the body with every fact
 * the host appended, the actions in footer order, the pictures, the width,
 * the live attachment, where its task runs and its risk. Status, stage and
 * position are not what a card offers. A card with no attachment, no place
 * and no risk fingerprints as it always did.
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
        ...(card.asking ? [{ asking: true }] : []),
        ...(card.designOnly ? [{ designOnly: true }] : []),
        ...(card.holdsPlace ? [{ holdsPlace: true }] : []),
        ...(card.reviewTaskId ? [{ reviewTaskId: card.reviewTaskId }] : []),
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

const submissionEnvelopeSchema = cardSubmissionSchema.extend({ questions: z.unknown().optional() });

function readSubmission(raw: unknown): SubmissionReading {
  if (raw === undefined) return { malformed: false };
  const envelope = submissionEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { malformed: true };
  const { questions: rawQuestions, ...rest } = envelope.data;
  const submission: CardSubmission = rest;
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

/**
 * Who put a task's card on the stack, read off its id: the Firstmate mints
 * `card-fm-…`, a crewmate `card-<taskId>-…`; anything else (the auth cards)
 * is the host's own.
 */
export function cardEmitter(cardId: string, taskId: string): "firstmate" | "crewmate" | "host" {
  if (cardId.startsWith(FIRSTMATE_CARD_PREFIX)) return "firstmate";
  if (cardId.startsWith(`card-${taskId}-`)) return "crewmate";
  return "host";
}

/**
 * Uniform chrome for agent-emitted cards (crewmate and firstmate alike). A
 * card carries exactly the actions its author declared (cards/tasks/agents
 * P0, WI-1): the host prepends, appends, and arranges nothing - an agent
 * that wants "ask me tomorrow" declares that as an ordinary action.
 */
function buildEmittedCard(
  id: string,
  input: EmittedCardInput,
  context: {
    taskId?: string;
    author: "crewmate" | "firstmate";
    meta: string;
    model?: string;
    place?: string;
  },
  createdAt: number,
): Card {
  // The emitter's own default is the primary button (WI-10) - never an
  // accident of which option it listed last.
  // The footer reads the same on every card (design skill ResponseCard):
  // the other choices, then the default last. Notes with no declared
  // actions have no footer; close lives in the card chrome.
  const rank = (action: EmittedCardInput["actions"][number]) => (action.default ? 1 : 0);
  const declared: Card["actions"] = [...input.actions]
    .sort((a, b) => rank(a) - rank(b))
    .map((action) => {
      // A destructive choice reads as one: declared danger, or a discard
      // (which is always destructive). Danger outranks the default's primary.
      const danger = action.danger === true || settleEffectOf(action)?.mode === "discard";
      return {
        id: action.id,
        label: action.label,
        variant: danger
          ? ("danger" as const)
          : action.default
            ? ("primary" as const)
            : ("secondary" as const),
        ...(action.default ? { default: true } : {}),
        ...(action.effect ? { effect: action.effect } : {}),
        ...(danger ? { danger: true } : {}),
        ...(action.care ? { care: action.care } : {}),
      };
    });
  const width = decidedCardWidth(input);
  return {
    id,
    ...(context.taskId ? { taskId: context.taskId } : {}),
    author: context.author,
    ...(input.reviewTaskId ? { reviewTaskId: input.reviewTaskId } : {}),
    priority: cardPriority(input),
    title: input.title,
    meta: context.meta,
    ...(context.model ? { model: context.model } : {}),
    ...(context.place ? { place: context.place } : {}),
    body: input.body,
    actions: declared,
    status: "ready",
    createdAt,
    ...(input.pictures?.length ? { pictures: input.pictures } : {}),
    // Facts first, then the author's hint, which only widens (the
    // captain's Q5 A); decided again on every revision, since a revised
    // body can hold a different table or picture.
    ...(width ? { width } : {}),
    // The host resolved it from the author's label (docs/task-browser.md,
    // "From a card"); a revision without one takes it away.
    ...(input.attachment ? { attachment: input.attachment } : {}),
    // The host keeps the author's declaration alone
    // (docs/card-authoring.md "The risk chart"); a revision replaces it.
    ...(input.risk ? { risk: input.risk } : {}),
    ...(input.requiredActions !== undefined ? { requiredActions: input.requiredActions } : {}),
    ...(input.asking ? { asking: true as const } : {}),
    ...(input.designOnly ? { designOnly: true as const } : {}),
    ...(input.holdsPlace ? { holdsPlace: true as const } : {}),
  };
}

/**
 * A crewmate card's id on its task. Idempotent, like resolveFirstmateCardId:
 * emit_card hands the model back the resolved id, so a crewmate revising its
 * own card resends that id. Prefixing it again would mint a duplicate instead.
 */
/** What a receipt adds when another card's thread still waits on its author. */
function stillWaitingWords(cards: readonly { id: string; title: string }[]): string {
  return `The captain's reply under ${waitingCardWords(cards)} still waits on your answer: answer it there with reply, or in that card's emit_card revision.`;
}

function crewmateCardId(taskId: string, stableId: string): string {
  return stableId.startsWith(`card-${taskId}-`) ? stableId : `card-${taskId}-${stableId}`;
}
