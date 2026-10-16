import {
  ariaKeyShortcuts,
  type CommandId,
  catalogBindings,
  chordLabel,
  type KeyChord,
  keyHint,
} from "@shared/keyboard";
import { type DesktopConventions, desktopConventions } from "@shared/platform";

/**
 * This computer's desktop, as the app reads it (src/shared/platform.ts): a
 * journey asks it whether the window has the Mac's material and Dock, its
 * app menu and its keys, rather than naming a system.
 */
export const THIS_DESKTOP: DesktopConventions = desktopConventions(process.platform);

/** Whether the app sets an app menu here: a Mac's, never a desktop whose window draws its own controls. */
export const HAS_APP_MENU = THIS_DESKTOP.windowControls === "system";

/** A command's key hint as this computer draws it: `⌘\` on a Mac, `Ctrl+\` on Linux (`keyHint`). */
export function hintOf(id: CommandId): string {
  const hint = keyHint(id, catalogBindings(THIS_DESKTOP.keys), THIS_DESKTOP.keys);
  if (!hint) throw new Error(`${id} has no key on this computer`);
  return hint;
}

/**
 * A key written as a Mac writes it, such as a panel's suggested ⌘J or one a
 * journey presses with `pressWindowKey`, pressed on this computer: on Linux
 * Ctrl takes ⌘'s place (docs/keyboard.md, "Keys on each system").
 */
export function pressedHere(chord: KeyChord): KeyChord {
  if (THIS_DESKTOP.keys === "mac" || !chord.meta) return chord;
  const { meta: _command, ...held } = chord;
  return { ...held, ctrl: true };
}

/** That key as this computer draws it (`chordLabel`): `⌘J` on a Mac, `Ctrl+J` on Linux. */
export function keyWords(chord: KeyChord): string {
  return chordLabel(pressedHere(chord), THIS_DESKTOP.keys);
}

/** A command's one key as `aria-keyshortcuts` names it here (`ariaKeyShortcuts`): `Meta+P` on a Mac. */
export function ariaKeysOf(id: CommandId, chord: KeyChord): string | undefined {
  return ariaKeyShortcuts(id, {
    ...catalogBindings(THIS_DESKTOP.keys),
    [id]: [pressedHere(chord)],
  });
}
