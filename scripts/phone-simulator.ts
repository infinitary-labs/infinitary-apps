import type { PhoneDevice } from "./phone-test-plan.ts";

type DeviceType = { name: string; identifier: string };
type Runtime = {
  identifier: string;
  isAvailable: boolean;
  version: string;
  supportedDeviceTypes?: { identifier: string }[];
};
export type SimulatorCatalog = { devicetypes: DeviceType[]; runtimes: Runtime[] };

/** INF-1552: a newer installed runtime may support only a different device. */
export function phoneSimulator(catalog: SimulatorCatalog, device: PhoneDevice) {
  const name = device === "ipad" ? "iPad Pro 11-inch (M4)" : "iPhone 16";
  const kind = catalog.devicetypes.find((item) => item.name === name);
  if (!kind) throw new Error(`Install the ${name} simulator device type in Xcode`);
  const runtime = catalog.runtimes.filter((item) =>
    item.isAvailable && item.identifier.includes(".iOS-") && Number(item.version.split(".")[0]) >= 18
    && item.supportedDeviceTypes?.some((supported) => supported.identifier === kind.identifier))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!runtime) throw new Error(`Install an iOS 18 or newer simulator runtime that supports ${name} in Xcode`);
  return { kind, runtime };
}
