import { formatDateTime } from "@shared/i18n/format";
import { changeLinesWords } from "@shared/vocabulary";
import type { SeenMerge, TaskDelivery } from "../storage/taskRecords";
import { escapeCardText } from "./cardText";

/**
 * What changed since the captain last saw a merge card (INF-3715,
 * docs/card-authoring.md "Since the card you saw"). The app holds the facts:
 * which merge card of the task's own change the captain last saw, when, at
 * which version and story, and the lines its strip showed. A later merge
 * card at another version or story hands them to its crewmate in the card's
 * answer, and the crewmate writes the summary in its own words
 * (`since_seen`). The app judges nothing about the growth and refuses
 * nothing: a card without a summary still goes up.
 */

/**
 * The record a sighting keeps: the window had the version `offerId` of the
 * card `cardId` in front of the captain. Only an offer the task keeps as a
 * merge offer of its own change counts; undefined for any other card, or a
 * sighting of the offer already kept.
 */
export function seenMergeOf(
  cardId: string,
  offerId: string,
  delivery: TaskDelivery | null | undefined,
  at: number,
): SeenMerge | undefined {
  if (!delivery || delivery.seenMerge?.offerId === offerId) return undefined;
  const offer = delivery.completionOffers?.find(
    (kept) => kept.cardId === cardId && kept.offerId === offerId,
  );
  if (!offer) return undefined;
  // The strip shows the lines only while they were read at the version on
  // offer (`settleCardFacts`), so only then are they what the captain saw.
  const lines = delivery.changeLines;
  return {
    cardId,
    offerId,
    at,
    headSha: offer.headSha,
    ...(offer.presentationRevision !== undefined
      ? { presentationRevision: offer.presentationRevision }
      : {}),
    ...(offer.shownFor !== undefined ? { change: offer.shownFor } : {}),
    ...(lines?.head === offer.headSha
      ? { lines: { added: lines.added, deleted: lines.deleted } }
      : {}),
  };
}

/** The merge card a new one comes back after: undefined when the captain saw none at another version or story. */
export function seenBefore(
  delivery: TaskDelivery | null | undefined,
  offered: { head: string | undefined; revision: number | undefined; change: number | undefined },
): SeenMerge | undefined {
  const seen = delivery?.seenMerge;
  if (!seen || !offered.head) return undefined;
  if (seen.change !== undefined && offered.change !== undefined && seen.change !== offered.change)
    return undefined;
  return seen.headSha !== offered.head || seen.presentationRevision !== offered.revision
    ? seen
    : undefined;
}

/** When the captain saw it, in this computer's own form: `Nov 10, 12:33 PM` in English. */
export function seenAtWords(at: number): string {
  return formatDateTime(at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The app's label over the crewmate's summary. */
export function sinceSeenLabel(at: number): string {
  return `Since the card you saw · ${seenAtWords(at)}`;
}

/**
 * The summary as the card draws it, first, above the saved story: the app's
 * label, then the crewmate's words as plain text, a paragraph for each
 * blank-line break. The words are escaped, never markup.
 */
export function sinceSeenSection(summary: string, seenAt: number): string {
  const paragraphs = summary
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeCardText(paragraph)}</p>`)
    .join("");
  return `<section class="inf-since-seen" data-since-seen><h6>${escapeCardText(sinceSeenLabel(seenAt))}</h6>${paragraphs}</section>`;
}

function versionWords(
  head: string,
  revision: number | undefined,
  lines: { added: number; deleted: number } | undefined,
): string {
  return `version ${head.slice(0, 12)}${revision !== undefined ? ` (story revision ${revision})` : ""}, ${lines ? changeLinesWords(lines.added, lines.deleted) : "its lines not read yet"}`;
}

/**
 * What the merge card's answer tells its crewmate: the facts of the card the
 * captain saw beside this one's, and what became of a summary it passed.
 * Empty when the captain saw no earlier merge card and none was passed.
 */
export function sinceSeenNotice(input: {
  seen: SeenMerge | undefined;
  head: string | undefined;
  revision: number | undefined;
  lines: TaskDelivery["changeLines"];
  summary: boolean;
}): string {
  const { seen, head } = input;
  if (!seen || !head)
    return input.summary
      ? " since_seen was left out: the captain saw no earlier merge card for this change at another version or story."
      : "";
  const lines = input.lines?.head === head ? input.lines : undefined;
  const facts = ` The captain last saw a merge card for this change on ${seenAtWords(seen.at)}: ${versionWords(seen.headSha, seen.presentationRevision, seen.lines)}. This card offers ${versionWords(head, input.revision, lines)}.`;
  return input.summary
    ? `${facts} Your since_seen summary is drawn first on this card.`
    : `${facts} Show this card again with the same id and since_seen: what changed since then, in your own words.`;
}
