import { thisDesktop } from "./desktop";

/** A key the app holds fixed, which no command and no setting changes. */
export type FixedKey = "Escape" | "Enter" | "ArrowLeft" | "ArrowRight" | "Copy" | "Z";

/**
 * A control's key hint for a key it always answers to, outside the catalog
 * (Esc closes the picture viewer, ← and → step it): drawn as the app's other
 * hints draw it, Esc as the word on every system as Close search's does.
 */
export function fixedKeys(key: FixedKey): {
  keys: string;
  "aria-keyshortcuts": string;
} {
  const system = thisDesktop().keys;
  // Copy is the system's own editing key, which the app never rebinds.
  if (key === "Copy")
    return system === "mac"
      ? { keys: "⌘C", "aria-keyshortcuts": "Meta+C" }
      : { keys: "Ctrl+C", "aria-keyshortcuts": "Control+C" }; // i18n-exempt: key name
  if (key === "Z") return { keys: "Z", "aria-keyshortcuts": "Z" };
  const keys =
    key === "Escape"
      ? "Esc" // i18n-exempt: key name
      : key === "Enter"
        ? system === "mac"
          ? "↩"
          : "Enter"
        : KEY_ARROWS[key];
  return { keys, "aria-keyshortcuts": key };
}

const KEY_ARROWS = { ArrowLeft: "←", ArrowRight: "→" } as const;
