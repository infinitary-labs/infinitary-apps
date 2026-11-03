import { absentKeychain, type HostKeychain } from "@core/host";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import { utilityProcess } from "electron";
import {
  createKeychainRequester,
  createProcessKeychain,
  type ForkKeychainProcess,
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
export async function readElectronKeychainStatus(helperPath: string, keychainPath: string) {
  const answer = await createKeychainRequester({ helperPath, fork })({
    operation: "status",
    keychainPath,
  });
  return answer.kind === "status" ? answer.state : "unknown";
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
