import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { COMPUTER } from "@shared/deviceNames";
import { deviceNameSchema } from "@shared/devices";
import { settingFrom } from "@shared/envSettings";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";

/**
 * This Mac's own name, as its person set it in System Settings, such as
 * "Sam's MacBook Air" (docs/devices.md). A device names itself by it when it
 * joins, and a home tells its devices by it which Mac they control. It is
 * read from macOS itself, never from another program; where macOS has none
 * to give, the network name stands in without its `.local`.
 */
export async function computerName(platform: string = hostPlatform()): Promise<string> {
  if (platform === "darwin") {
    const named = await new Promise<string>((resolve) => {
      execFile(
        "/usr/sbin/scutil",
        ["--get", "ComputerName"],
        { env: hostEnv(), timeout: 5_000 },
        (error, stdout) => resolve(error ? "" : String(stdout)),
      );
    });
    const name = asDeviceName(named);
    if (name) return name;
  }
  return asDeviceName(hostname().replace(/\.local\.?$/i, "")) ?? COMPUTER.One;
}

/**
 * This Mac's own name for what it tells others: `computerName`, or for a
 * development run the one `INFINITARY_DEVICE_NAME` stands in (under either of
 * its names, `@shared/envSettings`), so two copies on one Mac read as two
 * Macs. An installed app never reads the variable.
 */
export async function ownComputerName(options: {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const standIn = options.packaged
    ? null
    : asDeviceName(settingFrom(options.env, "DEVICE_NAME") ?? "");
  return standIn ?? (await computerName());
}

/** A name a device may carry (`deviceNameSchema`), cut to its length; null when none is left. */
export function asDeviceName(text: string): string | null {
  const parsed = deviceNameSchema.safeParse(text.trim().slice(0, 64));
  return parsed.success ? parsed.data : null;
}

/**
 * This Mac's own names on the network, lowercase and without a closing dot,
 * such as `kuns-macbook-pro.local`: the name Bonjour announces it by, as
 * its person set it in System Settings (`LocalHostName`), and the name the
 * system calls itself. Macs nearby leave out a Mac answering by one of them
 * (docs/devices.md, "Macs nearby").
 */
export async function ownNetworkNames(platform: string = hostPlatform()): Promise<string[]> {
  const names = new Set<string>();
  const system = hostname().replace(/\.$/, "").toLowerCase();
  if (system) names.add(system.endsWith(".local") ? system : `${system}.local`);
  if (platform === "darwin") {
    const local = await new Promise<string>((resolve) => {
      execFile(
        "/usr/sbin/scutil",
        ["--get", "LocalHostName"],
        { env: hostEnv(), timeout: 5_000 },
        (error, stdout) => resolve(error ? "" : String(stdout).trim()),
      );
    });
    if (local) names.add(`${local.toLowerCase()}.local`);
  }
  return [...names];
}
