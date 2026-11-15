import type { HostCapabilities } from "@core/host";
import type { BuildFlavor } from "@shared/userDataFolders";
import type { FreshAuthentication } from "../../core/secrets/approvals";
import type { SecretCustody } from "../../core/secrets/custody";
import { accountKeychainPath } from "../runEnvironment";
import type { UserDataChoice } from "../userDataDir";
import { createDarwinFreshAuthentication } from "./darwinFreshAuthentication";
import { createDarwinSecretCustody, loadDarwinCustodyApi } from "./darwinSecretCustody";
import type { KeychainFile } from "./keychainProcess";
import { createLinuxFreshAuthentication } from "./linuxFreshAuthentication";
import { createLinuxSecretCustody, loadLibsecretApi } from "./linuxSecretCustody";

/**
 * Protected Secrets in the app itself (docs/secrets.md, "Native custody"):
 * the native custody, fresh confirmation and Unlock gesture the person's own
 * app hands its core, so the core builds the protected owner. Only a run on
 * the person's own data folder gets them; a run on an isolated or chosen
 * folder, and every platform but macOS and Linux, gets none and so offers no
 * Secrets at all.
 */

export type HostSecrets = NonNullable<HostCapabilities["secrets"]>;

/**
 * The name each flavor's custody items carry: the Keychain service on macOS,
 * the Secret Service item's store attribute on Linux. One per flavor, so a
 * development run never reads the release's root. Renaming one loses every
 * secret that flavor kept: its sealed files then sit beside no root.
 */
export const SECRETS_CUSTODY_NAMES: Readonly<Record<BuildFlavor, string>> = {
  release: "Infinitary Secrets",
  dev: "Infinitary Secrets (development)",
};

/**
 * The name this Mac's own approval key is kept under when it approves Secrets
 * uses for another computer (docs/secrets.md, "Remote decisions"): one per
 * flavor, apart from that flavor's own Secrets, so approving never reads them.
 */
export const SECRET_APPROVER_NAMES: Readonly<Record<BuildFlavor, string>> = {
  release: "Infinitary Secret Approvals",
  dev: "Infinitary Secret Approvals (development)",
};

/** What a Mac approves with: its own custody for its key and its own fresh confirmation. */
export type NativeApprover = { custody: SecretCustody; authentication: FreshAuthentication };

/**
 * This Mac's approver, made when its window becomes a view of another
 * computer: only on macOS, only on the person's own data folder, as Secrets
 * are, and only where Touch ID or the password can confirm the person.
 */
export function nativeApprover(input: {
  platform: NodeJS.Platform;
  choice: UserDataChoice;
}): NativeApprover | undefined {
  if (input.choice.kind !== "flavor" || input.platform !== "darwin") return undefined;
  const api = loadDarwinCustodyApi(accountKeychainPath());
  const authentication = createDarwinFreshAuthentication();
  if (!api || !authentication) return undefined;
  return {
    custody: createDarwinSecretCustody(api, {
      service: SECRET_APPROVER_NAMES[input.choice.flavor],
    }),
    authentication,
  };
}

/** What the Mac composition takes from the app besides its custody name. */
export type DarwinSecretsHost = {
  /**
   * The custody's keychain file in fresh child processes
   * (`createElectronKeychainFile`), whose unlock may still show macOS's unlock
   * dialog: the app's own process touched the store silently first, so it
   * never can (docs/architecture.md, "The latch").
   */
  keychainFile: KeychainFile;
  /** The keychain file custody opens: the account's own login keychain unless a check names another. */
  keychainPath?: string;
};

/** What each platform composes for one custody name; undefined where its native store cannot load. */
export type NativeSecretsPlatforms = {
  darwin: (name: string, host: DarwinSecretsHost) => HostSecrets | undefined;
  linux: (name: string) => HostSecrets | undefined;
};

export function nativeSecrets(
  input: { platform: NodeJS.Platform; choice: UserDataChoice; keychainFile: KeychainFile },
  platforms: NativeSecretsPlatforms = NATIVE_SECRETS,
): HostSecrets | undefined {
  if (input.choice.kind !== "flavor") return undefined;
  const name = SECRETS_CUSTODY_NAMES[input.choice.flavor];
  if (input.platform === "darwin")
    return platforms.darwin(name, { keychainFile: input.keychainFile });
  if (input.platform === "linux") return platforms.linux(name);
  return undefined;
}

/**
 * The re-trust read of the macOS Unlock gesture: one read of each slot in the
 * app's own process with the Keychain's dialog allowed, so the person can
 * trust this app with an item again (that dialog is not latched). It waits
 * until they answer. Unlocked means every slot answered, present or not.
 */
export function interactiveUnlock(custody: SecretCustody): () => Promise<boolean> {
  return async () => {
    let unlocked = true;
    for (const slot of ["root", "authority-head"] as const) {
      const read = await custody.read(slot);
      if (read.kind === "value") read.bytes.fill(0);
      else if (read.kind !== "absent") unlocked = false;
    }
    return unlocked;
  };
}

/**
 * The macOS Unlock gesture: a fresh Keychain process unlocks the custody's own
 * keychain file by its path, with macOS's own dialog, then the re-trust read
 * decides. A silent child reads the lock first, so an open store asks nothing
 * and a missing file is not offered a dialog. Neither child's answer is the
 * reading: the slots' answers are.
 */
export function darwinUnlock(
  keychainPath: string,
  file: KeychainFile,
  retrust: () => Promise<boolean>,
): () => Promise<boolean> {
  return async () => {
    const state = await file.status(keychainPath);
    if (state === "locked" || state === "unknown") await file.unlock(keychainPath);
    return retrust();
  };
}

/**
 * Each platform's real composition. Exported so a live check composes exactly
 * this under a check-only name instead of a copy (docs/secrets.md, "In the app").
 */
export const NATIVE_SECRETS: NativeSecretsPlatforms = {
  darwin: (name, host) => {
    // By its path, never the default keychain: a run outside the logged-in
    // session, such as a system job, can get the Mac's System Keychain
    // (docs/secrets.md). Unlock opens the same file, never whichever store a
    // search finds.
    const keychainPath = host.keychainPath ?? accountKeychainPath();
    const api = loadDarwinCustodyApi(keychainPath);
    if (!api) return undefined;
    const authentication = createDarwinFreshAuthentication();
    return {
      custody: createDarwinSecretCustody(api, { service: name }),
      ...(authentication ? { authentication } : {}),
      unlock: darwinUnlock(
        keychainPath,
        host.keychainFile,
        interactiveUnlock(createDarwinSecretCustody(api, { service: name, interactive: true })),
      ),
    };
  },
  linux: (name) => {
    const api = loadLibsecretApi();
    if (!api) return undefined;
    const custody = createLinuxSecretCustody(api, { store: name });
    const authentication = createLinuxFreshAuthentication();
    return {
      custody,
      ...(authentication ? { authentication } : {}),
      unlock: () => custody.unlock(),
    };
  },
};
