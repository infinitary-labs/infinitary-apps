import { AsyncLocalStorage } from "node:async_hooks";
import { type ContractChangeName, listsChange } from "./connection/contractChanges";

/**
 * The paired view asking: the paired device it is, when known, and the
 * contract changes its hello listed.
 */
type Asking = { view: string | undefined; changes: readonly string[] | undefined };

const asking = new AsyncLocalStorage<Asking>();

/**
 * Runs a paired view's request, so that whatever it opens later on the way,
 * such as a sign-in's page, opens where the person is (docs/view.md, "Pages
 * it would open"), and so that what it changes can name the paired device
 * that asked (docs/secrets.md, "Remote decisions"). `changes` are the
 * contract changes that view listed.
 */
export function asAView<T>(
  work: () => T,
  from: { view?: string; changes?: readonly string[] } = {},
): T {
  return asking.run({ view: from.view || undefined, changes: from.changes }, work);
}

/** Whether the work running now began with a paired view's request. */
export function askedFromAView(): boolean {
  return asking.getStore() !== undefined;
}

/** Whether the paired view whose request this work began with listed a change. */
export function askingViewLists(change: ContractChangeName): boolean {
  return listsChange(asking.getStore()?.changes, change);
}

/** The paired device whose request began the work running now, if a view's did. */
export function askingView(): string | undefined {
  return asking.getStore()?.view;
}
