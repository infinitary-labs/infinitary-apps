/** FocusOptions as Chromium takes them; TypeScript's DOM types do not name `focusVisible` yet. */
type RingFocusOptions = FocusOptions & { focusVisible?: boolean };

/**
 * Puts focus on `element` and draws its ring (design skill: `--focus-ring`),
 * for focus a key moved that this document never heard: the main process
 * hears F6 and the window's other keys before any page does
 * (docs/keyboard.md), so a page cannot tell on its own that a key moved it.
 */
export function focusWithRing(element: HTMLElement, options: FocusOptions = {}): void {
  const ring: RingFocusOptions = { ...options, focusVisible: true };
  element.focus(ring);
}
