/** What a held Enter would press again: a button, a link, a summary. */
const PRESSABLE = "button, [role='button'], a[href], [role='link'], summary";

/**
 * A held key presses a control once (docs/keyboard.md, "Cards and frames").
 * Enter clicks a button again on every repeat the platform sends, so an
 * Enter held on a card's button would press it again, or whatever control
 * focus moves to once the card leaves. The window lets those repeats press
 * nothing; Space clicks only when it is let go, so it presses once already.
 * A card's or a panel's frame is a document of its own and keeps its keys.
 */
export function heldPress(event: {
  key: string;
  repeat: boolean;
  target: EventTarget | null;
}): boolean {
  if (!event.repeat || event.key !== "Enter") return false;
  const target = event.target as Partial<Pick<Element, "closest">> | null;
  return typeof target?.closest === "function" && target.closest(PRESSABLE) !== null;
}

/** Drops a held Enter's repeats on the window's controls, for as long as the shell lives. */
export function guardHeldPresses(): () => void {
  const down = (event: KeyboardEvent) => {
    if (heldPress(event)) event.preventDefault();
  };
  document.addEventListener("keydown", down, true);
  return () => document.removeEventListener("keydown", down, true);
}
