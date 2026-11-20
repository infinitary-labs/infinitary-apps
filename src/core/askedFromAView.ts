import { AsyncLocalStorage } from "node:async_hooks";
import { type FoldedInto16, hasSince16 } from "@shared/contractFeatures";

/**
 * The paired view asking: the paired device it is, when known, and the
 * contract version and changes its hello said.
 */
type Asking = {
  view: string | undefined;
  version: string | undefined;
  changes: readonly string[] | undefined;
};

const asking = new AsyncLocalStorage<Asking>();

/**
 * Runs a paired view's request, so that whatever it opens later on the way,
 * such as a sign-in's page, opens where the person is (docs/view.md, "Pages
 * it would open"), and so that what it changes can name the paired device
 * that asked (docs/secrets.md, "Remote decisions"). `version` and
 * `changes` are the contract and the changes that view's hello said.
 */
export function asAView<T>(
  work: () => T,
  from: { view?: string; version?: string; changes?: readonly string[] } = {},
): T {
  return asking.run(
    { view: from.view || undefined, version: from.version, changes: from.changes },
    work,
  );
}

/** Whether the work running now began with a paired view's request. */
export function askedFromAView(): boolean {
  return asking.getStore() !== undefined;
}

/**
 * Whether the paired view whose request this work began with has an addition
 * major 16 folded in: it speaks that major, or lists the addition's name.
 */
export function askingViewHas(name: FoldedInto16): boolean {
  const from = asking.getStore();
  return hasSince16(from?.version, from?.changes, name);
}

/** The paired device whose request began the work running now, if a view's did. */
export function askingView(): string | undefined {
  return asking.getStore()?.view;
}
