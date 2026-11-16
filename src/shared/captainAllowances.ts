import { type HoldOverride, reviewerOverrideWords, standingOverrideWords } from "./holds";

/**
 * A yes the captain gave on a crewmate's own card (INF-3170 piece 2,
 * `docs/delivery-rigor.md` "What the captain already allowed"): their own
 * click on the action the crewmate marked with what a yes covers
 * (`emit_card.allows`), or, INF-4446, on the approval of a check's own card
 * (`emit_card.validation_request`). The app keeps the words and never reads
 * them: the agent that reads the record judges whether a later ask falls
 * inside it.
 */
export type CaptainAllowance = {
  /** The captain's click as words: the button, its card, and anything they wrote beside it (`choiceWords`). */
  words: string;
  /** What the yes covers, as its card said it: the crewmate's words, or a check's declared resources and cost (`checkYesCovers`). */
  covers: string;
  /** The card the click was on. */
  card: string;
  at: number;
};

/** A crewmate's card whose action, once the captain clicks it, records a yes covering `covers`. */
export type AllowanceOffer = {
  card: string;
  /** The card's offer the yes was declared on; a click on another offer records nothing. */
  offer: string;
  action: string;
  covers: string;
};

/** A recorded yes as a later reader is served it, with the task it was given on when that is another. */
export type ServedAllowance = CaptainAllowance & { from?: { key: string; title: string } };

/** What a crewmate's turn is served as already allowed: the override standing on its own task and each recorded yes it carries. */
export type AlreadyAllowed = {
  override?: Pick<HoldOverride, "words" | "holds" | "until">;
  allowances: readonly ServedAllowance[];
};

/** Who reads the list: the task's own crewmate, or the reviewer of its change. */
export type AllowedReader = "crewmate" | "reviewer";

/** The heading every list opens with, so the rule that points at it can name it. */
export const ALREADY_ALLOWED_HEADING = "Already allowed";

/** One yes, with its card, which a check request names to take its approval from it (INF-4446). */
function allowanceLine(entry: ServedAllowance): string {
  const where = entry.from ? ` on ${entry.from.key} "${entry.from.title}", whose work this is` : "";
  return `- The captain's yes${where} (${entry.card}): "${entry.words}". What it covers, as its card said it: "${entry.covers}".`;
}

/**
 * The one "already allowed" list a crewmate or a reviewer is served
 * (INF-3170 piece 2): the captain's standing override and each yes the app
 * recorded from their click. A yes on it is that consent, so a later ask it
 * covers is not asked again; the reader judges what falls inside it. A
 * write kept for the captain's click, a browser handoff and anything no
 * entry names still ask. Empty when nothing is recorded.
 */
export function alreadyAllowedWords(allowed: AlreadyAllowed, reader: AllowedReader): string {
  const lines = [
    ...(allowed.override
      ? [
          `- ${reader === "reviewer" ? reviewerOverrideWords(allowed.override) : standingOverrideWords(allowed.override)}`,
        ]
      : []),
    ...allowed.allowances.map(allowanceLine),
  ];
  if (lines.length === 0) return "";
  const close =
    reader === "reviewer"
      ? "Access or a step an entry covers is not a finding; access or a step none covers still needs the captain's consent on a card."
      : "Where an ask of yours falls inside an entry, it is that consent: do not ask again. A write kept for their click, a browser handoff and anything no entry names still ask. Only the captain's words take an entry back.";
  return [
    `${ALREADY_ALLOWED_HEADING}, as the app recorded it from the captain's own words and clicks${reader === "reviewer" ? " on this change" : " on this task"}:`,
    ...lines,
    close,
  ].join("\n");
}

/** What a crewmate is served when the captain takes back a recorded yes. */
export function allowanceTakenBackWords(entry: Pick<CaptainAllowance, "words" | "covers">): string {
  return `The captain took back their yes "${entry.words}", which covered "${entry.covers}": ask again before anything it covered.`;
}

/** A recorded yes as its timeline row says it. */
export function allowanceRowWords(entry: Pick<CaptainAllowance, "words" | "covers">): string {
  return `You said yes: "${entry.words}". It covers: "${entry.covers}"`;
}
