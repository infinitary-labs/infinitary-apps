import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type UpdateChannel, updateChannelSchema } from "@shared/update";
import { z } from "zod";
import { isAlphaVersion, isStableVersion } from "./semver";

/**
 * The two update channels (docs/alpha.md "Update channels"). One app and
 * one saved-data folder; the installation chooses which updates it is
 * offered. This module owns the closed facts both sides of the channel
 * contract share: the installer-owned subscription marker the app reads,
 * the public tags and cask names of each channel, and the published update
 * targets file with its validation. The cask and target writer that
 * produce these files (`tapPublication.ts`) is built against the same
 * definitions.
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
  return `brew update && brew upgrade --cask ${tap.caskTokens[channel]}`;
}

/** The public tap's release page of a tag. */
function releasePageOf(tag: string, tap: TapNames): string {
  return tap.releasePage ?? `https://github.com/${tap.repo}/releases/tag/${tag}`;
}

/** Where every asset of a tag's public tap release downloads from. */
function downloadPrefixOf(tag: string, tap: TapNames): string {
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
 * install or upgrade; the app only reads it. The data root is the run's own
 * userData, so a development or isolated run never reads the installed
 * app's marker. On Linux the installer is the app itself, which writes the
 * marker after it installs an update, and an Arch or NixOS package carries
 * its own beside the app (docs/alpha.md "Update channels").
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

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
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

// --- The builds, keyed by system and chip -----------------------------------

/**
 * The file on the public tap naming, for each channel, the version it
 * offers and every build of that version, keyed by system, chip and kind
 * (docs/alpha.md "Builds by system and chip"). It is written in the same tap
 * commit as the targets file, after every download was fetched back and
 * verified, so the two never disagree on a channel's version; the targets
 * file stays exactly what installed Macs parse. A Linux installation reads
 * this one.
 */
export const BUILDS_FILE = TAP.buildsFile;
export const BUILDS_URL = buildsUrlOf(TAP);

/** How each Linux build installs (docs/linux-packages.md). */
export const LINUX_PACKAGES = ["deb", "rpm", "appimage", "arch", "nix"] as const;
export type LinuxPackage = (typeof LINUX_PACKAGES)[number];

export function isLinuxPackage(value: string): value is LinuxPackage {
  return (LINUX_PACKAGES as readonly string[]).includes(value);
}

/** The file each kind of build a release publishes is, by its asset name's ending. */
const BUILD_ASSET: Record<string, RegExp> = {
  zip: /\.zip$/,
  dmg: /\.dmg$/,
  deb: /\.deb$/,
  rpm: /\.rpm$/,
  appimage: /\.AppImage$/,
  arch: /\.PKGBUILD$/,
  nix: /\.nix$/,
};

/**
 * Kinds that are the same bytes whichever channel offers them. An Arch
 * recipe or a Nix package names its channel's package, so a stable version
 * handed to alpha carries alpha's own recipe.
 */
const CHANNEL_NEUTRAL = new Set(["zip", "dmg", "deb", "rpm", "appimage"]);

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BUILD_KEY = z.string().regex(/^[a-z0-9]+$/);

export const buildDownloadSchema = z.object({
  /** An asset of this version's release on the public tap. */
  url: z.string(),
  sha256: z.string().regex(SHA256),
});
export type BuildDownload = z.infer<typeof buildDownloadSchema>;

/**
 * One channel's version and its builds. Unknown keys are dropped rather
 * than refused, so a later system, chip or kind - or a later field - adds to
 * the file without an installed app refusing it.
 */
export const channelBuildsSchema = z.object({
  version: z.string(),
  releaseUrl: z.string(),
  sourceCommit: z.string().regex(GIT_COMMIT),
  /** System (`macos`, `linux`), then chip (`arm64`, `x64`), then kind. */
  systems: z.record(BUILD_KEY, z.record(BUILD_KEY, z.record(BUILD_KEY, buildDownloadSchema))),
});
export type ChannelBuilds = z.infer<typeof channelBuildsSchema>;

export const buildsFileSchema = z.object({
  schemaVersion: z.literal(1),
  channels: z.object({
    stable: channelBuildsSchema.optional(),
    alpha: channelBuildsSchema.optional(),
  }),
});
export type BuildsFile = z.infer<typeof buildsFileSchema>;

function eachDownload(
  entry: ChannelBuilds,
): { system: string; chip: string; kind: string; download: BuildDownload }[] {
  return Object.entries(entry.systems).flatMap(([system, chips]) =>
    Object.entries(chips).flatMap(([chip, kinds]) =>
      Object.entries(kinds).map(([kind, download]) => ({ system, chip, kind, download })),
    ),
  );
}

/**
 * Why a channel's builds are not ones the app may offer, or null. The
 * version is one the channel carries, the release page is that version's
 * release on the public tap, and every download is an asset of that
 * release whose name ends as its kind's file does.
 */
export function channelBuildsProblem(
  channel: UpdateChannel,
  entry: ChannelBuilds,
  tap: TapNames = TAP,
): string | null {
  const versionProblem = channelVersionProblem(channel, entry.version);
  if (versionProblem) return versionProblem;
  const tag = publicTagFor(entry.version, tap) as string;
  if (entry.releaseUrl !== releasePageOf(tag, tap)) {
    return `${channel} builds' release page is not the tap's ${tag} release`;
  }
  const prefix = downloadPrefixOf(tag, tap);
  for (const { system, chip, kind, download } of eachDownload(entry)) {
    const name = download.url.startsWith(prefix) ? download.url.slice(prefix.length) : "";
    const ending = BUILD_ASSET[kind];
    if (!ASSET_NAME.test(name) || (ending && !ending.test(name))) {
      return `${channel} ${system} ${chip} ${kind} download ${download.url} is not a ${kind} asset under ${prefix}`;
    }
  }
  return null;
}

/**
 * Reads a builds payload, or null when anything it carries is invalid:
 * the schema, either channel's builds, or a version both channels name
 * whose release, source or channel-neutral bytes disagree. A valid file
 * without a channel, a system or a chip offers that installation nothing.
 */
export function parseBuilds(payload: unknown, tap: TapNames = TAP): BuildsFile | null {
  const parsed = buildsFileSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { stable, alpha } = parsed.data.channels;
  if (stable && channelBuildsProblem("stable", stable, tap)) return null;
  if (alpha && channelBuildsProblem("alpha", alpha, tap)) return null;
  if (stable && alpha && stable.version === alpha.version) {
    if (stable.releaseUrl !== alpha.releaseUrl || stable.sourceCommit !== alpha.sourceCommit) {
      return null;
    }
    for (const [one, other] of [
      [stable, alpha],
      [alpha, stable],
    ] as const) {
      for (const { system, chip, kind, download } of eachDownload(one)) {
        if (!CHANNEL_NEUTRAL.has(kind)) continue;
        const same = other.systems[system]?.[chip]?.[kind];
        if (same?.url !== download.url || same.sha256 !== download.sha256) return null;
      }
    }
  }
  return parsed.data;
}

/** What one installation is offered: its channel's version and its own build of it, if any. */
export type BuildOffer = {
  version: string;
  releaseUrl: string;
  download: BuildDownload | null;
};

/**
 * The channel's offer for a system, chip and kind, or null when the file
 * names nothing for the channel. A channel whose version has no build for
 * this installation still names its version and release page.
 */
export function buildOfferFor(
  builds: BuildsFile,
  channel: UpdateChannel,
  where: { system: string; chip: string; kind: string },
): BuildOffer | null {
  const entry = builds.channels[channel];
  if (!entry) return null;
  return {
    version: entry.version,
    releaseUrl: entry.releaseUrl,
    download: entry.systems[where.system]?.[where.chip]?.[where.kind] ?? null,
  };
}

/** The tap-release download of a version's asset; the publication's own address for it. */
export function buildDownloadUrl(version: string, assetName: string, tap: TapNames = TAP): string {
  const tag = publicTagFor(version, tap);
  if (!tag) throw new Error(`${version} is not a stable or alpha version`);
  return `${downloadPrefixOf(tag, tap)}${assetName}`;
}
