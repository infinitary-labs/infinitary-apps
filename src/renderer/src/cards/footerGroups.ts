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
