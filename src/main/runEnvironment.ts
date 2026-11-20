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

/**
 * Whether this run was started by this app's own agent, the one the window
 * and `start-at-boot` set up under `label`: launchd names a job it started
 * in `XPC_SERVICE_NAME`, and systemd puts a user service's process in that
 * unit's group. Task Scheduler leaves no such mark, so a Windows run never
 * says so; neither does one started by hand.
 */
export function startedByAgent(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  label: string;
  cgroup: () => string;
}): boolean {
  if (options.platform === "darwin") return options.env.XPC_SERVICE_NAME === options.label;
  if (options.platform !== "linux") return false;
  try {
    return options
      .cgroup()
      .split("\n")
      .some((line) => line.endsWith(`/${options.label}.service`));
  } catch {
    return false;
  }
}

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
 * user record names. A run outside the logged-in session, such as a system
 * job, asks macOS for the default Keychain and gets the Mac's System
 * Keychain, unlocked, while the account's own stays locked (INF-1416's check
 * on a disposable Mac), so the run reads the account's own by its path instead.
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
  read: (path: string) => Promise<RunEnvironment["keychain"]>,
  keychainPath: string = accountKeychainPath(),
): Promise<RunEnvironment["keychain"]> {
  if (hostPlatform() !== "darwin") return "not-applicable";
  try {
    return await read(keychainPath);
  } catch {
    return "unknown";
  }
}

/** kSecUnlockStateStatus, from Security.framework's SecKeychainStatus bit field. */
export function keychainLockFromFlags(flags: number): "locked" | "unlocked" {
  return flags & 1 ? "unlocked" : "locked";
}
