import type { DeviceSignIns } from "@shared/signIns";
import { useEffect, useState } from "react";

/** The core owns each flow. Step events invalidate its whole view, never rebuild it here. */
export function useDeviceSignIns(): DeviceSignIns[] {
  const [devices, setDevices] = useState<DeviceSignIns[]>([]);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const apply = (next: DeviceSignIns[]) => {
      generation += 1;
      if (live) setDevices(next);
    };
    const read = () => {
      const started = ++generation;
      void window.infinitary.devices
        .signIns()
        .then((next) => {
          if (live && started === generation) apply(next);
        })
        .catch(() => {});
    };
    const offDevices = window.infinitary.devices.onSignIns(apply);
    const offStep = window.infinitary.devices.onSignIn(read);
    void window.infinitary.devices
      .shown()
      .then(({ shown: offered }) => {
        if (!live) return;
        setShown(offered);
        if (offered) read();
      })
      .catch(() => {});
    return () => {
      live = false;
      offDevices();
      offStep();
    };
  }, []);
  return shown ? devices : [];
}
