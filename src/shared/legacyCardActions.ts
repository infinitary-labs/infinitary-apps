import { type CardAction, type CardEffect, oneMergeEffect } from "./cards.ts";

// The cards of an older contract in today's vocabulary, split from
// `cards.ts` along its owner: the migrations and the replay harness.

/**
 * The action ids the host dispatched on before P1, as the effects they
 * meant. Migration 29 runs this once over the open cards of an upgraded
 * database, and the replay harness over the cards its recorded sessions
 * emit, so a card minted under the old contract still does what its
 * button says. `undefined` is an ordinary reply, untouched, the old close
 * controls included (`LEGACY_CLOSE_CONTROL_IDS`, INF-3108).
 */
export function legacyActionEffect(id: string): CardEffect | undefined {
  switch (id) {
    case "merge-pr":
    case "land":
      return { kind: "merge", after: "close" };
    case "discard":
      return { kind: "settle", mode: "discard" };
    case "discard-anyway":
      return { kind: "settle", mode: "discard", confirm: true };
    case "open-settings":
      return { kind: "open", target: "settings" };
    case "retry-firstmate":
      return { kind: "host", op: "retry-firstmate" };
    default:
      break;
  }
  const restore = "restore-account:";
  if (id.startsWith(restore))
    return { kind: "host", op: "restore-account", arg: id.slice(restore.length) };
  const move = "move-flagship:";
  if (id.startsWith(move)) return { kind: "host", op: "move-flagship", arg: id.slice(move.length) };
  return undefined;
}

/**
 * A card's actions from before P1 in P1's vocabulary: the reserved ids
 * become effects (a discard is danger), and every other action is the
 * reply it always was, the old close controls included. A settle merge or
 * a `request_merge` from before the one merge effect becomes that effect
 * (INF-2744, `mergeEffectOf`). Any other action that already carries an
 * effect is left alone, so the mapping is idempotent.
 */
export function migrateLegacyActions(actions: CardAction[]): CardAction[] {
  return oneMergeEffect(actions).flatMap((action) => {
    if (action.effect) return [action];
    const effect = legacyActionEffect(action.id);
    if (effect === undefined) return [action];
    const danger = effect.kind === "settle" && effect.mode === "discard";
    return [{ ...action, effect, ...(danger ? { danger: true, variant: "danger" as const } : {}) }];
  });
}
