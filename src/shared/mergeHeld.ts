import {
  type Card,
  type CardAction,
  cardActionSchema,
  MERGE_HELD_MARK,
  mergeEffectOf,
} from "./cards.ts";

/**
 * The line the host puts at the top of a merge card behind its change
 * (INF-4031, `settleCardFacts`). It keeps the merge it took off, so the
 * card current again gets it back and every reader of "the open merge
 * card" still finds the card while its Merge is held.
 */
export const HELD_LINE = new RegExp(
  `<p class="inf-panel" ${MERGE_HELD_MARK}="([^"]*)">[\\s\\S]*?</p>`,
);

const unescaped = (text: string): string =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * The merges a held line keeps: only well-formed actions whose effect is a
 * merge of the task's own change, so a body can never bring back anything
 * else as a button.
 */
export function heldMerges(body: string | undefined): CardAction[] | undefined {
  const found = body ? HELD_LINE.exec(body) : null;
  if (!found?.[1]) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unescaped(found[1]));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const merges = parsed.flatMap((raw) => {
    const action = cardActionSchema.safeParse(raw);
    if (!action.success || action.data.passes) return [];
    const merge = mergeEffectOf(action.data);
    return merge && !merge.review ? [action.data] : [];
  });
  return merges.length > 0 ? merges : undefined;
}

/** A card's merge actions, its held ones included: how a reader finds the open merge card. */
export function mergeActionsOf(card: Pick<Card, "actions"> & { body?: string }): CardAction[] {
  return [...card.actions, ...(heldMerges(card.body) ?? [])].filter(
    (action) => mergeEffectOf(action) !== undefined,
  );
}

/**
 * An authored body without the host's held mark (INF-4031): only the host
 * writes the line, so a body an agent sends never carries one.
 */
export function withoutHeldMark(body: string): string {
  if (!body.includes(MERGE_HELD_MARK)) return body;
  return body
    .replace(new RegExp(HELD_LINE.source, "g"), "")
    .replaceAll(MERGE_HELD_MARK, "data-inf-quoted");
}
