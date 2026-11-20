import { TYPING_CONTROL_SELECTOR } from "@shared/keyboardOffer";

/**
 * Whether a person is typing in the shown card (docs/card-authoring.md,
 * "Declared continuity"): focus rests in one of its text fields, or in its
 * frame, whose control the window cannot see, as `focusLanding.ts` counts it.
 */
export function typingInShownCard(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.closest('[data-window-region="card"]'))
    return false;
  return (
    active instanceof HTMLIFrameElement ||
    active.isContentEditable ||
    active.matches(TYPING_CONTROL_SELECTOR)
  );
}
