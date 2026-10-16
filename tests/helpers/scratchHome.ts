import { homedir } from "node:os";
import { join } from "node:path";
import { scratchDir } from "./scratchDirs";

/**
 * Runs `read` with this process's home and application-data roots in a
 * scratch folder, so code that looks for the app's data folders under the
 * person's home - the offline tools' default (`defaultUserDataDir`) - never
 * reads this computer's real ones. Gives `read` the scratch application-data
 * folder, as this system names it, and puts everything back afterwards.
 */
export function withScratchHome<T>(read: (appData: string) => T): T {
  const names = ["HOME", "XDG_CONFIG_HOME", "APPDATA"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const home = scratchDir("infinitary-scratch-home-");
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.APPDATA = join(home, "AppData", "Roaming");
  try {
    const appData =
      process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.platform === "win32"
          ? (process.env.APPDATA as string)
          : (process.env.XDG_CONFIG_HOME as string);
    return read(appData);
  } finally {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
