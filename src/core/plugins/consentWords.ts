import { HERE } from "@shared/deviceNames";
/** The words a panel's consent card says (`pluginInstaller.ts`, A2a), around its own markup. */

/** The consent card's title: adding a panel, or a newer version that asks for something different. */
export function panelConsentTitle(title: string, name: string, update = false): string {
  return update ? `Update the ${title} panel?` : `Add the ${title} panel by ${name}?`;
}

/** Who made the panel, and which version of it this is. */
export function panelByWords(name: string, version: string): string {
  return `a panel by ${name}, version ${version}`;
}

/** The start of the line that lists what the panel reads. */
export const CAN_READ_WORDS = "It can read";

/** The one grant that changes the captain's work, on its own line. */
export const MOVES_WORDS =
  "It can queue, start and drop your tasks, each only when you click or press a key in it. It can never merge or discard.";

/** What no added panel does. */
export const SENDS_NOTHING_WORDS = `sends nothing off ${HERE.this}`;
