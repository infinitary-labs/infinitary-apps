import {
  type Card,
  MERGE_ANYWAY_ACTION,
  settleEffectOf,
  splitSettleFacts,
  takesTaskFacts,
  withMergeClosesLine,
} from "@shared/cards";
import { MERGE_ANYWAY_WORDS } from "@shared/vocabulary";
import type { EmittedCardInput } from "../session/tools";

/**
 * What a settle card carries from the record rather than its author's words
 * (contract v2.0, captain ruling D4; the fact strip at v2.7): the facts the
 * host holds about its task - project, crewmate model, posture, PR link, CI
 * state - with the app's line saying whether its merge closes the task
 * (INF-2490), the words its merge reads now (INF-23), and Merge anyway
 * beside the merge while the host offers it (INF-1137 friction 6). The card
 * stack applies them when a card is emitted and again whenever the task's
 * record changes; they never come from an agent.
 */

/** What the facts are read from: the task's record and the stack, never the card's words. */
export type SettleFactsReading = {
  /** The task's fact strip and follow-ups now. */
  facts: () => string | undefined;
  /** Whether something besides this card keeps the task open past its merge (INF-2525). */
  othersOpen: () => boolean;
  /** The words a settle card's merge reads now, when the host names it; undefined leaves it. */
  mergeLabel?: (card: Card) => string | undefined;
  /** Whether a settle card offers Merge anyway beside its merge now. */
  mergeAnyway?: (card: Card) => boolean;
};

/**
 * A card with the facts the record holds now: its strip replaced in place,
 * its merge relabeled, and Merge anyway standing beside the merge or gone.
 * The same card back when nothing moved, and any card that takes no task
 * facts as it is.
 */
export function settleCardFacts(card: Card, read: SettleFactsReading): Card {
  if (!takesTaskFacts(card)) return card;
  const merges = (action: Card["actions"][number]) =>
    action.effect?.kind === "settle" && action.effect.mode === "merge" && !action.passes;
  const relabeled = (card: Card): Card => {
    const label = read.mergeLabel?.(card);
    if (!label || !card.actions.some((action) => merges(action) && action.label !== label))
      return card;
    return {
      ...card,
      actions: card.actions.map((action) => (merges(action) ? { ...action, label } : action)),
    };
  };
  // Merge anyway follows the record like the merge's words: it stands
  // beside the merge while the host offers it, and goes when it does not.
  const anyway = (card: Card): Card => {
    const offered = card.actions.some((action) => action.passes === "checks");
    const wanted = card.actions.some(merges) && read.mergeAnyway?.(card) === true;
    if (offered === wanted) return card;
    if (!wanted)
      return { ...card, actions: card.actions.filter((action) => action.passes !== "checks") };
    const at = card.actions.findIndex(merges);
    const action: Card["actions"][number] = {
      id: MERGE_ANYWAY_ACTION,
      label: MERGE_ANYWAY_WORDS,
      variant: "secondary",
      effect: { kind: "settle", mode: "merge" },
      passes: "checks",
    };
    return {
      ...card,
      actions: [...card.actions.slice(0, at), action, ...card.actions.slice(at)],
    };
  };
  const facts = withMergeClosesLine(read.facts(), card.actions, read.othersOpen());
  const split = facts ? splitSettleFacts(card.body) : undefined;
  if (!facts || !split) return anyway(relabeled(card));
  const body = split.body.slice(0, split.at) + facts + split.body.slice(split.at);
  return anyway(relabeled(body === card.body ? card : { ...card, body }));
}

/**
 * An emitted card on a task with the facts the host holds about it, on add
 * and on every in-place revision, so no prompt asks an agent to write them.
 * So does the story note of a task that merges on its own (INF-1219). Every
 * merge card's strip ends with the app's line saying whether its click
 * closes the task (INF-2490). A merge card also says what the crew filed
 * under the task's name (captain, 2026-09-14): deciding whether to land is
 * the one moment those follow-ups bear on the captain's choice, so they are
 * named here rather than met later as a refusal.
 */
export function emittedSettleFacts(
  input: EmittedCardInput,
  read: Pick<SettleFactsReading, "facts" | "othersOpen"> & {
    /** What the crew filed under the task's name. */
    followups: () => string | undefined;
  },
): EmittedCardInput {
  const facts = takesTaskFacts(input) ? read.facts() : undefined;
  const strip = withMergeClosesLine(facts, input.actions, read.othersOpen());
  let next = strip ? { ...input, body: `${input.body}${strip}` } : input;
  if (next.actions.some((action) => settleEffectOf(action)?.mode === "merge")) {
    const notice = read.followups();
    if (notice) next = { ...next, body: `${next.body}${notice}` };
  }
  return next;
}
