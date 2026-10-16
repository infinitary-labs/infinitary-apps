import type { CardAction } from "@shared/cards";

/**
 * Which of a card's actions its own body may raise over the frame bridge.
 *
 * An action carrying an `effect` - `settle` (merge or discard), `open`, or
 * one of the host's own ops - is run by the HOST, and the host runs it only
 * from its own chrome: the footer button the captain clicks. A card body is
 * agent-authored and can be prompt-injected, and since WI-16 it can run its
 * own script at mount, so an effect action reachable from `inf.action` (or a
 * `data-inf-action` click the bridge turns into one) would let a card merge
 * its own PR before the captain had read it (the one live vector the old
 * sanitizer never touched; captain decision, 2026-09-15). Undeclared ids are
 * already refused per mount by `FrameController`, so withholding the id IS
 * the gate - there is no second place to forget the check.
 *
 * An action with no effect is a reply to the card's own author, which a body
 * may still raise: the worst it can do is send its own emitter a message.
 */
export function bridgeActionIds(actions: readonly CardAction[]): string[] {
  const effectIds = new Set(actions.filter((action) => action.effect).map((action) => action.id));
  const declared = new Set<string>();
  const ids: string[] = [];
  for (const action of actions) {
    if (effectIds.has(action.id) || declared.has(action.id)) continue;
    declared.add(action.id);
    ids.push(action.id);
  }
  return ids;
}
