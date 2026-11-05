import { randomUUID } from "node:crypto";
import {
  ANSWER_DONE_LABEL,
  answerDoneRest,
  cardCornerOf,
  cardLeaveOperation,
} from "@shared/cardLeave";
import type { CardRevisionLinks } from "@shared/cards";
import {
  type Card,
  type CardAnswer,
  type CardAsked,
  type CardAwaiting,
  type CardChanges,
  type CardContributor,
  type CardMessage,
  type CardMessageWho,
  type CardMutation,
  type CardObservationActor,
  type CardObservationSource,
  type CardThread,
  cardPresentation,
  cardWord,
  compareStack,
  isPreviewBody,
  isStoryNote,
  keepsTaskOpen,
  onStage,
  type PastCard,
  settleEffectOf,
} from "@shared/cards";
import type { CrewResponse } from "@shared/crewResponses";
import { deviceForgeSignInCardId } from "@shared/deviceSetup";
import type { FmEvent } from "@shared/events";
import { decidedCardWidth } from "../pi/cardWidth";
import type { EmittedCardInput } from "../session/tools";
import type { CardResolution, CardStore, DuplicateResult } from "../storage/cardStore";
import type { TaskOriginLine } from "../tasks/taskOrigin";
import type { TaskService } from "../tasks/taskService";
import { CardEmits, cardEmitter, FIRSTMATE_CARD_PREFIX } from "./cardEmit";
import { CardEvidence, type CardInteractionEvidence, submissionDisplay } from "./cardEvidence";
import {
  authorKey,
  type CardCaller,
  type CardContribution,
  type CardRead,
  CardThreads,
  type MessageFacts,
  type ThreadActivity,
  type ThreadOwed,
} from "./cardThreads";
import {
  authDecisionCard,
  deviceForgeSignInCard,
  FIRSTMATE_FAILURE_CARD_ID,
  FIRSTMATE_MOVE_BACK_CARD_ID,
  FIRSTMATE_PAUSE_CARD_IDS,
  FIRSTMATE_QUIET_CARD_ID,
  type FirstmatePauseCard,
  firstmateFailureCard,
  firstmateMoveBackCard,
  firstmatePauseCard,
  firstmatePauseCardId,
  firstmateQuietCard,
  forgeSignInCard,
  hostCard,
  systemNoteCard,
} from "./hostCards";
import { requiredActionCard, requiredActionProvenance } from "./requiredActionCard";
import { settleCardFacts } from "./settleCardFacts";
import type { WakeCard } from "./wakes";

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
 *
 * Its owners each keep one part over the same stack (`CardStack`): the
 * record's evidence (`CardEvidence`), a card's thread and every write on
 * someone else's card (`CardThreads`), the cards agents emit (`CardEmits`),
 * the host's own cards (`hostCards`) and a settle card's facts
 * (`settleCardFacts`).
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

/** What the card stack needs from the supervisor that composes it. */
export type CardServiceHost = {
  /** The host's one clock (the ticker's). */
  now: () => number;
  tasks: TaskService;
  cardStore: CardStore;
  /** A card placed, revised or gone on a task: the ladder's captain gate follows. */
  syncCaptainGate(taskId: string, now: number): void;
  /** An answer task closes on its card's resolution (Task B); whether it did. */
  closeAnsweredTask(card: Card, action: string, by: CardActor): boolean;
  /** The fact strip and the follow-ups a settle card carries (HTML fragments). */
  settleFacts(taskId: string): string | undefined;
  /** The words a settle card's merge reads now, when the host names it; undefined leaves it. */
  mergeLabel?(card: Card): string | undefined;
  /** Whether a settle card offers Merge anyway beside its merge now (INF-1137 friction 6). */
  mergeAnyway?(card: Card): boolean;
  /**
   * Whether a story note stays off the stack until its task's merge has a
   * result (INF-2533): the task merges on its own, is open, and its change
   * has not merged - or, with `merging`, is merging now. Read from typed
   * facts, never the card's words.
   */
  holdsUntilMerge?(card: Card, merging?: boolean): boolean;
  /**
   * Another of the task's pull requests the record keeps that has not
   * merged, besides the one its completion offer merges (INF-2525).
   */
  otherChangeOpen?(taskId: string): boolean;
  followupNotice(taskId: string): string | undefined;
  /**
   * Whether the captain's choice on this card still waits on its author's
   * lane, not yet handed to a turn (`InboxStore.holdsUndeliveredChoice`).
   * Absent reads as heard.
   */
  choiceUnheard?(card: Card): boolean;
  broadcastCrewCounts(): void;
  broadcastEvent: (event: FmEvent) => void;
  broadcastCards: (cards: Card[]) => void;
  presentationChanged?: () => void;
  /** One card's thread, whole, after any message lands on it (phase 1). */
  broadcastThread?: (thread: CardThread) => void;
  /**
   * The captain chose an action on a card or closed it: the message it may
   * answer hears it (INF-1610, `AskEnding.captainResponded`).
   */
  captainResponded?: (card: Card, response: "choice" | "close", action?: string) => void;
  /**
   * A card was placed, revised or released onto the stage from its
   * close-out hold: a notice it answers may be taken back.
   */
  cardPlaced?: (card: Card) => void;
  /** The app build every observation is stamped with (docs/card-evidence.md). */
  build?: string;
  /**
   * A card answer carries a correlated response (INF-2222's one writer):
   * check it names a live request, this card's lifecycle and the captain
   * message the line answers, before anything is written; then save it in
   * the same transaction as the line. Absent, a response is refused.
   */
  checkCardResponse?: (
    taskId: string,
    response: CrewResponse,
    card: { id: string; lifecycleId?: string; messageId?: number },
  ) => void;
  submitCardResponse?: (
    taskId: string,
    response: CrewResponse,
    text: string,
    line: { cardId: string; messageId: number },
  ) => void;
};

/**
 * The open stack as its owners share it (`CardThreads`, `CardEmits`): the
 * cards and what the stage holds back, the one evidence writer, and the
 * stack's own moves, so a write from any owner lands, places and broadcasts
 * the way every other write does.
 */
export type CardStack = {
  cards: Map<string, Card>;
  staged: Map<string, Card>;
  asideUntilTurnEnd: Map<string, string>;
  answeringUntilCloseOut: Map<string, string>;
  contributedUntilCloseOut: Map<string, { writer: string; lifecycleId: string }>;
  evidence: CardEvidence;
  shown(id: string): Card | undefined;
  snapshot(): Card[];
  addMessage: CardService["addMessage"];
  placed(card: Card): void;
  scheduleBroadcast(): void;
  broadcastSnapshot(): void;
  topPriority(floor: number): number;
  othersOpen(taskId: string, except: string | undefined): boolean;
};

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
   * Cards their author answered the captain on and has not closed out
   * since, by card, with the lifecycle answered on (INF-1623): every
   * revision in that turn carries its own answer, as one while the reply
   * waits does. Memory only: a restart closes every author out.
   */
  private readonly answeringUntilCloseOut = new Map<string, string>();
  /** The newest `sentBackAt` handed out: stamps stay distinct inside one millisecond. */
  private lastSentBack = 0;
  /**
   * Cards holding a write from someone other than their author - a
   * revision the stage holds back, or an answer it named - whose writer has
   * not closed out since, by card, with that writer (`authorKey`) and the
   * lifecycle written on: that writer's turn end releases what the card
   * holds, never an unrelated turn of the card's own author. A card that
   * left the stack comes back under a new lifecycle, which no writer holds.
   * Memory only: a restart closes every author out.
   */
  private readonly contributedUntilCloseOut = new Map<
    string,
    { writer: string; lifecycleId: string }
  >();
  private presentation = "";
  private readonly threadOffers = new Map<string, string | undefined>();
  /** The record's evidence, the threads and the agents' emits, each over this stack. */
  private readonly evidence: CardEvidence;
  private readonly threads: CardThreads;
  private readonly emits: CardEmits;
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribeTasks: () => void;

  constructor(private readonly host: CardServiceHost) {
    this.evidence = new CardEvidence(host, this.cards);
    const stack: CardStack = {
      cards: this.cards,
      staged: this.staged,
      asideUntilTurnEnd: this.asideUntilTurnEnd,
      answeringUntilCloseOut: this.answeringUntilCloseOut,
      contributedUntilCloseOut: this.contributedUntilCloseOut,
      evidence: this.evidence,
      shown: (id) => this.shown(id),
      snapshot: () => this.snapshot(),
      addMessage: (...args) => this.addMessage(...args),
      placed: (card) => this.placed(card),
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastSnapshot: () => this.broadcastSnapshot(),
      topPriority: (floor) => this.topPriority(floor),
      othersOpen: (taskId, except) => this.othersOpen(taskId, except),
    };
    this.threads = new CardThreads(host, stack);
    this.emits = new CardEmits(host, stack, this.threads);
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
        this.evidence.write(
          { card: seeded, offer: true, opened: { lifecycle: "legacy-initial-snapshot" } },
          { basis: "legacy-initial-snapshot", source: "restore", cause: "restore" },
        );
      });
      this.cards.set(seeded.id, seeded);
    }
    // The dead process ended every author's turn, which is a close-out: a
    // card that waited on one reaches the stage now. One the captain's
    // reply holds stays off it until its author answers.
    for (const card of [...this.cards.values()]) {
      if (card.awaiting === "close-out") this.release(card, "restart");
      if (card.awaiting !== "answer" && card.lifecycleId) {
        host.cardStore.releaseRevisions(card.id, card.lifecycleId);
        if (
          !card.awaiting &&
          card.offerId &&
          !host.cardStore.currentUpdate(card.id, card.lifecycleId, card.offerId)
        )
          this.evidence.noteStage({ head: card, shown: card }, "restore", { source: "restore" });
        if (host.cardStore.unreleasedAnswer(card.id, card.lifecycleId))
          this.evidence.noteStage({ head: card, shown: card }, "close-out", {
            source: "host",
            closeOut: "restart",
            answer: true,
          });
      }
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
    this.host.tasks.readProjection(() => this.refreshSettleFactsInProjection(taskIds));
  }

  private refreshSettleFactsInProjection(taskIds?: readonly string[]): void {
    // The saved and shown revisions carry the same current task facts.
    // A new owner per pass keeps time wording fresh even in an outer read;
    // the task projection invalidates both records and facts after a write.
    const factsOwner = Symbol("settle facts");
    let changed = false;
    const refreshed = (card: Card): Card => {
      if (!card.taskId || (taskIds && !taskIds.includes(card.taskId))) return card;
      const taskId = card.taskId;
      return settleCardFacts(card, {
        facts: () => {
          const record = this.host.tasks.get(taskId);
          const read = () => this.host.settleFacts(taskId);
          return record ? this.host.tasks.projectedFact(record, factsOwner, read) : read();
        },
        othersOpen: () => this.othersOpen(taskId, card.id),
        mergeLabel: (shown) => this.host.mergeLabel?.(shown),
        mergeAnyway: (shown) => this.host.mergeAnyway?.(shown) === true,
      });
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

  /** A task's cards the captain closed or chose on (`CardStore.closedByCaptain`). */
  closedByCaptain(taskId: string): Card[] {
    return this.host.cardStore.closedByCaptain(taskId);
  }

  /** The crewmate's card the captain answered, never a merge decision: what a basis answered. */
  newestAnswerForTask(taskId: string): Card | undefined {
    return this.host.cardStore.newestAnswerForTask(taskId);
  }

  /** When the captain was last offered the card as it stands: its newest offer, else its creation. */
  shownAt(card: Card): number {
    return (
      (card.offerId ? this.host.cardStore.offer(card.id, card.offerId)?.at : undefined) ??
      card.createdAt
    );
  }

  /** A card's thread messages, oldest first. */
  messages(cardId: string): CardMessage[] {
    return this.host.cardStore.messages(cardId);
  }

  /** Whether a task's crewmate has emitted its completion card. */
  hasCompletionCard(taskId: string): boolean {
    return this.host.cardStore.hasCompletionCard(taskId);
  }

  /** A crewmate's card from its emit_card tool (`CardEmits`). */
  emitCrewmateCard(...args: Parameters<CardEmits["emitCrewmateCard"]>): string {
    return this.emits.emitCrewmateCard(...args);
  }

  /** The open completion card a crewmate's emit would revise in place (`CardEmits`). */
  openCompletionCard(taskId: string, declaredId: string | undefined): Card | undefined {
    return this.emits.openCompletionCard(taskId, declaredId);
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
    let observation: string | undefined;
    this.host.cardStore.transaction(() => {
      // A script-fired action may close a card, but it is not a captain
      // resolution in the next context block or a replayed human click.
      this.host.cardStore.resolve(
        card.id,
        by === "captain" ? resolution : `script:${resolution}`,
        answers,
      );
      observation = this.evidence.noteAction(card, action, { closes: true, answers, by, evidence });
      alongside?.();
      if (by === "captain") this.host.captainResponded?.(card, "choice", action);
    });
    this.cards.delete(card.id);
    this.staged.delete(card.id);
    const closedAnswer = this.recordResolution(card, action, by, answers, observation);
    this.scheduleBroadcast();
    return closedAnswer;
  }

  /**
   * The shared corner puts decisions, attention and pending notes aside;
   * an ordinary note leaves the stack as read. Neither path chooses an
   * action, receipts a pending answer task or ends work. An ordinary read
   * acknowledges its message and returns true so its author can hear it;
   * the marked saved answer keeps its receipt and ending for explicit Done.
   */
  dismiss(card: Card, submission?: unknown): boolean {
    if (cardLeaveOperation(cardPresentation(card), Boolean(card.awaiting)) === "aside") {
      this.setMinimized(card.id, true);
      return false;
    }
    const savedAnswer = card.taskId && this.answerNoteForTask(card.taskId)?.id === card.id;
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(card.id, "close");
      this.evidence.noteExit(card, "captain", "close-control", {
        reason: "dismissed",
        display: submissionDisplay(submission, card),
      });
      // Message acknowledgement does not end work. A marked saved answer
      // alone reserves its acknowledgement for explicit Done.
      if (!savedAnswer) this.host.captainResponded?.(card, "close");
    });
    this.cards.delete(card.id);
    this.staged.delete(card.id);
    // Reading an ordinary note may progress its author, never end its task.
    this.scheduleBroadcast();
    return !savedAnswer;
  }

  /** The captain explicitly receipts a saved answer, not a presentation change. */
  finishAnswer(taskId: string): boolean {
    const card = this.answerNoteForTask(taskId);
    if (!card) return false;
    if (this.cards.has(card.id)) this.dismiss(card);
    this.host.captainResponded?.(card, "close");
    return this.recordResolution(card, "answer-done", "captain");
  }

  /** The task-less question's explicit Dismiss, never a corner operation. */
  dismissQuestion(taskId: string): string | undefined {
    const record = this.host.tasks.get(taskId);
    const card = this.snapshot().find(
      (entry) => this.host.tasks.openCardTaskFor(entry.id)?.id === taskId,
    );
    if (record?.kind !== "decision" || !card || card.taskId)
      return "This question is no longer waiting.";
    let observation: string | undefined;
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(card.id, "close");
      observation = this.evidence.noteExit(card, "captain", "host", { reason: "dismissed" });
    });
    this.cards.delete(card.id);
    this.staged.delete(card.id);
    this.recordResolution(card, "dismissed", "captain", undefined, observation);
    this.scheduleBroadcast();
    return undefined;
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
   * the captain replied under keeps its place (`compareStack`).
   */
  taskSnapshot(): Card[] {
    this.evidence.pruneChanges();
    for (const [id, lifecycleId] of this.asideUntilTurnEnd) {
      if (this.cards.get(id)?.lifecycleId !== lifecycleId) this.asideUntilTurnEnd.delete(id);
    }
    // Task flags and minimized-card rows need the shown version and order,
    // not each card's message graph, task title or seen observation.
    return [...this.cards.values()].map((card) => this.stageVersion(card)).sort(compareStack);
  }

  /** The stage's full presentation, including task, message and seen facts. */
  snapshot(): Card[] {
    const asked = new Map<string, CardAsked | undefined>();
    return this.taskSnapshot().map((staged) => {
      const shown = {
        // Corner words and Done belong to the public view, not graph-free task flags.
        ...this.evidence.withChanges(this.onTheStage(staged)),
        ...this.evidence.updateState(staged),
        seen: staged.lifecycleId
          ? this.host.cardStore.lastSeenOffer(staged.id, staged.lifecycleId) !== undefined
          : false,
      };
      const task = shown.taskId ? this.host.tasks.get(shown.taskId) : undefined;
      const about = this.askedAbout(shown, asked);
      return {
        ...shown,
        ...(shown.author === "firstmate" && task ? { meta: task.title } : {}),
        ...(about ? { asked: about } : {}),
      };
    });
  }

  /** Accept only the released update actually drawn, never an old lifecycle or prepared successor. */
  seenUpdate(cardId: string, lifecycleId: string, updateId: string): void {
    const card = this.cards.get(cardId);
    const shown = card && this.onTheStage(card);
    if (
      !shown ||
      shown.lifecycleId !== lifecycleId ||
      !shown.offerId ||
      !onStage(shown) ||
      shown.minimized
    )
      return;
    if (!this.evidence.noteUpdateSeen(shown, lifecycleId, shown.offerId, updateId)) return;
    this.scheduleBroadcast();
  }

  /**
   * Where a card's work came from, for its line under the title (INF-1610,
   * INF-2326): the origin its task's graph leads to
   * (`TaskService.originAbout`), through the task it names or the task it
   * was raised on. `known` holds each task's answer for one snapshot.
   */
  private askedAbout(card: Card, known: Map<string, CardAsked | undefined>): CardAsked | undefined {
    const taskId = card.taskId ?? this.host.tasks.taskForCard(card.id)?.id;
    if (!taskId) return undefined;
    if (!known.has(taskId)) known.set(taskId, cardAskedOf(this.host.tasks.originAbout(taskId)));
    return known.get(taskId);
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
    const changes = this.evidence.changesSinceSeen(head, head.lifecycleId, head.offerId);
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
    this.evidence.noteSeen(shown, shown.lifecycleId, offerId);
  }

  /**
   * The card as the stage shows it: the version on it while a newer write
   * waits, under the head's own hold (what it awaits, where it was sent),
   * and still aside while its author's answer to that waits on its turn end.
   */
  private onTheStage(card: Card): Card {
    const shown = this.stageVersion(card);
    const record = card.taskId ? this.host.tasks.get(card.taskId) : undefined;
    const answer = record && this.answerNoteForTask(record.id);
    return {
      ...shown,
      corner: cardCornerOf(cardPresentation(shown), record?.key, Boolean(shown.awaiting)),
      ...(answer?.id === shown.id && record
        ? {
            answerDone: {
              taskId: record.id,
              label: ANSWER_DONE_LABEL,
              restWords: answerDoneRest(record.key),
            },
          }
        : {}),
    };
  }

  /** Saved note eligibility survives reading it, a restart and the author leaving. */
  answerNoteForTask(taskId: string): Card | undefined {
    const record = this.host.tasks.get(taskId);
    if (
      record?.status !== "active" ||
      record.kind !== "work" ||
      record.shape?.deliverable !== "answer"
    )
      return;
    const card = this.host.cardStore.newestForTask(taskId, "crewmate");
    return card?.answering &&
      card.actions.length === 0 &&
      !card.continues &&
      card.awaiting === undefined &&
      card.status === "ready" &&
      cardEmitter(card.id, taskId) === "crewmate"
      ? card
      : undefined;
  }

  private stageVersion(card: Card): Card {
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

  /** A card the Firstmate agent emits, its only user-facing output (`CardEmits`). */
  addFirstmateCard(input: EmittedCardInput): string {
    return this.emits.addFirstmateCard(input);
  }

  /** What an emit's id names for its caller (`CardThreads`). */
  targetOf(caller: CardCaller, rawId: string | undefined): ReturnType<CardThreads["targetOf"]> {
    return this.threads.targetOf(caller, rawId);
  }

  /** The line another writer wrote that answered a captain message (`CardThreads`). */
  answeredByContributor(cardId: string, messageId: number): CardMessage | undefined {
    return this.threads.answeredByContributor(cardId, messageId);
  }

  /** The host's words for a writer (`CardThreads`). */
  contributorOf(caller: CardCaller): CardContributor {
    return this.threads.contributorOf(caller);
  }

  /** One card's current facts for a writer about to edit or answer it (`CardThreads`). */
  cardRead(id: string): CardRead | undefined {
    return this.threads.cardRead(id);
  }

  /** Revise or answer someone else's card (`CardThreads`). */
  contribute(caller: CardCaller, raw: EmittedCardInput, facts: CardContribution): CardMutation {
    return this.threads.contribute(caller, raw, facts);
  }

  /** A line in a card's thread from any first mate or crewmate (`CardThreads`). */
  replyAs(...args: Parameters<CardThreads["replyAs"]>): CardMutation {
    return this.threads.replyAs(...args);
  }

  /** Correct a required action's words on its card (`CardThreads`). */
  reviseRequiredAction(...args: Parameters<CardThreads["reviseRequiredAction"]>): CardMutation {
    return this.threads.reviseRequiredAction(...args);
  }

  /** A host-presented Firstmate note with its record in one commit (`CardEmits`). */
  addRecordedFirstmateNote(...args: Parameters<CardEmits["addRecordedFirstmateNote"]>): string {
    return this.emits.addRecordedFirstmateNote(...args);
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
    let moved = false;
    const released: string[] = [];
    const key = authorKey(author);
    for (let card of [...this.cards.values()]) {
      const mine =
        author.kind === "firstmate"
          ? this.threads.firstmateAnswers(card)
          : card.author === "crewmate" && card.taskId === author.taskId;
      // Someone else's held write - a revision, or an answer it named -
      // moves the stage with its own writer's turn end, never with an
      // unrelated turn of the card's author (docs/card-threads.md, "Shared
      // cards"). The author's turn end still ends what it held for that
      // turn, and the writer's then releases everything the card holds.
      const held = this.contributedUntilCloseOut.get(card.id);
      const contributor =
        held !== undefined && held.lifecycleId === card.lifecycleId ? held.writer : undefined;
      const writer = contributor === key;
      if (!mine && !writer) continue;
      if (reason === "report" && this.reachedStage(card)) continue;
      if (mine) {
        this.answeringUntilCloseOut.delete(card.id);
        if (this.asideUntilTurnEnd.delete(card.id)) moved = true;
      }
      if (contributor !== undefined && !writer) continue;
      this.contributedUntilCloseOut.delete(card.id);
      let wrote = false;
      if (card.awaiting !== "answer" && card.lifecycleId) {
        if (this.host.cardStore.releaseRevisions(card.id, card.lifecycleId)) {
          moved = true;
          wrote = true;
          released.push(card.id);
        }
      }
      const answer =
        card.lifecycleId !== undefined &&
        this.host.cardStore.unreleasedAnswer(card.id, card.lifecycleId);
      const staged = this.staged.has(card.id);
      // The captain put the card aside while its author's newer write - a
      // revision or an answer - waited here, so he never saw it: it comes
      // back with it, the same as a write on a card already aside (INF-1472).
      const written = wrote || staged || answer || card.awaiting === "close-out";
      if (card.minimized && card.awaiting !== "answer" && written) {
        const { minimized: _aside, ...back } = card;
        this.host.cardStore.upsert(back);
        this.cards.set(card.id, back);
        card = back;
        moved = true;
      }
      if (card.awaiting === "close-out") this.release(card, reason);
      else if (card.awaiting === "answer") continue;
      else if (staged || answer) {
        // The stage moves from the version it held to the author's newest.
        this.host.cardStore.transaction(() =>
          this.evidence.noteStage({ head: card, shown: card }, "close-out", {
            source: "host",
            closeOut: reason,
            answer,
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
  private release(card: Card, reason: CloseOut, held = false): void {
    // A story note waits for its task's merge, not its author (INF-2533).
    if (!held && card.awaiting === "close-out" && this.host.holdsUntilMerge?.(card)) return;
    const { awaiting: _awaiting, sentBackAt: _sentBackAt, ...shown } = card;
    this.host.cardStore.transaction(() => {
      this.host.cardStore.upsert(shown);
      this.evidence.noteStage({ head: shown, shown }, "close-out", {
        source: "host",
        closeOut: reason,
      });
    });
    this.cards.set(card.id, shown);
    this.host.cardPlaced?.(shown);
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
   * Hold a card, waiting on `awaiting`. A captain's reply (`answer`) never
   * moves the card: it stays shown, stamped `sentBackAt`, until close-out
   * (docs/card-threads.md). The write runs in the caller's transaction; the
   * stack moves once it committed (`applyHold`).
   */
  private writeHold(
    id: string,
    awaiting: CardAwaiting,
    by: { actor: CardObservationActor; source: CardObservationSource },
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
        ? { sentBackAt: this.sentBackStamp() }
        : sentBackAt !== undefined
          ? { sentBackAt }
          : {}),
    };
    this.host.cardStore.upsert(held);
    this.evidence.noteStage(
      { head: held, shown: held },
      awaiting === "answer" ? "reply" : "answered",
      by,
    );
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
   * An author explicitly withdraws its own offer: resolve the row, remove
   * the card from the stack and broadcast. Does not decommission a crewmate.
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
      // An offer ends on an explicit action or its AUTHOR's withdrawal;
      // putting it away never resolves it. Words about someone else's card
      // are a steer to that author, not permission to withdraw it.
      throw new Error(
        `Card "${id}" is not yours to close: only its author withdraws it, and only the captain dismisses a card they are looking at. To change what it says, revise it yourself under its full id with expected_revision, or write on its thread with reply.`,
      );
    }
    if (actor.kind === "crewmate" && card.taskId !== actor.taskId) {
      throw new Error(`Crewmate cannot close card "${id}" (not emitted by this task).`);
    }
    const why = reason?.trim() || "closed";
    let observation: string | undefined;
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(id, why);
      observation = this.evidence.noteExit(card, actor.kind, "tool", {
        reason: "author-withdrawal",
        ...(reason?.trim() ? { note: why } : {}),
      });
    });
    this.cards.delete(id);
    this.staged.delete(id);
    this.recordResolution(card, "closed", actor.kind, undefined, observation);
    this.scheduleBroadcast();
    return `Closed card "${card.title}" (${id}).`;
  }

  /** A closed card as the captain last saw it, read-only (FI3-579); never changes anything. */
  past(cardId: string): PastCard | undefined {
    if (this.cards.has(cardId)) return undefined;
    return this.host.cardStore.past(cardId);
  }

  /** A card's thread as it stands, oldest first (`CardThreads`). */
  thread(cardId: string): CardThread {
    return this.threads.thread(cardId);
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
    interim = false,
    facts: MessageFacts = {},
  ): CardMessage {
    // The captain's line holds the card, still shown, until a line answers
    // it and that line's writer closes out. An author's interim line,
    // declared as one, keeps the hold too: it says what the author is
    // doing, and the answer is still owed (INF-990 friction 3).
    // A line ends the captain's question only when it says so: it names the
    // one the card waits on in `facts.answersMessage`, whoever wrote it
    // (docs/card-threads.md, "Shared cards"; the captain's "Only a line that
    // says it answers it; a handoff stays open"). Any other line - a
    // handoff, a comment, the host's "revised:" - leaves it waiting.
    // An author's line brings back a card the captain put aside: the
    // Firstmate's at once, a crewmate's when its turn ends (INF-926). A line
    // that leaves their question waiting - an interim line or a handoff - does
    // not: the card comes back with the final answer (INF-1623).
    const contributed = facts.contributor !== undefined;
    const asking = this.cards.get(cardId)?.awaiting === "answer";
    const waiting = !interim && asking;
    const answersMessage = facts.answersMessage;
    const question =
      waiting && answersMessage !== undefined && (who === "crewmate" || who === "firstmate")
        ? this.host.cardStore.newestCaptainMessage(cardId)
        : undefined;
    const answered = question !== undefined && answersMessage === question.id;
    const settles = answered || (!interim && !asking);
    if (who === "firstmate" && settles && !contributed) this.setMinimized(cardId, false);
    if (who === "crewmate" && settles && !contributed) this.backAtTurnEnd(cardId);
    if (answered && contributed) this.setMinimized(cardId, false);
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
        ...(facts.contributor ? { contributor: facts.contributor } : {}),
        ...(answersMessage !== undefined && who !== "host" ? { answersMessage } : {}),
        ...(facts.clarification ? { clarification: true as const } : {}),
        ...(facts.responseId ? { responseId: facts.responseId } : {}),
      });
      if (about) this.evidence.noteMessage(about, message, by, { interim, answers, submission });
      if (who === "captain") held = this.writeHold(cardId, "answer", by);
      else if (answered) held = this.writeHold(cardId, "close-out", by);
      return message;
    });
    if (who === "captain" || answered) this.applyHold(cardId, held);
    if (
      answered &&
      !contributed &&
      card?.lifecycleId &&
      (who === "crewmate" || who === "firstmate")
    ) {
      this.answeringUntilCloseOut.set(cardId, card.lifecycleId);
    }
    // Another writer's answer reaches the stage when that writer's turn ends.
    if (answered && facts.contributor && card?.lifecycleId) {
      this.contributedUntilCloseOut.set(cardId, {
        writer: authorKey(facts.contributor),
        lifecycleId: card.lifecycleId,
      });
    }
    this.host.broadcastThread?.(this.thread(cardId));
    // An author's answer is a row on the card's task too (FI3-1189's rule
    // 1); the captain's reply already is one, through its steer or its ask.
    if ((who === "crewmate" || who === "firstmate") && about) {
      const task = about.taskId
        ? this.host.tasks.get(about.taskId)
        : (this.host.tasks.openCardTaskFor(cardId) ?? this.host.tasks.taskForCard(cardId));
      if (task) {
        this.host.tasks.recordReply(task.id, {
          cardId,
          title: about.title,
          text,
          actor: who,
          ...(facts.contributor
            ? {
                contributor: {
                  ...(facts.contributor.taskId ? { taskId: facts.contributor.taskId } : {}),
                  label: facts.contributor.label,
                },
              }
            : {}),
        });
      }
    }
    return message;
  }

  /** The Firstmate's closing words as its line on a card it answers (`CardThreads`). */
  recordFirstmateThreadAnswer(cardId: string, text: string): boolean {
    return this.threads.recordFirstmateThreadAnswer(cardId, text);
  }

  /** Open cards on a session that have a thread, for Observe (`CardThreads`). */
  observeThreads(sessionId: string): ReturnType<CardThreads["observeThreads"]> {
    return this.threads.observeThreads(sessionId);
  }

  /** A crewmate's line in a card's thread, its `reply` output (`CardThreads`). */
  replyFromCrewmate(...args: Parameters<CardThreads["replyFromCrewmate"]>): string {
    return this.threads.replyFromCrewmate(...args);
  }

  /** Whether a captain reply on this open card still waits for its answer. */
  answerOwed(cardId: string): boolean {
    return this.threads.answerOwed(cardId);
  }

  /** Whether any of a task's open cards waits on an author answer (`CardThreads`). */
  threadAwaitingAuthor(taskId: string): boolean {
    return this.threads.threadAwaitingAuthor(taskId);
  }

  /** The task's open cards waiting on an author answer, oldest first (`CardThreads`). */
  threadsAwaitingAuthor(taskId: string): { id: string; title: string }[] {
    return this.threads.threadsAwaitingAuthor(taskId);
  }

  /** What a task's crew line says about its threads (`CardThreads`). */
  threadFact(taskId: string): string | undefined {
    return this.threads.threadFact(taskId);
  }

  /** The thread facts of a roster read, by task (`CardThreads`). */
  threadFacts(taskIds: readonly string[]): Map<string, string> {
    return this.threads.threadFacts(taskIds);
  }

  /**
   * The captain confirmed a card repeats an earlier one (WI-14,
   * flag_duplicate): the label is stamped write-once, and a duplicate still
   * on the stack closes with resolution `duplicate` and one feed line. No
   * card and no setting: the label is data for the duplicate metric.
   */
  flagDuplicate(input: { cardId: string; duplicateOf: string; note: string }): DuplicateResult {
    const open = this.cards.get(input.cardId);
    let observation: string | undefined;
    const result = this.host.cardStore.transaction(() => {
      const result = this.host.cardStore.flagDuplicate(input);
      if (result.status === "flagged" && open) {
        this.host.cardStore.resolve(open.id, "duplicate");
        // The Firstmate's tool stamps the label the captain confirmed.
        observation = this.evidence.noteExit(open, "firstmate", "tool", {
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
      this.recordResolution(open, "closed", "captain", undefined, observation);
      this.scheduleBroadcast();
    }
    this.host.broadcastEvent({
      type: "firstmate_note",
      text: `Closed "${result.card.title}" as a duplicate of "${result.original.title}".`,
    });
    return result;
  }

  /**
   * An explicit card resolution (P1): its task hears `card_resolved`,
   * and a decision task the Firstmate raised without a task closes with the
   * choice - answered on an action, cancelled on a dismiss, superseded when
   * the agent withdrew it.
   *
   * On an ANSWER task the captain's choice is also the CLOSE (Task B,
   * captain F2 A): the card was the deliverable, and answering it closes
   * the row `done/answered`, unless its crewmate declared the card
   * `continues` (INF-1226). Explicit Done also receipts a marked saved
   * answer. The corner never ends work: aside and saved-answer reads send
   * no author notification. Only an ordinary read or duplicate closure
   * reaches the live author, through the separate `tellCardClosed` path;
   * only the ordinary read acknowledges its note.
   * Returns whether it closed, because the click's ordinary round-trip to a
   * still-running crewmate has nowhere to go once the task is closed.
   * `observation` is the card evidence's record of the same resolution,
   * which the task's event names as that occurrence (its alias on
   * the unified timeline, docs/task-record.md).
   */
  private recordResolution(
    card: Card,
    action: string,
    by: "captain" | "firstmate" | "crewmate" = "captain",
    answers?: CardAnswer[],
    observation?: string,
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
        ...(answers ? { answers } : {}),
        ...(observation ? { observation } : {}),
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
        ...(observation ? { observation } : {}),
      });
      // This explicit resolution resynchronizes the captain gate, with
      // the action as its timeline reason. A real gate change restarts the
      // idle clock; putting a card aside never enters this path.
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
   * `reviseOnly` never recreates a card removed by a choice or withdrawal.
   * A card put aside remains pending rather than acquiring a refusal.
   */
  addFirstmatePauseCard(input: FirstmatePauseCard, options: { reviseOnly?: boolean } = {}): void {
    const id = firstmatePauseCardId(input);
    const previous = this.cards.get(id);
    if (!previous && options.reviseOnly) return;
    const next = firstmatePauseCard(id, input);
    if (
      previous &&
      previous.title === next.title &&
      previous.body === next.body &&
      JSON.stringify(previous.actions) === JSON.stringify(next.actions)
    ) {
      return;
    }
    this.put({ ...next, createdAt: previous?.createdAt ?? this.host.now() });
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
    this.put({ ...firstmateMoveBackCard(input), createdAt: this.host.now() });
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
    this.put({ ...authDecisionCard(id, meta, body, options), createdAt: this.host.now() });
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
    options: { reauth?: boolean; cli?: boolean } = {},
  ): void {
    if (this.cards.has(id)) return;
    this.put({
      ...forgeSignInCard(id, host, name, waitingChanges, options),
      createdAt: this.host.now(),
    });
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
    this.put({ ...deviceForgeSignInCard(id, input), createdAt: this.host.now() });
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
   * same id) by a core service that owns the question, such as the plugin
   * consent card (Phase A, A2a). The host stamps the author and the
   * priority; the caller's actions carry host effects only the captain's
   * click can run. A note (no choice to make, such as a clicked merge's
   * pending note) sits below every decision, so a question it accompanies -
   * signing in again - stays in front.
   */
  raiseHostCard(
    card: Omit<Card, "author" | "priority" | "status" | "createdAt">,
    options: { note?: boolean } = {},
  ): void {
    const previous = this.cards.get(card.id);
    this.put({ ...hostCard(card, options), createdAt: previous?.createdAt ?? this.host.now() });
  }

  /** Takes a host card down without an answer: the question it asked is gone. */
  withdrawHostCard(id: string, reason: string): void {
    if (this.cards.get(id)?.author !== "host") return;
    this.takeDown(id, reason);
  }

  /** Presentation state and the card commit together, so a crash cannot lose its first offer. */
  presentRequiredAction(taskId: string): boolean {
    if (!this.host.tasks.captainActionReady(taskId)) return false;
    const current = this.host.tasks.get(taskId)?.delivery?.captainAction;
    // Reopening an already shown generation must not erase a pending reply.
    if (
      current &&
      current.presentedGeneration === current.generation &&
      this.cards.has(current.cardId)
    )
      return true;
    this.host.tasks.atomic(
      () => {
        const action = this.host.tasks.presentCaptainAction(taskId);
        if (!action) throw new Error("The required action is no longer ready.");
        const next = requiredActionCard(
          taskId,
          action,
          this.host.now(),
          requiredActionProvenance(this.host.tasks),
        );
        const stamped = this.evidence.stamp({
          ...next,
          width: decidedCardWidth({ body: next.body }),
        });
        this.evidence.write(stamped, { basis: "put", source: "host", cause: "put" });
        return stamped.card;
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
  put(next: Card, options: { revise?: boolean } = {}): void {
    const stamped = this.evidence.stamp({
      ...next,
      width: decidedCardWidth({
        body: next.body,
        pictures: next.pictures,
        width: next.width === "regular" ? undefined : next.width,
      }),
    });
    const card = stamped.card;
    this.host.cardStore.transaction(() => {
      this.evidence.write(stamped, {
        ...(options.revise ? { revise: true } : {}),
        basis: "put",
        source: "host",
        cause: "put",
      });
    });
    this.cards.set(card.id, card);
    this.placed(card);
    this.scheduleBroadcast();
  }

  /**
   * The host rewrites an open card's body in place, as a revision of the
   * same card (`cardStore.revise`) with an offer of its own, so the stage
   * marks what changed since the captain last looked: the merge line on a
   * self-merging task's story note (INF-1219). A card no longer on the
   * stack, or a body that is the same, changes nothing.
   */
  reviseBody(id: string, body: string): void {
    const existing = this.cards.get(id);
    if (!existing || existing.body === body) return;
    const stamped = this.evidence.stamp({ ...existing, body });
    this.host.cardStore.transaction(() => {
      this.evidence.write(stamped, { revise: true, basis: "put", source: "host", cause: "put" });
    });
    this.cards.set(id, stamped.card);
    this.staged.delete(id);
    this.scheduleBroadcast();
  }

  /**
   * A closed task's notes still waiting on its crewmate reach the stage:
   * the crewmate is gone. The Firstmate is not, so a reply on its note
   * keeps its wait. A close calls it after writing its outcome on the
   * note, so a story note held for the merge shows once, with its merged
   * line (INF-2533).
   */
  releaseNotes(taskId: string): void {
    let moved = false;
    for (const card of [...this.cards.values()]) {
      if (card.taskId !== taskId || card.author !== "crewmate" || card.awaiting === undefined)
        continue;
      if (card.actions.length > 0) continue;
      this.release(card, "idle");
      moved = true;
    }
    if (moved) this.scheduleBroadcast();
  }

  /**
   * A merge that kept the task open has a result (INF-2533): a story note
   * held for it shows once, its body first revised by `revise`.
   */
  showHeld(taskId: string, revise: (body: string) => string): void {
    for (const card of [...this.cards.values()]) {
      if (card.taskId !== taskId || card.awaiting !== "close-out" || !isStoryNote(card)) continue;
      if (!this.host.holdsUntilMerge?.(card, true)) continue;
      this.reviseBody(card.id, revise(card.body));
      const revised = this.cards.get(card.id);
      if (revised) this.release(revised, "idle", true);
    }
    this.scheduleBroadcast();
  }

  /**
   * Whether something besides the card `except` keeps the task open past
   * its merge (INF-2525): an open question, or another pull request.
   */
  private othersOpen(taskId: string, except: string | undefined): boolean {
    for (const card of this.cards.values())
      if (card.taskId === taskId && card.id !== except && keepsTaskOpen(card)) return true;
    return this.host.otherChangeOpen?.(taskId) === true;
  }

  /** Take a card down unanswered: the question it asked is gone. */
  takeDown(id: string, resolution: string): void {
    const card = this.cards.get(id);
    if (!card) return;
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(id, resolution);
      this.evidence.noteExit(card, "host", "host", { reason: "host-withdrawal", note: resolution });
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
    this.host.cardPlaced?.(card);
    if (card.taskId) {
      this.host.syncCaptainGate(card.taskId, this.host.now());
      // Its merge card's line follows what else is open (INF-2525).
      this.refreshSettleFacts([card.taskId]);
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
      this.refreshSettleFacts([card.taskId]);
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
   * The crewmate's open completion card's merge action on a task, when one is up: the
   * card, the action the host itself attached (`withCompletionActions`),
   * and the label the captain is reading. Found by the declared EFFECT, the
   * way every other host dispatch is, never by an action id.
   */
  openMergeAction(
    taskId: string,
  ): { cardId: string; cardTitle: string; actionId: string; label: string } | undefined {
    for (const card of this.cards.values()) {
      if (card.taskId !== taskId || card.author !== "crewmate") continue;
      const merge = card.actions.find(
        (action) => settleEffectOf(action)?.mode === "merge" && !action.passes,
      );
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
        // once the close wrote its outcome on it (`releaseNotes`).
        this.staged.delete(cardId);
        this.asideUntilTurnEnd.delete(cardId);
        continue;
      }
      this.host.cardStore.transaction(() => {
        this.host.cardStore.resolve(cardId, reason);
        this.evidence.noteExit(card, "host", "host", { reason: "task-retired", note: reason });
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
    this.put({ ...firstmateQuietCard(body), createdAt: this.host.now() });
  }

  /** Activity resumed or the turn ended: the quiet question answered itself. */
  clearFirstmateQuietCard(): void {
    this.takeDown(FIRSTMATE_QUIET_CARD_ID, "activity-resumed");
  }

  /**
   * The Firstmate failure card (the agent-down set, ruling D6): the turn
   * failed and no agent can answer, so the host offers the one way out -
   * Retry, a host effect. One card under a stable id: a repeated failure
   * (a provider outage across several turns) revises it in place rather
   * than stacking copies.
   */
  addFirstmateFailureCard(body: string): void {
    const existing = this.cards.get(FIRSTMATE_FAILURE_CARD_ID);
    this.put(
      { ...firstmateFailureCard(body), createdAt: existing?.createdAt ?? this.host.now() },
      { revise: existing !== undefined },
    );
  }

  /** An app-raised note card (for example the mic permission primer). */
  addSystemNoteCard(id: string, title: string, body: string): void {
    if (this.cards.has(id)) return;
    this.put({ ...systemNoteCard(id, title, body), createdAt: this.host.now() });
  }

  /** Every card whose thread moved since `since`, newest first (`CardThreads`). */
  threadActivitySince(since: number, limit?: number): ThreadActivity[] {
    return this.threads.threadActivitySince(since, limit);
  }

  /** Who owes an answer on a card now (`CardThreads`). */
  owed(cardId: string): ThreadOwed {
    return this.threads.owed(cardId);
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

/** A task's origin line as the card carries it (`cardAskedSchema`). */
function cardAskedOf(line: TaskOriginLine | undefined): CardAsked | undefined {
  if (!line) return undefined;
  if (line.kind === "from") return { at: line.at, text: line.title, kind: "from", key: line.key };
  const through = line.through > 0 ? { through: line.through } : {};
  switch (line.kind) {
    case "asked":
      return { at: line.at, text: line.text, ...through };
    case "said":
      return { at: line.at, text: line.text, kind: "said", ...through };
    case "chose":
      return { at: line.at, text: line.text, kind: "chose", choice: line.choice, ...through };
    case "automation":
      return { at: line.at, text: line.name, kind: "automation", ...through };
  }
}
