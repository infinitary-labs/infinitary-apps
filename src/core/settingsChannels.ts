import type { CoreServices } from "./coreServices";

/**
 * Settings' channels that only hand their arguments to one service and emit
 * nothing: the runbook switches (docs/runbooks.md) and the app's cost limit
 * (docs/usage.md, "The cost limit"). The dispatcher spreads them into its
 * table, so it stays under the size check's ceiling.
 */
export function plainSettingsChannels(services: Pick<CoreServices, "runbooks" | "costLimit">) {
  return {
    "inf:settings:runbooks:get": () => services.runbooks.list(),
    "inf:settings:runbooks:copy": (id: string, copyId: string, name: string) =>
      services.runbooks.copy(id, copyId, name),
    "inf:settings:runbooks:set": (id: string, enabled: boolean) =>
      services.runbooks.set(id, enabled),
    "inf:settings:cost-limit:get": () => services.costLimit.view(),
    "inf:settings:cost-limit:set": (limit: Parameters<CoreServices["costLimit"]["set"]>[0]) =>
      services.costLimit.set(limit),
  };
}
