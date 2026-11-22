import { type Card, compareStack, onStage, withoutMergeClosesLine } from "@shared/cards";
import { ENDED_CLOSE, ENDED_CORNER, endedLineWords } from "@shared/endedCard";
import type { CardStore } from "../storage/cardStore";

/**
 * What `close_card` adds when the captain had seen the card (INF-3071): it
 * stays in front of them, ended, with the reason the author gave.
 */
export const ENDED_STAYS =
  "The captain had seen it, so it stays on their screen marked ended, with your reason, until they close it.";

/**
 * Cards their author ended while the captain had seen them (INF-3071), as
 * the stage last showed them, with how they ended. The record closed each
 * one when its author ended it: nothing reads them but the stack the views
 * draw (`CardService.stack`), until the captain closes one. Saved on the
 * resolved row (`CardStore.markEnded`), so a restart keeps them. The card
 * service is the one writer.
 */
export class EndedCards {
  private readonly cards = new Map<string, Card>();

  constructor(
    private readonly store: Pick<CardStore, "markEnded" | "listEnded">,
    /** The open stack: its snapshot and its push. */
    private readonly open: { snapshot(): Card[]; scheduleBroadcast(): void },
  ) {}

  /** The ended cards a restart finds: only resolved rows, so none is back on the stack. */
  restore(): void {
    for (const { card, ended } of this.store.listEnded())
      this.cards.set(card.id, { ...card, ended });
  }

  get size(): number {
    return this.cards.size;
  }

  has(id: string): boolean {
    return this.cards.has(id);
  }

  get(id: string): Card | undefined {
    return this.cards.get(id);
  }

  /**
   * The card as its author ends it: kept, ended, when the stage shows it and
   * the captain has seen it in this lifecycle; undefined for one they never
   * saw or put aside, which leaves as before. Saved in the caller's write.
   */
  end(
    shown: Card | undefined,
    by: "crewmate" | "firstmate",
    reason: string | undefined,
    at: number,
  ): Card | undefined {
    const why = reason?.trim();
    const kept =
      shown?.seen && onStage(shown) && !shown.minimized
        ? {
            ...shown,
            ended: { by, ...(why ? { reason: why } : {}), at, line: endedLineWords(by, why) },
          }
        : undefined;
    if (shown) this.store.markEnded(shown.id, kept?.ended);
    return kept;
  }

  hold(id: string, kept: Card | undefined): void {
    if (kept) this.cards.set(id, kept);
    else this.cards.delete(id);
  }

  /**
   * The stack the views draw, and only they: the stage's snapshot, which
   * every reader in the crew reads, and the ended cards in their places.
   */
  stack(): Card[] {
    const open = this.open.snapshot();
    if (this.cards.size === 0) return open;
    return [...open, ...[...this.cards.values()].map(endedView)].sort(compareStack);
  }

  /**
   * The captain closes an ended card: it leaves the stack and tells nobody,
   * since the record closed it when its author ended it. A card put back on
   * the stack under the same id leaves the ended ones the same way
   * (`CardService.placed`). False for a card that is not ended.
   */
  close(id: string): boolean {
    if (!this.cards.delete(id)) return false;
    this.store.markEnded(id, undefined);
    this.open.scheduleBroadcast();
    return true;
  }

  /** A task's ended cards leave the stack with its rows. */
  drop(taskId: string): void {
    for (const [id, card] of this.cards) if (card.taskId === taskId) this.close(id);
  }
}

/**
 * An ended card as the stack draws it: as the captain last saw it, with no
 * actions, no hold, update or merge parts to act on, no line saying what a
 * merge would do, and one Close, as a note's button and in the corner.
 */
function endedView(card: Card): Card {
  const {
    awaiting: _awaiting,
    sentBackAt: _sentBackAt,
    minimized: _minimized,
    changes: _changes,
    answerDone: _answerDone,
    requiredActions: _requiredActions,
    afterMerge: _afterMerge,
    currentUpdateId: _currentUpdateId,
    currentUpdateSeen: _currentUpdateSeen,
    ...rest
  } = card;
  return {
    ...rest,
    body: withoutMergeClosesLine(rest.body),
    actions: [],
    corner: ENDED_CORNER,
    noteDone: ENDED_CLOSE,
    seen: true,
  };
}
