import * as m from "@shared/i18n/messages.generated";
import {
  type KeyBinding,
  type PanelCommand,
  type PanelCommandId,
  panelCommandId,
  panelCommandParts,
} from "@shared/keyboard";
import { parseSuggestedKey } from "@shared/plugins/panelCards";
import { panelCardEntryId } from "../app/stack";
import { useShellStore } from "../app/store";
import { setInstalledKeymap } from "../design/core/installedKeys";
import type { SidePanelContribution } from "./contributions";
import type { PluginHost } from "./host";
import { pressHeaderButton, pressPanelAsk } from "./PanelHeaderButtons";
import { emitNamedCard } from "./panelCards";
import { panelRail } from "./panelRail";
import { railStore } from "./railStore";

/**
 * A panel's commands (docs/keyboard.md, "A panel's commands"): what its
 * manifest's `commands` add to command search, listed under its title,
 * with the key it suggests. The window installs them with the catalog's,
 * in the order the panels were added, so a suggested key is taken only
 * where no other command already uses it; Keyboard settings gives one a
 * key of a person's own. A command puts up one of the panel's named cards,
 * presses one of its header buttons - the same call its button makes, as
 * data - or asks the panel by a name of its own with no button, so it works
 * while the panel is collapsed.
 */

/** The commands of every registered panel, in the order the panels were added. */
export function panelCommandsOf(panels: readonly SidePanelContribution[]): PanelCommand[] {
  return panels.flatMap((panel) =>
    (panel.commands ?? []).map((command) => {
      const chord = command.key === undefined ? null : parseSuggestedKey(command.key);
      return {
        id: panelCommandId(panel.id, command.id),
        label: command.label,
        panel: panel.title,
        keys: chord ? [chord as KeyBinding] : [],
        ...(command.words?.length ? { words: [...command.words] } : {}),
        // The app's own panels carry no maker's name, and their commands read as the window's.
        ...(panel.attribution === null ? { own: true as const } : {}),
      };
    }),
  );
}

export function startPanelCommands(host: PluginHost): () => void {
  let told = "[]";
  const tell = () => {
    const commands = panelCommandsOf(host.sidePanels.list());
    const text = JSON.stringify(commands);
    if (text === told) return;
    told = text;
    void window.infinitary.keyboard
      .setPanels(commands)
      .then(setInstalledKeymap)
      .catch(() => {
        // The next change tells it again.
        told = "";
      });
  };
  tell();
  return host.sidePanels.subscribe(tell);
}

function resolve(host: PluginHost, id: PanelCommandId) {
  const { panel: panelId, command: commandId } = panelCommandParts(id);
  const panel = host.sidePanels.get(panelId);
  const command = panel?.commands?.find((candidate) => candidate.id === commandId);
  return panel && command ? { panel, command } : null;
}

/**
 * Why a panel's command cannot run now, beyond what holds every key: one
 * that presses a button or asks the panel needs its panel on a rail with something to show -
 * for a panel whose own code decides, one it says shows; one that puts up
 * a card works from anywhere, Settings included, the panel collapsed or not;
 * and none runs while its own page says it cannot (`rail.refuse`).
 */
export function panelCommandRefusal(
  host: PluginHost,
  id: PanelCommandId,
  recording: boolean,
): string | null {
  const found = resolve(host, id);
  if (!found) return m.panelCommandGone();
  if (recording) return m.panelCommandRecording();
  // Its own page's word on this one command, whatever the command does.
  const refused = panelRail.get(found.panel.id).refused[found.command.id];
  if (refused !== undefined) return refused;
  if (found.command.emits !== undefined) return null;
  if (railStore.isHidden(found.panel.id)) return m.panelCommandHidden({ title: found.panel.title });
  if (found.panel.source.get() === null)
    return m.panelCommandNothingToShow({ title: found.panel.title });
  if (found.panel.rail?.decides !== true) return null;
  // Off its rail by its own word: why, in its own words when it said them.
  const said = panelRail.get(found.panel.id);
  return said.shown === true
    ? null
    : (said.why ?? m.panelCommandNothingToShow({ title: found.panel.title }));
}

/**
 * Runs a panel's command: its named card at the front of the stack, from
 * the home screen, with the keyboard's focus in it once it is drawn
 * (`focusCard`); or its header button, or its own ask, pressed into the panel.
 */
export function runPanelCommand(
  host: PluginHost,
  id: PanelCommandId,
  focusCard: (entryId: string) => void,
): void {
  const found = resolve(host, id);
  if (!found) return;
  const { panel, command } = found;
  if (command.emits !== undefined) {
    const s = useShellStore.getState();
    if (s.view !== "home") s.setView("home");
    const cardId = emitNamedCard(panel.id, command.emits, command.data);
    if (cardId !== null) focusCard(panelCardEntryId(panel.id, cardId));
    return;
  }
  if (command.asks !== undefined) {
    pressPanelAsk(panel.id, command.asks, "key");
    return;
  }
  const button = panel.header?.find((candidate) => candidate.id === command.presses);
  if (button) pressHeaderButton(panel.id, button, "key");
}
