import {
  allCommandIds,
  type Bindings,
  COMMAND_IDS,
  type CommandId,
  isCatalogCommand,
  isWindowCommand,
  KEYBOARD_COMMANDS,
  type KeyboardCommand,
  keyHint,
  type PanelCommand,
  type PanelCommandId,
  type WindowCommandId,
} from "@shared/keyboard";
import type { KeySystem } from "@shared/platform";

/**
 * Command search's list (docs/keyboard.md): the window's commands by name,
 * in the catalog's order, each with its key and, when it cannot run now,
 * why. Search itself is not on its own list.
 */
export const SEARCHED_COMMANDS: readonly WindowCommandId[] = COMMAND_IDS.filter(
  (id): id is WindowCommandId => isWindowCommand(id) && id !== "commands.search",
);

export type CommandRow = {
  id: WindowCommandId | PanelCommandId;
  label: string;
  /**
   * A panel's command: the title of the panel it is listed under
   * (docs/keyboard.md); none for the window's own, the app's own panels'
   * among them.
   */
  panel?: string;
  /** Its first key as a hint shows it, or none for a command chosen only by name. */
  keys: string | undefined;
  /** Why it cannot run now, or null. */
  refusal: string | null;
};

/**
 * Whether a command's words hold every word typed, in any order and case:
 * its label's and the other words it is found by (`searchWords`).
 */
export function commandMatches(
  label: string,
  query: string,
  searchWords: readonly string[] = [],
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = [label, ...searchWords].join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * Whether this build offers a command where it acts: one whose Settings
 * section this build does not show - Devices, behind the multi-machine
 * gate - is never listed (docs/keyboard.md, "A command").
 */
export function commandOffered(id: CommandId, sections: { devices: boolean }): boolean {
  const { section } = KEYBOARD_COMMANDS[id] as KeyboardCommand;
  return section === undefined || sections[section];
}

/**
 * The rows for what is typed, each read against the window as it is now and
 * its key from the installed keys; a command this build does not offer is
 * never among them. The window's commands come first, in the catalog's
 * order with the app's own panels' among them; then each other panel's,
 * under its title, found by it and by the other words its manifest names.
 */
export function commandRows(
  query: string,
  refusal: (id: WindowCommandId | PanelCommandId) => string | null,
  bindings: Bindings,
  sections: { devices: boolean } = { devices: false },
  panels: readonly PanelCommand[] = [],
  /** Whose words a key is drawn in (docs/keyboard.md, "Keys on each system"). */
  system: KeySystem = "mac",
): CommandRow[] {
  const searched = new Set<string>(SEARCHED_COMMANDS);
  return allCommandIds(panels).flatMap((id): CommandRow[] => {
    if (isCatalogCommand(id)) {
      const command: KeyboardCommand = KEYBOARD_COMMANDS[id];
      if (!searched.has(id) || !commandOffered(id, sections)) return [];
      if (!commandMatches(command.label, query, command.searchWords)) return [];
      const windowId = id as WindowCommandId;
      return [
        {
          id: windowId,
          label: command.label,
          keys: keyHint(id, bindings, system),
          refusal: refusal(windowId),
        },
      ];
    }
    const command = panels.find((candidate) => candidate.id === id);
    if (!command) return [];
    const words = [...(command.own ? [] : [command.panel]), ...(command.words ?? [])];
    if (!commandMatches(command.label, query, words)) return [];
    return [
      {
        id: command.id,
        label: command.label,
        ...(command.own ? {} : { panel: command.panel }),
        keys: keyHint(command.id, bindings, system),
        refusal: refusal(command.id),
      },
    ];
  });
}

/** The row an arrow moves to, wrapping at either end; -1 when there are none. */
export function stepSelection(count: number, selected: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (selected < 0) return step === 1 ? 0 : count - 1;
  return (selected + step + count) % count;
}
