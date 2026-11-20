import * as m from "@shared/i18n/messages.generated";
import { mainMessageRefusal } from "../app/composer";
import { useShellStore } from "../app/store";

/**
 * Settings → Secrets' Move from another tool, and the command of the same
 * name (INF-4718's plan, piece 2; docs/secrets.md, "Bringing secrets from
 * another tool"): home, with the message box starting the ask to the first
 * mate and the caret after it, for the captain to name the tool. The first
 * mate starts the crewmate that moves them; nothing is sent from here.
 * Refused, as Go to the main message is, while the box is held. Returns
 * whether it started.
 */
export function startSecretsMove(): boolean {
  const shell = useShellStore.getState();
  if (mainMessageRefusal(shell) !== null) return false;
  shell.focusMainMessage();
  shell.beginDraft(m.settingsSecretsMoveDraft());
  return true;
}
