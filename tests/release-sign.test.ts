import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseSignOptions } from "../scripts/sign-release-mac.mjs";

const root = join(import.meta.dirname, "..");
const identity = JSON.parse(
  readFileSync(join(root, "packaging/release-identity.json"), "utf8"),
) as {
  teamId: string;
  acceptedTeamIds: string[];
  bundleId: string;
};

// The universal build's app and two of the files electron-builder's signer walks inside it.
const app = join(root, "dist/mac-universal/Infinitary.app");
const helper = join(app, "Contents/Frameworks/Infinitary Helper (Renderer).app");
const background = join(app, "Contents/MacOS/Infinitary Background");
const electronBuilderOptions = (filePath: string) => ({
  entitlements: join(root, "packaging/entitlements.plist"),
  hardenedRuntime: true,
  timestamp: undefined,
  requirements: undefined,
  additionalArguments: [] as string[],
  filePath,
});

describe("the release's Mac signing hook", () => {
  const options = releaseSignOptions({
    app,
    identity: "0123456789ABCDEF",
    optionsForFile: electronBuilderOptions,
  });

  // Squirrel.Mac installs an update only when it meets the running copy's
  // designated requirement: a copy without every accepted team in it refuses
  // the next team's release (the move to the company Apple team).
  it("gives the app bundle a designated requirement naming every accepted team", () => {
    const requirement = String(options.optionsForFile(app).requirements);
    expect(requirement.startsWith("=designated => ")).toBe(true);
    expect(requirement).toContain(`identifier "${identity.bundleId}"`);
    expect(identity.acceptedTeamIds).toContain(identity.teamId);
    for (const team of identity.acceptedTeamIds) {
      expect(requirement).toContain(`certificate leaf[subject.OU] = "${team}"`);
    }
  });

  // The background file is signed under the app's identifier and must carry
  // the app's requirement: scripts/verify-app.sh refuses an alpha whose two differ.
  it("gives the background file the app bundle's requirement", () => {
    expect(options.optionsForFile(background)).toEqual({
      ...electronBuilderOptions(background),
      requirements: options.optionsForFile(app).requirements,
    });
  });

  // The requirement names the app's identifier; a helper, signed under its own, would fail it.
  it("leaves a helper electron-builder's own options", () => {
    expect(options.optionsForFile(helper)).toEqual(electronBuilderOptions(helper));
  });

  it("keeps electron-builder's app, identity and settings", () => {
    expect(options.app).toBe(app);
    expect(options.identity).toBe("0123456789ABCDEF");
    expect(options.optionsForFile(app)).toMatchObject({
      hardenedRuntime: true,
      entitlements: electronBuilderOptions(app).entitlements,
    });
  });
});
