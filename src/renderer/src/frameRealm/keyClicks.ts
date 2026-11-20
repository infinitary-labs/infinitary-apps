import type { FrameBridgeApi } from "@shared/plugins/bridge";
import { PANEL_KEY_CLICK_ACTION } from "@shared/plugins/panelActionIds";
import { clickedCommand } from "../app/keyClick";

/**
 * A panel page's half of the key reminder (docs/keyboard.md, "The key
 * reminder"): the window's page does not hear a click inside a panel's
 * frame, so the page says when a mouse click pressed one of its controls
 * marked with one of its own commands (`data-key-command`, which each entry
 * of `PanelProps.keys` carries). The window checks the command is this
 * panel's and has a key, and shows its reminder; a page it does not answer,
 * such as a crewmate's draft, goes unheard. Heard at capture, since a
 * control may go with its own click. Returns how to stop.
 */
export function followKeyClicks(doc: Document, bridge: FrameBridgeApi): () => void {
  const onClick = (event: MouseEvent) => {
    const command = clickedCommand(event);
    if (command !== null) bridge.action(PANEL_KEY_CLICK_ACTION, command).catch(() => {});
  };
  doc.addEventListener("click", onClick, true);
  return () => doc.removeEventListener("click", onClick, true);
}
