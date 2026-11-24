import { deviceControls, isPhone } from "@shared/devices";
import type { CoreInvokeChannel, InvokeRequest, InvokeResponse } from "@shared/ipc";
import { askingView } from "../askedFromAView";
import type { CoreServices } from "../coreServices";
import type { HostCapabilities } from "../host";
import { prepareReset, type ResetPrepareDeps, resetScope } from "../reset/prepare";
import { real, undoProjectSettings, within } from "../reset/projectGit";

type ResetHandlers = {
  [C in Extract<
    CoreInvokeChannel,
    "inf:app:reset-scope" | "inf:app:reset-prepare" | "inf:home-reset:start"
  >]: (...args: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/**
 * Reset Infinitary's first-mate side (docs/reset.md): the counts its
 * question shows, the undoing the window's own program asks once the person
 * confirmed, and a reset a computer that controls this one asks once the
 * person confirmed it there. No agent reaches the last two: neither the
 * window's page nor the command is served them (`PROGRAM_ONLY_CHANNELS`).
 */
export function resetHandlers(
  services: CoreServices,
  host: Pick<HostCapabilities, "resetForController">,
): ResetHandlers {
  const deps = resetDeps(services);
  /** The computer whose request started this reset, left on the list since it resets itself. */
  let asker: string | undefined;
  return {
    "inf:app:reset-scope": () => resetScope(deps),
    "inf:app:reset-prepare": () => prepareReset(deps, asker ? { keep: asker } : {}),
    "inf:home-reset:start": async () => {
      const from = controllingComputer(services);
      if (!from) throw new Error("Only a computer that controls this first mate can reset it.");
      if (!host.resetForController)
        throw new Error("Infinitary cannot reset this computer from another one.");
      await host.resetForController();
      // Only an accepted ask is kept; its reset starts on a later tick, after this.
      asker = from;
      return { ok: true as const };
    },
  };
}

/**
 * The paired computer asking, when it is one that controls this first mate:
 * never a phone, a computer that only runs work, or this computer's own
 * window, which asks no view.
 */
function controllingComputer(services: CoreServices): string | undefined {
  const id = askingView();
  if (!id) return undefined;
  const device = services.devices.list().find((listed) => listed.id === id);
  if (!device || isPhone(device) || !deviceControls(device.kind)) return undefined;
  return device.id;
}

export function resetDeps(services: CoreServices): ResetPrepareDeps {
  // Read at each use, as the dispatcher's other handlers do, so building a
  // dispatcher over services that carry no paths reads nothing yet.
  const dataDir = () => services.paths.userData;
  return {
    devices: () => services.computers.list(),
    removeDevice: (id) => services.devices.remove(id),
    accounts: () => services.vault.list(),
    signOut: (id) => services.vault.remove(id),
    integrations: () => services.integrations.view().integrations,
    removeIntegration: (id) => services.integrations.remove(id),
    openTasks: () => services.tasks.listLive(),
    discardTask: (id) =>
      services.supervisor.settling.closing.closeTask(id, {
        status: "dropped",
        reason: "discarded",
        actor: "captain",
      }),
    leftoversSettled: (id) => services.leftovers.settled(id),
    keptJobs: () => services.keptRunning.list().jobs,
    removeKeptJob: (id) => services.keptRunning.remove(id),
    // Projects the app cloned live in its folder and go with it; one it
    // adopted may be listed by a link in the folder to where it really is.
    projects: () =>
      services.repos
        .list()
        .map((repo) => real(repo.path))
        .filter((path) => !within(real(dataDir()), path)),
    undoProject: (folder) => undoProjectSettings(folder, dataDir()),
  };
}
