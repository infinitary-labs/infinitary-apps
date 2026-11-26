import type { TurnImage } from "@shared/cards";
import { loadImages } from "../attachments";
import type { ModelSession } from "../session/session";
import type { InboxRow } from "../storage/inboxStore";
import { rowAttachments } from "./wakes";

type ModelRef = { provider: string; id: string };

/**
 * The pictures a first mate turn serves from its lane (docs/inbox.md,
 * "Pictures ride the row by reference"). A row with pictures is served with
 * them or not at all: while its copy is missing, or while the first mate's
 * model reads words only, it stays pending. The feed says the first once;
 * the pictures card says the second for as long as the lane holds such a row.
 */
export class FirstmatePictures {
  /** The lane rows whose pictures were already said to be unavailable. */
  private readonly blocked = new Set<number>();
  /** The lane rows the pictures card was put up for, and the model it names. */
  private held = new Set<number>();
  private heldFor: string | undefined;

  constructor(
    private readonly host: {
      /** False when a model's description says it reads words only. */
      readsPictures?: (ref: ModelRef) => boolean | undefined;
      /** A row's pictures could not be read: the feed says so. */
      unavailable: (caught: unknown) => void;
      raiseCard: (model: ModelRef) => void;
      withdrawCard: () => void;
    },
  ) {}

  /**
   * The rows this turn can serve, with the pictures their messages keep
   * copies of. Given the turn's `session`, a row with pictures also stays
   * pending while that session's model reads words only, and the pictures
   * card follows what the lane holds: a newly held row, or another
   * words-only model, puts it up or revises it, and a lane holding none
   * takes it down, a card left from before a restart included.
   */
  serve(rows: InboxRow[], session?: ModelSession): { rows: InboxRow[]; images?: TurnImage[] } {
    const wordsOnly = session ? this.wordsOnly(session) : undefined;
    const servable: InboxRow[] = [];
    const images: TurnImage[] = [];
    const held: number[] = [];
    for (const row of rows) {
      const refs = rowAttachments([row]);
      if (refs.length === 0) {
        servable.push(row);
      } else if (wordsOnly) {
        held.push(row.id);
      } else {
        try {
          images.push(...loadImages(refs));
          servable.push(row);
        } catch (caught) {
          if (!this.blocked.has(row.id)) {
            this.blocked.add(row.id);
            this.host.unavailable(caught);
          }
        }
      }
    }
    if (session) this.noteHeld(wordsOnly, held);
    return { rows: servable, ...(images.length > 0 ? { images } : {}) };
  }

  /**
   * A captain's message with pictures for a session whose model reads words
   * only: serving it would be refused before any request, and words alone
   * would lose the pictures, so `park` keeps it on the lane, answering its
   * row, and the pictures card says why. True when it was held.
   */
  holds(session: ModelSession, park: () => number): boolean {
    const model = this.wordsOnly(session);
    if (!model) return false;
    this.held.add(park());
    this.heldFor = modelKey(model);
    this.host.raiseCard(model);
    return true;
  }

  private wordsOnly(session: ModelSession): ModelRef | undefined {
    const model = session.modelRef();
    return model && this.host.readsPictures?.(model) === false ? model : undefined;
  }

  private noteHeld(wordsOnly: ModelRef | undefined, held: readonly number[]): void {
    if (!wordsOnly || held.length === 0) {
      this.held.clear();
      this.heldFor = undefined;
      this.host.withdrawCard();
      return;
    }
    const fresh = held.some((id) => !this.held.has(id)) || this.heldFor !== modelKey(wordsOnly);
    this.held = new Set(held);
    this.heldFor = modelKey(wordsOnly);
    if (fresh) this.host.raiseCard(wordsOnly);
  }
}

const modelKey = (model: ModelRef): string => `${model.provider}/${model.id}`;
