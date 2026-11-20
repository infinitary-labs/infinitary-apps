import * as m from "@shared/i18n/messages.generated";
import type { InvokeResponse } from "@shared/ipc";
import type { StandbyViews } from "@shared/standby";
import { useEffect, useState } from "react";

type SavedAddresses = InvokeResponse<"inf:standby:saved-addresses">;

/** Reads the selected copy's kept record at home, never its listener or its current network. */
export function TakeoverAddresses({
  deviceId,
  observed,
}: {
  deviceId: string;
  observed: StandbyViews;
}) {
  const [saved, setSaved] = useState<SavedAddresses>([]);
  useEffect(() => {
    const standby = window.infinitary?.devices?.standby;
    if (!standby?.savedAddresses || !observed.standbys.some((copy) => copy.deviceId === deviceId))
      return;
    let current = true;
    void standby.savedAddresses(deviceId).then(
      (entries) => {
        if (current) setSaved(entries);
      },
      () => {
        if (current) setSaved([]);
      },
    );
    return () => {
      current = false;
    };
  }, [deviceId, observed]);
  if (!saved.length) return null;
  const groups = [
    ["private", m.settingsDevicesPreferredAddress()],
    ["local", m.settingsDevicesLocalAddress()],
    [null, m.settingsDevicesOtherAddress()],
  ] as const;
  return (
    <div className="fm-device-address-details" data-device-saved-addresses="">
      <div>{m.settingsDevicesTakeoverAddress()}</div>
      <dl>
        {groups.map(([network, title]) => {
          const entries = saved.filter((entry) => entry.network === network);
          return (
            entries.length > 0 && (
              <div key={title}>
                <dt>{title}</dt>
                {entries.map(({ address }) => (
                  <dd key={address}>{address}</dd>
                ))}
              </div>
            )
          );
        })}
      </dl>
    </div>
  );
}
