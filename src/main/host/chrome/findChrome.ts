import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

import type { InstalledBrowser } from "@core/host";

export const browserNames = { chrome: "Google Chrome", edge: "Microsoft Edge" } as const;

/** The stable browsers' standard install locations, in lookup order. */
function browserCandidates(
  browser: InstalledBrowser,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  if (platform === "darwin") {
    const name = browserNames[browser];
    const inApp = `${name}.app/Contents/MacOS/${name}`;
    return [posix.join("/Applications", inApp), posix.join(home, "Applications", inApp)];
  }
  if (platform === "win32") {
    const inFolder =
      browser === "chrome"
        ? win32.join("Google", "Chrome", "Application", "chrome.exe")
        : win32.join("Microsoft", "Edge", "Application", "msedge.exe");
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (root): root is string => Boolean(root),
    );
    return roots.map((root) => win32.join(root, inFolder));
  }
  if (platform === "linux") {
    return browser === "chrome"
      ? ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"]
      : [
          "/opt/microsoft/msedge/msedge",
          "/usr/bin/microsoft-edge-stable",
          "/usr/bin/microsoft-edge",
        ];
  }
  return [];
}

/** The first standard location holding the named installed browser, if any. */
export function findInstalledBrowser(
  browser: InstalledBrowser,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return browserCandidates(browser, platform, env, home).find((path) => exists(path));
}

export function findChrome(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  exists?: (path: string) => boolean,
): string | undefined {
  return findInstalledBrowser("chrome", platform, env, home, exists);
}
