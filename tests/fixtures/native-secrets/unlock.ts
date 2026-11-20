import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { absentKeychain, type HostKeychain } from "../../../src/core/host";
import type { DarwinKeychainApi } from "../../../src/main/host/darwinKeychain";

export const FIXTURE_SERVICE = "INF-1109 signed Secrets fixture";
export const FIXTURE_PURPOSE = "infinitary-native-secrets-fixture";

/** The packaged proof may unlock only its compiled-in disposable store, never a searched item. */
export function fixtureUnlockReader(
  root: string,
  native: () => Pick<DarwinKeychainApi, "unlockKeychain"> | undefined,
): HostKeychain {
  return {
    ...absentKeychain,
    unlockKeychain: async (query) => {
      if (
        query.interactive !== true ||
        query.service !== FIXTURE_SERVICE ||
        query.account !== undefined
      )
        return { kind: "failed", message: "The fixture did not authorize this unlock." };
      try {
        const home = join(root, "home");
        const marker = join(root, "fixture.json");
        const keychain = join(home, "Library/Keychains/secrets-proof.keychain-db");
        if (
          realpathSync(root) !== root ||
          realpathSync(home) !== home ||
          (lstatSync(root).mode & 0o077) !== 0 ||
          (lstatSync(home).mode & 0o077) !== 0 ||
          !lstatSync(marker).isFile() ||
          lstatSync(marker).isSymbolicLink() ||
          JSON.parse(readFileSync(marker, "utf8")).purpose !== FIXTURE_PURPOSE ||
          realpathSync(keychain) !== keychain ||
          !lstatSync(keychain).isFile() ||
          lstatSync(keychain).nlink !== 1
        )
          return { kind: "failed", message: "The fixture refused an unowned store." };
        const unlock = native()?.unlockKeychain;
        if (!unlock) return { kind: "failed", message: "Native unlock is unavailable." };
        const code = unlock(keychain);
        return code === 0
          ? { kind: "unlocked" }
          : { kind: "failed", code, message: "The fixture store was not unlocked." };
      } catch {
        return { kind: "failed", message: "The fixture unlock did not complete." };
      }
    },
  };
}
