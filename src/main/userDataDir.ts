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
  const flavor = input.packaged ? packagedFlavor(input.readAppPackageJson) : "dev";
  const spelling = input.spelling ?? OWN_IDENTITY;
  return { kind: "flavor", flavor, dir: join(input.appData, userDataFolderOf(spelling, flavor)) };
}

/**
 * Whose data folders this run opens: this build's own identity's
 * (`OWN_IDENTITY`, `@shared/codeNames`). A development run may stand in Infinitary's with
 * `INFINITARY_FOLDER_SPELLING=inf`, so it opens `infinitary-dev` and first moves
 * `firstmate-3000-dev` into it: the one-time move, rehearsed on a throwaway
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
  } catch {
    // The release.
  }
  return "release";
}

export function readPackageJsonAt(appPath: string): () => string {
  return () => readFileSync(join(appPath, "package.json"), "utf8");
}
