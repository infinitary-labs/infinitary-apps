import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type Launchctl,
  type Launcher,
  launchctlAt,
  type ServiceManager,
  systemLaunchctl,
  systemSystemctl,
} from "@core/helper/background";
import { appLauncher } from "@core/helper/launcher";
import { type HelperPlace, helperPlace } from "@core/helper/place";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import { findOnPath } from "@core/userBin";
import { SETTING_PREFIXES, settingFrom } from "@shared/envSettings";
import { app } from "electron";
import { folderSpellingFor, packagedFlavor, readPackageJsonAt } from "./userDataDir";

/**
 * Where this user's work lives and how its background starts
 * (docs/helper.md, "Where it keeps its data", "In the background"), as the
 * work mode (./work.ts) and the app's window (./app.ts) both read it: the
 * window of a computer that joined at its first launch sets that computer's
 * work up there, and the window of a computer a command or its address added
 * controls its home with the grant its work keeps.
 */

/**
 * What a development run's background carries of its own environment: these
 * settings under either of their names (`@shared/envSettings`), and Pi's
 * offline switch.
 */
const DEVELOPMENT_STAND_INS = [
  "HELPER_DATA_DIR",
  "FOLDER_SPELLING",
  "DEVICE_NAME",
  "LAUNCHCTL",
  "SYSTEMCTL",
  "CLAUDE_CLI",
  "SYSTEM_GIT",
] as const;
const CARRIED_STAND_INS: readonly string[] = [
  ...DEVELOPMENT_STAND_INS.flatMap((name) => SETTING_PREFIXES.map((prefix) => `${prefix}${name}`)),
  "PI_OFFLINE",
];

export type WorkContext = {
  place: HelperPlace;
  /** The background starts this app again as it was started here. */
  launcher: Launcher;
  /** Null when nothing may be set up in the background, as in a test. */
  serviceManager: ServiceManager | null;
  backgroundEnv: Readonly<Record<string, string>>;
};

/**
 * The work context. `isolatedUserData` is the app's own userData folder
 * when a test isolated it: then the work folder sits inside it unless the
 * test named one, and nothing is set up in the background unless the test
 * stands in its own service manager.
 */
export function workContext(isolatedUserData?: string): WorkContext {
  const flavor = app.isPackaged ? packagedFlavor(readPackageJsonAt(app.getAppPath())) : "dev";
  const env = process.env;
  const platform = hostPlatform();
  // Whose folders it reads: this build's own, or a development run's
  // stand-in for Infinitary's, which rehearses the one-time move of its work
  // (docs/helper.md, "Under the other name"), as the window's does.
  const place = helperPlace({
    packaged: app.isPackaged,
    flavor,
    appData: app.getPath("appData"),
    env,
    spelling: folderSpellingFor({ packaged: app.isPackaged, env }),
  });
  const named = !app.isPackaged && Boolean(settingFrom(env, "HELPER_DATA_DIR")?.trim());
  const isolated = !app.isPackaged && (named || Boolean(isolatedUserData));
  // A development run may stand in its own launchctl or systemctl, so a test
  // never loads a real agent, and its background carries the stand-ins it
  // was started with; one whose data a test isolated with no stand-in sets
  // up nothing in the background. An installed app reads neither.
  const standIn = app.isPackaged
    ? undefined
    : (platform === "linux"
        ? settingFrom(env, "SYSTEMCTL")
        : settingFrom(env, "LAUNCHCTL")
      )?.trim();
  return {
    place:
      isolatedUserData && !named ? { ...place, dataDir: join(isolatedUserData, "work") } : place,
    launcher: appLauncher({
      packaged: app.isPackaged,
      platform,
      execPath: process.execPath,
      appDir: app.getAppPath(),
      resourcesDir: process.resourcesPath,
      env,
    }),
    serviceManager: standIn
      ? serviceManagerAt(platform, launchctlAt(standIn), env)
      : isolated
        ? null
        : systemServiceManager(platform, env),
    backgroundEnv: app.isPackaged
      ? {}
      : Object.fromEntries(
          CARRIED_STAND_INS.flatMap((name) => {
            const value = env[name];
            return value ? [[name, value]] : [];
          }),
        ),
  };
}

/**
 * This computer's own service manager for background work: launchd on a
 * Mac, and on Linux this user's systemd where the search path finds its
 * systemctl. None on a system with neither, which sets nothing up in the
 * background.
 */
function systemServiceManager(platform: string, env: NodeJS.ProcessEnv): ServiceManager | null {
  if (platform === "darwin") return { launchctl: systemLaunchctl };
  if (platform !== "linux") return null;
  const systemctl = findOnPath("systemctl", hostEnv());
  return systemctl ? serviceManagerAt(platform, systemSystemctl(systemctl), env) : null;
}

function serviceManagerAt(
  platform: string,
  program: Launchctl,
  env: NodeJS.ProcessEnv,
): ServiceManager {
  if (platform !== "linux") return { launchctl: program };
  // Where this user's own systemd reads their services: the person's
  // XDG_CONFIG_HOME when they moved it, else ~/.config.
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return {
    systemctl: program,
    configHome: xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"),
  };
}
