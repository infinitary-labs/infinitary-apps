import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** Where CoreSimulator keeps the shared library caches it built on this Mac, one folder per Mac build and runtime. */
export const SIMULATOR_CACHES = "/Library/Developer/CoreSimulator/Caches/dyld";

/** The pinned runtime's folder there on a Mac of this build (`sw_vers -buildVersion`). */
export function phoneSharedCacheFolder(macBuild: string, runtime: { identifier: string }, caches = SIMULATOR_CACHES) {
  return join(caches, macBuild, `${runtime.identifier}.${PHONE_PIN.iosBuild}`);
}

const holdsNoCache = (folder: string) => {
  try { return !readdirSync(folder).some((name) => name.startsWith("dyld_sim_shared_cache_")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * INF-2445: on the phone check's virtual Mac, an obsolete cache build left the pinned runtime's folder holding only its
 * warning that the runtime ships its own cache. CoreSimulator still names any such folder as the simulator's cache
 * folder; its processes fall back to the runtime's own cache, but the simulator's log never stores that cache's words,
 * so the kept log writes `<compose failure [shared UUID]>` for every message whose words live there, SpringBoard's
 * appearance line and the text-size reads among them. Without the folder the simulator uses the runtime's own cache
 * and stores its words. Removes such a folder through `remove` before the simulator starts, leaves a folder that holds a
 * cache, and answers the line the gate prints, or nothing when there was no such folder.
 */
export async function removeEmptyPhoneSharedCache(folder: string, remove: () => Promise<unknown>): Promise<string | undefined> {
  if (!holdsNoCache(folder)) return undefined;
  const unread = "so the simulator's kept log cannot spell out messages whose words live in its shared cache";
  try { await remove(); }
  catch (error) { return `Could not remove ${folder}, which holds no shared cache, ${unread}: ${(error as Error).message}`; }
  if (holdsNoCache(folder)) return `Removing ${folder}, which holds no shared cache, left it in place, ${unread}`;
  return `Removed ${folder}, which held no shared cache, so the simulator uses its runtime's own cache and its kept log spells out that cache's words`;
}
