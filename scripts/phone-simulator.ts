import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { budgetTimer, type DeadlineTimer } from "../tests/helpers/budgets.ts";
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

/**
 * How long the gate waits for a simulator to finish booting (INF-3689). Sixteen passing phone checks on the phone Macs
 * started their new simulator in 0.4 to 0.8 minutes, half of them in 0.5, while the app built beside it, and a first
 * boot of the pinned iPhone on a Mac mini took 15 seconds. A release check's iPhone boot never finished, and the check
 * sat silent until its job's 90-minute limit. The wait runs on the load clock, so a busy Mac stretches it, up to the
 * clock's wall cap.
 */
export const PHONE_BOOT_BUDGET_MS = 5 * 60_000;

// A `simctl bootstatus` heading, which starts each step of the boot it prints.
const BOOT_STEP = /^\[[^\]]+\] Status=/;

/**
 * Waits for `boot` - `simctl bootstatus <simulator> -b`, which boots the simulator and prints each step of its boot
 * through `heard` - to end, within `budget` (INF-3689). A boot still running then is stopped through `stop`, and the
 * wait fails naming the device, the simulator, the minutes it waited and the last step the boot printed, so a boot
 * that never finishes fails its check in minutes instead of at the job's own time limit.
 */
export async function phoneSimulatorBooted({
  device,
  simulator,
  boot,
  budget = PHONE_BOOT_BUDGET_MS,
}: {
  device: PhoneDevice;
  simulator: string;
  boot: (stop: AbortSignal, heard: (line: string) => void) => Promise<unknown>;
  budget?: number;
}): Promise<void> {
  const began = Date.now();
  // The lines of the last step the boot printed, after its heading; before the first heading, the lines it began with.
  let step: string[] = [];
  const heard = (line: string) => {
    const said = line.trim();
    if (BOOT_STEP.test(said)) step = [];
    else if (said) step.push(said);
  };
  const stopping = new AbortController();
  const booting = boot(stopping.signal, heard);
  let timer: DeadlineTimer | undefined;
  const stuck = new Promise<"stuck">((resolve) => {
    timer = budgetTimer(() => resolve("stuck"), budget);
  });
  try {
    if ((await Promise.race([booting.then(() => "booted" as const), stuck])) === "booted") return;
  } finally {
    timer?.cancel();
  }
  stopping.abort();
  // The stopped boot ends with a failure of its own, which this one replaces.
  await booting.catch(() => {});
  const minutes = ((Date.now() - began) / 60_000).toFixed(1);
  throw new Error(
    `${device}: simulator ${simulator} had not finished booting after ${minutes} minutes, so the gate stopped waiting; ` +
      (step.length > 0 ? `its boot last printed: ${step.join("; ")}` : "its boot printed nothing"),
  );
}
