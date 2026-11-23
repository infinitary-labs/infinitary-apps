import type { CoreInvokeChannel, InvokeRequest, InvokeResponse } from "@shared/ipc";
import type { CoreServices } from "../coreServices";
import { prepareReset, type ResetPrepareDeps, resetScope } from "../reset/prepare";
import { real, undoProjectSettings, within } from "../reset/projectGit";

type ResetHandlers = {
  [C in Extract<CoreInvokeChannel, "inf:app:reset-scope" | "inf:app:reset-prepare">]: (
    ...args: InvokeRequest<C>
  ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/**
 * Reset Infinitary's first-mate side (docs/reset.md): the counts its
 * question shows, and the undoing the window's own program asks once the
 * person confirmed. Only this computer's window reaches either.
 */
export function resetHandlers(services: CoreServices): ResetHandlers {
  const deps = resetDeps(services);
  return {
    "inf:app:reset-scope": () => resetScope(deps),
    "inf:app:reset-prepare": () => prepareReset(deps),
  };
}

export function resetDeps(services: CoreServices): ResetPrepareDeps {
  const dataDir = services.paths.userData;
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
        .filter((path) => !within(real(dataDir), path)),
    undoProject: (folder) => undoProjectSettings(folder, dataDir),
  };
}
