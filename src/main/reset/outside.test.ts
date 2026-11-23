import { join } from "node:path";
import type { CustodyRemove, SecretCustody } from "@core/secrets/custody";
import { appIdOf } from "@shared/codeNames";
import { describe, expect, it } from "vitest";
import {
  SECRET_APPROVER_NAMES,
  SECRET_STANDBY_NAMES,
  SECRETS_CUSTODY_NAMES,
} from "../host/nativeSecrets";
import { appFilePaths, clearPasswordStore, passwordStoreNames } from "./outside";

/**
 * What a reset clears outside the data folder (docs/reset.md, "Outside the
 * folder"): only this flavor's own items, and a store that cannot answer is
 * left for the next start.
 */

function custody(answers: Record<string, CustodyRemove | Error>) {
  const asked: string[] = [];
  const fake = {
    remove: async (slot: string) => {
      asked.push(slot);
      const answer = answers[slot];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as SecretCustody;
  return { asked, fake };
}

describe("the password store a reset clears", () => {
  it("names the flavor's Secrets and standby lock, and its approval key only on a Mac", () => {
    expect(passwordStoreNames("darwin", "release")).toEqual([
      SECRETS_CUSTODY_NAMES.release,
      SECRET_STANDBY_NAMES.release,
      SECRET_APPROVER_NAMES.release,
    ]);
    expect(passwordStoreNames("win32", "dev")).toEqual([
      SECRETS_CUSTODY_NAMES.dev,
      SECRET_STANDBY_NAMES.dev,
    ]);
  });

  it("is cleared once every slot answers removed or never there", async () => {
    const one = custody({ root: "removed", "authority-head": "absent" });
    expect(await clearPasswordStore([one.fake])).toBe(true);
    expect(one.asked).toEqual(["root", "authority-head"]);
  });

  it("is left for the next start when a slot is locked, throws, or the store cannot open", async () => {
    expect(
      await clearPasswordStore([
        custody({ root: "removed", "authority-head": "unavailable" }).fake,
      ]),
    ).toBe(false);
    expect(
      await clearPasswordStore([
        custody({ root: new Error("denied"), "authority-head": "absent" }).fake,
      ]),
    ).toBe(false);
    expect(await clearPasswordStore(undefined)).toBe(false);
  });
});

describe("the app's own files a reset clears", () => {
  it("names a Mac's files by the flavor's app id, and none elsewhere", () => {
    const paths = appFilePaths({ platform: "darwin", flavor: "dev", homeDir: "/Users/someone" });
    const library = join("/Users/someone", "Library");
    expect(paths).toContain(join(library, "Preferences", `${appIdOf("dev")}.plist`));
    expect(paths).toContain(join(library, "Caches", appIdOf("dev")));
    expect(paths.every((path) => path.startsWith(library))).toBe(true);
    expect(appFilePaths({ platform: "linux", flavor: "dev", homeDir: "/home/someone" })).toEqual(
      [],
    );
  });
});
