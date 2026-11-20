import { type Card, onStage } from "./cards";

/**
 * INF-2553, the captain's direction B: one intent layer between a view and the
 * home. Every change the captain makes is an intent, drawn at once over the
 * home's last snapshot, which is never edited, and kept until the home's own
 * evidence settles it, so taking a prediction back is dropping its intent.
 * The phone's session is the first view built on it
 * (`ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneIntents.swift`);
 * every other view takes the same table (docs/ios.md, "Changes show at the
 * tap"). Both replay one fixture,
 * `ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/Fixtures/PhoneIntents.json`.
 *
 * How an intent settles, whatever its kind: a snapshot that holds the change
 * retires it with nothing moving; a refusing result takes it back with the
 * home's words where the captain is; an accepted one waits for the snapshot
 * that shows it, and goes quietly after the serve watchdog's 15 seconds; a
 * lost result keeps it shown until the first snapshot read after reconnecting,
 * which retires it or takes it back with the unconfirmed words (a push the
 * reconnect replays only retires, since it can predate the change); and a target
 * that changed under it (a revised card, a closed task) voids it. Nothing is
 * queued or sent again.
 *
 * `seen` is the exception: it is the view's own report that it drew a card's
 * update, so a refusal or a lost result takes it back quietly, with no words,
 * and the card reads as the home says again. The phone lets an accepted one
 * go after the same 15 seconds; the desktop window keeps it until a snapshot
 * holds or voids it, since its own home's push follows the write.
 */
export const INTENT_TABLE = {
  close: {
    shows: "The card leaves; the next card is up.",
    settles: "A cards snapshot without it.",
  },
  choose: {
    shows: "The choice is sent and the card leaves.",
    settles: "A cards snapshot without it, or with it awaiting its author.",
  },
  putAside: {
    shows: "The card leaves the stage for its task row.",
    settles: "A cards snapshot with it put aside.",
  },
  bringBack: {
    shows: "The cards are back on the stage, the first one up.",
    settles: "A cards snapshot with them on the stage.",
  },
  reply: {
    shows: "The words join the thread, marked sending; the draft clears.",
    settles: "A thread snapshot with more of the captain's messages than it showed at the tap.",
  },
  send: {
    shows: "The box clears; the message is the last turn, marked sending.",
    settles: "A last-turn snapshot that follows the last turn shown at the tap.",
  },
  start: {
    shows: "The record and its row read Starting.",
    settles: "A board or record snapshot showing the start.",
  },
  finish: {
    shows: "The record and its row show the explicit Done or Decline ending.",
    settles: "A board or record snapshot with that ending, never merely a hidden card.",
  },
  interrupt: {
    shows: "The record reads Stopping.",
    settles: "A board or record snapshot not running.",
  },
  steer: {
    shows: "The words show as sent in the transcript; the draft clears.",
    settles: "A transcript snapshot with more of the captain's steers than it showed at the tap.",
  },
  seen: {
    shows: "The card's update is read: it leaves the new count and the arrows' dots.",
    settles: "A cards snapshot with that update seen; a newer update or the card gone voids it.",
  },
} as const;

export type IntentKind = keyof typeof INTENT_TABLE;

/** An intent on a card on the stage, named by the identity the view saw. */
export type CardIntent =
  | {
      kind: "close" | "choose" | "putAside";
      card: string;
      lifecycle?: string | undefined;
      offer?: string | undefined;
    }
  | { kind: "bringBack"; card: string }
  /**
   * INF-4541: the captain saw this update of the card, so "N new" and the
   * arrows' dots skip it before the home's own seen mark comes back.
   */
  | { kind: "seen"; card: string; lifecycle?: string | undefined; update: string };

/** What one snapshot says of one intent. */
export type IntentEvidence = "holds" | "void" | "lacks";

type FoldedCard = Pick<
  Card,
  | "id"
  | "lifecycleId"
  | "offerId"
  | "minimized"
  | "awaiting"
  | "sentBackAt"
  | "currentUpdateId"
  | "currentUpdateSeen"
>;

/** The cards a view shows: the snapshot with the intents drawn over it in the order sent. */
export function foldCards<T extends FoldedCard>(
  cards: readonly T[],
  intents: readonly CardIntent[],
): T[] {
  let shown = [...cards];
  for (const intent of intents) {
    if (intent.kind === "close" || intent.kind === "choose")
      shown = shown.filter((card) => card.id !== intent.card);
    else if (intent.kind === "seen")
      shown = shown.map((card) =>
        card.id === intent.card && card.currentUpdateId === intent.update
          ? { ...card, currentUpdateSeen: true }
          : card,
      );
    else
      shown = shown.map((card) => {
        if (card.id !== intent.card) return card;
        const { minimized: _held, ...rest } = card;
        return (intent.kind === "putAside" ? { ...rest, minimized: true } : rest) as T;
      });
  }
  return shown;
}

/** What a cards snapshot says of a card intent. */
export function cardEvidence(intent: CardIntent, cards: readonly FoldedCard[]): IntentEvidence {
  const card = cards.find((entry) => entry.id === intent.card);
  if (intent.kind === "seen") {
    if (
      !card ||
      (intent.lifecycle !== undefined && card.lifecycleId !== intent.lifecycle) ||
      card.currentUpdateId !== intent.update
    )
      return "void";
    return card.currentUpdateSeen === true ? "holds" : "lacks";
  }
  if (intent.kind === "bringBack") return !card ? "void" : card.minimized ? "lacks" : "holds";
  if (!card || (intent.lifecycle !== undefined && card.lifecycleId !== intent.lifecycle))
    return "holds";
  if (intent.kind === "choose" && !onStage(card)) return "holds";
  if (intent.kind === "putAside" && card.minimized) return "holds";
  return intent.offer === undefined || card.offerId === intent.offer ? "lacks" : "void";
}
