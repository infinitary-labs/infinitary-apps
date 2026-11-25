import { QUIET_CARD_MS, QUIET_FEED_MS } from "./crewWatch";
import type { HostCardStack } from "./hostCardStack";

type QuietCards = Pick<HostCardStack, "addFirstmateQuietCard" | "clearFirstmateQuietCard">;
type FeedNote = (event: { type: "firstmate_note"; text: string }) => void;

/**
 * Watchdog signals over the orchestrator's own turn (P4 extension, captain
 * call with the empty-turn rewording): the crewmate thresholds, driven by
 * the supervisor's shared tick through the hooks. Escalation only - the
 * Firstmate is steer-only, so the card informs, never offers an interrupt.
 */
export class FirstmateQuiet {
  private lastEventAt = 0;
  private level: 0 | 1 | 2 = 0;

  constructor(
    private readonly cards: QuietCards,
    private readonly note: FeedNote,
  ) {}

  /** A turn began: the watch counts from now. */
  began(): void {
    this.lastEventAt = Date.now();
    this.level = 0;
  }

  /** The 10-minute feed line and 20-minute card a crewmate gets, while `busy`. */
  check(now: number, busy: boolean): void {
    if (!busy) return;
    const quietFor = now - this.lastEventAt;
    const minutes = Math.round(quietFor / 60_000);
    if (quietFor >= QUIET_CARD_MS && this.level < 2) {
      this.level = 2;
      this.cards.addFirstmateQuietCard(
        `Your first mate has said nothing for ${minutes} minutes while working. It may be stuck; it recovers on its own when it finishes.`,
      );
    } else if (quietFor >= QUIET_FEED_MS && this.level < 1) {
      this.level = 1;
      this.note({
        type: "firstmate_note",
        text: `Your first mate has been quiet for ${minutes} minutes while working.`,
      });
    }
  }

  /** Any session event is proof of life; a stale quiet card retires. */
  activity(): void {
    this.lastEventAt = Date.now();
    if (this.level > 0) this.clear();
  }

  clear(): void {
    this.level = 0;
    this.cards.clearFirstmateQuietCard();
  }
}
