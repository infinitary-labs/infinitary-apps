import type { Page } from "@playwright/test";

/**
 * One queue of input per page. Playwright keeps one hit-target check per
 * page, so two clicks or a click and a key that overlap can swallow one of
 * them while it reports success. The app's own background presses (a dock
 * expanded so its frame is mounted, `expandDock`) and the helpers that
 * play a person's input (`pressKey`, `focusOn`, `clickInBody`) take turns
 * here, so none of them starts while another is in flight. A turn that
 * fails does not hold up the next one.
 */
const last = new WeakMap<Page, Promise<unknown>>();

export function takeTurn<T>(page: Page, input: () => Promise<T>): Promise<T> {
  const turn = (last.get(page) ?? Promise.resolve()).catch(() => {}).then(input);
  last.set(page, turn);
  return turn;
}
