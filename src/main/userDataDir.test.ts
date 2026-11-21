import { describe, expect, it } from "vitest";
import { chooseUserDataDir, folderSpellingFor, runFlavor, type UserDataInput } from "./userDataDir";

const appData = "/Users/someone/Library/Application Support";

function input(overrides: Partial<UserDataInput> = {}): UserDataInput {
  return {
    packaged: false,
    env: {},
    hasUserDataDirSwitch: false,
    appData,
    readAppPackageJson: () => {
      throw new Error("an unpackaged run never reads the app's package.json");
    },
    ...overrides,
  };
}

const releasePackageJson = () => JSON.stringify({ name: "infinitary", version: "0.1.1" });
const devBundlePackageJson = () =>
  JSON.stringify({ name: "infinitary", version: "0.1.1", infinitaryBuildFlavor: "dev" });

describe("chooseUserDataDir", () => {
  // The captain's ask on INF-5635's plan: pnpm dev opens the person's own saved data.
  it("opens the person's own folder, the release's, on an unpackaged run", () => {
    expect(chooseUserDataDir(input())).toEqual({
      kind: "flavor",
      flavor: "release",
      dir: `${appData}/infinitary`,
    });
  });

  it("opens the dev folder in the local dev bundle", () => {
    expect(
      chooseUserDataDir(input({ packaged: true, readAppPackageJson: devBundlePackageJson })),
    ).toEqual({ kind: "flavor", flavor: "dev", dir: `${appData}/infinitary-dev` });
    // Stamped under Firstmate 3000's older key, it is still the dev bundle.
    const older = () =>
      JSON.stringify({ name: "firstmate-3000", version: "0.1.1", fm3000BuildFlavor: "dev" });
    expect(chooseUserDataDir(input({ packaged: true, readAppPackageJson: older }))).toMatchObject({
      flavor: "dev",
    });
  });

  it("opens the release's own folder, Infinitary's", () => {
    expect(
      chooseUserDataDir(input({ packaged: true, readAppPackageJson: releasePackageJson })),
    ).toEqual({ kind: "flavor", flavor: "release", dir: `${appData}/infinitary` });
  });

  it("reads an unreadable or foreign package.json as the release", () => {
    for (const readAppPackageJson of [
      () => {
        throw new Error("ENOENT");
      },
      () => "not json",
      () => JSON.stringify({ infinitaryBuildFlavor: "something-else" }),
    ]) {
      expect(chooseUserDataDir(input({ packaged: true, readAppPackageJson }))).toMatchObject({
        flavor: "release",
        dir: `${appData}/infinitary`,
      });
    }
  });

  it("lets INFINITARY_USER_DATA_DIR win on an unpackaged run", () => {
    expect(
      chooseUserDataDir(
        input({ env: { INFINITARY_USER_DATA_DIR: " /tmp/e2e " }, hasUserDataDirSwitch: true }),
      ),
    ).toEqual({ kind: "isolated", dir: "/tmp/e2e" });
  });

  it("never takes a packaged build's data dir from the environment", () => {
    expect(
      chooseUserDataDir(
        input({
          packaged: true,
          env: { FM3000_USER_DATA_DIR: "/tmp/e2e" },
          readAppPackageJson: releasePackageJson,
        }),
      ),
    ).toMatchObject({ kind: "flavor", flavor: "release" });
  });

  it("leaves Chromium's --user-data-dir in charge", () => {
    expect(
      chooseUserDataDir(
        input({
          packaged: true,
          hasUserDataDirSwitch: true,
          readAppPackageJson: releasePackageJson,
        }),
      ),
    ).toEqual({ kind: "switch" });
  });

  it("opens Firstmate 3000's own folder when a run from source stands in its spelling", () => {
    const spelling = folderSpellingFor({ packaged: false, env: { FM3000_FOLDER_SPELLING: "fm" } });
    expect(chooseUserDataDir(input({ spelling }))).toEqual({
      kind: "flavor",
      flavor: "release",
      dir: `${appData}/firstmate-3000`,
    });
  });

  it("never lets a packaged build stand in another spelling's folders", () => {
    expect(folderSpellingFor({ packaged: true, env: { INFINITARY_FOLDER_SPELLING: "fm" } })).toBe(
      "inf",
    );
    expect(folderSpellingFor({ packaged: false, env: { FM3000_FOLDER_SPELLING: "x" } })).toBe(
      "inf",
    );
  });
});

describe("runFlavor", () => {
  const unreadable = () => {
    throw new Error("an unpackaged run never reads the app's package.json");
  };

  // The work folder and the background's label follow the same flavor as the
  // window's folder, so pnpm dev's work is the installed app's, and a test's
  // isolated run never takes the installed app's background label.
  it("gives a run from source the release's folders unless something isolates it", () => {
    expect(runFlavor({ packaged: false, readAppPackageJson: unreadable, isolated: false })).toBe(
      "release",
    );
    expect(runFlavor({ packaged: false, readAppPackageJson: unreadable, isolated: true })).toBe(
      "dev",
    );
  });

  it("keeps a packaged build's own flavor, isolated or not", () => {
    for (const isolated of [false, true]) {
      expect(
        runFlavor({ packaged: true, readAppPackageJson: devBundlePackageJson, isolated }),
      ).toBe("dev");
      expect(runFlavor({ packaged: true, readAppPackageJson: releasePackageJson, isolated })).toBe(
        "release",
      );
    }
  });
});
