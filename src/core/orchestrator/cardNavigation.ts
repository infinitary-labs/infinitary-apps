import {
  cardNavigationParts,
  type NavigationPart,
  normalizedCardMarkup,
  unmatchedParts,
} from "@shared/cardParts";
import { cardMediaUrl, cardPictureUrl } from "@shared/cardPictures";
import {
  type Card,
  type CardRevisionLinks,
  isPreviewBody,
  REVISION_TARGETS_MAX,
  type RevisionTarget,
} from "@shared/cards";
import { actionsKey } from "./cardChanges";

type Version = Pick<Card, "title" | "body" | "actions" | "pictures">;

function mediaOf(version: Version, identities: boolean): Map<string, string> {
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
function parts(version: Version, identities = true): NavigationPart[] {
  return cardNavigationParts(version.body, mediaOf(version, identities));
}

export function revisionLinks(previous: Card, next: Card): CardRevisionLinks | undefined {
  if (!previous.offerId || !next.offerId || !next.lifecycleId) return undefined;
  const identities = [...(previous.pictures ?? []), ...(next.pictures ?? [])].every(
    (p) => p.sha256,
  );
  const before = parts(previous, identities);
  const after = parts(next, identities);
  const { added } = unmatchedParts(
    before.filter((p) => !p.heading),
    after.filter((p) => !p.heading),
  );
  const gone = unmatchedParts(
    after.filter((p) => !p.heading),
    before.filter((p) => !p.heading),
  ).added;
  const edited = rewordedCount(added, gone);
  const removed = gone.length - edited;
  const changedHeadings = unmatchedParts(
    before.filter((p) => p.heading),
    after.filter((p) => p.heading),
  ).added;
  const targets: RevisionTarget[] = [];
  const add = (label: string, region: RevisionTarget["region"], start?: number) =>
    targets.push({
      id: targets.length,
      label: label.slice(0, 160),
      region,
      ...(start === undefined ? {} : { start }),
    });
  if (previous.title !== next.title) add("Title", "title");
  const bodyChanged =
    normalizedCardMarkup(previous.body, mediaOf(previous, identities)) !==
    normalizedCardMarkup(next.body, mediaOf(next, identities));
  if (bodyChanged && isPreviewBody(next.body)) add("Preview updated", "preview");
  else if (
    (added.length > 0 || changedHeadings.length > 0) &&
    (before.length > REVISION_TARGETS_MAX ||
      after.length > REVISION_TARGETS_MAX ||
      (added.length - edited) * 2 > after.filter((p) => !p.heading).length)
  )
    add("Whole card", "whole");
  else {
    const areas = new Set<number>();
    let unheaded = 0;
    const headings = after.filter((p) => p.heading);
    for (const part of [...added, ...changedHeadings].sort((a, b) => a.start - b.start)) {
      const area = part.area;
      if (!area) {
        add(`Change ${++unheaded}`, "body", part.start);
        continue;
      }
      if (areas.has(area.start)) continue;
      areas.add(area.start);
      const repeated = headings.filter((p) => p.area?.label === area.label);
      const number =
        repeated.length > 1 ? ` ${repeated.findIndex((p) => p.start === area.start) + 1}` : "";
      add(`${(area.label || "Change").slice(0, 160 - number.length)}${number}`, "body", part.start);
    }
  }
  if (actionsKey(previous.actions) !== actionsKey(next.actions)) add("Buttons", "buttons");
  return {
    lifecycleId: next.lifecycleId,
    offerId: next.offerId,
    previousOfferId: previous.offerId,
    released: false,
    targets,
    removed,
  };
}

/**
 * How many new parts are reworded old ones (INF-1623, the captain's
 * direction C): a part gone and a part new under the same heading pair
 * up, one for one, and count as edited, so a card whose lines were
 * reworded names its sections rather than Whole card, and its line counts
 * no removal for them. The pairing reads only where each part sits, never
 * its words.
 */
function rewordedCount(added: readonly NavigationPart[], gone: readonly NavigationPart[]): number {
  const left = new Map<string, number>();
  for (const part of gone) {
    const at = part.area?.path ?? "";
    left.set(at, (left.get(at) ?? 0) + 1);
  }
  let paired = 0;
  for (const part of added) {
    const at = part.area?.path ?? "";
    const count = left.get(at) ?? 0;
    if (!count) continue;
    left.set(at, count - 1);
    paired += 1;
  }
  return paired;
}

/** Carry identity across each intervening offer, stopping permanently at a missing/ambiguous area. */
export function resolveRevisionTargets(
  targets: readonly RevisionTarget[],
  versions: readonly Version[],
): RevisionTarget[] {
  if (!versions.length) return [];
  const identities = versions.flatMap((v) => v.pictures ?? []).every((p) => p.sha256);
  const parsed = versions.map((v) => parts(v, identities));
  return targets.flatMap((target) => {
    if (target.region !== "body") {
      if (target.region === "preview" && !isPreviewBody(versions.at(-1)?.body ?? "")) return [];
      return target.region === "buttons" && !versions.at(-1)?.actions.length ? [] : [target];
    }
    const original = parsed[0]?.find((p) => p.start === target.start);
    if (!original) return [];
    let source: NavigationPart = original;
    const originalKey = source.key;
    for (const current of parsed.slice(1)) {
      if (current.length > REVISION_TARGETS_MAX) return [];
      const area = source.area;
      if (!area) {
        const candidates = current.filter((p) => !p.area && p.key === originalKey);
        if (candidates.length !== 1) return [];
        source = candidates[0]!;
        continue;
      }
      // Both ends must be unique. Repeated paths never acquire identity by position.
      const prior = parsed[parsed.indexOf(current) - 1]!;
      const identity = (p: NavigationPart) =>
        p.heading &&
        (area.stableId ? p.area?.stableId === area.stableId : p.area?.path === area.path);
      if (prior.filter(identity).length !== 1) return [];
      const headings = current.filter(identity);
      if (headings.length !== 1) return [];
      const heading = headings[0]!;
      const originals = current.filter(
        (p) => p.area?.start === heading.start && p.key === originalKey,
      );
      source = originals.length === 1 ? originals[0]! : heading;
    }
    return [{ ...target, start: source.start }];
  });
}
