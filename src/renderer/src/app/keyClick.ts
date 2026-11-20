/**
 * The attribute naming the command a control runs, while that command has a
 * key: a mouse click on it shows the key reminder (docs/keyboard.md, "The
 * key reminder"). In the window it names the command's own id
 * (`useCommandKeys`); in a panel's page, the command's id in the panel's
 * manifest (`PanelProps.keys`).
 */
export const KEY_COMMAND_ATTRIBUTE = "data-key-command";

/**
 * The command a mouse click pressed, when it pressed a control marked with
 * one: never a click a key or a script made, nor one on a control marked
 * off. The window's page and a panel's page read their own clicks with it.
 */
export function clickedCommand(event: MouseEvent): string | null {
  // A pointer's click counts its presses; Enter, Space and a command's own press count none.
  if (!event.isTrusted || event.detail === 0) return null;
  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest<HTMLElement>(`[${KEY_COMMAND_ATTRIBUTE}]`);
  if (!control || control.closest('[aria-disabled="true"]')) return null;
  return control.getAttribute(KEY_COMMAND_ATTRIBUTE) || null;
}
