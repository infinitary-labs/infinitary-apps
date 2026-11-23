import type { UpdateChannel } from "@shared/updateChannel";
import { z } from "zod";
import {
  buildsUrlOf,
  channelVersionProblem,
  downloadPrefixOf,
  GIT_COMMIT,
  publicTagFor,
  releasePageOf,
  SHA256,
  TAP,
  type TapNames,
} from "./updateChannels";

/**
 * The builds a release publishes, keyed by system and chip, as Linux and
 * Windows installations read them. Installed Macs never read this file:
 * they read the update targets and the Mac feed (`updateChannels.ts`,
 * `releaseFeeds.ts`), so it stays off the signed installer check's list
 * (scripts/desktop-build.ts, SIGNED_INSTALLER_FILES).
 */

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

/** The Windows installer's kind under `windows`, then its chip (docs/alpha.md "Updates on Windows"). */
export const WINDOWS_INSTALLER = "exe";

/** How each Linux build installs (docs/linux-packages.md). */
export const LINUX_PACKAGES = ["deb", "rpm", "appimage", "arch", "nix"] as const;
export type LinuxPackage = (typeof LINUX_PACKAGES)[number];

export function isLinuxPackage(value: string): value is LinuxPackage {
  return (LINUX_PACKAGES as readonly string[]).includes(value);
}

const BUILD_ASSET: Record<string, RegExp> = {
  zip: /\.zip$/,
  dmg: /\.dmg$/,
  deb: /\.deb$/,
  rpm: /\.rpm$/,
  appimage: /\.AppImage$/,
  arch: /\.PKGBUILD$/,
  nix: /\.nix$/,
  exe: /\.exe$/,
};

/**
 * Kinds that are the same bytes whichever channel offers them. An Arch
 * recipe or a Nix package names its channel's package, so a stable version
 * handed to alpha carries alpha's own recipe.
 */
const CHANNEL_NEUTRAL = new Set(["zip", "dmg", "deb", "rpm", "appimage", "exe"]);

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
  /** System (`macos`, `linux`, `windows`), then chip (`arm64`, `x64`), then kind. */
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
    // i18n-exempt: a reason parseBuilds weighs, never shown to a person
    return `${channel} builds' release page is not the tap's ${tag} release`;
  }
  const prefix = downloadPrefixOf(tag, tap);
  for (const { system, chip, kind, download } of eachDownload(entry)) {
    const name = download.url.startsWith(prefix) ? download.url.slice(prefix.length) : "";
    const ending = BUILD_ASSET[kind];
    if (!ASSET_NAME.test(name) || (ending && !ending.test(name))) {
      // i18n-exempt: a reason parseBuilds weighs, never shown to a person
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
