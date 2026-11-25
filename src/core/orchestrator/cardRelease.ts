import type {
  Card,
  CardAwaiting,
  CardObservationActor,
  CardObservationSource,
  CardThread,
} from "@shared/cards";
import { cardWord, mergeEffectOf } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import type { CardEvidence } from "./cardEvidence";
import type { CardAuthorRef, CardServiceHost, CloseOut } from "./cardStackTypes";
import type { CardStage } from "./cardStage";
import { authorKey } from "./cardThreads";
import type { ReworkVerdict } from "./reworkHold";

/** What the release owner asks of the stack that composes it. */
export type CardReleaseOps = {
  thread(cardId: string): CardThread;
  scheduleBroadcast(): void;
  flushBroadcast(): void;
  saveCard(card: Card): void;
  /** Whether the card holds an answer from the Firstmate or the crewmate (`CardThreads`). */
  firstmateAnswers(card: Card): boolean;
  crewmateAnswers(card: Card, taskId: string): boolean;
};

/**
 * When a card reaches the stage (docs/card-threads.md "When a card reaches
 * the stage"): an author's close-out releases what it held, a captain's
 * reply holds a card until its answer, and a reworked merge card waits for
 * its new version's checks. `CardService` composes it over the same open
 * cards, stage and evidence.
 */
export class CardRelease {
  /** The newest `sentBackAt` handed out: stamps stay distinct inside one millisecond. */
  private lastSentBack = 0;

  constructor(
    private readonly host: CardServiceHost,
    private readonly cards: Map<string, Card>,
    private readonly stage: CardStage,
    private readonly evidence: CardEvidence,
    private readonly ops: CardReleaseOps,
  ) {}

  /**
   * An author closed out (docs/card-threads.md "When a card reaches the
   * stage"): a crewmate's `report` or its idle, the Firstmate's turn end.
   * Each of its cards that waited on it reaches the stage - one off it comes
   * up, one on it redraws with the newer write, one put aside that its author
   * wrote on comes back - unless the captain's reply or a rework holds it.
   * A report releases only a crewmate's new cards: one the captain already
   * had on the stage waits for its turn's end, to come back once (INF-926).
   */
  closeOut(author: CardAuthorRef, reason: CloseOut): void {
    let moved = false;
    const released: string[] = [];
    const key = authorKey(author);
    for (const card of [...this.cards.values()]) {
      const mine =
        author.kind === "firstmate"
          ? this.ops.firstmateAnswers(card)
          : this.ops.crewmateAnswers(card, author.taskId);
      // Someone else's held write - a revision, or an answer it named -
      // moves the stage with its own writer's turn end, never with an
      // unrelated turn of the card's author (docs/card-threads.md, "Shared
      // cards"). The author's turn end still ends what it held for that
      // turn, and the writer's then releases everything the card holds.
      const { writer } = this.stage.of(card);
      if (!mine && writer !== key) continue;
      if (reason === "report" && this.reachedStage(card)) continue;
      const aside = mine && this.stage.release(card, "aside");
      if (mine) this.stage.release(card, "answering");
      moved ||= aside;
      if (writer !== undefined && writer !== key) continue;
      if (this.releaseWrites(card, reason, released, aside)) moved = true;
    }
    if (moved) this.broadcastReleased(released);
  }

  /**
   * A crewmate's task left (`retireTaskCards`): what it wrote on other
   * cards reaches the stage now, as its turn's end would have released it.
   * A cancelled, failed or settled turn ends with no close-out of its own,
   * and the card's author can never release it (INF-3307's audit, row 2).
   */
  writerLeft(taskId: string): void {
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
   * `released`; `aside`, whether the stage kept the card aside till now.
   */
  private releaseWrites(held: Card, reason: CloseOut, released: string[], aside = false): boolean {
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
    const written = wrote || shown !== undefined || answer;
    if (card.minimized && !card.awaiting && written) {
      const { minimized: _aside, ...back } = card;
      this.ops.saveCard(back);
      card = back;
    }
    if (card.awaiting === "close-out") {
      // A reworked merge card held for its checks stays as the captain left it (INF-6241).
      const showed = this.release(card, reason);
      if (!showed && aside) this.ops.saveCard({ ...card, minimized: true });
      if (!showed && this.stage.of(card).forChecks) return moved;
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
    this.ops.scheduleBroadcast();
    for (const id of released) this.host.broadcastThread?.(this.ops.thread(id));
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
  release(card: Card, reason: CloseOut): boolean {
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
    const { awaiting: _awaiting, sentBackAt: _sentBackAt, minimized: _aside, ...shown } = card;
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
  writeHold(
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

  applyHold(id: string, held: Card | undefined): void {
    if (!held) return;
    this.cards.set(id, held);
    this.ops.scheduleBroadcast();
    // The window marks a replied-under card news when it sees the wait end,
    // so the reply's wait goes out at once: an author answering inside the
    // coalescing window must not fold it into one push that never waited.
    if (held.awaiting === "answer") this.ops.flushBroadcast();
  }
}

/** The hold note's key: one note per reply a reworked merge card waits under. */
function reworkKey(card: Card): string {
  return `${card.id}@${card.sentBackAt ?? ""}`;
}
