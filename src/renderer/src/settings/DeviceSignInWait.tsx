import * as m from "@shared/i18n/messages.generated";
import { type DeviceSignIns, signInPlace, wordedPlace } from "@shared/signIns";
import { workSetupWords } from "@shared/workSetupWords";
import { useState } from "react";
import { Button } from "../design";
import { awayNote, DEVICE_SIGN_INS_WORDS } from "./accountRows";
import { offersFixWork } from "./devicesWords";

/** While there is no report, never mistake missing sign-in facts for an empty account list. */
export function deviceSignInWaitLine(device: DeviceSignIns, home: string): string {
  const { label, who } = wordedPlace(signInPlace(device));
  if (device.reach !== "in-reach")
    return (
      workSetupWords(label, device.workSetup, device.heldOnLocalNetwork) ?? awayNote(device) ?? ""
    );
  return device.unanswered
    ? DEVICE_SIGN_INS_WORDS.unanswered(who, home)
    : m.settingsForgeChecking();
}

/** Intelligence's Fix it uses exactly the Devices row's retry, via the computer's window. */
export function DeviceSignInWait({ device, line }: { device: DeviceSignIns; line: string }) {
  const [error, setError] = useState<string | null>(null);
  const fix = offersFixWork({ ...device, inReach: device.reach === "in-reach" });
  const retry = async () => {
    setError(null);
    try {
      const { asked } = await window.infinitary.devices.fixWork(device.deviceId);
      if (!asked) setError(m.settingsDevicesTryAgainFailed());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : m.settingsDevicesTryAgainFailed());
    }
  };
  return (
    <div className="fm-forges-box" data-device-sign-in-wait={device.deviceId}>
      <div className="fm-forges-quiet">{line}</div>
      {fix && (
        <div className="fm-forges-add">
          <div>
            <Button
              variant="secondary"
              size="sm"
              aria-label={m.settingsDevicesFixItNamed({
                device: wordedPlace(signInPlace(device)).label,
              })}
              onClick={() => void retry()}
            >
              {m.settingsDevicesFixIt()}
            </Button>
          </div>
          {error && <span role="alert">{error}</span>}
        </div>
      )}
    </div>
  );
}
