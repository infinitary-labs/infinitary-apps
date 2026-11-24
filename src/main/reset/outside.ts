import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { SKILL_TEXT } from "@core/axi/captainCommands";
import { hostEnv } from "@core/hostEnv";
import { INFINITARY_COMMAND } from "@core/integrations/commandWords";
import { removeAll } from "@core/removeWhole";
import type { CustodySlot, SecretCustody } from "@core/secrets/custody";
import { appIdOf, runLabelOf, workLabels } from "@shared/codeNames";
import { PHONE_KEY_COMMENT } from "@shared/phoneLink";
import { type BuildFlavor, userDataFoldersNewestFirst } from "@shared/userDataFolders";
import {
  createDarwinSecretCustody,
  type DarwinCustodyApi,
  inKeychainTurn,
  loadDarwinCustodyApi,
} from "../host/darwinSecretCustody";
import {
  createLinuxSecretCustody,
  type LibsecretApi,
  loadLibsecretApi,
} from "../host/linuxSecretCustody";
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
 * True while another flavor's folder sits beside this one: what every flavor
 * shares outside its folder then still serves that flavor.
 */
function anotherFlavorBeside(flavor: BuildFlavor, dataDir: string): boolean {
  const other: BuildFlavor = flavor === "release" ? "dev" : "release";
  const parent = dirname(dataDir);
  return userDataFoldersNewestFirst(other).some((name) => existsSync(join(parent, name)));
}

/**
 * Removes the key lines phones placed in this account's `authorized_keys`
 * to reach this computer over Remote Login, each ending in the phone's own
 * comment; every other line stays as it was. Phones reach only a Mac or
 * Linux, and every flavor's phones place the same comment, so the lines are
 * left while another flavor's folder sits beside this one. True once none is
 * left.
 */
export function clearPhoneKeys(input: {
  platform: NodeJS.Platform;
  flavor: BuildFlavor;
  dataDir: string;
  homeDir: string;
}): boolean {
  if (input.platform === "win32" || anotherFlavorBeside(input.flavor, input.dataDir)) return true;
  const named = join(input.homeDir, ".ssh", "authorized_keys"); // i18n-exempt: OpenSSH's own file name
  let file: string;
  let text: string;
  try {
    // A person who keeps the file as a link (to a dotfiles copy, say) keeps
    // the link: the lines are written beside the file it leads to.
    file = realpathSync(named);
    text = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const lines = text.split("\n");
  const kept = lines.filter((line) => line.trim().split(/\s+/).at(-1) !== PHONE_KEY_COMMENT);
  if (kept.length === lines.length) return true;
  // Written whole beside it and renamed over it, with the file's own
  // permissions, which sshd checks before it reads a line.
  const pending = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(pending, kept.join("\n"), { mode: 0o600 });
    chmodSync(pending, statSync(file).mode & 0o777);
    renameSync(pending, file);
    return true;
  } catch {
    rmSync(pending, { force: true });
    return false;
  }
}

/**
 * This copy's own command, where Settings' link leads: inside the packaged
 * app, or the source's resources in a run from source, as the first mate
 * names it (`axiBinDir`, `src/core/services.ts`).
 */
export function ownCommand(app: {
  packaged: boolean;
  appDir: string;
  resourcesDir: string;
}): string {
  return app.packaged
    ? join(app.resourcesDir, "axi-bin", INFINITARY_COMMAND)
    : join(app.appDir, "resources", "axi-bin", INFINITARY_COMMAND);
}

/** Where Settings' one-click link to the command goes (`Inbox.link`). */
export const COMMAND_LINK_DIR = "/usr/local/bin";

/**
 * Removes the command's link Settings made and the agent skill `setup skill`
 * wrote. The link goes only while it still leads to this copy's own command,
 * so another flavor's link and anything else at that name stay; the skill
 * goes only while it still reads as the app wrote it and no other flavor's
 * folder sits beside this one, since every flavor writes the same skill.
 * True once neither is left.
 */
export function clearCommandLink(input: {
  flavor: BuildFlavor;
  dataDir: string;
  homeDir: string;
  /** This copy's own command, the link's target. */
  command: string;
  linkDir?: string;
}): boolean {
  let cleared = true;
  const link = join(input.linkDir ?? COMMAND_LINK_DIR, INFINITARY_COMMAND);
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === input.command) rmSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleared = false;
  }
  if (anotherFlavorBeside(input.flavor, input.dataDir)) return cleared;
  // i18n-exempt: Claude's own folder names
  const skillDir = join(input.homeDir, ".claude", "skills", INFINITARY_COMMAND);
  const skill = join(skillDir, "SKILL.md");
  try {
    if (readFileSync(skill, "utf8") === SKILL_TEXT) {
      rmSync(skill);
      rmdirSync(skillDir);
    }
  } catch (error) {
    // A folder the person keeps more in stays, with what they put there.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") cleared = false;
  }
  return cleared;
}

/** macOS's errSecItemNotFound: the item was never there. */
const ERR_SEC_ITEM_NOT_FOUND = -25300;

/**
 * Deletes the key Chromium keeps in the password store to encrypt the
 * window's saved data, its cookies: on a Mac the keychain item "<name> Safe
 * Storage" with the account <name>, on Linux the item of Chromium's own
 * schema with the application <name>, where <name> is the app's name
 * (`app.getName()`). Windows keeps that key inside the data folder.
 *
 * Every flavor of the app runs under the same name, so they share the key: it
 * is left while another flavor's folder sits beside this one, whose saved
 * data would no longer open. True once the key is gone or left on purpose;
 * a locked or unreachable store answers false.
 */
export async function clearSafeStorage(
  input: { platform: NodeJS.Platform; flavor: BuildFlavor; dataDir: string; appName: string },
  apis: { darwin?: () => DarwinCustodyApi | undefined; linux?: () => LibsecretApi | undefined } = {
    darwin: () => loadDarwinCustodyApi(accountKeychainPath()),
    linux: () => loadLibsecretApi(),
  },
): Promise<boolean> {
  const other: BuildFlavor = input.flavor === "release" ? "dev" : "release";
  const parent = dirname(input.dataDir);
  if (userDataFoldersNewestFirst(other).some((name) => existsSync(join(parent, name)))) return true;
  const item = `${input.appName} Safe Storage`; // i18n-exempt: Chromium's own item name
  if (input.platform === "darwin") {
    const api = apis.darwin?.();
    if (!api) return false;
    const status = await inKeychainTurn(() => {
      api.setUserInteractionAllowed(false);
      return api.remove(item, input.appName);
    });
    return status === 0 || status === ERR_SEC_ITEM_NOT_FOUND;
  }
  if (input.platform === "linux") {
    const api = apis.linux?.();
    if (!api) return false;
    const answer = await api.removeSafeStorage(input.appName);
    return answer === "removed" || answer === "absent";
  }
  return true;
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
