import { type AnyCommandId, ariaKeyShortcuts, type Bindings, keyHint } from "@shared/keyboard";
import type { KeySystem } from "@shared/platform";
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
