/** What a computer that runs work confirmed it opened, against what the home asked. */
import { offeringKey } from "@shared/modelSlots";
import type { PlacedSpec } from "@shared/work";

/**
 * The spec of the conversation a computer confirmed it opened: the one asked,
 * bound to the account that computer says it bound, which may not be the one
 * the home named.
 */
export function confirmedSpec(
  asked: PlacedSpec,
  state: { accountId?: string | undefined },
): PlacedSpec {
  return state.accountId && state.accountId !== asked.binding.accountId
    ? { ...asked, binding: { ...asked.binding, accountId: state.accountId } }
    : asked;
}

/** Whether a conversation's model is the one asked, by offering; one asked for none is any. */
export function sameModel(
  model: { provider: string; id: string } | undefined,
  asked: { provider: string; id: string } | undefined,
): boolean {
  return !asked || (model !== undefined && offeringKey(model) === offeringKey(asked));
}
