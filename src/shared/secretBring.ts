import { z } from "zod";
import * as m from "./i18n/messages.generated";

/**
 * Bringing secrets from another tool (docs/secrets.md, "Bringing secrets
 * from another tool"): the shapes the window and the core share. None of
 * them has a place for a value: a value goes from the other tool's output
 * straight into Secrets inside the core process, and never crosses here.
 */

/** One row of a bring card: a secret the source names, the name and place it is kept under, and whether it replaces one. */
export const secretBringRowSchema = z.strictObject({
  /** The row's id on its card, which the window's Bring names among the ticked rows. */
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /** The name Secrets keeps it under. */
  name: z.string().trim().min(1),
  /** The name the source gives it, when that differs. */
  source: z.string().optional(),
  place: z.string().optional(),
  /** A secret Secrets already keeps under that name and place: it arrives unticked. */
  replaces: z.strictObject({ ref: z.string(), version: z.number().int().positive() }).optional(),
  ticked: z.boolean(),
  /** Why the row cannot be kept, read from the source: it arrives unticked and cannot be ticked. */
  cannot: z.enum(["empty", "too-large", "not-text"]).optional(),
});
export type SecretBringRow = z.infer<typeof secretBringRowSchema>;

/**
 * What a bring card's Bring into Secrets button carries as its host
 * effect's `arg`, as JSON: the rows the window draws, one tick box each. The
 * button's id is the one-time pass the window's Bring sends.
 */
export const secretBringOfferSchema = z.strictObject({
  rows: z.array(secretBringRowSchema).min(1),
});
export type SecretBringOffer = z.infer<typeof secretBringOfferSchema>;

/** The rows a host card's Bring button offers, or none: an agent's card never draws one. */
export function secretBringRows(card: {
  author: string;
  actions: readonly { id: string; effect?: unknown }[];
}): { pass: string; rows: SecretBringRow[] } | undefined {
  if (card.author !== "host") return undefined;
  for (const action of card.actions) {
    const effect = action.effect as { kind?: unknown; op?: unknown; arg?: unknown } | undefined;
    if (effect?.kind !== "host" || effect.op !== "secrets-bring" || typeof effect.arg !== "string")
      continue;
    try {
      const offer = secretBringOfferSchema.safeParse(JSON.parse(effect.arg));
      if (offer.success) return { pass: action.id, rows: offer.data.rows };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The window's Bring on a bring card (`inf:secrets:bring`): its pass and the
 * ids of the rows the captain ticked. It carries no value; Infinitary runs
 * or reads the source itself and keeps only the ticked rows.
 */
export const secretBringInputSchema = z.strictObject({
  pass: z.string().min(1).max(64),
  picked: z.array(z.string().min(1).max(32)).max(1000),
});
export type SecretBringInput = z.infer<typeof secretBringInputSchema>;

/** Whether the bring finished, and the host's words for the card when it did not. */
export const secretBringSchema = z.strictObject({
  brought: z.boolean(),
  words: z.string().optional(),
});
export type SecretBringAnswer = z.infer<typeof secretBringSchema>;

/**
 * The opening tag of the bring card's line saying where to pick, as the
 * card's body holds it: hidden, since the window that shows the card draws
 * the tick boxes. A view that cannot draw them gets the card without Bring
 * into Secrets, and the line shown (`SECRET_BRING_ELSEWHERE_SHOWN`), by the
 * host that leaves the button out (`withoutUnreadActions`). A whole tag, so
 * no escaped word an agent wrote can match it.
 */
export const SECRET_BRING_ELSEWHERE_HIDDEN =
  '<p class="secret-bring-fine" data-secret-bring-elsewhere hidden>';
export const SECRET_BRING_ELSEWHERE_SHOWN =
  '<p class="secret-bring-fine" data-secret-bring-elsewhere>';

export const SECRET_BRING_CARD_WORDS = {
  /** Its title names how many secrets and the tool, in the asker's word. */
  title: (count: number | null, tool: string) =>
    count === null
      ? `Read secrets from ${tool}?`
      : `Bring ${count === 1 ? "1 secret" : `${count} secrets`} from ${tool}?`,
  from: "From",
  fromValue: (tool: string) => `${tool}, in the crewmate's word`,
  /** A bring from a computer that runs work: that computer, by the name the person knows it by. */
  computer: () => m.secretsApprovalComputer(),
  runs: "Runs",
  reads: "Reads",
  folder: "In folder",
  reason: "Its reason",
  asked: "Asked by the crewmate on this task, in its own words.",
  unlocks: "Uses to unlock",
  version: (version: number) => `version ${version}`,
  unlockOnce:
    "If you bring these secrets, your computer asks you to confirm giving these keys to this program for this run only.",
  confirmUnlock: "Allow this program to use your kept keys once to bring secrets.",
  /** Before a read: the names appear once Infinitary has read the source. */
  readFirst:
    "Infinitary reads it first and then lists the names it found here. Nothing is kept until you tick names and press Bring into Secrets.",
  found: (count: number) =>
    count === 0
      ? "Infinitary read it and found no secrets."
      : `Infinitary read it and found ${count === 1 ? "1 name" : `${count} names`}. Tick the ones to keep.`,
  /** What the crewmate never gets; the window's rows say what the press does. */
  fine: "The crewmate gets names and references, never a value, and the copy in the other tool stays as it is.",
  /** Shown only where the tick boxes cannot draw: the phone, or a window from before them. */
  elsewhere:
    "To pick the secrets to bring, answer this card in Infinitary's window on the first mate's computer.",
  bring: "Bring into Secrets",
  read: "Read it",
  dontBring: "Don't bring",
  /** Beside the card's buttons when a press could not finish. */
  locked: "Secrets storage is locked. Unlock it in Settings → Secrets, then press again.",
  unavailable: "Secrets could not keep this now. Nothing was kept; try again.",
  gone: "This card no longer asks. Nothing was kept.",
  closed: "The task that asked has closed, so nothing was kept.",
} as const;
