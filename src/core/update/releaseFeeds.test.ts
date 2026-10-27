import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseUpdateInfo, resolveFiles } from "electron-updater/out/providers/Provider";
import { describe, expect, it } from "vitest";
import { macFeed, type ReleaseManifest, releaseFeedFiles } from "./releaseFeeds";
import { PUBLIC_RELEASE_NAMES, releaseSource } from "./releaseSource";
import type { Publication } from "./tapPublication";
import { parseBuilds, parseUpdateTargets } from "./updateChannels";

// INF-640: feed publication preserves immutable bytes and each channel's forward-only target.
// Real file digests stand in for artifact identity; this suite claims no signed-package verification.
const bytes = readFileSync(new URL("../../../packaging/build/icon.png", import.meta.url));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sha512 = createHash("sha512").update(bytes).digest("base64");
function publication(version: string): { manifest: ReleaseManifest; publication: Publication } {
  const channel = version.includes("-alpha.") ? "alpha" : "stable";
  return {
    manifest: {
      schemaVersion: 1,
      version,
      sourceCommit: "affbc83e0b6ed93d40ca01e6d287823df02e7d39",
      zip: { asset: `Infinitary-${version}-universal.zip`, sha256, sha512, size: bytes.length },
      dmg: { asset: `Infinitary-${version}-mac-universal.dmg`, sha256, size: bytes.length },
    },
    publication: {
      channel,
      version,
      assetName: `Infinitary-${version}-universal.zip`,
      sha256,
      sourceCommit: "affbc83e0b6ed93d40ca01e6d287823df02e7d39",
      linux: {
        stable: { x64: { deb: { asset: `infinitary-${version}-linux-amd64.deb`, sha256 } } },
        alpha: { x64: { deb: { asset: `infinitary-${version}-linux-amd64.deb`, sha256 } } },
      },
    },
  };
}
function next(version: string, files: Record<string, string> = {}) {
  const read = (name: string) => (files[name] === undefined ? undefined : JSON.parse(files[name]));
  return releaseFeedFiles({
    ...publication(version),
    currentTargets: read(PUBLIC_RELEASE_NAMES.targetsFile),
    currentBuilds: read(PUBLIC_RELEASE_NAMES.buildsFile),
    previousManifest: read(`versions/${version}.json`),
  });
}

describe("public release feeds without cask publication", () => {
  it("produces metadata the actual updater resolves to the finalized ZIP and its digest", () => {
    const { manifest } = publication("0.5.0-alpha.9");
    const feed = macFeed(manifest);
    const url = new URL("alpha-mac.yml", releaseSource.feedUrl);
    const info = parseUpdateInfo(feed, "alpha-mac.yml", url);
    const files = resolveFiles(info, new URL(releaseSource.feedUrl));
    expect(info.version).toBe(manifest.version);
    expect(files).toHaveLength(1);
    expect(files[0]?.url.href).toBe(
      `${releaseSource.downloadBase}releases/v${manifest.version}/${manifest.zip.asset}`,
    );
    expect(files[0]?.info).toMatchObject({ size: bytes.length, sha512 });
  });

  it("advances alpha alone, stable to both, then alpha alone while retaining Linux and both Mac architectures", () => {
    let files = next("0.5.0-alpha.9").files;
    expect(files["latest-mac.yml"]).toBeUndefined();
    files = { ...files, ...next("0.5.0", files).files };
    expect(JSON.parse(files["latest-mac.yml"] ?? "null").version).toBe("0.5.0");
    expect(JSON.parse(files["alpha-mac.yml"] ?? "null").version).toBe("0.5.0");
    files = { ...files, ...next("0.5.1-alpha.11", files).files };
    const targets = parseUpdateTargets(
      JSON.parse(files[PUBLIC_RELEASE_NAMES.targetsFile] ?? "null"),
      PUBLIC_RELEASE_NAMES,
    );
    expect(targets?.targets.stable?.version).toBe("0.5.0");
    expect(targets?.targets.alpha?.version).toBe("0.5.1-alpha.11");
    const builds = parseBuilds(
      JSON.parse(files[PUBLIC_RELEASE_NAMES.buildsFile] ?? "null"),
      PUBLIC_RELEASE_NAMES,
    );
    expect(builds?.channels.alpha?.systems.linux?.x64?.deb?.sha256).toBe(sha256);
    for (const chip of ["arm64", "x64"]) {
      expect(builds?.channels.alpha?.systems.macos?.[chip]?.zip?.sha256).toBe(sha256);
      expect(builds?.channels.alpha?.systems.macos?.[chip]?.dmg?.sha256).toBe(sha256);
    }
  });

  it("keeps a newer alpha when a stable is published", () => {
    const first = next("0.5.1-alpha.11").files;
    const stable = next("0.5.0", first);
    expect(stable.files["alpha-mac.yml"]).toBeUndefined();
    expect(JSON.parse(stable.files["latest-mac.yml"] ?? "null").version).toBe("0.5.0");
  });

  it("makes an identical retry inert and rejects changed installer bytes or a late older release", () => {
    const first = next("0.5.0-alpha.9").files;
    expect(next("0.5.0-alpha.9", first).files).toEqual({});
    const changed = publication("0.5.0-alpha.9");
    changed.manifest.dmg.size++;
    expect(() =>
      releaseFeedFiles({
        ...changed,
        previousManifest: JSON.parse(first["versions/0.5.0-alpha.9.json"] ?? "null"),
      }),
    ).toThrow("cannot change");
    expect(() => next("0.5.0-alpha.8", first)).toThrow("never moves backwards");
  });

  it("refuses a foreign target, inconsistent artifact record or missing Linux builds", () => {
    const first = next("0.5.0-alpha.9").files;
    const current = JSON.parse(first[PUBLIC_RELEASE_NAMES.targetsFile] ?? "null");
    current.targets.alpha.downloadUrl = "https://unrelated.example/app.zip";
    expect(() =>
      releaseFeedFiles({ ...publication("0.5.0-alpha.10"), currentTargets: current }),
    ).toThrow();
    const wrong = publication("0.5.0-alpha.10");
    wrong.manifest.version = "0.5.0-alpha.9";
    expect(() => releaseFeedFiles(wrong)).toThrow("does not describe");
    const noLinux = publication("0.5.0-alpha.10");
    delete noLinux.publication.linux;
    expect(() => releaseFeedFiles(noLinux)).toThrow("keep the Linux");
  });
});
