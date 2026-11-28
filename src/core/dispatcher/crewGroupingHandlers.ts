import type { CoreInvokeChannel, InvokeRequest, InvokeResponse } from "@shared/ipc";
import type { Appearance } from "@shared/preferences";
import { crewGroupingValue } from "@shared/settingValues";
import type { CoreServices } from "../coreServices";

type CrewGroupingHandlers = {
  [C in Extract<
    CoreInvokeChannel,
    "inf:settings:crew-grouping:get" | "inf:settings:crew-grouping:set"
  >]: (...args: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/**
 * The look's crew grouping alone (docs/crew-orbits.md, "Grouping by
 * project"), which the phone's Appearance reads and sets. A set goes through
 * `setLook`, the look's own dispatched write, so every window hears the new
 * look and the trail says the change once, as a window's own switch does.
 */
export function crewGroupingHandlers(
  services: CoreServices,
  setLook: (look: Appearance) => Promise<Appearance>,
): CrewGroupingHandlers {
  return {
    "inf:settings:crew-grouping:get": () => crewGroupingValue(services.settings.getAppearance()),
    "inf:settings:crew-grouping:set": async ({ grouping }) =>
      crewGroupingValue(
        await setLook({ ...services.settings.getAppearance(), crewGrouping: grouping }),
      ),
  };
}
