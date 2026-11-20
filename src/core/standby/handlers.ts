import { splitDialAddress } from "@shared/devices";
import type { CoreInvokeChannel, InvokeRequest, InvokeResponse } from "@shared/ipc";
import { reachedNetwork } from "../connection/addresses";
import type { Standbys } from "./wiring";
import { STANDBY_WORDS } from "./words";

type StandbyHandlers = {
  [C in Extract<CoreInvokeChannel, `inf:standby:${string}`>]: (
    ...args: InvokeRequest<C>
  ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/** Settings -> Devices' requests about the copies on other computers (docs/devices.md, "Keeping a copy on another computer"). */
export function standbyHandlers(standbys: Standbys | undefined): StandbyHandlers {
  return {
    "inf:standby:list": () => standbys?.views() ?? { standbys: [] },
    "inf:standby:saved-addresses": (id) =>
      (standbys?.stream.kept().find((entry) => entry.deviceId === id)?.addresses ?? []).map(
        (address) => ({
          address,
          network: reachedNetwork(splitDialAddress(address)?.host ?? ""),
        }),
      ),
    "inf:standby:name": (deviceId, on) =>
      standbys ? standbys.name(deviceId, on) : { ok: false, text: STANDBY_WORDS.noCopies },
    "inf:standby:keep-secrets": (deviceId) =>
      standbys ? standbys.keepSecrets(deviceId) : { ok: false, text: STANDBY_WORDS.noCopies },
    "inf:standby:ready": (deviceId) => {
      if (!standbys) throw new Error(STANDBY_WORDS.noCopies);
      return standbys.ready(deviceId);
    },
    "inf:standby:other-home": (other) => ({ ok: standbys?.otherHome(other).ok ?? false }),
    "inf:standby:keep-home": (choice) =>
      standbys ? standbys.keepHome(choice) : { ok: false, text: STANDBY_WORDS.noCopies },
  };
}
