import { statSync } from "node:fs";
import type { Systemctl } from "./background";

/** Runtime facts, not the presence of a program or the words of an error. */
export type SystemdRuntime = "systemd" | "unavailable" | "unknown";

/** systemd creates this directory when it boots; an unreadable check proves nothing. */
export function systemdRuntime(path = "/run/systemd/system"): SystemdRuntime {
  try {
    return statSync(path).isDirectory() ? "systemd" : "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "unknown";
  }
}

/** A reachable user manager works even under an unusual system startup arrangement. */
export async function linuxStartup(
  systemctl: Systemctl,
  uid: number,
  runtime: () => SystemdRuntime = systemdRuntime,
): Promise<"available" | "at-login" | "unavailable" | "unknown"> {
  try {
    if ((await systemctl(["--user", "show-environment"])).ok) return "available";
    const system = runtime();
    if (system !== "systemd") return system;
    // A running system manager can positively identify an inactive user manager.
    // Failed reads (including missing permission or a missing bus) are not a login promise.
    const user = await systemctl([
      "--system",
      "show",
      `user@${uid}.service`,
      "--property=ActiveState",
      "--value",
    ]);
    if (user.ok && user.output.trim() === "inactive") return "at-login";
    return "unknown";
  } catch {
    return "unknown";
  }
}
