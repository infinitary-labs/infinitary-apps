import { absentKeychain, type HostKeychain } from "@core/host";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import { utilityProcess } from "electron";
import {
  createProcessKeychain,
  createProcessKeychainFile,
  type ForkKeychainProcess,
  type KeychainFile,
} from "./keychainProcess";

const fork: ForkKeychainProcess = (modulePath, args) =>
  utilityProcess.fork(modulePath, args, {
    serviceName: "Infinitary Saved Passwords",
    stdio: "ignore",
    env: hostEnv(),
  });

/** A fresh utility process owns each read and its macOS interaction policy. */
export function createElectronKeychain(helperPath: string, allowInteraction = false) {
  return createProcessKeychain({ helperPath, allowInteraction, fork });
}

/** Windowless startup's lock-bit probe uses the same silent child boundary. */
export function readElectronKeychainStatus(helperPath: string, keychainPath: string) {
  return createProcessKeychainFile({ helperPath, fork }).status(keychainPath);
}

/** One keychain file by its path, for the Mac's Secrets Unlock: a silent status child, then an unlock child. */
export function createElectronKeychainFile(helperPath: string): KeychainFile {
  return createProcessKeychainFile({ helperPath, allowInteraction: true, fork });
}

/** Isolated launches cannot reach the person's saved-password reader, whatever USER says. */
export function createDesktopKeychain(
  helperPath: string | undefined,
  isolated: boolean,
): HostKeychain {
  if (hostPlatform() !== "darwin" || isolated) return absentKeychain;
  if (helperPath) return createElectronKeychain(helperPath, true);
  return {
    findGenericPassword: async () => ({
      kind: "failed",
      message: "The saved-password reader is unavailable.",
    }),
    readGenericPassword: async () => ({
      kind: "failed",
      message: "The saved-password reader is unavailable.",
    }),
  };
}
