import type { Spelling } from "./codeNames";

/**
 * Where each build keeps its state: the folder under the platform's
 * application-data directory (`~/Library/Application Support` on macOS)
 * that becomes Electron's userData.
 *
 * The release keeps the folder Electron gives it - the package.json `name` -
 * so an installed app's data stays where it is from one version to the next.
 * `pnpm dev` opens the same folder, the person's own saved data, one app at a
 * time (src/main/userDataDir.ts `runFlavor`). The local dev bundle from
 * `electron-builder.dev.yml`, and a run from source that a test isolated,
 * keep the development folder, so neither opens the installed app's data.
 */

export type BuildFlavor = "release" | "dev";

/**
 * This build's own folders, its identity's (`OWN_IDENTITY`, `@shared/codeNames`;
 * `codeNames.test.ts` holds the two in step): the release's, and every
 * other run's. Written out, so a script run by plain Node reads this file alone.
 */
export const RELEASE_USER_DATA_FOLDER = "infinitary";
export const DEV_USER_DATA_FOLDER = "infinitary-dev";

/**
 * Each spelling's folders (`@shared/codeNames`): Firstmate 3000's, and
 * Infinitary's (the Infinitary rename, FI3-1780). An app whose spelling has
 * older spellings before it moves an older spelling's folder of its flavor
 * into its own once (src/core/folderMove/); release and development move
 * apart, each into its own.
 */
export const USER_DATA_FOLDERS: Readonly<Record<Spelling, Readonly<Record<BuildFlavor, string>>>> =
  {
    fm: { release: "firstmate-3000", dev: "firstmate-3000-dev" },
    inf: { release: RELEASE_USER_DATA_FOLDER, dev: DEV_USER_DATA_FOLDER },
  };

/** The spellings in the order they were named: each one's app moves the folders before it. */
const NAMED_IN_ORDER: readonly Spelling[] = ["fm", "inf"];

/**
 * The package.json key a packaged build is stamped with when it is not the
 * release: `electron-builder.dev.yml` adds `"infinitaryBuildFlavor": "dev"`
 * through `extraMetadata`, so the bundle carries its own flavor whatever
 * built it. A packaged build without the key is the release.
 */
export const BUILD_FLAVOR_KEY = "infinitaryBuildFlavor";
/**
 * The same stamp as Firstmate 3000 named it before the Infinitary rename,
 * still read, so a development package never opens the release folder
 * whichever name stamped it.
 */
export const OLDER_BUILD_FLAVOR_KEY = "fm3000BuildFlavor";

/** This build's own folder for its flavor. */
export function userDataFolderFor(flavor: BuildFlavor): string {
  return flavor === "dev" ? DEV_USER_DATA_FOLDER : RELEASE_USER_DATA_FOLDER;
}

export function userDataFolderOf(spelling: Spelling, flavor: BuildFlavor): string {
  return USER_DATA_FOLDERS[spelling][flavor];
}

/**
 * The folders an app of this spelling moves into its own, newest first:
 * those of the spellings named before it, of the same flavor. Firstmate
 * 3000's app has none, so its move never wakes.
 */
export function olderUserDataFolders(spelling: Spelling, flavor: BuildFlavor): string[] {
  const at = NAMED_IN_ORDER.indexOf(spelling);
  return NAMED_IN_ORDER.slice(0, Math.max(0, at))
    .reverse()
    .map((older) => userDataFolderOf(older, flavor));
}

/**
 * Every spelling's folder of a flavor, newest first: where a computer that
 * runs work may keep it, under either name, as a home looks for it there
 * (src/core/devices/farSystems.ts).
 */
export function userDataFoldersNewestFirst(flavor: BuildFlavor): string[] {
  return [...NAMED_IN_ORDER].reverse().map((spelling) => userDataFolderOf(spelling, flavor));
}

/** The spelling whose folder a data folder's name is, of either flavor; undefined for any other name. */
export function spellingOfUserDataFolder(name: string): Spelling | undefined {
  return NAMED_IN_ORDER.find((spelling) =>
    Object.values(USER_DATA_FOLDERS[spelling]).includes(name),
  );
}
