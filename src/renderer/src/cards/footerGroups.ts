import type { CardAction } from "@shared/cards";

/**
 * A card footer's two groups, in order: the quiet actions (ghost: explain
 * more) and the choices ending in the default. An empty group is dropped.
 */
export function footerGroups<A extends Pick<CardAction, "variant">>(actions: readonly A[]) {
  const quiet = actions.filter((action) => action.variant === "ghost");
  const choices = actions.filter((action) => action.variant !== "ghost");
  return [
    { key: "quiet", actions: quiet },
    { key: "choices", actions: choices },
  ].filter((group) => group.actions.length > 0);
}

/**
 * A footer's actions in the order its choice keys press them
 * (docs/keyboard.md): the default first, at ⌘1 wherever it is drawn, then
 * the rest from the right edge leftward, so the recommended step is always
 * the same key. A footer with no default starts at its rightmost button.
 */
export function choiceOrder<A extends Pick<CardAction, "variant" | "default">>(
  actions: readonly A[],
): A[] {
  const leftward = footerGroups(actions)
    .flatMap((group) => group.actions)
    .reverse();
  const recommended = leftward.find((action) => action.default);
  return recommended
    ? [recommended, ...leftward.filter((action) => action !== recommended)]
    : leftward;
}
