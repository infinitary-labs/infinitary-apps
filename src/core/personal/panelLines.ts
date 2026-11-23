/**
 * The feed's lines about the captain's panels:
 * one line per change, never a card (`pluginInstaller.ts`,
 * `personalizeTool.ts`, and the safe-mode boot in `bootRecovery.ts`). A plain
 * module, so an e2e spec reads them from their owner (docs/e2e-contracts.md,
 * "Words come from their owner").
 */

/** What a line about an added panel ends with while the captain's panels are off. */
const PANELS_OFF_TAIL = " - your panels are off, so it shows once they are back on";

/** A panel someone else made, added on the captain's yes. */
export function panelAddedLine(title: string, by: string, panelsOn = true): string {
  return `added "${title}", a panel by ${by}${panelsOn ? "" : PANELS_OFF_TAIL}`;
}

/** A newer version of an added panel, put in on the captain's yes. */
export function panelUpdatedLine(
  title: string,
  by: string,
  version: string,
  panelsOn = true,
): string {
  return `updated "${title}", a panel by ${by}, to ${version}${panelsOn ? "" : PANELS_OFF_TAIL}`;
}

/** An added panel taken away with its data. */
export function panelRemovedLine(title: string, by: string | null): string {
  return `removed "${title}", a panel by ${by}`;
}

export function personalPanelRemovedLine(title: string): string {
  return `${title} removed`;
}

/** An app panel, hidden rather than removed. */
export function appPanelHiddenLine(title: string): string {
  return `${title} hidden`;
}

/** The note a safe-mode boot leaves: what happened, and where the switch is. */
export const PANELS_SAFE_MODE_NOTE =
  "Your panels are off, the ones built for you and the ones you added: the app closed twice just after starting. Turn them back on in Settings when you are ready.";
