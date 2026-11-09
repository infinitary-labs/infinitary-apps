import { type DomNode, textOf } from "@shared/cardHeadings";
import { type Card, onStage } from "@shared/cards";
import { parseDocument } from "htmlparser2";

/**
 * Native notifications (capability-gap P2): exactly the events that already
 * raise cards reach Notification Center, and only while the window is not
 * focused. The card/feed split is the noise filter - feed lines never
 * notify. The notifier diffs card snapshots at the broadcast seam, so the
 * supervisor stays notification-free and every card producer is covered by
 * one observer.
 */

export type CardNotifierOptions = {
  /** The user's toggle (default on). */
  enabled: () => boolean;
  /** True while any app window is focused; focused means no notification. */
  focused: () => boolean;
  /** Shows one native notification (Electron Notification behind this). */
  show: (notification: { title: string; body: string }) => void;
};

const BODY_LIMIT = 140;

export class CardNotifier {
  /**
   * Whether each last-seen card was waiting on its author
   * (the captain replied under it); also the "already notified" record.
   */
  private readonly seen = new Map<string, { waiting: boolean }>();
  private primed = false;

  constructor(private readonly options: CardNotifierOptions) {}

  /**
   * Observe one cards broadcast. The first snapshot only seeds the map:
   * cards restored from a previous run are old news, not notifications.
   * A card off the stage, awaiting its author, is not there yet: it
   * notifies when it reaches the stage, the moment the window shows it. A
   * kept card the captain replied under stays on the stage: its
   * author's answer notifies when the wait ends.
   */
  observe(cards: Card[]): void {
    const live = new Set<string>();
    // An ended card is not news: its author closed it (INF-3071).
    for (const card of cards.filter((entry) => onStage(entry) && !entry.ended)) {
      live.add(card.id);
      const before = this.seen.get(card.id);
      this.seen.set(card.id, { waiting: card.awaiting !== undefined });
      if (!this.primed) continue;
      // A new card or an answered reply is news; a body update alone is not.
      const becameReady = before === undefined || (before.waiting && card.awaiting === undefined);
      if (!becameReady) continue;
      if (!this.options.enabled() || this.options.focused()) continue;
      this.options.show({
        title: card.title,
        body: firstLine(visibleText(card.body)).slice(0, BODY_LIMIT),
      });
    }
    for (const id of this.seen.keys()) {
      if (!live.has(id)) this.seen.delete(id);
    }
    this.primed = true;
  }

  /**
   * Starts over as at boot: the next snapshot only seeds. A view of another
   * Mac (docs/view.md) does this when it reads everything again, so what
   * that read finds is old news, as restored cards are.
   */
  forget(): void {
    this.seen.clear();
    this.primed = false;
  }

  /**
   * Seeds from a snapshot that was read rather than pushed, unless a push
   * has seeded since the last start: a push is never older than the read.
   */
  seed(cards: Card[]): void {
    if (!this.primed) this.observe(cards);
  }
}

/** Card bodies are HTML fragments; a notification shows only their text. */
function visibleText(body: string): string {
  const document = parseDocument(body, { decodeEntities: true });
  return (document.children as unknown as DomNode[]).map(textOf).join(" ");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .trim();
}
