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
  "scripts/frame-lib.ts",
  "scripts/copy-ort-assets.mjs",
  "scripts/clone-or-copy.ts",
  "scripts/ensure-electron-installed.mjs",
  "scripts/ensure-bundled-git.ts",
  "scripts/build-git-launcher.ts",
  "scripts/git-launcher.c",
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

/** Whether a repository path is something the desktop app is built from. */
export function isDesktopPath(path: string): boolean {
  if (TEST_FILE.test(path)) return false;
  return DESKTOP_BUILD.some((entry) => matches(entry, path));
}
