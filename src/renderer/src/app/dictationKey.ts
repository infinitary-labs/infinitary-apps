import { dictationKeyHoldsShortcuts } from "@shared/dictation";
import { flushSync } from "react-dom";
import { useShellStore } from "./store";

/** A press released sooner is a tap; one held this long is a hold. */
const HOLD_MS = 250;

/** One press of the dictation key, from its keydown until it ends. */
type Press = {
  at: number;
  /** This press stopped a tapped recording, so its release starts nothing. */
  stoppingToggle: boolean;
  /** The key also holds shortcuts, so another key with it ends the press. */
  holdsShortcuts: boolean;
  /** Pending until the press is a hold; then the hold starts the recording. */
  untilHold: ReturnType<typeof setTimeout> | null;
};

/** The press the dictation key is in, dropped when a click takes the key (`dictationKeyTakenByPointer`). */
let takenByPointer: (() => void) | null = null;

/**
 * A click made with the dictation key held, such as a ⌥-click on a card's
 * minus with right ⌥ (INF-4002), was the key's other use: what its press
 * recorded is dropped, and its release starts nothing.
 */
export function dictationKeyTakenByPointer(): void {
  takenByPointer?.();
}

/**
 * The saved dictation key works as a tap toggle or a hold, only while the
 * window's page has focus (D-10; docs/composer.md, "Voice"). A release
 * after a long hold accepts; a release after a tap leaves capture on; a new
 * press during a tapped recording stops it, and its release opens nothing.
 *
 * Right ⌥ records the moment it goes down. Right ⌘ and right ⌃ also hold
 * shortcuts, so their press waits: released sooner than HOLD_MS it is a tap,
 * held that long alone it is a hold, and another key pressed with it first
 * makes the press that key's shortcut, which runs with nothing recording.
 * Another key after a hold began drops what it recorded, except Escape,
 * which drops it itself (App.tsx). A key the window takes before the page
 * (`onTaken`) is another key too, and so is the window losing focus: the
 * page hears neither, nor the dictation key coming up after them.
 */
export function followDictationKey(): () => void {
  let press: Press | null = null;
  const forget = () => {
    if (press?.untilHold) clearTimeout(press.untilHold);
    press = null;
  };
  const withAnotherKey = (dropsRecording: boolean) => {
    if (!press?.holdsShortcuts) return;
    const { untilHold, stoppingToggle } = press;
    forget();
    // Committed now, so the key itself meets the main message as it is
    // with no recording: writable, and taking Enter.
    if (!untilHold && !stoppingToggle && dropsRecording)
      flushSync(() => useShellStore.getState().abandonRecording());
  };
  const down = (event: KeyboardEvent) => {
    const store = useShellStore.getState();
    if (store.pickingDictationKey) return;
    if (!store.dictation?.enabled) {
      forget();
      return;
    }
    if (event.code !== store.dictation.key) return;
    event.preventDefault();
    if (event.repeat || press !== null) return;
    press = {
      at: performance.now(),
      stoppingToggle: store.recording,
      holdsShortcuts: dictationKeyHoldsShortcuts(store.dictation.key),
      untilHold: null,
    };
    if (press.stoppingToggle) store.acceptRecording();
    else if (!press.holdsShortcuts) store.startRecording();
    else {
      const held = press;
      held.untilHold = setTimeout(() => {
        held.untilHold = null;
        useShellStore.getState().startRecording();
      }, HOLD_MS);
    }
  };
  // Before any field hears the other key, so it finds no recording there.
  const another = (event: KeyboardEvent) => {
    if (press && event.code !== useShellStore.getState().dictation?.key)
      withAnotherKey(event.key !== "Escape");
  };
  const up = (event: KeyboardEvent) => {
    const store = useShellStore.getState();
    if (!store.dictation?.enabled || store.pickingDictationKey) {
      forget();
      return;
    }
    if (event.code !== store.dictation.key) return;
    event.preventDefault();
    const ended = press;
    press = null;
    if (!ended || ended.stoppingToggle) return;
    if (ended.untilHold) {
      // A tap: talking starts, and stays on until the next press.
      clearTimeout(ended.untilHold);
      store.startRecording();
    } else if (performance.now() - ended.at >= HOLD_MS) store.acceptRecording(true);
  };
  const elsewhere = () => withAnotherKey(true);
  takenByPointer = () => {
    if (!press) return;
    const { untilHold, stoppingToggle } = press;
    forget();
    if (!untilHold && !stoppingToggle) useShellStore.getState().abandonRecording();
  };
  window.addEventListener("keydown", down);
  window.addEventListener("keydown", another, true);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", elsewhere);
  const stopTaken = window.infinitary.keyboard.onTaken(elsewhere);
  return () => {
    forget();
    takenByPointer = null;
    window.removeEventListener("keydown", down);
    window.removeEventListener("keydown", another, true);
    window.removeEventListener("keyup", up);
    window.removeEventListener("blur", elsewhere);
    stopTaken();
  };
}
