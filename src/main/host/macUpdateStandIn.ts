import { appendFileSync } from "node:fs";
import { DIRECT_MAC_INSTALLATION, parseMacInstallation } from "@core/update/macInstallation";
import type { MacUpdateDriver } from "@core/update/macUpdates";
import { releaseSource } from "@core/update/releaseSource";
import { settingFrom } from "@shared/envSettings";

/**
 * A direct Mac copy's update, stood in for a development or test run that
 * names a version (`INFINITARY_MAC_UPDATE_STAND_IN`): the release feed offers
 * it, the download finishes at once and the install, where a release would
 * quit and replace the copy, replaces nothing and never answers, so the
 * real update controller, the crew's save and every request around them run
 * as a release's would (tests/e2e/home-update.spec.ts,
 * tests/e2e/app-follows-home.spec.ts). A packaged build
 * always uses the real driver.
 */
export function macUpdateStandIn(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean,
): MacUpdateDriver | undefined {
  if (packaged) return undefined;
  const version = settingFrom(env, "MAC_UPDATE_STAND_IN")?.trim();
  if (!version) return undefined;
  /** Where each install that reached the replacement says its version, one line each. */
  const installs = settingFrom(env, "MAC_UPDATE_STAND_IN_INSTALLS")?.trim();
  /** The version last downloaded, the one an install replaces the copy with. */
  let downloaded: string | undefined;
  return {
    installation: parseMacInstallation(DIRECT_MAC_INSTALLATION),
    check: async () => ({ version, releaseUrl: releaseSource.releaseUrl(version) }),
    // Every version is published here, so a copy following another computer gets its version.
    checkVersion: async (exact) => ({
      version: exact,
      releaseUrl: releaseSource.releaseUrl(exact),
    }),
    download: async (offer, progress) => {
      downloaded = offer.version;
      progress(100);
    },
    // A release stages and quits here to replace the copy and never answers; nothing is
    // replaced and nothing quits. Someone using the app by then keeps it running, as a
    // release does before it stages. A journey reads the version that reached this step.
    install: (stillWanted) => {
      if (stillWanted && !stillWanted()) return Promise.resolve("unstaged");
      if (installs && downloaded) appendFileSync(installs, `${downloaded}\n`);
      return new Promise<void>(() => {});
    },
  };
}
