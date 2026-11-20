import type { CardPressInput } from "@shared/cards";
import { type AnyCommandId, bindingLabel, keysOf } from "@shared/keyboard";
import { thisDesktop } from "../design/core/desktop";
import { installedBindings } from "../design/core/installedKeys";

/**
 * What pressed a card's button (INF-4175, docs/card-evidence.md "What a
 * click carries"): the shell says it beside the press, so a choice's record
 * shows how it was made. It only names the input; a press acts the same
 * whatever pressed it.
 */

/** How a window command reached the shell: its key, heard by the main process, or a row of command search. */
export type CommandVia = "key" | "command-search";

/** The window command pressing a button right now, while its click runs. */
let commanded: CardPressInput | null = null;

/** Enter or Space on the focused control, from its keydown until just after its keyup. */
let heldKey: { key: "Enter" | "Space"; target: EventTarget | null } | null = null;

function heardKeyDown(event: KeyboardEvent): void {
  heldKey =
    event.key === "Enter" || event.key === " "
      ? { key: event.key === "Enter" ? "Enter" : "Space", target: event.target }
      : null;
}

function heardKeyUp(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  // Space presses a button at its keyup, after this listener: the key is
  // forgotten once that press has run.
  const held = heldKey;
  setTimeout(() => {
    if (heldKey === held) heldKey = null;
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("keydown", heardKeyDown, true);
  document.addEventListener("keyup", heardKeyUp, true);
  document.addEventListener("pointerdown", () => (heldKey = null), true);
}

/** The keys `command` has installed now, as this computer draws them (⌘1). */
function installedKeysOf(command: AnyCommandId): string[] {
  const system = thisDesktop().keys;
  return keysOf(installedBindings(), command).map((binding) => bindingLabel(binding, system));
}

/**
 * Presses `button` for a window command: the click a pointer would make,
 * through the button's own checks, saying which command pressed it and how
 * the command came.
 */
export function pressForCommand(button: HTMLElement, command: AnyCommandId, via: CommandVia): void {
  const before = commanded;
  const keys = via === "key" ? installedKeysOf(command) : [];
  commanded = {
    kind: via,
    command,
    ...(keys.length > 0 ? { keys } : {}),
  };
  try {
    button.click();
  } finally {
    commanded = before;
  }
}

/**
 * What pressed `button`, from the click event that reached it: a window
 * command pressing it now, a pointer, or Enter or Space on that button.
 * Undefined when none of these is known, such as a click a script made.
 */
export function pressInputOf(event: MouseEvent, button: EventTarget): CardPressInput | undefined {
  if (commanded) return commanded;
  if (!event.isTrusted) return undefined;
  // A pointer's click counts its presses; a key's click counts none.
  if (event.detail > 0) {
    const pointerType = "pointerType" in event ? event.pointerType : undefined;
    return pointerType === "mouse" || pointerType === "pen" || pointerType === "touch"
      ? { kind: "pointer", pointer: pointerType }
      : { kind: "pointer" };
  }
  const held = heldKey;
  if (held && held.target === button) {
    heldKey = null;
    return { kind: "key", key: held.key };
  }
  return undefined;
}
