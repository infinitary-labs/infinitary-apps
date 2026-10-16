import type { KeyPress } from "@shared/keyboard";
import type React from "react";

/**
 * Whether a keydown belongs to an input method's composition (Japanese,
 * Chinese, Korean). The Enter that confirms a candidate arrives as
 * `key: "Enter"` with `isComposing` set (W3C UI Events), and keyCode 229
 * marks the keydowns an input method is still processing. Such an Enter
 * confirms the candidate; it never sends.
 */
export function isComposing(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** A keydown as the app's keyboard commands read it (`src/shared/keyboard.ts`). */
export function keyPress(event: React.KeyboardEvent): KeyPress {
  return {
    key: event.key,
    code: event.code,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    composing: isComposing(event),
    repeat: event.repeat,
  };
}
