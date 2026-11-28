/**
 * Which card the card overlay shows first (docs/card-overlay.md, "Which
 * card it shows"), from the stack as this window draws it - put-aside cards
 * and the ones the project focus holds back are not on it:
 *
 * 1. the card the newest notification on this computer was about, while it
 *    is still on the stack and still asks for a choice;
 * 2. else the first card on the stack that asks for a choice;
 * 3. else the card the stack shows now.
 *
 * Null when the stack is empty: the overlay then says so and takes no keys.
 */
export function overlayTarget(
  stack: readonly { id: string; actions: readonly unknown[] }[],
  shownId: string | undefined,
  noticedId: string | null,
): string | null {
  const asks = (entry: { actions: readonly unknown[] }) => entry.actions.length > 0;
  const noticed = noticedId ? stack.find((entry) => entry.id === noticedId) : undefined;
  if (noticed && asks(noticed)) return noticed.id;
  const decision = stack.find(asks);
  if (decision) return decision.id;
  if (shownId && stack.some((entry) => entry.id === shownId)) return shownId;
  return stack[0]?.id ?? null;
}
