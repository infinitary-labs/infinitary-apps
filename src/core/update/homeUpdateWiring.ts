import { askingView } from "../askedFromAView";
import type { CoreDispatcherOptions } from "../dispatcher";
import { createHomeUpdates } from "./homeUpdate";

/**
 * This computer's own update as the core answers it (docs/view.md, "Updating
 * the first mate's computer"): `inf:update:status` for its own window, naming
 * the view that started an update under way, and the `inf:home-update:*`
 * requests any paired view asks. On a Mac whose first mate a command started,
 * only the window opened beside it replaces the copy, so every step is asked
 * of it, opening it first when it is closed.
 */
export function dispatcherHomeUpdates({ services, host, emit, ownWindow }: CoreDispatcherOptions) {
  const homeUpdates = createHomeUpdates({
    updates: services.updateChecker,
    ...(ownWindow && host.macUpdates
      ? {
          window: {
            open: () => ownWindow.open(),
            ask: async (step: "status" | "install" | "later", from?: string) =>
              (await ownWindow.ask({ kind: "update", step, ...(from ? { from } : {}) })).status,
            ...(host.openOwnWindow ? { start: host.openOwnWindow } : {}),
          },
        }
      : {}),
    stops: () => ({
      tasks: services.supervisor.updates.wouldStopHere(),
      jobs: services.jobs.runningCount(),
    }),
    asked: (from) => emit("inf:update:asked", { from }),
  });
  const askingViewName = (): string | undefined => {
    const id = askingView();
    return id ? services.devices.list().find((device) => device.id === id)?.name : undefined;
  };
  return {
    "inf:update:status": () => homeUpdates.own(),
    "inf:home-update:status": () => homeUpdates.status(),
    "inf:home-update:install": () => homeUpdates.install(askingViewName()),
    "inf:home-update:later": () => homeUpdates.later(),
  };
}
