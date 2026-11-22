import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  buildUpdateTarget,
  FIRSTMATE_TAP,
  INFINITARY_TAP,
  parseUpdateTargets,
  readUpdateChannelMarker,
  resolveUpdateChannel,
  UPDATE_CHANNEL_MARKER,
  type UpdateTarget,
  upgradeCommandFor,
} from "./updateChannels";

function target(version: string, sha = "a"): UpdateTarget {
  return buildUpdateTarget({
    version,
    assetName: `Infinitary-${version}-universal.zip`,
    sha256: sha.repeat(64),
    sourceCommit: "c".repeat(40),
  });
}

function dataRootWith(marker: string | null): string {
  const dir = scratchDir("fm-update-channel-");
  if (marker !== null) writeFileSync(join(dir, UPDATE_CHANNEL_MARKER), marker);
  return dir;
}

describe("the installed subscription", () => {
  it("follows a valid installer marker whatever version runs", () => {
    const alpha = dataRootWith(JSON.stringify({ schemaVersion: 1, channel: "alpha" }));
    // An alpha tester who received a stable version stays on alpha.
    expect(resolveUpdateChannel(alpha, "0.1.25")).toBe("alpha");
    expect(resolveUpdateChannel(alpha, "0.1.26-alpha.43")).toBe("alpha");
    const stable = dataRootWith(JSON.stringify({ schemaVersion: 1, channel: "stable" }));
    // Installing stable switches even an alpha build's notices to stable.
    expect(resolveUpdateChannel(stable, "0.1.26-alpha.43")).toBe("stable");
  });

  it("falls back to alpha only for an alpha logical version when the marker is missing or invalid", () => {
    for (const marker of [
      null,
      "",
      "not json",
      JSON.stringify({ schemaVersion: 2, channel: "alpha" }),
      JSON.stringify({ schemaVersion: 1, channel: "beta" }),
      JSON.stringify({ schemaVersion: 1, channel: "alpha", extra: true }),
      JSON.stringify({ channel: "alpha" }),
    ]) {
      const root = dataRootWith(marker);
      expect(readUpdateChannelMarker(root)).toBeNull();
      expect(resolveUpdateChannel(root, "0.1.26-alpha.43")).toBe("alpha");
      expect(resolveUpdateChannel(root, "0.1.25")).toBe("stable");
      expect(resolveUpdateChannel(root, "0.1.25-rc.1")).toBe("stable");
      expect(resolveUpdateChannel(root, "not a version")).toBe("stable");
    }
  });

  // INF-1913: an explicit tap/cask lets Homebrew trust an older installation's
  // selected cask, without trusting the rest of either public tap.
  it("names each channel's own tap and cask in its upgrade command", () => {
    for (const tap of [INFINITARY_TAP, FIRSTMATE_TAP]) {
      for (const channel of ["stable", "alpha"] as const) {
        expect(upgradeCommandFor(channel, tap)).toBe(
          `brew update && brew upgrade --cask ${tap.tap}/${tap.caskTokens[channel]}`,
        );
      }
    }
    expect(upgradeCommandFor("stable")).toBe(upgradeCommandFor("stable", INFINITARY_TAP));
    expect(upgradeCommandFor("alpha")).toBe(upgradeCommandFor("alpha", INFINITARY_TAP));
  });
});

describe("the published update targets", () => {
  it("accepts stable and alpha targets on the public tap, including stable handed to alpha", () => {
    const alphaArtifact = { schemaVersion: 1, targets: { alpha: target("0.1.26-alpha.43") } };
    expect(parseUpdateTargets(alphaArtifact)).toEqual(alphaArtifact);
    expect(target("0.1.26-alpha.43")).toMatchObject({
      releaseUrl:
        "https://github.com/infinitary-labs/homebrew-tap/releases/tag/infinitary-alpha-v0.1.26-alpha.43",
      downloadUrl:
        "https://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-alpha-v0.1.26-alpha.43/Infinitary-0.1.26-alpha.43-universal.zip",
    });
    const handedOn = {
      schemaVersion: 1,
      targets: { stable: target("0.1.25"), alpha: target("0.1.25") },
    };
    expect(parseUpdateTargets(handedOn)).toEqual(handedOn);
    // A valid file may name no target for a channel; nothing is invented for it.
    expect(parseUpdateTargets({ schemaVersion: 1, targets: {} })).toEqual({
      schemaVersion: 1,
      targets: {},
    });
  });

  it("refuses wrong hosts, tags, versions, checksums and conflicting identities", () => {
    const stable = target("0.1.25");
    const refused: unknown[] = [
      null,
      [],
      { schemaVersion: 2, targets: { stable } },
      { schemaVersion: 1, targets: { stable }, extra: 1 },
      { schemaVersion: 1, targets: { stable, beta: stable } },
      { schemaVersion: 1, targets: { stable: { ...stable, extra: 1 } } },
      { schemaVersion: 1, targets: { stable: target("0.1.26-alpha.43") } },
      { schemaVersion: 1, targets: { alpha: { ...stable, version: "0.1.26-beta.1" } } },
      { schemaVersion: 1, targets: { stable: { ...stable, version: "v0.1.25" } } },
      // The private product repository, a foreign host, another release.
      {
        schemaVersion: 1,
        targets: {
          stable: {
            ...stable,
            downloadUrl:
              "https://github.com/infinitary-labs/infinitary/releases/download/v0.1.25/Infinitary-0.1.25-universal.zip",
          },
        },
      },
      {
        schemaVersion: 1,
        targets: {
          stable: { ...stable, releaseUrl: "https://example.com/infinitary-v0.1.25" },
        },
      },
      {
        schemaVersion: 1,
        targets: { stable: { ...stable, releaseUrl: target("0.1.24").releaseUrl } },
      },
      {
        schemaVersion: 1,
        targets: {
          stable: {
            ...stable,
            downloadUrl: `${stable.downloadUrl.replace(/[^/]+$/, "")}nested/evil.zip`,
          },
        },
      },
      {
        schemaVersion: 1,
        targets: {
          alpha: {
            ...stable,
            releaseUrl:
              "https://github.com/infinitary-labs/homebrew-tap/releases/tag/infinitary-alpha-v0.1.25",
          },
        },
      },
      { schemaVersion: 1, targets: { stable: { ...stable, sha256: "A".repeat(64) } } },
      { schemaVersion: 1, targets: { stable: { ...stable, sha256: "abc123" } } },
      { schemaVersion: 1, targets: { stable: { ...stable, sourceCommit: "main" } } },
      { schemaVersion: 1, targets: { stable, alpha: target("0.1.25", "b") } },
    ];
    for (const payload of refused) expect(parseUpdateTargets(payload)).toBeNull();
    expect(() =>
      buildUpdateTarget({
        version: "0.1.25-rc.1",
        assetName: "x.zip",
        sha256: "a".repeat(64),
        sourceCommit: "c".repeat(40),
      }),
    ).toThrow(/not a stable or alpha version/);
  });
});

describe("the channel marker an install writes", () => {
  it("reads the channel of a marker that says it came through the old cask", () => {
    const dir = scratchDir("fm-channel-old-cask-");
    writeFileSync(
      join(dir, UPDATE_CHANNEL_MARKER),
      `${JSON.stringify({ schemaVersion: 1, channel: "alpha", cameThroughOldCask: true })}\n`,
    );
    expect(readUpdateChannelMarker(dir)).toBe("alpha");
    expect(resolveUpdateChannel(dir, "0.4.0-alpha.75")).toBe("alpha");
  });
});
