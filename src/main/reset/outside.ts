import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { hostEnv } from "@core/hostEnv";
import { removeAll } from "@core/removeWhole";
import type { CustodySlot, SecretCustody } from "@core/secrets/custody";
import { appIdOf, runLabelOf, workLabels } from "@shared/codeNames";
import type { BuildFlavor } from "@shared/userDataFolders";
import { createDarwinSecretCustody, loadDarwinCustodyApi } from "../host/darwinSecretCustody";
import { createLinuxSecretCustody, loadLibsecretApi } from "../host/linuxSecretCustody";
import {
  SECRET_APPROVER_NAMES,
  SECRET_STANDBY_NAMES,
  SECRETS_CUSTODY_NAMES,
} from "../host/nativeSecrets";
import { createWindowsSecretCustody, loadWindowsCustodyApi } from "../host/windowsSecretCustody";
import { accountKeychainPath } from "../runEnvironment";

/**
 * What a reset clears outside the data folder (docs/reset.md, "Outside the
 * folder"), by kind. Only a run on the person's own folder of a flavor
 * reaches any of it; an isolated or chosen folder has none of these.
 */

const SLOTS: readonly CustodySlot[] = ["root", "authority-head"];

/** macOS's own folder names under a home folder, the same in every language. */
const MAC_FOLDERS = {
  library: "Library", // i18n-exempt: a macOS folder name
  preferences: "Preferences", // i18n-exempt: a macOS folder name
  caches: "Caches", // i18n-exempt: a macOS folder name
  savedState: "Saved Application State", // i18n-exempt: a macOS folder name
  logs: "Logs", // i18n-exempt: a macOS folder name
} as const;

/**
 * The names a flavor's items carry in the system's password store: its
 * Secrets, its standby lock and, on a Mac, its approval key. Each is the
 * same name the app writes them under, so a reset never reaches another
 * flavor's items or anything else in the store.
 */
export function passwordStoreNames(platform: NodeJS.Platform, flavor: BuildFlavor): string[] {
  return [
    SECRETS_CUSTODY_NAMES[flavor],
    SECRET_STANDBY_NAMES[flavor],
    ...(platform === "darwin" ? [SECRET_APPROVER_NAMES[flavor]] : []),
  ];
}

/**
 * This computer's custody for each name, through the same native bindings
 * the app keeps them with. A Mac opens the account's login keychain by its
 * path unless a check names a scratch file.
 */
export function passwordStoreCustodies(input: {
  platform: NodeJS.Platform;
  flavor: BuildFlavor;
  keychainPath?: string;
}): SecretCustody[] | undefined {
  const names = passwordStoreNames(input.platform, input.flavor);
  if (input.platform === "darwin") {
    const api = loadDarwinCustodyApi(input.keychainPath ?? accountKeychainPath());
    return api && names.map((service) => createDarwinSecretCustody(api, { service }));
  }
  if (input.platform === "linux") {
    const api = loadLibsecretApi();
    return api && names.map((store) => createLinuxSecretCustody(api, { store }));
  }
  if (input.platform === "win32") {
    const api = loadWindowsCustodyApi();
    return api && names.map((name) => createWindowsSecretCustody(api, { name }));
  }
  return [];
}

/**
 * Deletes every slot's item of each custody. True once each answered gone or
 * never there; a locked or unreachable store is left for the next start.
 */
export async function clearPasswordStore(
  custodies: readonly SecretCustody[] | undefined,
): Promise<boolean> {
  if (!custodies) return false;
  let cleared = true;
  for (const custody of custodies)
    for (const slot of SLOTS) {
      const answer = custody.remove
        ? await custody.remove(slot).catch(() => "unavailable")
        : "unavailable";
      if (answer !== "removed" && answer !== "absent") cleared = false;
    }
  return cleared;
}

/**
 * What the app and macOS keep for a Mac's app outside its folder: its
 * preferences, caches, the updater's downloads, the saved window state and
 * the logs of its run and its work. Other systems keep these inside the data
 * folder. Each is named by this flavor's own app id or label.
 */
export function appFilePaths(input: {
  platform: NodeJS.Platform;
  flavor: BuildFlavor;
  homeDir: string;
}): string[] {
  if (input.platform !== "darwin") return [];
  const library = join(input.homeDir, MAC_FOLDERS.library);
  const appId = appIdOf(input.flavor);
  return [
    join(library, MAC_FOLDERS.preferences, `${appId}.plist`),
    join(library, MAC_FOLDERS.caches, appId),
    join(library, MAC_FOLDERS.caches, `${appId}.ShipIt`),
    join(library, MAC_FOLDERS.savedState, `${appId}.savedState`),
    ...[runLabelOf(input.flavor), ...workLabels(input.flavor)].map((label) =>
      join(library, MAC_FOLDERS.logs, `${label}.log`),
    ),
  ];
}

/**
 * Clears the app's files outside its folder, run at the start after the
 * reset, once nothing of the old app writes them. A Mac's preferences are
 * also kept by its preferences service, so they are deleted through it
 * before the file goes. True once every path is gone. Asynchronous, since
 * it runs before the window opens and must not hold the main thread.
 */
export async function clearAppFiles(
  input: { platform: NodeJS.Platform; flavor: BuildFlavor; homeDir: string },
  remove: (path: string) => boolean = removeAll,
): Promise<boolean> {
  if (input.platform === "darwin") {
    try {
      await promisify(execFile)("/usr/bin/defaults", ["delete", appIdOf(input.flavor)], {
        env: hostEnv(),
        timeout: 10_000,
      });
    } catch {
      // `defaults` refuses a domain it does not hold, which is already the
      // state a reset wants; the file's own removal below decides.
    }
  }
  let cleared = true;
  for (const path of appFilePaths(input)) if (!remove(path)) cleared = false;
  return cleared;
}
