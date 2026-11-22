import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PHONE_BUILD_ARCHIVE,
  PHONE_BUILD_MANIFEST,
  type PhoneBuildIdentity,
  type PhoneBuildManifest,
  phoneBuildRefusal,
  useSharedPhoneBuild,
} from "../scripts/phone-build";
import { scratchDir } from "./helpers/scratchDirs";

// INF-6039's plan, part 1, as the captain approved it for careful review: "A mix-up could test an app built from another
// version and still pass." A job given a shared build that is not of its own version, Xcode, SDK and chip refuses it,
// unpacks nothing and builds the app itself. The readings are a phone Mac's: two consecutive commits of this project,
// Xcode 27.1's own `xcodebuild -version`, its iOS simulator SDK build and the chip.
const OWN: PhoneBuildIdentity = {
  commit: "172a2345d3dc1b501f694c5fc82c4396b83bef12",
  clean: true,
  xcode: "Xcode 27.1\nBuild version 27A9275",
  sdk: "24A94232",
  arch: "arm64",
};
const PREVIOUS_COMMIT = "3bff13fba0b698741693f5a36b020c04aa8b4856";
const shared = (over: Partial<PhoneBuildManifest> = {}): PhoneBuildManifest => ({
  ...OWN,
  plan: "Infinitary_Infinitary_iphonesimulator27.0-arm64.xctestrun",
  sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  ...over,
});

describe("a shared phone build", () => {
  it("stands in for the job's own build only when it is of the job's version, Xcode, SDK and chip", () => {
    expect(phoneBuildRefusal(shared(), OWN)).toBeUndefined();
    expect(phoneBuildRefusal(shared({ commit: PREVIOUS_COMMIT }), OWN)).toBe(
      `it was built from ${PREVIOUS_COMMIT}, not this version ${OWN.commit}`,
    );
    for (const other of [
      { xcode: "Xcode 27.0\nBuild version 27A5218g" },
      { sdk: "24A5279f" },
      { arch: "x64" },
      { clean: false },
    ])
      expect(phoneBuildRefusal(shared(other), OWN), JSON.stringify(other)).toBeDefined();
    // A job whose own checkout has changes builds them itself.
    expect(phoneBuildRefusal(shared(), { ...OWN, clean: false })).toBeDefined();
    expect(phoneBuildRefusal(undefined, OWN)).toBeDefined();
  });

  it("refuses a build of another version before unpacking anything, so the job builds the app itself", async () => {
    const folder = scratchDir("phone-build-");
    writeFileSync(join(folder, PHONE_BUILD_ARCHIVE), "the products of another version");
    writeFileSync(
      join(folder, PHONE_BUILD_MANIFEST),
      JSON.stringify(shared({ commit: PREVIOUS_COMMIT })),
    );
    const commands: string[] = [];
    const answer = await useSharedPhoneBuild(
      folder,
      join(folder, "Products"),
      OWN,
      async (command, args) => {
        commands.push([command, ...args].join(" "));
        return "";
      },
    );
    expect(answer).toEqual({
      refusal: `it was built from ${PREVIOUS_COMMIT}, not this version ${OWN.commit}`,
    });
    expect(commands).toEqual([]);
  });

  it("refuses a build of this version whose archive is not the one its first job recorded", async () => {
    const folder = scratchDir("phone-build-");
    writeFileSync(join(folder, PHONE_BUILD_ARCHIVE), "a download cut short");
    writeFileSync(join(folder, PHONE_BUILD_MANIFEST), JSON.stringify(shared()));
    const commands: string[] = [];
    const answer = await useSharedPhoneBuild(
      folder,
      join(folder, "Products"),
      OWN,
      async (command) => {
        commands.push(command);
        return "";
      },
    );
    expect("refusal" in answer && answer.refusal).toMatch(
      /^its archive's SHA-256 is [0-9a-f]{64}, not the /,
    );
    expect(commands).toEqual([]);
  });
});
