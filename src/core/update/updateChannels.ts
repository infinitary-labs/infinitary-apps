import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAlphaVersion, isStableVersion } from "@shared/semver";
import { type UpdateChannel, updateChannelSchema } from "@shared/updateChannel";
import { z } from "zod";

/**
 * The two update channels (docs/alpha.md "Update channels"). One app and
 * one saved-data folder; the installation chooses which updates it is
 * offered. This module owns the closed facts both sides of the channel
 * contract share: the installer-owned subscription marker the app reads,
 * the public tags and cask names of each channel, and the published update
 * targets file with its validation. The builds file Linux and Windows read
 * is `releaseBuilds.ts`, kept apart so a change to it alone does not hold an
 * alpha for the signed installer check (scripts/desktop-build.ts). The cask
 * and target writer that produce these files (`tapPublication.ts`) is built
 * against the same definitions.
 */

/**
 * A public tap's names: where its casks, its releases and its update files
 * live, and what each channel's cask and release tag is called. Every reader
 * and writer below takes one, its own tap's unless told otherwise.
 */
export type TapNames = {
  /** The tap's repository on GitHub, `owner/homebrew-name`. */
  repo: string;
  /** Build-owned object-storage destination; absent for the unchanged Homebrew taps. */
  downloadBase?: string;
  releasePage?: string;
  /** What `brew install --cask` names the tap by, `owner/name`. */
  tap: string;
  /** Public release tag prefixes, before the version. */
  stableTagPrefix: string;
  alphaTagPrefix: string;
  caskTokens: Readonly<Record<UpdateChannel, string>>;
  /** The update targets file installed Macs read, and the builds file Linux reads. */
  targetsFile: string;
  buildsFile: string;
  /**
   * Set on the tap of Firstmate 3000's casks, which install Infinitary for
   * the people who installed Firstmate 3000 (the old-cask switch, the
   * Infinitary rename's steps 13 and 14): what they install says it came
   * through the old cask, so its update notice keeps naming that cask.
   */
  throughOldCask?: true;
};

/** Infinitary's own public tap: its casks, its releases and its update files. */
export const INFINITARY_TAP: TapNames = {
  repo: "infinitary-labs/homebrew-tap",
  tap: "infinitary-labs/tap",
  stableTagPrefix: "infinitary-v",
  alphaTagPrefix: "infinitary-alpha-v",
  caskTokens: { stable: "infinitary", alpha: "infinitary@alpha" },
  targetsFile: "infinitary-updates.json",
  buildsFile: "infinitary-builds.json",
};

/**
 * Firstmate 3000's tap, shared with the captain's other products. An
 * installed Firstmate 3000 reads only its schema-1 files and accepts only
 * its `firstmate-3000-v` and `firstmate-3000-alpha-v` releases, so the
 * old-cask switch publishes Infinitary there under those names.
 */
export const FIRSTMATE_TAP: TapNames = {
  repo: "kunchenguid/homebrew-tap",
  tap: "kunchenguid/tap",
  stableTagPrefix: "firstmate-3000-v",
  alphaTagPrefix: "firstmate-3000-alpha-v",
  caskTokens: { stable: "firstmate-3000", alpha: "firstmate-3000@alpha" },
  targetsFile: "firstmate-3000-updates.json",
  buildsFile: "firstmate-3000-builds.json",
  throughOldCask: true,
};

/** The tap this build publishes to and reads from. */
export const TAP: TapNames = INFINITARY_TAP;

/** This build's own tap's names, as one value each. */
export const TAP_REPO = TAP.repo;
/** Public tap tag prefixes. Stable's never changes: older apps still read it. */
export const STABLE_TAG_PREFIX = TAP.stableTagPrefix;
export const ALPHA_TAG_PREFIX = TAP.alphaTagPrefix;
export const CASK_TOKENS: Readonly<Record<UpdateChannel, string>> = TAP.caskTokens;

/** The selectable command the update panel shows for the installed channel. */
export function upgradeCommandFor(channel: UpdateChannel, tap: TapNames = TAP): string {
  // The explicit tap/cask also trusts this cask on Homebrew 6+, including
  // installations made before tap trust existed; older Homebrew accepts it too.
  return `brew update && brew upgrade --cask ${tap.tap}/${tap.caskTokens[channel]}`;
}

/** The public tap's release page of a tag. */
export function releasePageOf(tag: string, tap: TapNames): string {
  return tap.releasePage ?? `https://github.com/${tap.repo}/releases/tag/${tag}`;
}

/** Where every asset of a tag's public tap release downloads from. */
export function downloadPrefixOf(tag: string, tap: TapNames): string {
  return tap.downloadBase
    ? `${tap.downloadBase}releases/${tag}/`
    : `https://github.com/${tap.repo}/releases/download/${tag}/`;
}

/** This app's release list on the shared tap for a channel with no known target. */
export function releasesPageFor(channel: UpdateChannel, tap: TapNames = TAP): string {
  if (tap.releasePage) return tap.releasePage;
  const prefix = channel === "alpha" ? tap.alphaTagPrefix : tap.stableTagPrefix;
  return `https://github.com/${tap.repo}/releases?q=${encodeURIComponent(prefix)}`;
}

/** Where a tap's files read from its default branch. */
function rawUrlOf(tap: TapNames, file: string): string {
  return `https://raw.githubusercontent.com/${tap.repo}/HEAD/${file}`;
}

/**
 * The starter list served beside the update feed (docs/model-lists.md,
 * "The served starter list"), read from this build's own tap.
 */
export const STARTERS_URL = rawUrlOf(TAP, "infinitary-starters.json");

/** A tap's update targets file, as installed Macs fetch it. */
export function targetsUrlOf(tap: TapNames): string {
  return rawUrlOf(tap, tap.targetsFile);
}

/** A tap's builds file, as Linux installations fetch it. */
export function buildsUrlOf(tap: TapNames): string {
  return rawUrlOf(tap, tap.buildsFile);
}

// --- The installed subscription --------------------------------------------

/**
 * The installer writes this file into the data root after a successful
 * install or upgrade; on a Mac the app only reads it. The data root is the run's own
 * userData, so a development or isolated run never reads the installed
 * app's marker. On Linux the installer is the app itself, which writes the
 * marker after it installs an update, and an Arch or NixOS package carries
 * its own beside the app. On Windows the app writes it too, just before it
 * hands its installer over, and puts the earlier one back when the hand-over
 * fails, or says it could not (`windowsInstall.ts`; docs/alpha.md "Update channels").
 */
export const UPDATE_CHANNEL_MARKER = "update-channel.json";

export const updateChannelMarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: updateChannelSchema,
    /**
     * The version the installer installed. A marker that names one holds
     * only while that version runs, so a package installed by hand later
     * decides its own channel again. The casks never name one.
     */
    version: z.string().optional(),
    /**
     * Set when the installation came through the old Firstmate 3000 cask
     * (`FIRSTMATE_TAP`): its update notice names that cask and reads that
     * tap. The channel it names is unchanged by it.
     */
    cameThroughOldCask: z.boolean().optional(),
  })
  .strict();
export type UpdateChannelMarker = z.infer<typeof updateChannelMarkerSchema>;

/**
 * The installer's marker, or null when it is missing, unreadable, or names
 * a version other than `currentVersion`.
 */
export function readUpdateMarker(
  dataRoot: string,
  currentVersion?: string,
): UpdateChannelMarker | null {
  try {
    const parsed = updateChannelMarkerSchema.safeParse(
      JSON.parse(readFileSync(join(dataRoot, UPDATE_CHANNEL_MARKER), "utf8")),
    );
    if (!parsed.success) return null;
    const { version } = parsed.data;
    return version === undefined || currentVersion === undefined || version === currentVersion
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

/**
 * The remembered subscription, or null when the marker is missing,
 * unreadable, or names a version other than `currentVersion`.
 */
export function readUpdateChannelMarker(
  dataRoot: string,
  currentVersion?: string,
): UpdateChannel | null {
  return readUpdateMarker(dataRoot, currentVersion)?.channel ?? null;
}

/**
 * The tap this installation updates through: Firstmate 3000's when its
 * installer says it came through the old cask, so the notice names the
 * command that installed it and a version that cask carries; otherwise this
 * build's own.
 */
export function resolveUpdateTap(dataRoot: string, currentVersion: string): TapNames {
  return readUpdateMarker(dataRoot, currentVersion)?.cameThroughOldCask ? FIRSTMATE_TAP : TAP;
}

/**
 * The subscription this installation follows. A valid remembered marker
 * wins, independently of the version: an alpha tester who received a
 * stable version stays on alpha. Next comes the marker a Linux package
 * carries beside the app (`packageRoot`, its resources folder), then only a
 * valid alpha logical version reads as alpha; everything else is stable.
 */
export function resolveUpdateChannel(
  dataRoot: string,
  currentVersion: string,
  packageRoot?: string,
): UpdateChannel {
  return (
    readUpdateChannelMarker(dataRoot, currentVersion) ??
    (packageRoot ? readUpdateChannelMarker(packageRoot, currentVersion) : null) ??
    (isAlphaVersion(currentVersion) ? "alpha" : "stable")
  );
}

// --- The published update targets ------------------------------------------

/**
 * The file on the public tap naming what each channel's cask installs now.
 * It is written in the same tap commit as the casks, after the download was
 * fetched back and verified, so a notice never names a version its cask
 * cannot install yet.
 */
export const UPDATE_TARGETS_FILE = TAP.targetsFile;
export const UPDATE_TARGETS_URL = targetsUrlOf(TAP);

export const SHA256 = /^[0-9a-f]{64}$/;
export const GIT_COMMIT = /^[0-9a-f]{40}$/;
const ZIP_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;

export const updateTargetSchema = z
  .object({
    /** The logical version the cask installs: stable `X.Y.Z` or alpha `X.Y.Z-alpha.N`. */
    version: z.string(),
    /** The public tap release page of that version. */
    releaseUrl: z.string(),
    /** The public download the cask carries. */
    downloadUrl: z.string(),
    sha256: z.string().regex(SHA256),
    /** The product source commit the artifact was built from. */
    sourceCommit: z.string().regex(GIT_COMMIT),
  })
  .strict();
export type UpdateTarget = z.infer<typeof updateTargetSchema>;

export const updateTargetsSchema = z
  .object({
    schemaVersion: z.literal(1),
    targets: z
      .object({ stable: updateTargetSchema.optional(), alpha: updateTargetSchema.optional() })
      .strict(),
  })
  .strict();
export type UpdateTargets = z.infer<typeof updateTargetsSchema>;

/** The public tap tag of an artifact version, or null for any other version shape. */
export function publicTagFor(version: string, tap: TapNames = TAP): string | null {
  if (isStableVersion(version)) return `${tap.stableTagPrefix}${version}`;
  if (isAlphaVersion(version)) return `${tap.alphaTagPrefix}${version}`;
  return null;
}

/**
 * The target record of a published artifact: its version's release page and
 * download on the public tap. Throws for a version no channel publishes.
 */
export function buildUpdateTarget(
  artifact: {
    version: string;
    assetName: string;
    sha256: string;
    sourceCommit: string;
  },
  tap: TapNames = TAP,
): UpdateTarget {
  const tag = publicTagFor(artifact.version, tap);
  if (!tag) throw new Error(`${artifact.version} is not a stable or alpha version`);
  return {
    version: artifact.version,
    releaseUrl: releasePageOf(tag, tap),
    downloadUrl: `${downloadPrefixOf(tag, tap)}${artifact.assetName}`,
    sha256: artifact.sha256,
    sourceCommit: artifact.sourceCommit,
  };
}

/**
 * Why a channel's target is not one the app may offer, or null when it is.
 * Stable carries only stable artifacts; alpha carries an alpha artifact or
 * the stable one handed to it. Both URLs must be this version's release on
 * the public tap - never the private product repository, another host or
 * another product's release.
 */
export function targetProblem(
  channel: UpdateChannel,
  target: UpdateTarget,
  tap: TapNames = TAP,
): string | null {
  const versionProblem = channelVersionProblem(channel, target.version);
  if (versionProblem) return versionProblem;
  const tag = publicTagFor(target.version, tap) as string;
  if (target.releaseUrl !== releasePageOf(tag, tap)) {
    return `${channel} release page is not the tap's ${tag} release`;
  }
  const downloadProblem = downloadUrlProblem(target.version, target.downloadUrl, tap);
  return downloadProblem ? `${channel} ${downloadProblem}` : null;
}

/**
 * Why a version is not one this channel carries, or null. Stable carries
 * only stable versions; alpha carries an alpha version or the stable one
 * handed to it.
 */
export function channelVersionProblem(channel: UpdateChannel, version: string): string | null {
  if (!publicTagFor(version)) return `${channel} version ${version} is not a channel version`;
  if (channel === "stable" && !isStableVersion(version)) {
    return `${version} is not a stable version; the stable channel carries only X.Y.Z`;
  }
  return null;
}

/**
 * Why a download is not a `.zip` asset of this version's release on the
 * public tap, or null: never the private product repository, another host
 * or another product's or version's release.
 */
export function downloadUrlProblem(
  version: string,
  downloadUrl: string,
  tap: TapNames = TAP,
): string | null {
  const tag = publicTagFor(version, tap);
  if (!tag) return `version ${version} is not a stable or alpha version`;
  const prefix = downloadPrefixOf(tag, tap);
  if (!downloadUrl.startsWith(prefix) || !ZIP_ASSET.test(downloadUrl.slice(prefix.length))) {
    return `download ${downloadUrl} is not a public release asset under ${prefix}`;
  }
  return null;
}

/**
 * Reads a targets payload, or null when anything in it is invalid: the
 * schema, either channel's target, or a stable version handed to alpha that
 * disagrees with stable's own record of the same version. A file that is
 * valid but names no target for a channel is returned as is - that channel
 * has nothing to offer, and nothing is guessed for it.
 */
export function parseUpdateTargets(payload: unknown, tap: TapNames = TAP): UpdateTargets | null {
  const parsed = updateTargetsSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { stable, alpha } = parsed.data.targets;
  if (stable && targetProblem("stable", stable, tap)) return null;
  if (alpha && targetProblem("alpha", alpha, tap)) return null;
  if (
    stable &&
    alpha &&
    stable.version === alpha.version &&
    (stable.downloadUrl !== alpha.downloadUrl ||
      stable.sha256 !== alpha.sha256 ||
      stable.sourceCommit !== alpha.sourceCommit)
  ) {
    return null;
  }
  return parsed.data;
}

/** The tap-release download of a version's asset; the publication's own address for it. */
export function buildDownloadUrl(version: string, assetName: string, tap: TapNames = TAP): string {
  const tag = publicTagFor(version, tap);
  if (!tag) throw new Error(`${version} is not a stable or alpha version`);
  return `${downloadPrefixOf(tag, tap)}${assetName}`;
}
