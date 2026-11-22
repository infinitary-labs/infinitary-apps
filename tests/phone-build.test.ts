import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  keepPhoneBuild,
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

  it("keeps the whole products folder of a real Xcode test plan, and a job of the same version takes it", async () => {
    // Xcode 26.4's own test plan names the whole configuration folder and joined `__TESTROOT__` paths, so the archive
    // holds the products folder whole rather than the files the plan names one by one.
    const folder = scratchDir("phone-build-");
    const products = join(folder, "Products");
    mkdirSync(products);
    const plan = "Infinitary_Infinitary_iphonesimulator26.4-arm64.xctestrun";
    copyFileSync(
      join(import.meta.dirname, "fixtures", "phone-test-plan", "xcode-26.4.json"),
      join(products, plan),
    );
    const out = join(folder, "shared");
    const archive = join(out, PHONE_BUILD_ARCHIVE);
    const kept: string[][] = [];
    const manifest = await keepPhoneBuild(products, plan, OWN, out, async (command, args) => {
      kept.push([command, ...args]);
      writeFileSync(archive, "the products folder");
      return "";
    });
    expect(kept).toEqual([["tar", "-cf", archive, "-C", products, "."]]);
    expect(manifest).toMatchObject({ ...OWN, plan });
    const into = join(folder, "job-2", "Products");
    const unpacked: string[][] = [];
    const answer = await useSharedPhoneBuild(out, into, OWN, async (command, args) => {
      unpacked.push([command, ...args]);
      copyFileSync(join(products, plan), join(into, plan));
      return "";
    });
    expect(answer).toEqual({ plan });
    expect(unpacked).toEqual([["tar", "-xf", archive, "-C", into]]);
    expect(existsSync(join(into, plan))).toBe(true);
  });
});
