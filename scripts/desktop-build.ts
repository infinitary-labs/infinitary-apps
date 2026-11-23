/**
 * What the desktop app is built from (docs/alpha.md, "An alpha with nothing
 * new to build"): the one list a rolling alpha reads to decide whether main
 * changed anything it would ship. release.yml's resolve job reads it from the
 * workflow's own commit through `release-notes.ts desktop-changes`; a path
 * that is not on it never cuts an alpha on its own.
 *
 * An entry ending in a slash is a folder, `*` matches within one name, and
 * any other entry is one file. Test files inside a listed folder never count.
 * tests/release-workflows-alpha-cut.test.ts fails when the build starts running a
 * script this list misses and BUILD_SCRIPTS_THAT_SHIP_NOTHING does not name.
 */
export const DESKTOP_BUILD: readonly string[] = [
  "src/",
  "resources/",
  "packaging/",
  "vendor/",
  "store/",
  "patches/",
  "package.json",
  "LICENSE",
  "NOTICE",
  "ios/Infinitary/InfinitaryApp/Fonts/Font-licenses.txt",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "electron-builder.yml",
  "electron-builder.linux.yml",
  "electron.vite.config.ts",
  "tsconfig*.json",
  ".claude/skills/infinitary-design/",
  // The scripts the release's install, build and packaging run, and what they import.
  "scripts/generate-self-source.mjs",
  "scripts/moduleRunner.ts",
  "scripts/build-load-supervisor.ts",
  "scripts/bundled-packages.ts",
  "scripts/frame-lib.ts",
  "scripts/copy-ort-assets.mjs",
  "scripts/clone-or-copy.ts",
  "scripts/ensure-electron-installed.mjs",
  "scripts/ensure-bundled-git.ts",
  "scripts/build-git-launcher.ts",
  "scripts/git-launcher.c",
  "scripts/after-pack.mjs",
  "scripts/sign-release-mac.mjs",
  "scripts/place-mac-app-launcher.mjs",
  "scripts/mac-app-launcher.m",
  "scripts/mark-mac-installation.mjs",
  "scripts/linux-recipes.ts",
  "scripts/generate-messages.ts",
  "scripts/github-errors.ts",
];

/**
 * Scripts the build runs that put nothing into the app, each with why. A
 * change to one alone rides with the next desktop alpha.
 */
export const BUILD_SCRIPTS_THAT_SHIP_NOTHING: Readonly<Record<string, string>> = {
  "scripts/apt-install.sh": "it only installs the Linux build machine's own tools before the build",
  "scripts/check-installed-packages.ts": "it only refuses an install that left out a package",
  "scripts/refuse-build-during-e2e.ts": "it only refuses a build while journeys run",
  "scripts/prepare-local-codesign.mjs": "it prepares this computer's local signing, never the release's",
  "scripts/release-notes.ts":
    "the build's catalog is a development one; a release packages the notes job's catalog",
};

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function matches(entry: string, path: string): boolean {
  if (entry.endsWith("/")) return path.startsWith(entry);
  if (!entry.includes("*")) return path === entry;
  const pattern = entry.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${pattern.join("[^/]*")}$`).test(path);
}

export function isDesktopPath(path: string): boolean {
  if (TEST_FILE.test(path)) return false;
  return DESKTOP_BUILD.some((entry) => matches(entry, path));
}

/**
 * What the alpha's five-copy signed installer check guards (docs/alpha.md,
 * "Isolated signed verification"): the real Mac update and install with five
 * signed copies, on the paths the update check skips. An alpha runs it only
 * when one of these changed since the previous release; every other alpha
 * relies on the update check, which every alpha runs.
 *
 * The files, by what they hold: the Mac update code (and the update file Mac
 * shares with Linux and Windows, but not `releaseBuilds.ts`, the builds file
 * only Linux and Windows read), the app's own executables the packaging
 * steps place, signing and notarization, and app shutdown, which an update's
 * relaunch waits on. Entries match like DESKTOP_BUILD's.
 */
export const SIGNED_INSTALLER_FILES: readonly string[] = [
  "src/core/update/macUpdates.ts",
  "src/core/update/macInstallation.ts",
  "src/core/update/updateChannels.ts",
  "src/core/update/updateWork.ts",
  "src/core/update/updateChecker.ts",
  "src/main/host/macUpdate*",
  "src/main/host/macInstallation*",
  "src/shared/semver.ts",
  "packaging/app-update.yml",
  // The updater library, Electron and the universal merge, as patched.
  "patches/electron-updater@*",
  "patches/electron@*",
  "patches/@electron__universal@*",
  // The app's own executables and the receipt the packaging steps place.
  "scripts/after-pack.mjs",
  "scripts/place-mac-app-launcher.mjs",
  "scripts/mac-app-launcher.m",
  "scripts/mark-mac-installation.mjs",
  "packaging/mac-installation.json",
  "packaging/entitlements.plist",
  "packaging/release-identity.json",
  "src/shared/releaseRequirement.ts",
  "scripts/sign-release-mac.mjs",
  "scripts/notarize.ts",
  // App shutdown.
  "src/main/lifecycle.ts",
];

/** The packages whose version line in package.json counts: the updater library, Electron and its packager. */
export const SIGNED_INSTALLER_PACKAGES: readonly string[] = ["electron", "electron-updater", "electron-builder"];

/**
 * The top-level settings of electron-builder.yml that count: identity, the
 * Mac build and its signing, the executables placed after packing, the fuses,
 * the update feed and the disk image. Copyright, license files and comments
 * do not.
 */
export const SIGNED_INSTALLER_BUILDER_KEYS: readonly string[] = [
  "appId",
  "productName",
  "mac",
  "afterPack",
  "afterSign",
  "electronFuses",
  "publish",
  "dmg",
];

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

function packageVersions(text: string | null): Record<string, string | null> {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text === null ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    // An unreadable package.json is a change to every line.
    return Object.fromEntries(SIGNED_INSTALLER_PACKAGES.map((name) => [name, "unreadable"]));
  }
  const versions: Record<string, string | null> = {};
  for (const name of SIGNED_INSTALLER_PACKAGES) {
    versions[name] = null;
    for (const field of DEPENDENCY_FIELDS) {
      const deps = parsed[field];
      if (deps && typeof deps === "object" && name in deps) {
        versions[name] = `${field}:${String((deps as Record<string, unknown>)[name])}`;
      }
    }
  }
  return versions;
}

/**
 * electron-builder.yml's top-level settings, each as its lines without
 * comment lines or blank lines. The file is a mapping whose keys start at the
 * first column, so a setting runs until the next such key.
 */
function builderSettings(text: string | null): Map<string, string> {
  const settings = new Map<string, string>();
  let key: string | null = null;
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const top = /^([A-Za-z0-9_]+):/.exec(line);
    if (top) {
      key = top[1] as string;
      settings.set(key, "");
    }
    if (key !== null) settings.set(key, `${settings.get(key)}${line.trimEnd()}\n`);
  }
  return settings;
}

/**
 * Why an alpha needs the five-copy check: each changed input, named, or none.
 * `paths` changed since the previous release; `read` gives a file's text
 * before and after, or null where it does not exist.
 */
export function signedInstallerChanges(
  paths: readonly string[],
  read: (path: string, side: "before" | "after") => string | null,
): string[] {
  const reasons: string[] = [];
  for (const path of paths) {
    if (TEST_FILE.test(path)) continue;
    if (SIGNED_INSTALLER_FILES.some((entry) => matches(entry, path))) reasons.push(path);
    else if (path === "package.json") {
      const before = packageVersions(read(path, "before"));
      const after = packageVersions(read(path, "after"));
      for (const name of SIGNED_INSTALLER_PACKAGES)
        if (before[name] !== after[name]) reasons.push(`package.json ${name}`);
    } else if (path === "electron-builder.yml") {
      const before = builderSettings(read(path, "before"));
      const after = builderSettings(read(path, "after"));
      for (const key of SIGNED_INSTALLER_BUILDER_KEYS)
        if (before.get(key) !== after.get(key)) reasons.push(`electron-builder.yml ${key}`);
    }
  }
  return reasons;
}
