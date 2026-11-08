import {
  type AnyCommandId,
  ariaKeyShortcuts,
  type Bindings,
  keyHint,
  panelCommandParts,
} from "@shared/keyboard";
import type { KeymapSnapshot } from "@shared/keymap";
import type { PanelCommandKeys, PanelKeys } from "@shared/personal/contracts";
import type { KeySystem } from "@shared/platform";
import { useMemo } from "react";
import { thisDesktop } from "../design/core/desktop";
import { useInstalledKeymap } from "../design/core/installedKeys";

/** What a control says about the window command it shares (docs/keyboard.md). */
export type CommandKeys = { keys: string | undefined; "aria-keyshortcuts": string | undefined };

/**
 * A control's key hint for the window command it runs: the command's first
 * key drawn in its label, and every key named for assistive technology. A
 * panel's header button reads the key of its panel's command that does the
 * same (docs/keyboard.md, "A panel's commands").
 */
export function commandKeys(
  id: AnyCommandId,
  bindings: Bindings,
  system: KeySystem = "mac",
): CommandKeys {
  return {
    keys: keyHint(id, bindings, system),
    "aria-keyshortcuts": ariaKeyShortcuts(id, bindings),
  };
}

/** A control's key hint from the installed keys, drawn again when they change; none for no command. */
export function useCommandKeys(id: AnyCommandId | null): CommandKeys {
  const { bindings } = useInstalledKeymap();
  return id === null
    ? { keys: undefined, "aria-keyshortcuts": undefined }
    : commandKeys(id, bindings, thisDesktop().keys);
}

/**
 * The keys one panel's own commands have in `keymap` (`PanelProps.keys`;
 * docs/keyboard.md, "Key hints"): each command the window installed for
 * that panel that has a key, by its id in the panel's manifest, drawn as
 * `system` draws it. A command with no key is left out.
 */
export function panelKeys(
  panel: string,
  keymap: Pick<KeymapSnapshot, "bindings" | "panels">,
  system: KeySystem = "mac",
): PanelKeys {
  const keys: Record<string, PanelCommandKeys> = {};
  for (const command of keymap.panels) {
    const parts = panelCommandParts(command.id);
    if (parts.panel !== panel) continue;
    const { keys: drawn, "aria-keyshortcuts": named } = commandKeys(
      command.id,
      keymap.bindings,
      system,
    );
    if (drawn === undefined) continue;
    keys[parts.command] =
      named === undefined ? { keys: drawn } : { keys: drawn, "aria-keyshortcuts": named };
  }
  return keys;
}

/**
 * A panel's `keys` from the installed keys, a new value only when they
 * change; none for no panel (a crewmate's draft, whose commands reach
 * nothing).
 */
export function usePanelKeys(panel: string | null): PanelKeys {
  const keymap = useInstalledKeymap();
  return useMemo(
    () => (panel === null ? {} : panelKeys(panel, keymap, thisDesktop().keys)),
    [panel, keymap],
  );
}
