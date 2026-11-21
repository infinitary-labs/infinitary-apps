import { z } from "zod";
import { parseBuilds } from "./releaseBuilds";
import { PUBLIC_RELEASE_NAMES } from "./releaseSource";
import { advanceBuilds, advanceUpdateTargets, type Publication } from "./tapPublication";
import { buildDownloadUrl } from "./updateChannels";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const asset = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const archiveSchema = z
  .object({ asset, sha256: digest, size: z.number().int().positive() })
  .strict();
export const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string(),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    zip: archiveSchema.extend({ sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict(),
    dmg: archiveSchema,
    /** An alpha's Windows installer, the one its Windows check tested (docs/windows.md). */
    windows: archiveSchema.optional(),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Standard electron-updater metadata, serialized as JSON (also valid YAML). */
export function macFeed(manifest: ReleaseManifest): string {
  const zip = manifest.zip;
  return `${JSON.stringify(
    {
      version: manifest.version,
      files: [
        {
          url: buildDownloadUrl(manifest.version, zip.asset, PUBLIC_RELEASE_NAMES),
          sha512: zip.sha512,
          size: zip.size,
        },
      ],
      path: buildDownloadUrl(manifest.version, zip.asset, PUBLIC_RELEASE_NAMES),
      sha512: zip.sha512,
      // electron-updater compares this with os.release(): Electron's macOS 12 floor is Darwin 21.
      minimumSystemVersion: "21.0.0",
    },
    null,
    2,
  )}\n`;
}

/** INF-640: verified immutable artifacts first, then one atomic, forward-only channel commit. */
export function releaseFeedFiles(options: {
  currentTargets?: unknown;
  currentBuilds?: unknown;
  previousManifest?: unknown;
  publication: Publication;
  manifest: ReleaseManifest;
}): { files: Record<string, string>; notes: string[] } {
  const manifest = releaseManifestSchema.parse(options.manifest);
  const publication = options.publication;
  if (
    manifest.version !== publication.version ||
    manifest.sourceCommit !== publication.sourceCommit ||
    manifest.zip.asset !== publication.assetName ||
    manifest.zip.sha256 !== publication.sha256 ||
    !manifest.zip.asset.endsWith(".zip") ||
    !manifest.dmg.asset.endsWith(".dmg") ||
    (manifest.windows &&
      (publication.channel !== "alpha" ||
        manifest.windows.asset !== `Infinitary-${manifest.version}-windows-x64-setup.exe`))
  ) {
    throw new Error(
      "The installer manifest does not describe this publication's finalized artifacts.",
    );
  }
  if (
    options.previousManifest !== undefined &&
    JSON.stringify(releaseManifestSchema.parse(options.previousManifest)) !==
      JSON.stringify(manifest)
  ) {
    throw new Error("A published version's installer or updater bytes cannot change.");
  }
  const advanced = advanceUpdateTargets(options.currentTargets, publication, {
    tap: PUBLIC_RELEASE_NAMES,
  });
  const builds = advanceBuilds(options.currentBuilds, advanced, publication, PUBLIC_RELEASE_NAMES);
  if (!builds) throw new Error("A release must keep the Linux and paired-device downloads.");
  if (advanced.changed.length === 0 && options.previousManifest === undefined)
    throw new Error("The published version has no installer manifest.");
  const files: Record<string, string> = {};
  if (advanced.changed.length > 0) {
    for (const channel of advanced.changed) {
      files[channel === "stable" ? "latest-mac.yml" : "alpha-mac.yml"] = macFeed(manifest);
      const entry = builds.channels[channel];
      if (!entry) throw new Error("A moved channel has no builds.");
      for (const chip of ["arm64", "x64"]) {
        const kinds = entry.systems.macos?.[chip];
        if (!kinds)
          throw new Error("A Mac release must carry the universal ZIP for both architectures.");
        kinds.dmg = {
          url: buildDownloadUrl(manifest.version, manifest.dmg.asset, PUBLIC_RELEASE_NAMES),
          sha256: manifest.dmg.sha256,
        };
      }
      // Only the alpha it was built for names the Windows installer: a
      // stable handed to alpha carries none (docs/windows.md).
      if (manifest.windows && channel === publication.channel) {
        entry.systems.windows = {
          x64: {
            exe: {
              url: buildDownloadUrl(manifest.version, manifest.windows.asset, PUBLIC_RELEASE_NAMES),
              sha256: manifest.windows.sha256,
            },
          },
        };
      }
    }
    // The reader every installed copy runs is the last word, before the feed
    // switches: a file it refuses would hide every build, Mac and Linux too.
    if (!parseBuilds(builds, PUBLIC_RELEASE_NAMES))
      throw new Error("The next builds file does not validate.");
    files[PUBLIC_RELEASE_NAMES.targetsFile] = `${JSON.stringify(advanced.targets, null, 2)}\n`;
    files[PUBLIC_RELEASE_NAMES.buildsFile] = `${JSON.stringify(builds, null, 2)}\n`;
    files[`versions/${manifest.version}.json`] = `${JSON.stringify(manifest, null, 2)}\n`;
  }
  return { files, notes: advanced.notes };
}
