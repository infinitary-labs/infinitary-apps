import { AsyncLocalStorage } from "node:async_hooks";

const asking = new AsyncLocalStorage<true>();

/**
 * Runs a paired view's request, so that whatever it opens later on the way,
 * such as a sign-in's page, opens where the person is (docs/view.md, "Pages
 * it would open").
 */
export function asAView<T>(work: () => T): T {
  return asking.run(true, work);
}

/** Whether the work running now began with a paired view's request. */
export function askedFromAView(): boolean {
  return asking.getStore() === true;
}
