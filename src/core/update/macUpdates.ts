import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppFollowResult } from "@shared/appFollow";
import { isAlphaVersion, isNewerVersion, isStableVersion } from "@shared/semver";
import type { UpdateChannel, UpdateInstallResult, UpdateStatus } from "@shared/update";
import { UPDATE_LATER, UPDATE_NOTICES, UPDATE_PROBLEMS } from "@shared/updateWords";
import type { ActiveMark, ActiveMarks } from "./activeMark";
import type { MacInstallation } from "./macInstallation";
import { readUpdateMarker, resolveUpdateChannel, UPDATE_CHANNEL_MARKER } from "./updateChannels";
import type { UpdateChecker } from "./updateChecker";
import { createUpdateSaving, type UpdateSaving } from "./updateWork";

/** Native effects live in main; channel, version and consent policy live here (INF-640). */
export type MacUpdateOffer = { version: string; releaseUrl: string };
/** A bounded explanation authored by the host, never a remote error's raw text. */
export class MacUpdateProblem extends Error {}
/** Native staging succeeded; a new channel must not replace this consented update on quit. */
export class MacUpdateReadyProblem extends MacUpdateProblem {}
export type MacUpdateDriver = {
  installation: MacInstallation;
  /**
   * Reads the channel's feed. A `mark` rides that read alone, never a
   * download, and the driver calls its `answered` once the feed was read
   * (`src/core/update/activeMark.ts`).
   */
  check: (channel: UpdateChannel, mark?: ActiveMark) => Promise<MacUpdateOffer | null>;
  /**
   * Reads one exact version's own published manifest, whatever channel
   * offers it (docs/view.md, "Following the home's version"): its offer
   * while it is newer than this copy, null when it is not published.
   */
  checkVersion?: (version: string) => Promise<MacUpdateOffer | null>;
  download: (
    offer: MacUpdateOffer,
    progress: (percent: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * After consent, download and the crew's saved work; owns native
   * signature verification and graceful shutdown. `stillWanted` is asked
   * before native staging starts and again once staged, before shutdown;
   * false keeps the copy running and nothing quits. The install answers
   * `unstaged` when it was asked before staging, and `staged` once staged:
   * Squirrel applies a staged update at the next start, a later install of
   * that version quits with no staging, and one of another version stages
   * it in its place. A release that quits never answers.
   */
  install: (stillWanted?: () => boolean) => Promise<void | MacInstallKept>;
};

/** Where an install that kept the copy running rests: nothing staged, or staged for the next start. */
export type MacInstallKept = "unstaged" | "staged";

/** What an install or a followed version answers while another is under way. */
const ALREADY_INSTALLING = "The update is already installing.";
/** What an install or a followed version answers once a channel change let it go. */
const CHANNEL_CHANGED = "The channel changed, so the previous update was cancelled.";
/** What an install or a followed version answers when it failed for a reason the host did not write. */
const NOT_INSTALLED =
  "The update could not be installed. Try again, or download the disk image from the releases page.";

export function saveMacUpdateChannel(dataRoot: string, channel: UpdateChannel): void {
  mkdirSync(dataRoot, { recursive: true });
  const path = join(dataRoot, UPDATE_CHANNEL_MARKER);
  const temporary = `${path}.tmp`;
  // Only a direct copy reaches this writer; Homebrew keeps its own channel and tap.
  writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, channel }), { mode: 0o600 });
  renameSync(temporary, path);
}

export function createMacUpdateChecker(options: {
  currentVersion: string;
  dataRoot: string;
  driver: MacUpdateDriver;
  releasesUrl: string;
  openExternal: (url: string) => void | Promise<void>;
  now?: () => number;
  /** Saves the crew's work before the copy is replaced (`createUpdateSaving`). */
  saving?: UpdateSaving;
  /** The daily and monthly mark an installed copy's feed read carries; absent, none. */
  activeMarks?: ActiveMarks;
}): UpdateChecker {
  const now = options.now ?? Date.now;
  const saving = options.saving ?? createUpdateSaving(undefined);
  // Adopting an existing subscription is independent of which app a person just copied.
  let channel =
    readUpdateMarker(options.dataRoot)?.channel ??
    resolveUpdateChannel(options.dataRoot, options.currentVersion);
  // Persist before any check: a promoted stable must not turn an alpha subscriber into stable.
  let saved = false;
  let generation = 0;
  let checkedAt: number | undefined;
  let checking: Promise<UpdateStatus> | undefined;
  /** A person pressed Check for updates for the read running now. */
  let loud = false;
  let download: AbortController | undefined;
  let phase: NonNullable<UpdateStatus["phase"]> = "idle";
  let percent: number | undefined;
  let problem: string | undefined;
  /**
   * A problem the app cannot fix on this copy (not writable, not in
   * Applications, an unsupported macOS): it stays for the rest of this run,
   * and Update and restart is withdrawn for it, so the releases page is the
   * way on.
   */
  let blocked: string | undefined;
  let offer: MacUpdateOffer | null = null;
  /**
   * The exact version this copy follows, the version of the computer it
   * controls (`follow`): while set, the channel's feed is not read, so the
   * offer stays that version, and Update and restart installs it.
   */
  let following: string | undefined;
  /** The followed version downloaded and checked, ready to install with no download. */
  let downloaded: string | undefined;

  function status(): UpdateStatus {
    const available = offer !== null && isNewerVersion(offer.version, options.currentVersion);
    const work = saving.status();
    return {
      currentVersion: options.currentVersion,
      channel,
      latestVersion: offer?.version ?? null,
      updateAvailable: available,
      releaseUrl: offer?.releaseUrl ?? options.releasesUrl,
      upgradeCommand: "",
      channelChoice: true,
      phase,
      ...(available && !blocked ? { install: { asksPassword: false, restarts: true } } : {}),
      ...(percent === undefined ? {} : { percent }),
      ...(blocked || problem ? { problem: blocked ?? problem } : {}),
      ...(checkedAt === undefined ? {} : { checkedAt }),
      ...(phase === "idle" && !available
        ? {
            notice: !offer
              ? UPDATE_NOTICES.none
              : isNewerVersion(options.currentVersion, offer.version)
                ? UPDATE_NOTICES.ahead
                : UPDATE_NOTICES.latest(channel),
          }
        : {}),
      ...(work ? { work } : {}),
    };
  }

  function persist(): void {
    if (saved) return;
    const marker = readUpdateMarker(options.dataRoot);
    if (!marker || marker.version || marker.cameThroughOldCask)
      saveMacUpdateChannel(options.dataRoot, channel);
    saved = true;
  }

  /**
   * Reads the feed once the saved answer is four hours old, or now when
   * `force` says so; a read already running is joined, and a consented
   * update is left alone. A failed read keeps what the last one found
   * (docs/alpha.md "Update channels"): a pressed check says it failed beside
   * it, and the quiet read says nothing.
   */
  function read(force: boolean, pressed: boolean): Promise<UpdateStatus> {
    if (phase === "downloading" || phase === "installing" || phase === "ready")
      return Promise.resolve(status());
    // A followed version is the offer: the channel's newest never replaces it.
    if (following) return Promise.resolve(status());
    if (checking) {
      loud ||= pressed;
      return checking;
    }
    if (!force && checkedAt !== undefined && now() - checkedAt < 4 * 60 * 60 * 1000)
      return Promise.resolve(status());
    const reading = generation;
    const wanted = channel;
    loud = pressed;
    checking = Promise.resolve().then(async () => {
      phase = "checking";
      try {
        persist();
        const mark = options.activeMarks?.next() ?? undefined;
        const next = await options.driver.check(wanted, mark);
        if (reading !== generation) return status();
        if (
          next &&
          !isStableVersion(next.version) &&
          !(wanted === "alpha" && isAlphaVersion(next.version))
        ) {
          throw new Error("The release does not belong to this channel.");
        }
        offer = next;
        problem = undefined;
        phase = "idle";
        checkedAt = now();
      } catch {
        if (reading === generation) {
          // Nothing read yet has nothing to keep quiet about: the copy is not up to date.
          if (loud || checkedAt === undefined) {
            phase = "error";
            problem = UPDATE_PROBLEMS.checkFailed;
          } else phase = problem ? "error" : "idle";
        }
      } finally {
        if (reading === generation) checking = undefined;
      }
      return status();
    });
    return checking;
  }

  const getStatus = (): Promise<UpdateStatus> => read(false, false);

  // A pressed check reads the feed now, past the saved answer.
  const checkNow = (): Promise<UpdateStatus> => read(true, true);

  async function setChannel(next: UpdateChannel): Promise<UpdateStatus> {
    if (phase === "installing" || phase === "ready")
      throw new Error("The update is installing. Change channels after Infinitary restarts.");
    // Save first: a failed write leaves the old subscription and download untouched.
    saveMacUpdateChannel(options.dataRoot, next);
    saved = true;
    channel = next;
    generation++;
    download?.abort();
    download = undefined;
    checking = undefined;
    checkedAt = undefined;
    offer = null;
    following = undefined;
    downloaded = undefined;
    percent = undefined;
    problem = undefined;
    phase = "idle";
    return getStatus();
  }

  function isInstalling(): boolean {
    return download !== undefined || phase === "installing";
  }

  /** The install under way, which Update later waits on to answer where it rests. */
  let inFlight: Promise<UpdateInstallResult> | undefined;

  function install(stillWanted?: () => boolean): Promise<UpdateInstallResult> {
    if (inFlight) return installOnce(stillWanted);
    const run = installOnce(stillWanted);
    inFlight = run;
    void run.finally(() => {
      if (inFlight === run) inFlight = undefined;
    });
    return run;
  }

  async function installOnce(stillWanted?: () => boolean): Promise<UpdateInstallResult> {
    if (blocked) return { ok: false, problem: blocked };
    if (isInstalling()) return { ok: false, problem: ALREADY_INSTALLING };
    const consent = generation;
    // Update and restart installs the newest version: it reads the feed first, and a
    // failed read installs the version already offered. A staged update reads nothing,
    // and neither does a followed version, which is the offer (`follow`).
    const current = following ? status() : await read(true, false);
    if (consent !== generation) return { ok: false, problem: CHANNEL_CHANGED };
    if (isInstalling()) return { ok: false, problem: ALREADY_INSTALLING };
    if (!current.updateAvailable || !offer)
      return { ok: false, problem: "There is no newer update to install." };
    const wanted = offer;
    const controller = new AbortController();
    download = controller;
    phase = "downloading";
    percent = 0;
    problem = undefined;
    try {
      const alreadyStaged = current.phase === "ready";
      if (!alreadyStaged && !(following && downloaded === wanted.version))
        await options.driver.download(
          wanted,
          (value) => {
            if (consent === generation && Number.isFinite(value))
              percent = Math.max(0, Math.min(100, value));
          },
          controller.signal,
        );
      if (consent !== generation || controller.signal.aborted)
        return { ok: false, problem: CHANNEL_CHANGED };
      phase = "installing";
      // The crew's work stops where nothing is lost before the copy is
      // replaced; Update later lets the update go first.
      if (!(await saving.save())) {
        if (consent === generation) phase = alreadyStaged ? "ready" : "idle";
        return { ok: false, later: true, problem: UPDATE_LATER };
      }
      // Someone started using the app while the work was saved: it stays as it was.
      if (stillWanted && !stillWanted()) {
        saving.release();
        if (consent === generation) phase = alreadyStaged ? "ready" : "idle";
        return { ok: false, later: true, problem: UPDATE_LATER };
      }
      let kept: void | MacInstallKept;
      try {
        kept = await options.driver.install(stillWanted);
      } catch (error) {
        // Nothing replaced this copy: the work it stopped carries on.
        saving.release();
        throw error;
      }
      // Someone started using the app before it quit: it keeps running, staged or as it was.
      if (kept) {
        saving.release();
        if (consent === generation) phase = alreadyStaged || kept === "staged" ? "ready" : "idle";
        return { ok: false, later: true, problem: UPDATE_LATER };
      }
      return { ok: true };
    } catch (error) {
      const message = controller.signal.aborted
        ? CHANNEL_CHANGED
        : error instanceof MacUpdateProblem
          ? error.message
          : NOT_INSTALLED;
      if (consent === generation) {
        phase = error instanceof MacUpdateReadyProblem ? "ready" : "error";
        problem = message;
      }
      if (error instanceof MacUpdateProblem && !(error instanceof MacUpdateReadyProblem))
        blocked = message;
      return { ok: false, problem: message };
    } finally {
      if (download === controller) download = undefined;
    }
  }

  /**
   * Gets one exact version ready, the version of the computer this copy
   * controls (docs/view.md, "Following the home's version"): reads that
   * version's own manifest, downloads and checks it, and answers once it
   * is ready to install. From then on the offer is that version, so Update
   * and restart, here or asked from afar, installs it with no download.
   */
  async function follow(version: string): Promise<AppFollowResult> {
    if (blocked) return { ok: false, reason: "installation", problem: blocked };
    if (!options.driver.checkVersion) return { ok: false, reason: "installation" };
    // A version already followed is ready again, staged too: installing it again downloads nothing.
    if (following === version && (downloaded === version || phase === "ready")) return { ok: true };
    if (isInstalling()) return { ok: false, failed: ALREADY_INSTALLING };
    // Another version staged and kept running is no longer the target: the driver stages this
    // one in its place before it quits, and until then the staged one applies at the next start.
    // A channel read or download under way is let go: the followed version is the offer.
    const consent = ++generation;
    checking = undefined;
    following = version;
    downloaded = undefined;
    let next: MacUpdateOffer | null;
    try {
      next = await options.driver.checkVersion(version);
    } catch {
      if (consent === generation) following = undefined;
      return { ok: false, failed: UPDATE_PROBLEMS.checkFailed };
    }
    if (consent !== generation) return { ok: false, failed: CHANNEL_CHANGED };
    if (!next || next.version !== version) {
      following = undefined;
      return { ok: false, reason: "unpublished" };
    }
    offer = next;
    checkedAt = now();
    problem = undefined;
    const controller = new AbortController();
    download = controller;
    phase = "downloading";
    percent = 0;
    try {
      await options.driver.download(
        next,
        (value) => {
          if (consent === generation && Number.isFinite(value))
            percent = Math.max(0, Math.min(100, value));
        },
        controller.signal,
      );
    } catch (error) {
      const message = controller.signal.aborted
        ? CHANNEL_CHANGED
        : error instanceof MacUpdateProblem
          ? error.message
          : NOT_INSTALLED;
      if (consent === generation) {
        phase = "error";
        problem = message;
      }
      if (error instanceof MacUpdateProblem) {
        blocked = message;
        return { ok: false, reason: "installation", problem: message };
      }
      return { ok: false, failed: message };
    } finally {
      if (download === controller) download = undefined;
    }
    if (consent !== generation || controller.signal.aborted)
      return { ok: false, failed: CHANNEL_CHANGED };
    downloaded = version;
    phase = "idle";
    percent = undefined;
    return { ok: true };
  }

  /**
   * Installs the followed version, and only it: a channel change or another
   * followed version since it got ready refuses, so the app never starts
   * again on a version nobody asked it to follow.
   */
  function installFollowed(
    version: string,
    stillWanted: () => boolean,
  ): Promise<UpdateInstallResult> {
    if (following !== version || offer?.version !== version)
      return Promise.resolve({ ok: false, problem: NOT_INSTALLED });
    return install(stillWanted);
  }

  /**
   * Stops following a version: the next read is the channel's own again. A
   * version staged and kept running is no longer offered; until another is
   * staged in its place it applies at the next start, as the driver says.
   */
  function unfollow(): void {
    // A version being replaced stays; its download in the background goes.
    if (!following || phase === "installing") return;
    generation++;
    download?.abort();
    download = undefined;
    following = undefined;
    downloaded = undefined;
    offer = null;
    checkedAt = undefined;
    percent = undefined;
    phase = "idle";
  }

  return {
    getStatus,
    checkNow,
    setChannel,
    install: () => install(),
    follow,
    installFollowed,
    unfollow,
    later: async () => {
      // A save let go ends its install, which sets the phase it rests in: answer from there.
      if (saving.later()) await inFlight;
      return status();
    },
    openReleasePage: async () => {
      await options.openExternal(offer?.releaseUrl ?? options.releasesUrl);
    },
  };
}
