import { hasNotTypingKeys, type KeyPress } from "@shared/keyboard";
import { TYPING_CONTROL_SELECTOR } from "@shared/keyboardOffer";
import { installedBindings } from "../design/core/installedKeys";
import { focusWithRing } from "../design/focus";
import { available } from "./focusRecovery";

/** Every editing control, including a read-only prompt, keeps its keys. */
export function typingTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches(TYPING_CONTROL_SELECTOR))
  );
}

/** Offer after the whole event: a list or control may already have used it. */
export function followNotTypingKeys(): () => void {
  const down = (event: KeyboardEvent) => {
    // Where the press went is read during dispatch, as its path is: a key this
    // page heard while a frame held its focus is that frame's to offer, even
    // once focus has come back to the page before this offer runs.
    const elsewhere =
      event.composedPath().some(typingTarget) ||
      document.activeElement instanceof HTMLIFrameElement;
    setTimeout(() => {
      if (
        !hasNotTypingKeys(installedBindings()) ||
        !document.hasFocus() ||
        document.activeElement instanceof HTMLIFrameElement ||
        !event.isTrusted ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        elsewhere
      )
        return;
      const press: KeyPress = {
        key: event.key,
        code: event.code,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        composing: false,
        repeat: event.repeat,
      };
      void window.infinitary.keyboard.offer(press).catch(() => {});
    });
  };
  window.addEventListener("keydown", down, true);
  return () => window.removeEventListener("keydown", down, true);
}

/** The last Escape action, only for message fields and only with this layer installed. */
export function leaveMessageField(): void {
  if (!hasNotTypingKeys(installedBindings())) return;
  const active = document.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    !active.matches('[name="task-prompt"], [data-card-reply] textarea')
  )
    return;
  const target = shownCard() ?? document.querySelector<HTMLElement>("[data-stage]");
  if (target && available(target)) focusWithRing(target, { preventScroll: true });
}

/**
 * With this layer installed, an Escape on a maximized card goes to the card
 * and stops there, from its controls, its buttons or its reply alike: only
 * Maximize or restore card's key, or Restore, gives the size back. Without
 * it, the Escape is left to restore the card (docs/keyboard.md).
 */
export function escapeToMaximizedCard(event?: { isComposing: boolean }): boolean {
  if (!hasNotTypingKeys(installedBindings())) return false;
  // An input method's Escape stays its own, and the card keeps its size.
  if (event?.isComposing) return true;
  const card = shownCard();
  if (card && document.activeElement !== card) focusWithRing(card, { preventScroll: true });
  return true;
}

function shownCard(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-window-region="card"]')].find(available);
}
