import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FmEvent } from "@shared/events";
import { BUILTIN_SURFACES } from "@shared/surfaces";
import type { CrewSupervisor } from "../orchestrator/crewSupervisor";
import type { AppPaths } from "../paths";
import type { PersonalExtensions } from "../personal/personalExtensions";
import type { PersonalStore } from "../personal/personalStore";
import type { ShellPreferencesService } from "../preferences/shellPreferences";
import type { Runbooks } from "../runbooks/runbooks";
import { PluginInstaller } from "./pluginInstaller";
import type { PluginRecords } from "./pluginRecords";

/**
 * Home wiring for adding plugins by talking (Phase A, A2a): the installer,
 * the captain's consent on its card, and what an earlier run left staged,
 * reconciled before the app goes on.
 */
export async function startHomePlugins({
  pluginRecords,
  runbooks,
  paths,
  personalStore,
  supervisor,
  broadcastEvent,
  personal,
  preferences,
}: {
  pluginRecords: PluginRecords;
  runbooks: Runbooks;
  paths: AppPaths;
  personalStore: PersonalStore;
  supervisor: Pick<CrewSupervisor, "cards" | "hostOps">;
  broadcastEvent: (event: FmEvent) => void;
  personal: Pick<PersonalExtensions, "refresh">;
  preferences: Pick<ShellPreferencesService, "get">;
}): Promise<PluginInstaller> {
  // Install by talking (Phase A, A2a): the installer stages a plugin and
  // asks on the host's consent card; the supervisor routes the captain's
  // click on it (a host effect only his click on the card's controls runs).
  const pluginInstaller = new PluginInstaller({
    records: pluginRecords,
    runbooks,
    pluginsDir: paths.pluginsDir,
    stagingDir: paths.pluginsStagingDir,
    checkCacheDir: join(paths.pluginsStagingDir, ".check"),
    store: personalStore,
    cards: {
      raise: (card) => supervisor.cards.hostCards.raiseHostCard(card),
      withdraw: (id, reason) => supervisor.cards.hostCards.withdrawHostCard(id, reason),
      has: (id) => supervisor.cards.has(id),
    },
    broadcast: (event) => broadcastEvent(event),
    refresh: () => personal.refresh(),
    // An added plugin may not take the id of an app panel or of one of the
    // captain's own, whether or not the switch has them mounted right now.
    reservedIds: async () => [
      ...BUILTIN_SURFACES.map((surface) => surface.id),
      ...runbooks
        .list()
        .filter((book) => book.path)
        .map((book) => book.id),
      ...(await readdir(paths.personalWorkspaceDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    ],
    panelsOn: () => preferences.get().panels.enabled,
    log: (message) => console.warn(`[infinitary] ${message}`),
  });
  supervisor.hostOps.setPluginConsent({
    add: (id) => {
      void pluginInstaller.add(id).catch((error: unknown) => {
        broadcastEvent({
          type: "firstmate_note",
          text: `Could not add the panel "${id}": ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
    decline: (id) => void pluginInstaller.decline(id),
  });
  await pluginInstaller.reconcile();
  return pluginInstaller;
}
