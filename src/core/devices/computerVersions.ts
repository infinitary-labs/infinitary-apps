import type { AppFollowReport } from "@shared/appFollow";
import { type BuildIdentity, compareBuilds, sourceCommitOf } from "@shared/buildIdentity";
import { takesDownload, takesUpdate } from "@shared/contractFeatures";
import {
  type DeviceAppVersion,
  type DeviceOtherVersion,
  type DeviceView,
  deviceControls,
  isPhone,
} from "@shared/devices";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { compareSemver } from "@shared/semver";
import type { WorkDeviceVersion } from "../connection/connection";
import type { WorkDevices } from "../placed/workDevices";

type VersionOptions = {
  home?: { app?: string; contract: string; build?: BuildIdentity };
  work: Pick<WorkDevices, "runningVersions" | "lacksTurnChange">;
};

/**
 * Whether an update over the connection has the computer download this
 * Mac's published version itself first (docs/devices.md, "Downloading over
 * the connection"): a Mac elsewhere, which keeps its own copy, on a
 * contract that takes the download order.
 */
export function downloadsThere(device: DeviceView, contract: string): boolean {
  return device.onThisMac !== true && device.system === "macos" && takesDownload(contract);
}

/**
 * The version of the app open on each device that controls this computer
 * now, as its connection's hello said it (docs/devices.md, "Each copy's
 * version"), by device id. Two apps of one device read as the older, so a
 * copy behind is never hidden; one that said none reads as too old to say.
 */
export function appVersions(
  devices: readonly DeviceView[],
  options: VersionOptions,
  appFollows: ReadonlyMap<string, AppFollowReport>,
): Map<string, DeviceAppVersion> {
  const apps = new Map<string, DeviceAppVersion>();
  const running = devices.some((device) => deviceControls(device.kind))
    ? options.work.runningVersions()
    : [];
  const home = options.home?.app;
  for (const device of devices) {
    const said = running
      .filter((row) => row.deviceId === device.id && row.role === "view")
      .map((row) => row.version);
    if (said.length === 0) continue;
    const known = said.filter((version): version is string => version !== null);
    const app =
      known.length < said.length
        ? undefined
        : known.reduce((oldest, version) =>
            (compareSemver(version, oldest) ?? 0) < 0 ? version : oldest,
          );
    if (app === undefined) {
      apps.set(device.id, {});
      continue;
    }
    // A phone's app has versions of its own: never measured against this computer's.
    const order = isPhone(device) || home === undefined ? null : compareSemver(app, home);
    // What it said of catching up, while it is behind this computer's version and said it of that version.
    const follow = appFollows.get(device.id);
    apps.set(
      device.id,
      order === null
        ? { app }
        : order === 0
          ? { app, same: true }
          : {
              app,
              than: order < 0 ? "older" : "newer",
              ...(order < 0 && follow && follow.version === home ? { follow } : {}),
            },
    );
  }
  return apps;
}

/**
 * What the list says of a computer connected on another version of
 * Firstmate than this Mac's: undefined when it runs this Mac's. Two
 * versions of Firstmate are compared when both are known, else the
 * contracts they speak.
 */
export function otherVersion(
  device: DeviceView,
  version: WorkDeviceVersion,
  options: VersionOptions,
): DeviceOtherVersion | undefined {
  const home = options.home ?? { contract: PROTOCOL_VERSION };
  // Another account on this Mac runs this Mac's own copy, whichever build it
  // names: it is compared by version alone, and never matched by build
  // (docs/devices.md, "Matching the home's build").
  const builds = !device.onThisMac;
  const match = compareBuilds(builds ? home : { contract: home.contract, app: home.app }, {
    contract: version.contract,
    app: version.app,
    ...(builds ? { build: version.build } : {}),
  });
  if (match.same) return undefined;
  const homeCommit = builds ? sourceCommitOf(home.build) : null;
  const source = match.target === "source" && homeCommit;
  const updateBy = device.remoteLogin
    ? "remote-login"
    : takesUpdate(version.contract)
      ? "connection"
      : "command";
  return {
    ...(version.app !== undefined ? { app: version.app } : {}),
    ...(match.than ? { than: match.than } : {}),
    takesWork: version.takesWork && !options.work.lacksTurnChange(device.id),
    updateBy,
    ...(source ? { source: { commit: homeCommit } } : {}),
    ...(!source && updateBy === "connection" && downloadsThere(device, version.contract)
      ? { downloads: true as const }
      : {}),
  };
}
