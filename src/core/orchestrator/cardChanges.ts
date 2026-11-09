import { cardParts, unmatchedParts } from "@shared/cardParts";
import { cardMediaUrl, cardPictureUrl } from "@shared/cardPictures";
import {
  CARD_CHANGE_MARKS_MAX,
  type Card,
  type CardAction,
  type CardChanges,
  isPreviewBody,
} from "@shared/cards";

export { cardParts } from "@shared/cardParts";

/**
 * What changed in a card since the captain last saw it (the accepted
 * FI3-472 plan; docs/card-authoring.md "What changed since you looked").
 *
 * A body is compared PART by part - a paragraph, a list item, a table row,
 * a figure, a question - read through htmlparser2, the parser the shape
 * lint reads a body with, never a regex over markup. A part is the
 * outermost element of those kinds: a list item holding a paragraph is one
 * part, and a paragraph in a `<details>` is one of its own. Headings,
 * containers and bare text are not parts; they only hold them.
 *
 * Two parts are the same when their markup is: tag names, attributes in any
 * order, and text with its whitespace collapsed. Two things the host itself
 * rewrites on every call are not the author's change: the name of a
 * picture's or a demo recording's copy (a fresh random name each emit),
 * which is read as the copy's verified bytes (`mediaOf`), so the same file
 * is the same part and another file under the same words is a change
 * (INF-3188), and the host's fact strip and follow-up rows on a settle card,
 * which are ignored. Older pictures saved with no bytes recorded still read
 * every picture as the same. A
 * project font's copy needs no such rule: the host names it by its own
 * bytes (`verifyCardImages`), so an unchanged font keeps its name in a
 * preview's style sheet and a changed one is the author's change.
 *
 * The comparison is a multiset match, not a sequence diff: a part that only
 * moved is not new. A part with no unmatched twin in the version last seen
 * is new; a part of that version left unmatched is removed.
 */

/** What a version of a card shows the captain, for comparing two of them. */
export type CardVersion = Pick<Card, "title" | "body" | "actions" | "pictures">;

/**
 * Each picture and demo copy's address read as its verified bytes. A version
 * with a picture saved before bytes were recorded reads none of its pictures
 * by bytes (`identities` false), so its pictures all read as "picture".
 */
export function mediaOf(version: Pick<Card, "pictures">, identities: boolean): Map<string, string> {
  const media = new Map<string, string>();
  // Identity comes from verified bytes, never a freshly minted copy name.
  for (const picture of version.pictures ?? []) {
    if (identities && picture.sha256)
      for (const ext of ["png", "jpg", "webp"] as const)
        media.set(cardPictureUrl(picture.id, ext), picture.sha256);
    if (picture.demo)
      media.set(cardMediaUrl(picture.demo.id, picture.demo.kind), picture.demo.sha256);
  }
  return media;
}

export function actionsKey(actions: readonly CardAction[]): string {
  return JSON.stringify(
    actions.map((action) => [action.id, action.label, action.default ?? false, action.effect]),
  );
}

/**
 * The changes from the version the captain last saw to the version on the
 * stage, written at `at`; undefined when nothing the captain sees changed. More
 * than half the parts new is a rewrite: the line says so and nothing is
 * marked. A playable preview is never marked - its own code draws it.
 */
export function cardChanges(
  seen: CardVersion,
  shown: CardVersion,
  at: number,
): CardChanges | undefined {
  const identities = [...(seen.pictures ?? []), ...(shown.pictures ?? [])].every((p) => p.sha256);
  const parts = cardParts(shown.body, mediaOf(shown, identities));
  const { added, removed } = unmatchedParts(cardParts(seen.body, mediaOf(seen, identities)), parts);
  if (
    added.length === 0 &&
    removed === 0 &&
    seen.title === shown.title &&
    actionsKey(seen.actions) === actionsKey(shown.actions)
  ) {
    return undefined;
  }
  const rewritten = added.length * 2 > parts.length;
  const marks =
    rewritten || isPreviewBody(shown.body)
      ? []
      : added.slice(0, CARD_CHANGE_MARKS_MAX).map((part) => part.start);
  return { at, added: added.length, removed, rewritten, marks };
}

/**
 * What a crewmate is told about a revision of a card the captain has seen:
 * the app's own count of new and removed parts, and "Rewritten" when the
 * stage will draw no bars. Informational - a rewrite is never refused - and
 * empty when the captain saw no earlier version or no part changed.
 */
export function revisionNotice(changes: (CardChanges & { preview: boolean }) | undefined): string {
  if (!changes || (changes.added === 0 && changes.removed === 0)) return "";
  const parts = (count: number) => `${count} ${count === 1 ? "part" : "parts"}`;
  const counts = `Compared with the version the captain last saw, the app found ${parts(changes.added)} new and ${changes.removed} removed.`;
  if (changes.preview) return ` ${counts}`;
  if (!changes.rewritten)
    return ` ${counts} The captain will see a change bar beside each new part.`;
  return ` ${counts} More than half is new, so they will see "Rewritten" with no change bars. That is fine when the answer itself changed shape. If you meant to change only a few parts, you can still edit those in place and call emit_card again before you close out.`;
}
