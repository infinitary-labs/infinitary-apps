import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostEnv } from "../hostEnv";
import { readLinuxInstallation } from "../update/linuxInstall";
import { findOnPath } from "../userBin";
import type { Launcher } from "./background";

/** The command a Linux package puts on the search path. */
const LINUX_COMMAND = "infinitary";

/**
 * How this app starts itself again from outside this run (docs/helper.md,
 * "In the background"): what the background starts at each login, and what
 * the command for another user on this computer runs. It must outlive this
 * run and the next update:
 *
 * - a Mac's app, a Linux package that installs to one place, and a run from
 *   source start this run's own program (with the checkout's folder);
 * - an AppImage starts the AppImage file, never the folder its runtime
 *   mounted it at for this run, which only this run's user can enter and
 *   which goes when it ends;
 * - a Nix package starts the command its profile puts on the search path,
 *   never this version's place in the store, which a later update leaves to
 *   be collected; without one, the package's own wrapper there.
 */
export function appLauncher(options: {
  packaged: boolean;
  platform: string;
  execPath: string;
  /** The checkout's folder, which an unpackaged run loads. */
  appDir: string;
  resourcesDir: string;
  env: NodeJS.ProcessEnv;
  onPath?: (name: string) => string | undefined;
}): Launcher {
  if (!options.packaged) return { executable: options.execPath, args: [options.appDir] };
  const own = { executable: options.execPath, args: [] };
  if (options.platform !== "linux") return own;
  const installation = readLinuxInstallation({
    chip: process.arch,
    resourcesDir: options.resourcesDir,
    execPath: options.execPath,
    env: options.env,
  });
  if (installation.package === "appimage" && installation.appImage)
    return { executable: installation.appImage, args: [] };
  if (installation.package !== "nix") return own;
  const onPath = options.onPath ?? ((name: string) => findOnPath(name, hostEnv()));
  const profile = onPath(LINUX_COMMAND);
  if (profile && !profile.startsWith("/nix/store/")) return { executable: profile, args: [] };
  // The package's own wrapper, which puts its git on the search path: the
  // store keeps it until this version is collected.
  const wrapper = join(dirname(dirname(dirname(options.execPath))), "bin", LINUX_COMMAND);
  return existsSync(wrapper) ? { executable: wrapper, args: [] } : own;
}
