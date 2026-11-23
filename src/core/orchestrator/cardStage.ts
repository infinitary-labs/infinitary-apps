import type { Card } from "@shared/cards";

/**
 * What the stage holds back on one open card for its current lifecycle,
 * beyond the saved card (docs/card-threads.md, "When a card reaches the
 * stage"). Every part waits on a close-out, and a restart closes every
 * writer out, so it lives in memory only.
 */
export type StageHold = {
  /** The version the stage still shows while a newer write waits on a close-out. */
  shown?: Card;
  /**
   * Another writer (`authorKey`) whose close-out releases what the card
   * holds, never an unrelated turn of the card's own author.
   */
  writer?: string;
  /** Kept aside until its author's turn ends, though the card no longer says aside (INF-926). */
  aside?: true;
  /** Its author answered the captain and has not closed out since (INF-1623). */
  answering?: true;
  /** A story note held for its task's merge, not its author (INF-2533). */
  forMerge?: true;
};

type Part = keyof StageHold;

/**
 * Each open card's place on the stage as one value (`StageHold`), keyed to
 * the lifecycle it was written on: a card that comes back under its id
 * starts a lifecycle nothing holds. A card leaving the stack takes its hold
 * with it (`leave`), the one way a hold ends besides its parts' release.
 */
export class CardStage {
  private readonly holds = new Map<string, StageHold & { lifecycleId: string }>();

  of(card: Card): StageHold {
    const hold = this.holds.get(card.id);
    return hold && hold.lifecycleId === card.lifecycleId ? hold : {};
  }

  hold(card: Card, parts: StageHold): void {
    if (!card.lifecycleId) return;
    this.holds.set(card.id, { ...this.of(card), ...parts, lifecycleId: card.lifecycleId });
  }

  release(card: Card, ...parts: Part[]): boolean {
    const hold = this.holds.get(card.id);
    if (!hold || hold.lifecycleId !== card.lifecycleId) return false;
    let held = false;
    for (const part of parts) {
      held ||= hold[part] !== undefined;
      delete hold[part];
    }
    if (Object.keys(hold).length === 1) this.holds.delete(card.id);
    return held;
  }

  leave(cardId: string): void {
    this.holds.delete(cardId);
  }

  heldBy(writer: string): string[] {
    return [...this.holds].filter(([, hold]) => hold.writer === writer).map(([id]) => id);
  }

  /** The story notes held for their task's merge. */
  forMerge(): string[] {
    return [...this.holds].filter(([, hold]) => hold.forMerge).map(([id]) => id);
  }
}
