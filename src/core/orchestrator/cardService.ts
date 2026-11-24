import { randomUUID } from "node:crypto";
import { withAppDecline } from "@shared/cardDecline";
import {
  ANSWER_DONE_LABEL,
  cardCornerOf,
  NOTE_DONE_ACTION_ID,
  NOTE_GOT_IT_LABEL,
  noteDoneOf,
} from "@shared/cardLeave";
import type { CardRevisionLinks, ChoiceCarriedRecord, TaskFactsPart } from "@shared/cards";
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
  firstmateOwnCard,
  isPreviewBody,
  keepsTaskOpen,
  mergeEffectOf,
  onStage,
  type PastCard,
} from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { shortTaskTitle } from "@shared/taskTitle";
import { decidedCardWidth } from "../pi/cardWidth";
import type { EmittedCardInput } from "../session/tools";
import type { CardResolution, DuplicateResult, ResolutionHead } from "../storage/cardStore";
import type { SeenMergeAct } from "../storage/taskRecords";
import type { TaskOriginLine } from "../tasks/taskOrigin";
import { CardEmits, cardEmitter, FIRSTMATE_CARD_PREFIX, type OwnCardWrite } from "./cardEmit";
import { CardEvidence, type CardInteractionEvidence } from "./cardEvidence";
import { cardShapeMarks } from "./cardShapeMarks";
import type { CardAuthorRef, CardServiceHost, CardStack, CloseOut } from "./cardStackTypes";
import { CardStage } from "./cardStage";
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
import { ENDED_STAYS, EndedCards } from "./endedCards";
import { HostCardStack } from "./hostCardStack";
import { PutOffs } from "./putOffs";
import type { WakeCard } from "./reportWakes";
import { requiredActionCard, requiredActionProvenance } from "./requiredActionCard";
import { asksAbout, openReviewQuestions, reviewedTaskOf } from "./reviewCard";
import type { ReworkVerdict } from "./reworkHold";
import { type MergeBehind, settleCardFacts } from "./settleCardFacts";
import { type OpenMergeAction, openMergeActionIn } from "./settleHost";
import { withMergeLine } from "./settleWords";
import { seenMergeOf } from "./sinceSeen";

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

/**
 * What close_card tells an author who withdrew a decision (INF-2828): every
 * action closes its card, so an open one the author withdraws holds no
 * action the captain chose. A reply in its thread is not on that record.
 */
export const WITHDRAWN_UNCHOSEN =
  "The captain chose none of its actions: its record ends as your withdrawal.";

export class CardService {
  /** The open cards as their authors last wrote them: the record. */
  private readonly cards = new Map<string, Card>();
  /** Cards ended while the captain had seen them, which only the views' stack draws (INF-3071). */
  readonly ended: EndedCards;
  /** What the stage holds back on each open card (`CardStage`). */
  private readonly stage = new CardStage();
  /** A held merge card's recheck is queued for after the current record change. */
  private recheckQueued = false;
  /** The newest `sentBackAt` handed out: stamps stay distinct inside one millisecond. */
  private lastSentBack = 0;
  private presentation = "";
  private readonly threadOffers = new Map<string, string | undefined>();
  private readonly evidence: CardEvidence;
  readonly threads: CardThreads;
  private readonly emits: CardEmits;
  readonly hostCards: HostCardStack;
  /** The put-off choices the host keeps and raises again (INF-3846 piece 3). */
  readonly putOffs: PutOffs;
  /** The reading each merge card behind its change was last handed on at (`mergeFellBehind`). */
  private readonly toldBehind = new Map<string, string>();
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribeTasks: () => void;

  constructor(private readonly host: CardServiceHost) {
    this.hostCards = new HostCardStack(
      host,
      this.cards,
      (card, options) => this.put(card, options),
      (id, reason) => this.takeDown(id, reason),
    );
    this.evidence = new CardEvidence(host, this.cards);
    this.putOffs = new PutOffs({
      now: host.now,
      tasks: host.tasks,
      cardStore: host.cardStore,
      // The same card, back on top: its answer was only put off.
      raise: ({ minimized: _aside, awaiting: _held, ...card }) =>
        this.put({ ...card, priority: this.topPriority(card.priority) }),
    });
    this.ended = new EndedCards(host.cardStore, this);
    const stack: CardStack = {
      cards: this.cards,
      stage: this.stage,
      evidence: this.evidence,
      shown: (id) => this.shown(id),
      snapshot: () => this.snapshot(),
      addMessage: (...args) => this.addMessage(...args),
      placed: (card) => this.placed(card),
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastSnapshot: () => this.broadcastSnapshot(),
      topPriority: (floor) => this.topPriority(floor),
      othersOpen: (taskId, except) => this.othersOpen(taskId, except),
      resolve: (...args) => this.resolve(...args),
      ended: this.ended,
    };
    this.threads = new CardThreads(host, stack);
    this.emits = new CardEmits(host, stack, this.threads, this.putOffs);
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
    this.ended.restore();
    // A note whose merge came while the app was closed reads merged before
    // it shows (INF-2678).
    this.refreshSettleFacts();
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
    this.unsubscribeTasks = host.tasks.onChange(({ taskIds }) => {
      this.refreshSettleFacts(taskIds);
      this.recheckAfterChange();
    });
    if (this.cards.size > 0 || this.ended.size > 0) this.scheduleBroadcast();
  }

  /**
   * A record change may end what holds a reworked merge card; its return
   * writes the task, so it runs once the change seam has finished.
   */
  private recheckAfterChange(): void {
    if (this.recheckQueued || this.stage.forChecks().length === 0) return;
    this.recheckQueued = true;
    queueMicrotask(() => {
      this.recheckQueued = false;
      this.recheckHeld();
    });
  }

  dispose(): void {
    this.unsubscribeTasks();
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = undefined;
  }

  /**
   * Host facts follow the record, not an author's revision or close-out:
   * the fact strip, the words of the merge it names (INF-23), and a story
   * note's merge line, drawn from its change's receipt (INF-2678). It runs
   * from the task change seam, so it writes no task itself.
   */
  refreshSettleFacts(taskIds?: readonly string[]): void {
    this.host.tasks.readProjection(() => this.refreshSettleFactsInProjection(taskIds));
  }

  /**
   * A settle of these tasks ended (INF-2678): a story note held for its
   * task's merge (INF-2533) shows once its merge line reads merged, so it
   * shows once, as the settle that merged it ends.
   */
  releaseMerged(taskIds: readonly string[]): void {
    this.refreshSettleFacts(taskIds);
    let released = false;
    for (const id of this.stage.forMerge()) {
      const card = this.cards.get(id);
      if (!card?.taskId || !taskIds.includes(card.taskId)) continue;
      if (card.awaiting !== "close-out" || !this.host.mergedLine?.(card)) continue;
      this.release(card, "idle");
      released = true;
    }
    if (released) this.scheduleBroadcast();
  }

  /** Whether the card stack draws this card's merged line from its change's receipt. */
  drawsMergedLine(card: Card): boolean {
    return this.host.mergedLine?.(card) !== undefined;
  }

  private refreshSettleFactsInProjection(taskIds?: readonly string[]): void {
    // The saved and shown revisions carry the same current task facts.
    // A new owner per pass keeps time wording fresh even in an outer read;
    // the task projection invalidates both records and facts after a write.
    // One owner for each part of the strip a card may carry (`taskFactsPartOf`).
    const factsOwners = {
      whole: Symbol("settle facts"),
      reference: Symbol("settle facts reference"),
    } satisfies Record<TaskFactsPart, symbol>;
    let changed = false;
    const fellBehind = new Map<string, MergeBehind>();
    const refreshed = (card: Card): Card => {
      // A reviewer's own Review finding card draws its builder's facts (INF-4338).
      const taskId = reviewedTaskOf(card, this.host.tasks) ?? card.taskId;
      if (!taskId || (taskIds && !taskIds.includes(taskId))) return card;
      const line = this.host.mergedLine?.(card);
      if (line) {
        const body = withMergeLine(card.body, line);
        if (body !== card.body) card = { ...card, body };
      }
      return settleCardFacts(card, {
        facts: (part) => {
          const record = this.host.tasks.get(taskId);
          const read = () => this.host.settleFacts(taskId, part);
          return record ? this.host.tasks.projectedFact(record, factsOwners[part], read) : read();
        },
        othersOpen: () => this.othersOpen(taskId, card.id),
        mergeLabel: (shown) => this.host.mergeLabel?.(shown),
        mergeAnyway: (shown) => this.host.mergeAnyway?.(shown) === true,
        ...(this.host.mergeBehind
          ? {
              behind: (shown: Card) => {
                const behind = this.host.mergeBehind?.(shown);
                if (behind) fellBehind.set(shown.id, behind);
                return behind;
              },
            }
          : {}),
        followups: () => this.host.followupNotice(taskId),
        reviewQuestions: () =>
          openReviewQuestions(this.cards.values(), taskId, this.host.tasks).map(
            (question) => question.title,
          ),
      });
    };
    for (const [id, card] of this.cards) {
      const next = refreshed(card);
      if (next !== card) {
        this.cards.set(id, next);
        this.host.cardStore.upsert(next);
        changed = true;
      }
      const { shown } = this.stage.of(next);
      if (shown) {
        const nextShown = refreshed(shown);
        if (nextShown !== shown) {
          this.stage.hold(next, { shown: nextShown });
          changed = true;
        }
      }
    }
    if (changed) this.scheduleBroadcast();
    // The redraw or wake writes, so it runs once this read is over, and once
    // per card and reading: what it writes runs this pass again.
    const tell = this.host.mergeFellBehind;
    for (const [id, behind] of fellBehind) {
      const reading = `${behind.why}:${behind.shown}:${behind.current}:${behind.newest}:${behind.published}`;
      if (this.toldBehind.get(id) === reading) fellBehind.delete(id);
      else this.toldBehind.set(id, reading);
    }
    if (tell && fellBehind.size > 0)
      queueMicrotask(() => {
        for (const [id, behind] of fellBehind) if (this.cards.has(id)) tell(id, behind);
      });
  }

  get(id: string): Card | undefined {
    return this.cards.get(id);
  }

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

  /** A task's cards the captain saw, passing over lifecycles their author withdrew. */
  seenCards(taskId: string): { cardId: string; at: number }[] {
    return this.host.cardStore.seenCards(taskId);
  }

  /** A card's thread messages, oldest first. */
  messages(cardId: string): CardMessage[] {
    return this.host.cardStore.messages(cardId);
  }

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
    ends?: { by: "crewmate" | "firstmate" },
  ): boolean {
    // The row and the action it records commit together, before the stack
    // moves: a choice that could not be kept is never shown as made. What
    // the choice grants (`alongside`: a merge approval, FI3-304) commits in
    // the same transaction. A card its author's mark resolves (`ends`, a
    // crewmate's sign-off) stays in front of a captain who had seen it,
    // ended, with one Close, as `close` keeps one (INF-3071).
    let observation: string | undefined;
    const shown = ends ? this.snapshot().find((entry) => entry.id === card.id) : undefined;
    let kept: Card | undefined;
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
      if (ends) kept = this.ended.end(shown, ends.by, undefined, this.host.now());
    });
    this.drop(card.id);
    if (ends) this.ended.hold(card.id, kept);
    const closedAnswer = this.recordResolution(
      card,
      action,
      by,
      answers,
      observation,
      evidence?.carried,
    );
    this.scheduleBroadcast();
    return closedAnswer;
  }

  /**
   * The shared corner only ever puts a card aside (INF-2794): it chooses no
   * action, reads no note, receipts no answer and ends no work.
   */
  dismiss(card: Card): void {
    this.setMinimized(card.id, true);
  }

  /**
   * A live note's own button (INF-2794): Done on the marked answer note of
   * an active answer task closes that task as answered; Got it on any other
   * note reads it. Returns which it was, or undefined for a card that is not
   * a live note. Only Got it acknowledges the note to its author.
   */
  pressNote(card: Card, submission?: unknown): "done" | "got-it" | undefined {
    if (!this.cards.has(card.id) || cardPresentation(card) !== "note") return undefined;
    if (card.taskId && this.answerNoteForTask(card.taskId)?.id === card.id) {
      this.finishAnswer(card.taskId, submission);
      return "done";
    }
    this.readNote(card, NOTE_GOT_IT_LABEL, submission, true);
    return "got-it";
  }

  /**
   * The note leaves the stack as read, its past card naming the button the
   * captain pressed. Only an ordinary read acknowledges its message; a marked
   * saved answer's acknowledgement belongs to its Done.
   */
  private readNote(card: Card, label: string, submission: unknown, acknowledge: boolean): void {
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(card.id, "close");
      this.evidence.noteAction(
        { ...card, actions: [{ id: NOTE_DONE_ACTION_ID, label }] },
        NOTE_DONE_ACTION_ID,
        { closes: true, by: "captain", evidence: { source: "chrome", submission } },
      );
      if (acknowledge) this.host.captainResponded?.(card, "close");
    });
    this.drop(card.id);
    this.scheduleBroadcast();
  }

  /** The captain explicitly receipts a saved answer, not a presentation change. */
  finishAnswer(taskId: string, submission?: unknown): boolean {
    const card = this.answerNoteForTask(taskId);
    if (!card) return false;
    if (this.cards.has(card.id)) this.readNote(card, ANSWER_DONE_LABEL, submission, false);
    this.host.captainResponded?.(card, "close");
    return this.recordResolution(card, "answer-done", "captain");
  }

  /** The shown task-less question a decision row waits on, for the record's Decline (INF-3108). */
  questionCard(taskId: string): Card | undefined {
    if (this.host.tasks.get(taskId)?.kind !== "decision") return undefined;
    const card = [...this.cards.values()].find(
      (entry) => this.host.tasks.capture.openCardTaskFor(entry.id)?.id === taskId,
    );
    return card && !card.taskId ? this.shown(card.id) : undefined;
  }

  /** A task that never started leaves no card rows behind. */
  deleteRowsForTask(taskId: string): void {
    this.host.cardStore.deleteForTask(taskId);
    this.ended.drop(taskId);
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
    this.ended.drop(taskId);
    for (const [cardId, card] of this.cards) {
      if (card.taskId !== taskId) continue;
      this.drop(cardId);
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
    return this.threads.wakeCards(taskId).cards;
  }

  /**
   * The cards on the captain's screen about a task, oldest first: what
   * supervision needs to tell "waiting on the captain's choice" from a stall
   * (WI-6). Its own, and its reviewer's question card (`asksAbout`,
   * INF-5004), each with the task it is kept on. Read-only.
   */
  openCardsFor(taskId: string): Pick<Card, "id" | "taskId" | "title" | "actions" | "createdAt">[] {
    return [...this.cards.values()]
      .filter((card) => asksAbout(card, taskId, this.host.tasks))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, taskId: on, title, actions, createdAt }) => ({
        id,
        taskId: on,
        title,
        actions,
        createdAt,
      }));
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
    this.evidence.pruneChanges(); // Task flags need only the shown version and order.
    return this.stagedVersions().map((card) => withAppDecline(card));
  }

  /** Each card's shown version in stack order, as its author wrote it. */
  private stagedVersions(): Card[] {
    return [...this.cards.values()].map((card) => this.stageVersion(card)).sort(compareStack);
  }

  /**
   * The stage's full presentation, including task, message and seen facts.
   * One task read projection holds it (INF-4464): each card's origin walk
   * reads a task several times, and cards share tasks, so a record is
   * composed once per snapshot rather than on every read.
   */
  snapshot(): Card[] {
    return this.host.tasks.readProjection(() => this.snapshotInProjection());
  }

  private snapshotInProjection(): Card[] {
    const asked = new Map<string, CardAsked | undefined>();
    this.evidence.pruneChanges();
    return this.stagedVersions().map((staged) => {
      const shown = {
        // Corner words and Done belong to the public view, not graph-free task flags;
        // Decline joins after the change marks, which compare the author's versions.
        ...withAppDecline(this.evidence.withChanges(this.onTheStage(staged))),
        ...this.evidence.updateState(staged),
        seen: staged.lifecycleId
          ? this.host.cardStore.lastSeenOffer(staged.id, staged.lifecycleId) !== undefined
          : false,
      };
      const about = this.askedAbout(shown, asked);
      return {
        ...shown,
        ...(about ? { asked: about } : {}),
        ...cardShapeMarks(this.host.tasks, shown),
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
    this.keepSeenMerge(shown, shown.offerId);
    this.scheduleBroadcast();
  }

  /**
   * Where a card's work came from, for its line under the title (INF-1610,
   * INF-2326): the origin its task's graph leads to
   * (`TaskService.capture.originAbout`), through the task it names or the task it
   * was raised on. A first mate card is its own (INF-2714): only the record
   * filed for it speaks, never the task its buttons act on. `known` holds
   * each task's answer for one snapshot.
   */
  private askedAbout(card: Card, known: Map<string, CardAsked | undefined>): CardAsked | undefined {
    const filed = (): string | undefined => this.host.tasks.capture.taskForCard(card.id)?.id;
    const answer = firstmateOwnCard(card);
    const own = answer ? filed() : undefined;
    const taskId = answer ? (own !== card.taskId ? own : undefined) : (card.taskId ?? filed());
    if (!taskId) return undefined;
    if (!known.has(taskId))
      known.set(taskId, cardAskedOf(this.host.tasks.capture.originAbout(taskId)));
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
    this.keepSeenMerge(shown, offerId);
  }

  /**
   * A merge card of the task's own change keeps what it offered, which a
   * later merge card hands its crewmate and labels its summary with
   * (INF-3715, `sinceSeen.ts`): on every sighting report, older or current,
   * and on the captain's own click (`act`), which replaces a sighting of the
   * same version. The one writer of `TaskDelivery.seenMerge`.
   */
  keepSeenMerge(shown: Card, offerId: string, act?: SeenMergeAct): void {
    if (shown.author !== "crewmate" || !shown.taskId) return;
    const seenMerge = seenMergeOf(
      shown.id,
      offerId,
      this.host.tasks.get(shown.taskId)?.delivery,
      this.host.now(),
      act,
    );
    if (seenMerge) this.host.tasks.delivery.recordChangeEvidence(shown.taskId, { seenMerge });
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
      corner: cardCornerOf(cardPresentation(shown)),
      ...(cardPresentation(shown) === "note"
        ? { noteDone: noteDoneOf(record?.key, answer?.id === shown.id) }
        : {}),
      // A phone from before every note had its button still draws Done here.
      ...(answer?.id === shown.id && record
        ? {
            answerDone: {
              taskId: record.id,
              label: ANSWER_DONE_LABEL,
              restWords: noteDoneOf(record.key, true).restWords,
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
    const { shown: version, aside: heldAside } = this.stage.of(card);
    const aside = !card.minimized && heldAside === true;
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

  /**
   * The version of an open card the captain is looking at: the stage's,
   * which is what a click on it chose from.
   */
  shown(id: string): Card | undefined {
    const card = this.cards.get(id);
    return card && withAppDecline(this.onTheStage(card));
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
  addFirstmateCard(input: EmittedCardInput, written?: OwnCardWrite): string {
    return this.emits.addFirstmateCard(input, written);
  }

  /** The id the host's own offer card for an `app_change` ask goes up under (`CardEmits`). */
  offerCardId(stableId: string): string {
    return this.emits.offerCardId(stableId);
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
    for (const card of [...this.cards.values()]) {
      const mine =
        author.kind === "firstmate"
          ? this.threads.firstmateAnswers(card)
          : this.threads.crewmateAnswers(card, author.taskId);
      // Someone else's held write - a revision, or an answer it named -
      // moves the stage with its own writer's turn end, never with an
      // unrelated turn of the card's author (docs/card-threads.md, "Shared
      // cards"). The author's turn end still ends what it held for that
      // turn, and the writer's then releases everything the card holds.
      const { writer } = this.stage.of(card);
      if (!mine && writer !== key) continue;
      if (reason === "report" && this.reachedStage(card)) continue;
      if (mine) {
        this.stage.release(card, "answering");
        if (this.stage.release(card, "aside")) moved = true;
      }
      if (writer !== undefined && writer !== key) continue;
      if (this.releaseWrites(card, reason, released)) moved = true;
    }
    if (moved) this.broadcastReleased(released);
  }

  /**
   * A crewmate's task left (`retireTaskCards`): what it wrote on other
   * cards reaches the stage now, as its turn's end would have released it.
   * A cancelled, failed or settled turn ends with no close-out of its own,
   * and the card's author can never release it (INF-3307's audit, row 2).
   */
  private writerLeft(taskId: string): void {
    const writer = authorKey({ kind: "crewmate", taskId });
    const released: string[] = [];
    for (const id of this.stage.heldBy(writer)) {
      const card = this.cards.get(id);
      if (card && this.stage.of(card).writer === writer) this.releaseWrites(card, "idle", released);
    }
    this.broadcastReleased(released);
  }

  /**
   * Release what a card holds for a close-out: its revisions reach the
   * record's offers, and the stage moves from the version it held to the
   * newest write. Whether the stage moved; a released thread is named in
   * `released`.
   */
  private releaseWrites(held: Card, reason: CloseOut, released: string[]): boolean {
    let card = held;
    const { shown } = this.stage.of(card);
    this.stage.release(card, "writer");
    let moved = false;
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
    // The captain put the card aside while its author's newer write - a
    // revision or an answer - waited here, so he never saw it: it comes
    // back with it, the same as a write on a card already aside (INF-1472).
    const written = wrote || shown !== undefined || answer || card.awaiting === "close-out";
    if (card.minimized && card.awaiting !== "answer" && written) {
      const { minimized: _aside, ...back } = card;
      this.host.cardStore.upsert(back);
      this.cards.set(card.id, back);
      card = back;
      moved = true;
    }
    if (card.awaiting === "close-out") {
      // A reworked merge card held for its new version's checks keeps the
      // version the captain replied under on the stage (INF-6241).
      if (!this.release(card, reason) && this.stage.of(card).forChecks) return moved;
    } else if (card.awaiting === "answer") return moved;
    else if (shown || answer) {
      // The stage moves from the version it held to the author's newest.
      this.host.cardStore.transaction(() =>
        this.evidence.noteStage({ head: card, shown: card }, "close-out", {
          source: "host",
          closeOut: reason,
          answer,
        }),
      );
    } else return moved;
    this.stage.release(card, "shown");
    return true;
  }

  private broadcastReleased(released: readonly string[]): void {
    this.scheduleBroadcast();
    for (const id of released) this.host.broadcastThread?.(this.thread(id));
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
  private release(card: Card, reason: CloseOut): boolean {
    // A story note waits for its task's merge, not its author (INF-2533):
    // `releaseMerged` shows it once a settle merged it.
    if (card.awaiting === "close-out" && this.host.holdsUntilMerge?.(card)) {
      this.stage.hold(card, { forMerge: true });
      return false;
    }
    // A reworked merge card waits for its new version's checks, not its
    // author (INF-6241): `recheckHeld` returns it once nothing holds it.
    const verdict = card.awaiting === "close-out" ? this.host.reworkHold?.(card) : undefined;
    if (verdict) {
      this.holdRework(card, verdict);
      return false;
    }
    const before = this.stage.of(card).forChecks;
    this.stage.release(card, "forMerge", "forChecks");
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
    if (card.author !== "crewmate" || !card.taskId) return true;
    const returned = this.host.cardStore
      .messages(card.id)
      .some((message) => message.who === "captain");
    this.host.tasks.capture.recordCardRaised(card.taskId, {
      cardId: card.id,
      kind: cardWord(card),
      title: card.title,
      actor: "crewmate",
      closeOut: reason,
      ...(returned ? { returned } : {}),
      ...(before ? { heldFor: before } : {}),
    });
    return true;
  }

  /** Keep a reworked merge card off the stage for what holds it. */
  private holdRework(card: Card, { hold, checking }: ReworkVerdict): void {
    this.stage.hold(card, { forChecks: hold });
    // The note says the card waits for its new version's checks: a reply
    // answered with no push, or a push with no checks to run, returns once
    // the crewmate's work ends, unnoted.
    if (checking && card.taskId && !this.reworkNoted(card.taskId, card))
      this.host.tasks.note(card.taskId, m.taskNoteReworkHeld({ title: card.title }), {
        news: false,
        data: {
          cardId: card.id,
          sentBackAt: card.sentBackAt,
          held: hold,
          reworkHeld: reworkKey(card),
        },
      });
    if (hold === "read" && card.taskId) this.host.readAfterTurn?.(card.taskId);
  }

  /**
   * Return each reworked merge card nothing holds any longer (INF-6241):
   * after a record change, a read, or the tick, with no author turn needed.
   * A card whose captain replied again waits for that answer first.
   */
  recheckHeld(reason: CloseOut = "idle"): void {
    const released: string[] = [];
    let moved = false;
    for (const id of this.stage.forChecks()) {
      const card = this.cards.get(id);
      if (card?.awaiting !== "close-out") continue;
      const verdict = this.host.reworkHold?.(card);
      if (verdict) this.holdRework(card, verdict);
      else if (this.releaseWrites(card, reason, released)) moved = true;
    }
    if (moved) this.broadcastReleased(released);
  }

  /** The hold under this reply is on the timeline already: a restart writes it once. */
  private reworkNoted(taskId: string, card: Card): boolean {
    return this.host.tasks.hasNoteWith(taskId, "reworkHeld", reworkKey(card));
  }

  /**
   * Whether a merge card of the task waits on its change's version: under
   * a captain's reply, or held for its new version's checks (INF-6241).
   */
  awaitsVersion(taskId: string): boolean {
    for (const card of this.cards.values()) {
      if (card.taskId !== taskId || card.author !== "crewmate") continue;
      if (this.stage.of(card).forChecks) return true;
      if (card.awaiting === "answer" && card.actions.some((action) => mergeEffectOf(action)))
        return true;
    }
    return false;
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
    const shown = this.snapshot().find((entry) => entry.id === id);
    let observation: string | undefined;
    let kept: Card | undefined;
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(id, why);
      kept = this.ended.end(shown, actor.kind, reason, this.host.now());
      observation = this.evidence.noteExit(card, actor.kind, "tool", {
        reason: "author-withdrawal",
        ...(reason?.trim() ? { note: why } : {}),
      });
    });
    this.drop(id);
    this.ended.hold(id, kept);
    this.recordResolution(card, "closed", actor.kind, undefined, observation);
    this.scheduleBroadcast();
    const decision = card.actions.length > 0 ? ` ${WITHDRAWN_UNCHOSEN}` : "";
    return `Closed card "${card.title}" (${id}).${decision}${kept ? ` ${ENDED_STAYS}` : ""}`;
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
    // An interim line answers nothing, even when it names the captain's
    // message: saved as an answer, it would make the author's real answer
    // read as a comment and keep the question waiting for good (INF-2730).
    const records = answersMessage !== undefined && who !== "host" && !interim;
    const message = this.host.cardStore.transaction(() => {
      const message = this.host.cardStore.appendMessage({
        cardId,
        who,
        text,
        notes: facts.notes,
        ...(who === "captain" && facts.captainText !== undefined
          ? { captainText: facts.captainText }
          : {}),
        ...(revision ? { revision } : {}),
        ...(facts.contributor ? { contributor: facts.contributor } : {}),
        ...(records ? { answersMessage } : {}),
        ...(facts.clarification ? { clarification: true as const } : {}),
        ...(facts.responseId ? { responseId: facts.responseId } : {}),
      });
      if (about) this.evidence.noteMessage(about, message, by, { interim, answers, submission });
      if (who === "captain" && !facts.owesNoAnswer) held = this.writeHold(cardId, "answer", by);
      else if (answered) held = this.writeHold(cardId, "close-out", by);
      return message;
    });
    if ((who === "captain" && !facts.owesNoAnswer) || answered) this.applyHold(cardId, held);
    if (answered && !contributed && card && (who === "crewmate" || who === "firstmate"))
      this.stage.hold(card, { answering: true });
    // Another writer's answer reaches the stage when that writer's turn ends.
    if (answered && facts.contributor && card)
      this.stage.hold(card, { writer: authorKey(facts.contributor) });
    this.host.broadcastThread?.(this.thread(cardId));
    // An author's answer is a row on the card's task too (FI3-1189's rule
    // 1); the captain's reply already is one, through its steer or its ask.
    if ((who === "crewmate" || who === "firstmate") && about) {
      const task = about.taskId
        ? this.host.tasks.get(about.taskId)
        : (this.host.tasks.capture.openCardTaskFor(cardId) ??
          this.host.tasks.capture.taskForCard(cardId));
      if (task) {
        this.host.tasks.turns.recordReply(task.id, {
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
      this.drop(open.id);
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
  private directionRetention:
    | ((cardId: string, action: string, actor: string, offerId?: string) => boolean)
    | undefined;

  setDirectionRetention(
    retains?: (cardId: string, action: string, actor: string, offerId?: string) => boolean,
  ): void {
    this.directionRetention = retains;
  }

  private recordResolution(
    card: Card,
    action: string,
    by: "captain" | "firstmate" | "crewmate" = "captain",
    answers?: CardAnswer[],
    observation?: string,
    carried?: ChoiceCarriedRecord,
  ): boolean {
    const tasks = this.host.tasks;
    let closedAnswer = false;
    if (card.taskId && tasks.get(card.taskId)?.delivery?.captainAction) {
      if (action === "dismissed" || action === "defer")
        tasks.delivery.deferCaptainAction(card.taskId);
      tasks.capture.recordCardResolved(card.taskId, {
        cardId: card.id,
        title: card.title,
        action,
        actor: by,
        ...(answers ? { answers } : {}),
        ...(observation ? { observation } : {}),
        ...(carried ? { carried } : {}),
      });
      return false;
    }
    // A put-off choice (INF-3846 piece 3) answers nothing yet: the host
    // keeps the card, so its task stays as it is and its row stays open.
    // Read from the chosen action itself, as `answerTaskResponse` reads it.
    const putOff = card.actions.some((entry) => entry.id === action && entry.until !== undefined);
    if (card.taskId && tasks.get(card.taskId)) {
      tasks.capture.recordCardResolved(card.taskId, {
        cardId: card.id,
        title: card.title,
        action,
        actor: by,
        ...(answers ? { answers } : {}),
        ...(observation ? { observation } : {}),
        ...(carried ? { carried } : {}),
      });
      // This explicit resolution resynchronizes the captain gate, with
      // the action as its timeline reason. A real gate change restarts the
      // idle clock; putting a card aside never enters this path.
      this.syncGates(card);
      if (!putOff) closedAnswer = this.host.closeAnsweredTask(card, action, by, carried);
    }
    const row = tasks.capture.openCardTaskFor(card.id);
    if (!row || putOff) return closedAnswer;
    if (this.directionRetention?.(card.id, action, by, card.offerId)) {
      tasks.placement.setGate(row.id, null, "the chosen direction is awaiting verified saving");
      return closedAnswer;
    }
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

  /** Presentation state and the card commit together, so a crash cannot lose its first offer. */
  presentRequiredAction(taskId: string): boolean {
    if (!this.host.tasks.delivery.captainActionReady(taskId)) return false;
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
        const action = this.host.tasks.delivery.presentCaptainAction(taskId);
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
   * back also ends a wait for its author's turn end (`StageHold.aside`).
   */
  setMinimized(cardId: string, minimized: boolean): void {
    const card = this.cards.get(cardId);
    if (!card || Boolean(card.minimized || this.stage.of(card).aside) === minimized) return;
    this.stage.release(card, "aside");
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
    if (!card?.minimized) return;
    const { minimized: _aside, ...rest } = card;
    this.host.cardStore.upsert(rest);
    this.cards.set(cardId, rest);
    this.stage.hold(rest, { aside: true });
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
    this.stage.release(stamped.card, "shown");
    this.scheduleBroadcast();
  }

  /**
   * A closed task's notes still waiting on its crewmate reach the stage:
   * the crewmate is gone. The Firstmate is not, so a reply on its note
   * keeps its wait. A close calls it once the close is recorded, so a story
   * note held for the merge shows once, its merged line already drawn from
   * the receipt (INF-2533, INF-2678).
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
   * Whether something besides the card `except` keeps the task open past
   * its merge (INF-2525): an open question, or another pull request.
   */
  private othersOpen(taskId: string, except: string | undefined): boolean {
    for (const card of this.cards.values())
      if (asksAbout(card, taskId, this.host.tasks) && card.id !== except && keepsTaskOpen(card))
        return true;
    return this.host.otherChangeOpen?.(taskId) === true;
  }

  private drop(id: string): void {
    this.cards.delete(id);
    this.stage.leave(id);
  }

  /** Take a card down unanswered: the question it asked is gone. */
  takeDown(id: string, resolution: string): void {
    const card = this.cards.get(id);
    if (!card) return;
    this.host.cardStore.transaction(() => {
      this.host.cardStore.resolve(id, resolution);
      this.evidence.noteExit(card, "host", "host", { reason: "host-withdrawal", note: resolution });
    });
    this.drop(id);
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
    this.ended.close(card.id); // Back under an ended card's id, it is open again.
    this.host.cardPlaced?.(card);
    if (card.taskId) {
      this.syncGates(card);
      // Its merge card's line follows what else is open (INF-2525), and a
      // reviewer's question its builder's merge card (INF-5396's audit, finding 2).
      this.refreshSettleFacts(this.factsTasksOf(card, card.taskId));
      return;
    }
    if (card.author !== "host" || cardWord(card) !== "decision") return;
    if (this.host.tasks.capture.openCardTaskFor(card.id)) return;
    this.host.tasks.capture.fileHostCardTask({
      id: randomUUID().slice(0, 8),
      title: shortTaskTitle(card.title),
      cardId: card.id,
    });
  }

  /**
   * The captain gate of the card's task, and of the builder a reviewer's
   * card asks about (INF-5004), so its idle clock restarts when it leaves.
   */
  /** The tasks whose merge cards a card's coming or going redraws: its own, and the builder its reviewer asks about. */
  private factsTasksOf(card: Card, taskId: string): string[] {
    const asked = reviewedTaskOf(card, this.host.tasks);
    return asked ? [taskId, asked] : [taskId];
  }

  private syncGates(card: Card): void {
    if (!card.taskId) return;
    this.host.syncCaptainGate(card.taskId, this.host.now());
    const asked = reviewedTaskOf(card, this.host.tasks);
    if (asked) this.host.syncCaptainGate(asked, this.host.now());
  }

  /** A card left the stack unanswered: the gate it placed, or its row, goes with it. */
  private left(card: Card): void {
    if (card.taskId) {
      this.syncGates(card);
      this.refreshSettleFacts(this.factsTasksOf(card, card.taskId));
      return;
    }
    const row = this.host.tasks.capture.openCardTaskFor(card.id);
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

  has(id: string): boolean {
    return this.cards.has(id);
  }

  openMergeAction(taskId: string, scope?: { review?: string }): OpenMergeAction | undefined {
    return openMergeActionIn(this.cards.values(), taskId, scope);
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
      // A reviewer's question outlives its review's close: it is the
      // builder's to answer, and leaves when the builder does (INF-4338).
      const asks = reviewedTaskOf(card, this.host.tasks);
      if (card.taskId !== taskId && asks !== taskId) continue;
      if (card.taskId === taskId && asks && options.keepNotes) continue;
      if (options.keepNotes && card.author !== "host" && card.actions.length === 0) {
        // The crewmate is gone: a note still waiting on it reaches the stage
        // once the close wrote its outcome on it (`releaseNotes`).
        this.stage.release(card, "shown", "aside");
        continue;
      }
      this.host.cardStore.transaction(() => {
        this.host.cardStore.resolve(cardId, reason);
        this.evidence.noteExit(card, "host", "host", { reason: "task-retired", note: reason });
      });
      this.drop(cardId);
    }
    this.writerLeft(taskId);
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
    return this.captainResolutionHeadsSince(since)
      .slice(0, limit)
      .flatMap(({ cardId }) => this.resolutionOf(cardId) ?? []);
  }

  /**
   * The captain's resolutions since `since`, newest first, each without its
   * card's words: the one selection `captainResolutionsSince` reads too.
   * `resolutionOf` reads one whole for a reader that shows it.
   */
  captainResolutionHeadsSince(since: number): ResolutionHead[] {
    return this.host.cardStore
      .resolutionHeadsSince(since)
      .filter(({ action, actions }) => byCaptain(action, actions));
  }

  /** One resolved card whole, words and closing offer included. */
  resolutionOf(cardId: string): CardResolution | undefined {
    return this.host.cardStore.resolutionOf(cardId);
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
        byCaptain(action, offer?.actions ?? card.actions),
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
    const snapshot = this.ended.stack();
    this.host.broadcastCards(snapshot);
    for (const card of snapshot) {
      if (this.threadOffers.get(card.id) === card.offerId) continue;
      this.threadOffers.set(card.id, card.offerId);
      if (this.host.cardStore.threadStat(card.id))
        this.host.broadcastThread?.(this.thread(card.id));
    }
    for (const id of this.threadOffers.keys())
      if (!this.cards.has(id) && !this.ended.has(id)) this.threadOffers.delete(id);
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

/**
 * Whether the captain resolved a card: a dismissal (`close`) or one of the
 * actions the card offered, never an app or agent close.
 */
function byCaptain(action: string, actions: Card["actions"]): boolean {
  return action === "close" || actions.some((entry) => entry.id === action);
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
      return {
        at: line.at,
        text: line.text,
        kind: "chose",
        choice: line.choice,
        ...(line.card ? { card: line.card } : {}),
        ...through,
      };
    case "automation":
      return { at: line.at, text: line.name, kind: "automation", ...through };
  }
}

/** The hold note's key: one note per reply a reworked merge card waits under. */
function reworkKey(card: Card): string {
  return `${card.id}@${card.sentBackAt ?? ""}`;
}
