import { APP_IDENTITIES, OWN_IDENTITY } from "@shared/codeNames";
import { compareSemver, isAlphaVersion, isStableVersion } from "@shared/semver";
import type { UpdateChannel } from "@shared/updateChannel";
import { RELEASE_USER_DATA_FOLDER } from "@shared/userDataFolders";
import {
  homebrewInstallationReceipt,
  MAC_INSTALLATION_ATTRIBUTE,
  MAC_INSTALLATION_RESOURCE,
} from "./macInstallation";
import { BUILDS_FILE, type BuildsFile, type ChannelBuilds, parseBuilds } from "./releaseBuilds";
import {
  buildDownloadUrl,
  buildUpdateTarget,
  channelVersionProblem,
  downloadUrlProblem,
  FIRSTMATE_TAP,
  INFINITARY_TAP,
  parseUpdateTargets,
  TAP,
  type TapNames,
  targetProblem,
  UPDATE_CHANNEL_MARKER,
  UPDATE_TARGETS_FILE,
  type UpdateChannelMarker,
  type UpdateTarget,
  type UpdateTargets,
} from "./updateChannels";

/**
 * What the public tap carries for each channel (docs/alpha.md "Casks and
 * update targets"): the two casks and the update targets file. Both are
 * produced here from the closed facts in `updateChannels.ts`, so a cask and
 * the update notice that names its version never disagree. Pure: the
 * release workflow reads the tap, asks for the next files, and writes them
 * in one tap commit after the download was fetched back and verified.
 */

export { BUILDS_FILE, FIRSTMATE_TAP, INFINITARY_TAP, TAP, UPDATE_TARGETS_FILE };

/** The bundle the casks install, quit before replacing, and zap. */
export const BUNDLE_ID = APP_IDENTITIES[OWN_IDENTITY].bundleId;

/** The app the casks install, by its file name. */
export const APP_BUNDLE = `${APP_IDENTITIES[OWN_IDENTITY].app.release}.app`;

/**
 * Infinitary's website, every cask's homepage on both taps - and every Linux
 * package's (`docs/linux-packages.md`), whose templates the release contract
 * holds to this - never a repository: the captain's site address
 * (FI3-1780's question 4, INF-12). Homebrew's style wants the slash.
 */
export const HOMEPAGE = "https://getinfinitary.com/";

/** What a channel's cask calls the app it installs. */
const CASK_NAMES: Record<UpdateChannel, string> = {
  stable: APP_IDENTITIES[OWN_IDENTITY].app.release,
  alpha: `${APP_IDENTITIES[OWN_IDENTITY].app.release} Alpha`,
};

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;

/** A cask or publication the tap must never carry; the message says why. */
export class TapPublicationRefusal extends Error {
  override name = "TapPublicationRefusal";
}

// --- The casks ---------------------------------------------------------------

/** What one channel's cask installs: a version's public download and its checksum. */
export type CaskArtifact = { version: string; sha256: string; downloadUrl: string };

/** The tap path of a channel's cask. */
export function caskPathFor(channel: UpdateChannel, tap: TapNames = TAP): string {
  return `Casks/${tap.caskTokens[channel]}.rb`;
}

/** Why a cask for this channel must not carry this artifact, or null when it may. */
export function caskArtifactProblem(
  channel: UpdateChannel,
  artifact: CaskArtifact,
  tap: TapNames = TAP,
): string | null {
  return (
    channelVersionProblem(channel, artifact.version) ??
    (SHA256.test(artifact.sha256)
      ? null
      : `sha256 ${artifact.sha256} is not 64 lowercase hex digits`) ??
    downloadUrlProblem(artifact.version, artifact.downloadUrl, tap)
  );
}

/**
 * The marker file the cask's install step writes, relative to the home
 * folder: the release data root, never inside the signed app. Homebrew runs
 * cask install steps in a sandbox whose `~` is a throwaway folder, so the
 * step names the real home through its `home` base instead.
 */
export const MARKER_HOME_PATH = `Library/Application Support/${RELEASE_USER_DATA_FOLDER}/${UPDATE_CHANNEL_MARKER}`;

/**
 * The marker's exact bytes for a channel. A cask of Firstmate 3000's tap
 * says the installation came through the old cask (`TapNames.throughOldCask`).
 */
export function markerContent(channel: UpdateChannel, tap: TapNames = TAP): string {
  const marker: UpdateChannelMarker = {
    schemaVersion: 1,
    channel,
    ...(tap.throughOldCask ? { cameThroughOldCask: true } : {}),
  };
  return `${JSON.stringify(marker)}\n`;
}

/**
 * The channel paragraph each cask's caveats add after the alpha notice: which
 * channel this is and how to switch without losing saved work. The tap
 * carries a stable cask only once it names a stable target (`stableTarget`);
 * until then the alpha paragraph names no stable cask to switch to - on
 * Infinitary's own tap, from its first alpha to its first stable.
 */
export function channelCaveats(
  channel: UpdateChannel,
  tap: TapNames = TAP,
  stableTarget = true,
): string[] {
  const { stable, alpha } = tap.caskTokens;
  if (channel === "alpha" && !stableTarget) {
    return [
      "This is the alpha channel: new versions sooner, with lighter checks,",
      "and every newer stable version too. There is no stable channel to",
      "switch to yet.",
      "",
      "Never add --zap when uninstalling: it deletes your saved work.",
    ];
  }
  return channel === "stable"
    ? [
        "This is the stable channel. To get new versions sooner, with lighter",
        "checks, switch to the alpha channel; your saved work stays in place:",
        "",
        `  brew uninstall --cask ${stable}`,
        `  brew install --cask ${tap.tap}/${alpha}`,
        "",
        "Never add --zap when switching: it deletes your saved work.",
      ]
    : [
        "This is the alpha channel: new versions sooner, with lighter checks,",
        "and every newer stable version too. To return to the stable channel,",
        "keeping your saved work in place:",
        "",
        `  brew uninstall --cask ${alpha}`,
        `  brew install --cask ${tap.tap}/${stable}`,
        "",
        "If that stable version cannot open work saved by a newer alpha, it says",
        "so and changes nothing; reinstall the alpha or wait for the next stable.",
        "Never add --zap when switching: it deletes your saved work.",
      ];
}

/** Each channel's paragraph on this build's own tap, once it names a stable target. */
export const CHANNEL_CAVEATS: Record<UpdateChannel, string[]> = {
  stable: channelCaveats("stable"),
  alpha: channelCaveats("alpha"),
};

/** Greedy word wrap at `width` columns, as `fold -s` reads a paragraph. */
function fold(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A double-quoted Ruby literal. Every value the casks interpolate is a
 * closed fact or already validated, but a `#` (Ruby interpolation) or a
 * backslash in a literal or in the caveats heredoc would change what
 * Homebrew reads, so both are refused rather than escaped.
 */
function rubyString(value: string): string {
  if (/[#\\]/.test(value)) {
    throw new TapPublicationRefusal(`cask text may not contain # or \\: ${value}`);
  }
  return JSON.stringify(value);
}

function heredocLine(line: string): string {
  if (/[#\\]/.test(line))
    throw new TapPublicationRefusal(`caveats may not contain # or \\: ${line}`);
  return line ? `    ${line}` : "";
}

/**
 * One channel's cask. Both casks install the same `Infinitary.app` and
 * conflict with each other; Homebrew quits the running app before it
 * replaces or removes it; and after every install or upgrade the declared
 * install step (or legacy postflight on older Homebrew) writes this channel's
 * marker into the release data root, overwriting the other channel's - a stable install switches an
 * alpha installation to stable even when both casks carry the same
 * artifact, and an alpha cask carrying a stable version still writes alpha.
 * The caveats are the alpha notice, then the channel paragraph, which names
 * the stable cask only when the tap names a stable target (`stableTarget`).
 *
 * On Firstmate 3000's tap (`FIRSTMATE_TAP`) the same cask, under its old
 * token, installs Infinitary for the people who installed Firstmate 3000:
 * Homebrew quits and removes the older app by the bundle its installed cask
 * names, and the marker says the installation came through the old cask.
 */
export function renderCask(
  channel: UpdateChannel,
  artifact: CaskArtifact,
  notice: string,
  tap: TapNames = TAP,
  stableTarget = true,
): string {
  const token = tap.caskTokens[channel];
  const problem = caskArtifactProblem(channel, artifact, tap);
  if (problem) throw new TapPublicationRefusal(`${token} cask: ${problem}`);
  // Homebrew's audit wants the version interpolated into the URL; the tag
  // always carries it, and the template reads back as the exact download.
  const urlTemplate = artifact.downloadUrl.split(artifact.version).join("#{version}");
  const other: UpdateChannel = channel === "stable" ? "alpha" : "stable";
  const caveats = [...fold(notice, 76), "", ...channelCaveats(channel, tap, stableTarget)];
  const marker = markerContent(channel, tap);
  return [
    `cask ${rubyString(token)} do`,
    `  version ${rubyString(artifact.version)}`,
    `  sha256 ${rubyString(artifact.sha256)}`,
    "",
    `  url "${urlTemplate}"`,
    `  name ${rubyString(CASK_NAMES[channel])}`,
    `  desc "Calm desktop first mate that runs AI crew on your own subscriptions"`,
    `  homepage ${rubyString(HOMEPAGE)}`,
    "",
    `  conflicts_with cask: ${rubyString(tap.caskTokens[other])}`,
    "  depends_on macos: :ventura",
    "",
    `  app ${rubyString(APP_BUNDLE)}`,
    "",
    "  if defined?(Homebrew::InstallSteps::DSL) && Homebrew::InstallSteps::DSL.method_defined?(:write_file)",
    "    postflight_steps do",
    `      write_file ${rubyString(MARKER_HOME_PATH)},`,
    `                 ${rubyString(marker)},`,
    "                 base: :home",
    "    end",
    "    preflight_steps do",
    // Stamp ownership before moving the app into Applications, so a failed stamp cannot leave
    // a Homebrew installation that looks direct. Only a custom attribute changes, not file bytes.
    `      ownership = { args: ["-w", ${rubyString(MAC_INSTALLATION_ATTRIBUTE)},`,
    `                           ${rubyString(homebrewInstallationReceipt(channel, tap))},`,
    `                           ${rubyString(`{{staged_path}}/${APP_BUNDLE}/${MAC_INSTALLATION_RESOURCE}`)}] }`,
    "      if Homebrew::InstallSteps::DSL.instance_method(:run).parameters.include?([:key, :writable_paths])",
    `        ownership[:writable_paths] = [${rubyString(`${APP_BUNDLE}/${MAC_INSTALLATION_RESOURCE}`)}]`,
    "        ownership[:writable_base] = :staged_path",
    "      end",
    '      run "/usr/bin/xattr", **ownership',
    "    end",
    "  else",
    "    postflight do",
    `      marker = File.expand_path(${rubyString(`~/${MARKER_HOME_PATH}`)})`,
    "      FileUtils.mkdir_p File.dirname(marker)",
    `      File.write marker, ${rubyString(marker)}`,
    "    end",
    "    preflight do",
    `      system_command "/usr/bin/xattr", args:         ["-w", ${rubyString(MAC_INSTALLATION_ATTRIBUTE)},`,
    `                                                      ${rubyString(homebrewInstallationReceipt(channel, tap))},`,
    `                                                      staged_path.join(${rubyString(`${APP_BUNDLE}/${MAC_INSTALLATION_RESOURCE}`)})],`,
    "                                       must_succeed: true",
    "    end",
    "  end",
    "",
    `  uninstall quit: ${rubyString(BUNDLE_ID)}`,
    "",
    "  zap trash: [",
    `    "~/Library/Application Support/${RELEASE_USER_DATA_FOLDER}",`,
    `    "~/Library/Caches/${BUNDLE_ID}",`,
    `    "~/Library/Preferences/${BUNDLE_ID}.plist",`,
    `    "~/Library/Saved Application State/${BUNDLE_ID}.savedState",`,
    "  ]",
    "",
    "  caveats <<~EOS",
    ...caveats.map(heredocLine),
    "  EOS",
    "end",
    "",
  ].join("\n");
}

// --- The update targets ------------------------------------------------------

/** One file a publication carries on its tap release: its asset name and checksum. */
export type PublishedFile = { asset: string; sha256: string };

/**
 * A publication's Linux builds for one channel, chip first, then kind
 * (`deb`, `rpm`, `appimage`, `arch`, `nix`): `scripts/linux-recipes.ts
 * release` writes them as a manifest. A stable publication carries alpha's
 * too, with alpha's own Arch recipe and Nix package, for when the stable
 * version is handed to alpha.
 */
export type LinuxBuilds = Record<string, Record<string, PublishedFile>>;

/**
 * One signed artifact a release workflow is publishing on its channel: an
 * alpha publication carries an alpha version, a stable one a stable version.
 */
export type Publication = {
  channel: UpdateChannel;
  version: string;
  /** The zip's file name on the tap release. */
  assetName: string;
  sha256: string;
  /** The product source commit the artifact was built from. */
  sourceCommit: string;
  /**
   * The Linux builds published beside the zip, for each channel the
   * publication may move. With them the tap commit writes the builds file
   * too (docs/alpha.md "Builds by system and chip").
   */
  linux?: Partial<Record<UpdateChannel, LinuxBuilds>>;
};

export type TargetsAdvance = {
  targets: UpdateTargets;
  /** The channels whose target moved, in stable-then-alpha order. */
  changed: UpdateChannel[];
  /** One plain line per channel saying what happened to it. */
  notes: string[];
};

function sameTarget(a: UpdateTarget, b: UpdateTarget): boolean {
  return (
    a.version === b.version &&
    a.releaseUrl === b.releaseUrl &&
    a.downloadUrl === b.downloadUrl &&
    a.sha256 === b.sha256 &&
    a.sourceCommit === b.sourceCommit
  );
}

function refuse(message: string): never {
  throw new TapPublicationRefusal(message);
}

/** The publication's target record, or a refusal saying why it is not one. */
export function publicationTarget(publication: Publication, tap: TapNames = TAP): UpdateTarget {
  const { channel, version } = publication;
  if (channel === "alpha" && !isAlphaVersion(version)) {
    refuse(
      `an alpha publication carries an alpha version X.Y.Z-alpha.N, not ${version}; stable reaches alpha only through a stable publication`,
    );
  }
  if (channel === "stable" && !isStableVersion(version)) {
    refuse(`a stable publication carries a stable version X.Y.Z, not ${version}`);
  }
  if (!SHA256.test(publication.sha256)) {
    refuse(`sha256 ${publication.sha256} is not 64 lowercase hex digits`);
  }
  if (!GIT_COMMIT.test(publication.sourceCommit)) {
    refuse(`source commit ${publication.sourceCommit} is not a full lowercase git commit`);
  }
  const target = buildUpdateTarget(publication, tap);
  const problem = targetProblem(channel, target, tap);
  if (problem) refuse(problem);
  return target;
}

/**
 * Where one channel's target goes when a publication offers `next`: forward
 * to a newer version, nowhere for an identical retry, and never backwards or
 * over a different artifact of the same version - published bytes never
 * change. Returns whether the target moved.
 */
function placeTarget(
  channel: UpdateChannel,
  current: UpdateTarget | undefined,
  next: UpdateTarget,
): boolean {
  if (!current) return true;
  const order = compareSemver(next.version, current.version) ?? refuse("unreadable version");
  if (order > 0) return true;
  if (order < 0) {
    refuse(
      `${channel} already carries ${current.version}, newer than ${next.version}; a channel's target never moves backwards`,
    );
  }
  if (!sameTarget(current, next)) {
    refuse(
      `${channel} already carries ${current.version} with a different artifact or source; a published version's bytes never change`,
    );
  }
  return false;
}

/**
 * The version a cask the tap already carries installs, read off its
 * `version` stanza, or null when there is none. Before the first
 * publication through the channel workflow, the stable cask the old
 * workflow wrote is the only record of what stable installs.
 */
export function caskVersion(cask: string): string | null {
  return /^ {2}version "([^"]+)"$/m.exec(cask)?.[1] ?? null;
}

export type AdvanceOptions = {
  /**
   * The version the tap's stable cask carries when the tap has no targets
   * file yet (the transition from the single-cask workflow). It stands in
   * for stable's target: no publication may move behind it.
   */
  legacyStableVersion?: string;
  /** The tap the publication writes to; this build's own unless given. */
  tap?: TapNames;
};

/**
 * The next update targets after one publication, refusing anything that
 * would move a channel backwards or rewrite a published version
 * (docs/alpha.md "Casks and update targets"):
 *
 * - An alpha publication moves only alpha, and only forwards past both
 *   alpha's target and the stable version.
 * - A stable publication moves stable forwards, and hands the same artifact
 *   to alpha when it is newer than alpha's target; a newer alpha stays.
 * - Publishing the identical artifact again changes nothing, so a retry is
 *   safe; the same version with other bytes or another source is refused.
 *
 * `current` is the tap's parsed targets file, or undefined when the tap has
 * none yet; then `legacyStableVersion`, the stable cask's version, is the
 * floor. An invalid current file is refused, never overwritten.
 */
export function advanceUpdateTargets(
  current: unknown | undefined,
  publication: Publication,
  options: AdvanceOptions = {},
): TargetsAdvance {
  const tap = options.tap ?? TAP;
  const target = publicationTarget(publication, tap);
  const legacy = current === undefined ? options.legacyStableVersion : undefined;
  if (legacy && (compareSemver(target.version, legacy) ?? -1) < 0) {
    refuse(
      `the tap's stable cask already carries ${legacy}, newer than ${target.version}; a channel's target never moves backwards`,
    );
  }
  const existing: UpdateTargets =
    current === undefined
      ? { schemaVersion: 1 as const, targets: {} }
      : (parseUpdateTargets(current, tap) ??
        refuse(`the tap's ${tap.targetsFile} is invalid; a publication never overwrites it`));
  let { stable, alpha } = existing.targets;
  const changed: UpdateChannel[] = [];
  const notes: string[] = [];

  if (publication.channel === "stable") {
    if (placeTarget("stable", stable, target)) {
      stable = target;
      changed.push("stable");
      notes.push(`stable moves to ${target.version}`);
    } else {
      notes.push(`stable already carries ${target.version}`);
    }
    const order = alpha ? (compareSemver(target.version, alpha.version) ?? 0) : 1;
    if (alpha && order < 0) {
      notes.push(`alpha keeps ${alpha.version}, newer than stable ${target.version}`);
    } else if (placeTarget("alpha", alpha, target)) {
      alpha = target;
      changed.push("alpha");
      notes.push(`alpha moves to stable ${target.version}`);
    } else {
      notes.push(`alpha already carries ${target.version}`);
    }
  } else {
    if (stable && (compareSemver(target.version, stable.version) ?? 0) < 0) {
      refuse(
        `stable ${stable.version} is newer than alpha ${target.version}; alpha already carries or has passed it`,
      );
    }
    if (placeTarget("alpha", alpha, target)) {
      alpha = target;
      changed.push("alpha");
      notes.push(`alpha moves to ${target.version}`);
    } else {
      notes.push(`alpha already carries ${target.version}`);
    }
    notes.push(stable ? `stable stays at ${stable.version}` : "stable has no target yet");
  }

  const targets: UpdateTargets = {
    schemaVersion: 1,
    targets: { ...(stable && { stable }), ...(alpha && { alpha }) },
  };
  // The reader's own validation is the last word on what the writer produced.
  if (!parseUpdateTargets(targets, tap)) refuse("the next update targets do not validate");
  return { targets, changed, notes };
}

/** The targets file's exact bytes. */
export function formatUpdateTargets(targets: UpdateTargets): string {
  return `${JSON.stringify(targets, null, 2)}\n`;
}

export type TapFiles = TargetsAdvance & {
  /** Tap-relative path to the new content: empty when nothing moved. */
  files: Record<string, string>;
};

export type TapFilesOptions = AdvanceOptions & {
  /** The tap's current builds file, parsed as stored; undefined when it has none. */
  currentBuilds?: unknown;
};

/**
 * One channel's builds for a publication that moved it to `target`: the
 * universal zip for both Mac chips, and the publication's Linux builds for
 * that channel, each at its asset on the version's tap release.
 */
function channelBuildsFor(
  target: UpdateTarget,
  publication: Publication,
  linux: LinuxBuilds,
  tap: TapNames,
): ChannelBuilds {
  const zip = { url: target.downloadUrl, sha256: target.sha256 };
  const linuxSystem: ChannelBuilds["systems"][string] = {};
  for (const [chip, kinds] of Object.entries(linux)) {
    linuxSystem[chip] = {};
    for (const [kind, file] of Object.entries(kinds)) {
      if (!SHA256.test(file.sha256))
        refuse(`linux ${chip} ${kind} sha256 is not 64 lowercase hex digits`);
      linuxSystem[chip][kind] = {
        url: buildDownloadUrl(target.version, file.asset, tap),
        sha256: file.sha256,
      };
    }
  }
  return {
    version: target.version,
    releaseUrl: target.releaseUrl,
    sourceCommit: publication.sourceCommit,
    systems: { macos: { arm64: { zip }, x64: { zip } }, linux: linuxSystem },
  };
}

/**
 * The next builds file after one publication, or null when it writes none
 * (docs/alpha.md "Builds by system and chip"). It moves in step with the
 * targets file: each channel the targets moved takes this publication's
 * builds for that channel, and a channel's version always matches its
 * target. A publication without Linux builds onto a tap that carries the
 * file is refused, so the two can never drift apart; an invalid current
 * file is refused, never overwritten.
 */
export function advanceBuilds(
  current: unknown | undefined,
  advance: TargetsAdvance,
  publication: Publication,
  tap: TapNames = TAP,
): BuildsFile | null {
  const buildsFile = tap.buildsFile;
  if (!publication.linux) {
    if (current !== undefined && advance.changed.length > 0) {
      refuse(
        `the tap carries ${buildsFile}; a publication that moves a channel carries its Linux builds`,
      );
    }
    return null;
  }
  const existing: BuildsFile =
    current === undefined
      ? { schemaVersion: 1, channels: {} }
      : (parseBuilds(current, tap) ??
        refuse(`the tap's ${buildsFile} is invalid; a publication never overwrites it`));
  const channels = { ...existing.channels };
  for (const channel of advance.changed) {
    const linux =
      publication.linux[channel] ??
      refuse(`the publication moves ${channel} but carries no Linux builds for it`);
    channels[channel] = channelBuildsFor(
      advance.targets.targets[channel] as UpdateTarget,
      publication,
      linux,
      tap,
    );
  }
  for (const channel of ["stable", "alpha"] as const) {
    const builds = channels[channel];
    const target = advance.targets.targets[channel];
    if (builds && builds.version !== target?.version) {
      refuse(
        `${buildsFile} would name ${channel} ${builds.version}, not its target ${target?.version ?? "(none)"}`,
      );
    }
  }
  const next: BuildsFile = {
    schemaVersion: 1,
    channels: {
      ...(channels.stable && { stable: channels.stable }),
      ...(channels.alpha && { alpha: channels.alpha }),
    },
  };
  // The reader's own validation is the last word on what the writer produced.
  if (!parseBuilds(next, tap)) refuse(`the next ${buildsFile} does not validate`);
  return next;
}

/**
 * Every tap file one publication writes, for one tap commit: the targets
 * file and the cask of each channel whose target moved, carrying exactly
 * that target, and - for a publication with Linux builds - the builds file.
 * A channel that did not move keeps its cask untouched, except that
 * stable's first target writes the alpha cask again at alpha's own target,
 * because its caveats name the stable cask only from then on.
 */
export function tapFilesFor(
  current: unknown | undefined,
  publication: Publication,
  notice: string,
  options: TapFilesOptions = {},
): TapFiles {
  const tap = options.tap ?? TAP;
  const advance = advanceUpdateTargets(current, publication, options);
  const builds = advanceBuilds(options.currentBuilds, advance, publication, tap);
  const stableTarget = advance.targets.targets.stable !== undefined;
  const files: Record<string, string> = {};
  for (const channel of advance.changed) {
    const target = advance.targets.targets[channel] as UpdateTarget;
    files[caskPathFor(channel, tap)] = renderCask(channel, target, notice, tap, stableTarget);
  }
  // advanceUpdateTargets refused a current file that does not parse, and a
  // stable publication always leaves alpha a target.
  const hadStable =
    current !== undefined && parseUpdateTargets(current, tap)?.targets.stable !== undefined;
  const notes = [...advance.notes];
  if (publication.channel === "stable" && !hadStable && !advance.changed.includes("alpha")) {
    const alpha = advance.targets.targets.alpha as UpdateTarget;
    files[caskPathFor("alpha", tap)] = renderCask("alpha", alpha, notice, tap, stableTarget);
    notes.push(`alpha cask rewritten at ${alpha.version} so its caveats name the stable cask`);
  }
  if (advance.changed.length > 0) {
    files[tap.targetsFile] = formatUpdateTargets(advance.targets);
    if (builds) files[tap.buildsFile] = `${JSON.stringify(builds, null, 2)}\n`;
  }
  return { ...advance, notes, files };
}

// --- Republishing the casks --------------------------------------------------

/**
 * What a cask on the tap installs, read off its stanzas: its version, its
 * checksum and the download its url names once the version is filled in;
 * null when a stanza is missing.
 */
export function caskArtifact(cask: string): CaskArtifact | null {
  const version = caskVersion(cask);
  const sha256 = /^ {2}sha256 "([^"]+)"$/m.exec(cask)?.[1];
  const url = /^ {2}url "([^"]+)"$/m.exec(cask)?.[1];
  if (!version || !sha256 || !url) return null;
  return { version, sha256, downloadUrl: url.split("#{version}").join(version) };
}

export type Republication = {
  /** The channels whose cask this generator now writes differently. */
  changed: UpdateChannel[];
  /** One plain line per channel saying what happened to its cask. */
  notes: string[];
  /** Tap-relative path to the new content: only casks, never the targets file. */
  files: Record<string, string>;
};

/**
 * The casks this generator writes for the targets the tap already carries
 * (docs/alpha.md "Republishing the casks"). After a change to how a cask is
 * written - support for an older Homebrew, a new notice - each channel's
 * cask is rendered again at exactly its current target, its caveats naming
 * the stable cask only when the tap names a stable target. Nothing moves: the
 * targets file is never written, and a cask that installs anything but its
 * channel's target is refused rather than replaced, because republishing
 * never changes which bytes a person installs. A cask that is already
 * current writes nothing, so a repeated run is safe.
 *
 * `current` is the tap's parsed targets file, or undefined when it has none;
 * `casks` is each channel's cask as the tap carries it now.
 */
export function republishCasks(
  current: unknown | undefined,
  casks: Partial<Record<UpdateChannel, string>>,
  notice: string,
  tap: TapNames = TAP,
): Republication {
  if (current === undefined) {
    refuse(`the tap has no ${tap.targetsFile}; only a publication writes the first one`);
  }
  const targets =
    parseUpdateTargets(current, tap) ??
    refuse(`the tap's ${tap.targetsFile} is invalid; republishing never overwrites it`);
  const changed: UpdateChannel[] = [];
  const notes: string[] = [];
  const files: Record<string, string> = {};
  for (const channel of ["stable", "alpha"] as const) {
    const target = targets.targets[channel];
    const cask = casks[channel];
    const token = tap.caskTokens[channel];
    if (!target) {
      if (cask !== undefined) {
        refuse(`the tap carries the ${token} cask but names no ${channel} target`);
      }
      notes.push(`${channel} has no target and no cask`);
      continue;
    }
    if (cask === undefined) {
      refuse(`the tap names a ${channel} target but carries no ${token} cask`);
    }
    const installs = caskArtifact(cask);
    if (
      installs?.version !== target.version ||
      installs.sha256 !== target.sha256 ||
      installs.downloadUrl !== target.downloadUrl
    ) {
      refuse(
        `the ${token} cask installs ${installs ? `${installs.version} from ${installs.downloadUrl} (${installs.sha256})` : "something unreadable"}, not ${channel}'s target ${target.version}; republishing never changes what a cask installs`,
      );
    }
    const next = renderCask(channel, target, notice, tap, targets.targets.stable !== undefined);
    if (next === cask) {
      notes.push(`${channel} cask is already current at ${target.version}`);
      continue;
    }
    files[caskPathFor(channel, tap)] = next;
    changed.push(channel);
    notes.push(`${channel} cask republished at ${target.version}`);
  }
  return { changed, notes, files };
}

// --- Activating the alpha channel --------------------------------------------

/**
 * The last stable published before the saved-data guard and the
 * channel-aware update reader (docs/saved-data-compatibility.md, docs/alpha.md
 * "Update channels"). Every stable after it is cut from a main line that
 * carries both, so the first of them is the minimum protected stable.
 */
export const LAST_UNPROTECTED_STABLE = "0.1.24";

/**
 * Why a live alpha may not publish onto this tap yet, or null when it may
 * (docs/alpha.md "Activating the channels"). A build older than the guard
 * cannot refuse work a newer alpha saved, and nothing can give it that
 * protection afterwards, so the first live alpha waits until a protected
 * stable - newer than `LAST_UNPROTECTED_STABLE`, published through the
 * channel workflow and verified - is stable's target: someone who leaves
 * the alpha channel always has a stable to return to that refuses work it
 * cannot open. A rehearsal reports this and carries on.
 *
 * Infinitary's own tap starts with no targets file, after Firstmate 3000's
 * stables on the older tap (the Infinitary rename). `archivedStable`, the
 * newest stable the record of past releases names
 * (`release-notes/archive.json`), stands in for its stable there: every
 * stable the tap will carry numbers above it, so when it is a protected
 * stable a live alpha may publish before Infinitary's first stable. Until
 * then the alpha cask names no stable channel to switch to (`channelCaveats`).
 */
export function alphaActivationProblem(
  current: unknown | undefined,
  options: { tap?: TapNames; archivedStable?: string } = {},
): string | null {
  const tap = options.tap ?? TAP;
  const file = tap.targetsFile;
  const bootstrap = `a protected stable (newer than ${LAST_UNPROTECTED_STABLE}) has to be published first`;
  const protectedStable = (version: string) =>
    (compareSemver(version, LAST_UNPROTECTED_STABLE) ?? 0) > 0;
  if (current === undefined) {
    if (options.archivedStable && protectedStable(options.archivedStable)) return null;
    return `the tap has no ${file} yet; ${bootstrap}`;
  }
  const targets = parseUpdateTargets(current, tap);
  if (!targets) return `the tap's ${file} is invalid`;
  const stable = targets.targets.stable;
  if (!stable) {
    if (options.archivedStable && protectedStable(options.archivedStable)) return null;
    return `the tap's ${file} names no stable target; ${bootstrap}`;
  }
  if (!protectedStable(stable.version)) {
    return `stable's target ${stable.version} predates the saved-data guard; ${bootstrap}`;
  }
  return null;
}
