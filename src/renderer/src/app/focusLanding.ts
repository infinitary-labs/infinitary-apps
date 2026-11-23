import type { KeyPress } from "@shared/keyboard";
import { available, type Landing } from "./focusRecovery";
import { typingTarget } from "./notTypingKeys";
import { enterCard } from "./regions";
import { useShellStore } from "./store";

/**
 * Where focus lands when the control holding it goes away (docs/keyboard.md,
 * "Where focus lands"): a shortcut never changes whether a person is typing
 * while a card is left to act on. This module keeps one fact about the last
 * place focus rested - whether a person was typing there - and the
 * lost-focus fallback (`guardLostFocus`) lands by it: in the main message
 * while typing, else on the shown card, and in the main message once no card
 * is left, in every preset.
 *
 * Typing means focus rests in a text field, inside a frame (whose control
 * the window cannot see), or where a pointer put it. Only a key, or code
 * that rings focus as a key would (`focusWithRing`), leaves a person not
 * typing: a key pressed in focus, or a key the window's page or a card's
 * frame offers as not typed (`offerNotTypingKey`), since each document
 * offers a key only from a control that is not a text field. Command search
 * is left out: it gives focus back itself.
 */
let restedTyping = true;
/** The shown card is coming but not ready yet: focus waits on the stage for it. */
let waitingForCard = false;
/** The typing fact when Settings opened, given back when it closes. */
let typingBeforeSettings: boolean | null = null;

const stage = () => document.querySelector<HTMLElement>("[data-stage]");

function typingRest(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  // The empty card area is never a field, and only a key or this module puts focus there.
  if (target.matches("[data-stage]")) return false;
  if (target instanceof HTMLIFrameElement || typingTarget(target)) return true;
  return !target.matches(":focus-visible");
}

function trackRest(): () => void {
  const focusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-command-search]")) return;
    if (target !== stage()) waitingForCard = false;
    restedTyping = typingRest(target);
  };
  // A pointer leaves a person typing, also where its click focuses nothing.
  const pointerDown = () => {
    restedTyping = true;
  };
  document.addEventListener("focusin", focusIn, true);
  document.addEventListener("pointerdown", pointerDown, true);
  const unsubscribe = useShellStore.subscribe((s, previous) => {
    if (s.view === previous.view) return;
    if (s.view === "settings") typingBeforeSettings = restedTyping;
    else if (previous.view === "settings" && typingBeforeSettings !== null) {
      // Leaving Settings returns focus where it was: its controls are gone,
      // and the fallback lands by the fact from before it opened.
      restedTyping = typingBeforeSettings;
      typingBeforeSettings = null;
    }
  });
  return () => {
    document.removeEventListener("focusin", focusIn, true);
    document.removeEventListener("pointerdown", pointerDown, true);
    unsubscribe();
  };
}

/**
 * Offers a key the window's page or a card's frame heard and nothing used
 * (docs/keyboard.md, "Keys used when not typing"). The document offers it
 * only from a control that is not a text field, so the person pressing it
 * is not typing there, whatever the frame or a pointer left behind: a page
 * the key runs then lands on the next card, where the same key runs again.
 */
export function offerNotTypingKey(press: KeyPress, frame?: string): void {
  restedTyping = false;
  void window.infinitary.keyboard.offer(press, frame).catch(() => {});
}

export function typingWhereFocusRested(): boolean {
  return restedTyping;
}

export function landLostFocus(): void {
  const prompt = document.querySelector<HTMLElement>('[aria-label="Task prompt"]');
  // Settings and the first-launch gate have no available main message: nothing to land on.
  if (!prompt || !available(prompt)) {
    waitingForCard = false;
    return;
  }
  if (restedTyping) {
    waitingForCard = false;
    prompt.focus({ preventScroll: true });
    return;
  }
  const area = stage();
  const card = document.querySelector<HTMLElement>('[data-window-region="card"]');
  if (card && available(card)) {
    waitingForCard = false;
    enterCard(card);
    return;
  }
  // The shown card is drawn but not ready: hold focus on the stage, out of
  // every field, and land on the card when it is (`waiting`).
  if (card && area) {
    if (document.activeElement !== area) area.focus({ preventScroll: true });
    waitingForCard = true;
    return;
  }
  // No card left, as when a key closed the last one: the main message, so
  // the words typed next reach it.
  waitingForCard = false;
  prompt.focus({ preventScroll: true });
}

export function focusLanding(): Landing & { stop: () => void } {
  const stop = trackRest();
  return {
    land: landLostFocus,
    waiting: () => waitingForCard && document.activeElement === stage(),
    stop,
  };
}
