import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PublishedBuilds } from "../src/core/devices/publishedBuilds";
import { publicBuildsUrl, releaseSource } from "../src/core/update/releaseSource";
import { BUILDS_URL, buildDownloadUrl, buildUpdateTarget } from "../src/core/update/updateChannels";
import { createUpdateChecker } from "../src/core/update/updateChecker";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1613's approved Homebrew/Linux-only unblock must work even before the R2 domain exists.
const version = "0.6.0";
const sha256 = createHash("sha256")
  .update(readFileSync(new URL("../packaging/build/icon.png", import.meta.url)))
  .digest("hex");
const target = buildUpdateTarget({
  version,
  assetName: `Infinitary-${version}-universal.zip`,
  sha256,
  sourceCommit: "affbc83e0b6ed93d40ca01e6d287823df02e7d39",
});
const download = {
  url: buildDownloadUrl(version, `infinitary-${version}-linux-amd64.deb`),
  sha256,
};
const builds = {
  schemaVersion: 1,
  channels: {
    stable: {
      version,
      releaseUrl: target.releaseUrl,
      sourceCommit: target.sourceCommit,
      systems: { linux: { x64: { deb: download } } },
    },
  },
};

function fixture() {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith(releaseSource.downloadBase))
      throw new TypeError("DNS name is not yet configured");
    if (url === BUILDS_URL) return Response.json(builds);
    throw new Error(`Unexpected request ${url}`);
  };
  return { requests, fetchImpl };
}

describe("pre-storage download fallback", () => {
  it("offers the existing tap's Linux package when the new domain cannot resolve", async () => {
    const f = fixture();
    const checker = createUpdateChecker({
      currentVersion: "0.5.0",
      channel: () => "stable",
      linux: { chip: "x64", package: "deb" },
      fetchImpl: f.fetchImpl,
      openExternal: () => {},
    });
    expect(await checker.getStatus()).toMatchObject({
      latestVersion: version,
      updateAvailable: true,
      releaseUrl: target.releaseUrl,
    });
    expect(f.requests).toEqual([publicBuildsUrl, BUILDS_URL]);
  });

  it("resolves the exact paired-computer package through the tap without trusting an absent host", async () => {
    const f = fixture();
    const published = new PublishedBuilds({
      version,
      dir: join(scratchDir("infinitary-source-fallback-"), "builds"),
      fetchImpl: f.fetchImpl,
    });
    expect(await published.downloadFor({ system: "linux", chip: "x64", kind: "deb" })).toEqual(
      download,
    );
    expect(f.requests.at(-1)).toBe(BUILDS_URL);
  });

  it("does not reinterpret a deliberately supplied source as permission to fall back", async () => {
    const f = fixture();
    const published = new PublishedBuilds({
      version,
      dir: join(scratchDir("infinitary-source-explicit-"), "builds"),
      fetchImpl: f.fetchImpl,
      buildsUrl: publicBuildsUrl,
    });
    await expect(
      published.downloadFor({ system: "linux", chip: "x64", kind: "deb" }),
    ).rejects.toThrow("could not be reached");
    expect(f.requests).toEqual([publicBuildsUrl]);
  });
});
