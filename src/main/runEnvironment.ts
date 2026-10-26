import { userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hostPlatform } from "../core/platform";

/** Facts observed by the run, never inferred from how somebody started it. */
export const RunEnvironmentSchema = z.object({
  observedAt: z.string().datetime(),
  display: z.enum(["own", "session", "none", "unknown"]),
  keychain: z.enum(["locked", "unlocked", "absent", "unknown", "not-applicable"]),
  voice: z.literal("unavailable"),
  notifications: z.literal("unknown"),
});
export type RunEnvironment = z.infer<typeof RunEnvironmentSchema>;

/** No display variable proves only that Linux has no display to open, not that a Mac cannot draw. */
export function runEnvironment(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  ownDisplay: boolean;
  keychain: () => RunEnvironment["keychain"];
  now?: Date;
}): RunEnvironment {
  return {
    observedAt: (options.now ?? new Date()).toISOString(),
    display: options.ownDisplay
      ? "own"
      : options.platform === "linux"
        ? options.env.DISPLAY || options.env.WAYLAND_DISPLAY
          ? "session"
          : "none"
        : "unknown",
    keychain: options.platform === "darwin" ? options.keychain() : "not-applicable",
    voice: "unavailable",
    notifications: "unknown",
  };
}

/**
 * This account's own login Keychain, by its path under the home folder its
 * user record names. A run started at boot by a system job asks macOS for the
 * default Keychain and gets the Mac's System Keychain, unlocked, while the
 * account's own stays locked (INF-1416's check on a disposable Mac), so the
 * run reads the account's own by its path instead.
 */
export function accountKeychainPath(homeDir: string = userInfo().homedir): string {
  return join(homeDir, "Library", "Keychains", "login.keychain-db");
}

/**
 * Metadata only: reads a Keychain's lock bit, never an item or a password,
 * and never asks to unlock it. It reads this account's own login Keychain
 * unless given another file, which keeps native verification off the
 * person's Keychains and search list. Isolated app launches do not call this
 * at all.
 */
export async function readKeychainLock(
  keychainPath: string = accountKeychainPath(),
): Promise<RunEnvironment["keychain"]> {
  if (hostPlatform() !== "darwin") return "not-applicable";
  try {
    const { default: koffi } = await import("koffi");
    const security = koffi.load("/System/Library/Frameworks/Security.framework/Security");
    const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
    const pointer = koffi.out(koffi.pointer(koffi.pointer("void")));
    const setInteraction = security.func("SecKeychainSetUserInteractionAllowed", "int32", [
      "uint8",
    ]);
    const getStatus = security.func("SecKeychainGetStatus", "int32", [
      "void *",
      koffi.out(koffi.pointer("uint32")),
    ]);
    const release = cf.func("CFRelease", "void", ["void *"]);
    const keychain: [unknown] = [null];
    if (setInteraction(0) !== 0) return "unknown";
    // Opening names a file without reading it; its status says whether it is there.
    const result = security.func("SecKeychainOpen", "int32", ["const char *", pointer])(
      keychainPath,
      keychain,
    );
    if (result !== 0 || keychain[0] === null) return "unknown";
    try {
      const flags = [0];
      const status = getStatus(keychain[0], flags);
      if (status === -25294) return "absent"; // errSecNoSuchKeychain
      return status === 0 ? keychainLockFromFlags(flags[0] ?? 0) : "unknown";
    } finally {
      release(keychain[0]);
    }
  } catch {
    return "unknown";
  }
}

/** kSecUnlockStateStatus, from Security.framework's SecKeychainStatus bit field. */
export function keychainLockFromFlags(flags: number): "locked" | "unlocked" {
  return flags & 1 ? "unlocked" : "locked";
}
