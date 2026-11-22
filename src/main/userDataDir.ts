import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWN_IDENTITY, readSpellings, type Spelling } from "@shared/codeNames";
import { settingFrom } from "@shared/envSettings";
import {
  BUILD_FLAVOR_KEY,
  type BuildFlavor,
  OLDER_BUILD_FLAVOR_KEY,
  userDataFolderOf,
} from "@shared/userDataFolders";

/**
 * Which userData directory this process opens (src/shared/userDataFolders.ts
 * names the folders). Decided once, at the top of main, before the
 * single-instance lock or any path helper reads userData.
 */
export type UserDataChoice =
  /** `INFINITARY_USER_DATA_DIR` on an unpackaged run: e2e and throwaway dev state. */
  | { kind: "isolated"; dir: string }
  /**
   * Chromium's `--user-data-dir` already set userData (the release launch
   * gate boots into a throwaway profile this way); it is left alone.
   */
  | { kind: "switch" }
  | { kind: "flavor"; flavor: BuildFlavor; dir: string };

export type UserDataInput = {
  packaged: boolean;
  env: Record<string, string | undefined>;
  hasUserDataDirSwitch: boolean;
  /** Electron's `appData` path. */
  appData: string;
  /** The app's own package.json, read only for a packaged build. */
  readAppPackageJson: () => string;
  /** Whose folders this run opens (`folderSpellingFor`); this build's own unless given. */
  spelling?: Spelling;
};

export function chooseUserDataDir(input: UserDataInput): UserDataChoice {
  // Ignored in packaged builds: a release never takes its data dir from the
  // environment.
  const isolated = input.packaged ? undefined : settingFrom(input.env, "USER_DATA_DIR")?.trim();
  if (isolated) return { kind: "isolated", dir: isolated };
  if (input.hasUserDataDirSwitch) return { kind: "switch" };
  const flavor = runFlavor({ ...input, isolated: false });
  const spelling = input.spelling ?? OWN_IDENTITY;
  return { kind: "flavor", flavor, dir: join(input.appData, userDataFolderOf(spelling, flavor)) };
}

/**
 * Whose data folders this run opens: this build's own identity's
 * (`OWN_IDENTITY`, `@shared/codeNames`). A development run may stand in Infinitary's with
 * `INFINITARY_FOLDER_SPELLING=inf`, so it opens `infinitary` and first moves
 * `firstmate-3000` into it: the one-time move, rehearsed on a throwaway
 * home (docs/saved-data-compatibility.md, "The one-time move"). A packaged
 * app ignores it.
 */
export function folderSpellingFor(input: {
  packaged: boolean;
  env: Record<string, string | undefined>;
}): Spelling {
  if (input.packaged) return OWN_IDENTITY;
  return (
    readSpellings([settingFrom(input.env, "FOLDER_SPELLING")?.trim() ?? ""])?.[0] ?? OWN_IDENTITY
  );
}

/**
 * The flavor whose folders and background labels a run uses
 * (src/shared/userDataFolders.ts): a packaged build's own, from its stamp;
 * a run from source with nothing isolating it (`pnpm dev`) the release's,
 * so it opens the person's own saved data, as the installed app does; and a
 * run from source that a test or an experiment isolated - its data folder or
 * its work folder named - the development flavor's, so its background never
 * takes the installed app's label.
 */
export function runFlavor(input: {
  packaged: boolean;
  readAppPackageJson: () => string;
  isolated: boolean;
}): BuildFlavor {
  if (input.packaged) return packagedFlavor(input.readAppPackageJson);
  return input.isolated ? "dev" : "release";
}

/**
 * Whether something isolates a run from source from the person's own
 * folders: its data folder named (`INFINITARY_USER_DATA_DIR`, Chromium's
 * `--user-data-dir`, or a folder a test handed the window) or its work folder
 * named (`INFINITARY_HELPER_DATA_DIR`). Every name a run derives from its
 * flavor - its folders, its background and run labels, its standby lock, the
 * folder it looks for on another computer - reads `runFlavor` with this.
 */
export function sourceRunIsolated(input: {
  env: Record<string, string | undefined>;
  hasUserDataDirSwitch: boolean;
  isolatedUserData?: string | undefined;
}): boolean {
  return (
    Boolean(settingFrom(input.env, "HELPER_DATA_DIR")?.trim()) ||
    Boolean(input.isolatedUserData) ||
    Boolean(settingFrom(input.env, "USER_DATA_DIR")?.trim()) ||
    input.hasUserDataDirSwitch
  );
}

/**
 * A packaged build is the release unless its package.json carries the dev
 * stamp. An unreadable or unparseable file reads as the release: the
 * installed app must keep opening the folder it always has.
 */
export function packagedFlavor(readAppPackageJson: () => string): BuildFlavor {
  try {
    const parsed: unknown = JSON.parse(readAppPackageJson());
    if (
      parsed &&
      typeof parsed === "object" &&
      [BUILD_FLAVOR_KEY, OLDER_BUILD_FLAVOR_KEY].some((key) => Reflect.get(parsed, key) === "dev")
    ) {
      return "dev";
    }
  } catch {}
  return "release";
}

export function readPackageJsonAt(appPath: string): () => string {
  return () => readFileSync(join(appPath, "package.json"), "utf8");
}
