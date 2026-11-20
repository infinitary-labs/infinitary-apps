import type { CardAction } from "@shared/cards";

/**
 * A card footer's two groups, in order: the quiet actions (ghost: explain
 * more) and the choices ending in the default. An empty group is dropped.
 * The default is drawn last whatever order the card lists it in, so a card
 * the app builds itself reads like an agent's (design skill ResponseCard).
 */
export function footerGroups<A extends Pick<CardAction, "variant" | "default">>(
  actions: readonly A[],
) {
  const quiet = actions.filter((action) => action.variant === "ghost");
  const choices = actions.filter((action) => action.variant !== "ghost");
  return [
    { key: "quiet", actions: quiet },
    {
      key: "choices",
      actions: [
        ...choices.filter((action) => !action.default),
        ...choices.filter((action) => action.default),
      ],
    },
  ].filter((group) => group.actions.length > 0);
}

/**
 * The button a footer draws for an action: its own variant, else primary
 * for the default and secondary for the rest, so a card the app builds
 * itself draws its default like an agent's (design skill ResponseCard,
 * FinishSetup, AddAMac's update card).
 */
export function footerVariant(
  action: Pick<CardAction, "variant" | "default">,
): NonNullable<CardAction["variant"]> {
  return action.variant ?? (action.default ? "primary" : "secondary");
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
