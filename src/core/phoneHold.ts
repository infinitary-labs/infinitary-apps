import type { Card } from "@shared/cards";
import type { CardNotice } from "./notifications";

/** A card-worthy moment held for the phone: its card and whether it was new or an answer. */
type Held = Pick<CardNotice, "kind" | "cardId">;

/**
 * The phone's notices held while someone is at a computer that shows this
 * first mate (INF-7038's plan, Part 2; docs/phone-push.md, "When the
 * computer sends"). A moment goes at once when nobody is; otherwise it waits
 * until the last word that someone is there ends, then each goes as its own
 * push, oldest first, in its card's words at that time. A held moment whose
 * card was seen or left the stage is dropped, and every one while the
 * Notifications switch is off. Held moments live in memory only.
 */
export class PhoneHold {
  private held: Held[] = [];
  private cards = new Map<string, Card>();

  constructor(
    private readonly options: {
      someoneHere: () => boolean;
      send: (notice: CardNotice) => void;
      switchedOn: () => boolean;
      /** The card's words for `kind` now (`noticeFor`). */
      words: (card: Card, kind: CardNotice["kind"]) => CardNotice;
      /** Whether a phone no longer needs a card's notice (`withdrawable`). */
      done: (card: Card | undefined) => boolean;
    },
  ) {}

  offer(notice: CardNotice): void {
    if (!this.options.someoneHere()) {
      this.options.send(notice);
      return;
    }
    // A card held as new and then replied to keeps its place, as its newer moment.
    const at = this.held.findIndex((held) => held.cardId === notice.cardId);
    const held = { kind: notice.kind, cardId: notice.cardId };
    if (at >= 0) this.held[at] = held;
    else this.held.push(held);
  }

  /** Each cards broadcast, after the notifier offered its moments. */
  observe(cards: Card[]): void {
    this.cards = new Map(cards.map((card) => [card.id, card]));
    this.drop();
  }

  /** The Notifications switch changed. */
  switched(): void {
    this.drop();
  }

  /** The last word that someone is at a computer ended. */
  left(): void {
    const held = this.held;
    this.held = [];
    if (!this.options.switchedOn()) return;
    for (const { kind, cardId } of held) {
      const card = this.cards.get(cardId);
      if (card && !this.options.done(card)) this.options.send(this.options.words(card, kind));
    }
  }

  private drop(): void {
    if (!this.options.switchedOn()) {
      this.held = [];
      return;
    }
    this.held = this.held.filter((held) => !this.options.done(this.cards.get(held.cardId)));
  }
}
