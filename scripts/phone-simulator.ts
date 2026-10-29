import { readFileSync } from "node:fs";
import type { PhoneDevice } from "./phone-test-plan.ts";

type DeviceType = { name: string; identifier: string };
type Runtime = {
  identifier: string;
  isAvailable: boolean;
  version: string;
  buildversion?: string;
  supportedDeviceTypes?: { identifier: string }[];
};
export type SimulatorCatalog = { devicetypes: DeviceType[]; runtimes: Runtime[] };
export type PhonePin = { xcode: string; ios: string; iosBuild: string; devices: Record<PhoneDevice, string> };

/** INF-1645: every Mac's phone check uses one Xcode and its own iOS simulator, named only in phone-pin.json. */
export const PHONE_PIN: PhonePin = JSON.parse(readFileSync(new URL("./phone-pin.json", import.meta.url), "utf8"));
const download = `Install Xcode ${PHONE_PIN.xcode}, then the iOS ${PHONE_PIN.ios} simulator with xcodebuild -downloadPlatform iOS -buildVersion ${PHONE_PIN.iosBuild}`;

/** Refuses an `xcodebuild -version` reading of any Xcode but the pinned one. */
export function phoneXcode(reading: string) {
  const version = /^Xcode (\S+)$/m.exec(reading)?.[1];
  if (version !== PHONE_PIN.xcode) throw new Error(`The phone check needs Xcode ${PHONE_PIN.xcode}, not ${version ?? "an unreadable Xcode"}. ${download}.`);
}

/** The pinned runtime and the device's type; never a newer or older runtime in its place (INF-1552, INF-1645). */
export function phoneSimulator(catalog: SimulatorCatalog, device: PhoneDevice) {
  const name = PHONE_PIN.devices[device];
  const kind = catalog.devicetypes.find((item) => item.name === name);
  if (!kind) throw new Error(`Install the ${name} simulator device type in Xcode`);
  const runtime = catalog.runtimes.find((item) => item.isAvailable && item.identifier.includes(".iOS-")
    && item.version === PHONE_PIN.ios && item.buildversion === PHONE_PIN.iosBuild);
  if (!runtime) throw new Error(`The phone check needs the iOS ${PHONE_PIN.ios} simulator ${PHONE_PIN.iosBuild}. ${download}.`);
  if (!runtime.supportedDeviceTypes?.some((supported) => supported.identifier === kind.identifier)) {
    throw new Error(`The pinned iOS ${PHONE_PIN.ios} simulator ${PHONE_PIN.iosBuild} does not support ${name}`);
  }
  return { kind, runtime };
}
