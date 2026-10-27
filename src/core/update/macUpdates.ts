import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateChannel, UpdateInstallResult, UpdateStatus } from "@shared/update";
import type { MacInstallation } from "./macInstallation";
import { isAlphaVersion, isNewerVersion, isStableVersion } from "./semver";
import { readUpdateMarker, resolveUpdateChannel, UPDATE_CHANNEL_MARKER } from "./updateChannels";
import type { UpdateChecker } from "./updateChecker";

/** Native effects live in main; channel, version and consent policy live here (INF-640). */
export type MacUpdateOffer = { version: string; releaseUrl: string };
/** A bounded explanation authored by the host, never a remote error's raw text. */
export class MacUpdateProblem extends Error {}
/** Native staging succeeded; a new channel must not replace this consented update on quit. */
export class MacUpdateReadyProblem extends MacUpdateProblem {}
export type MacUpdateDriver = {
  installation: MacInstallation;
  check: (channel: UpdateChannel) => Promise<MacUpdateOffer | null>;
  download: (
    offer: MacUpdateOffer,
    progress: (percent: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /** After consent and download; owns native signature verification and graceful shutdown. */
  install: () => Promise<void>;
};

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
}): UpdateChecker {
  const now = options.now ?? Date.now;
  // Adopting an existing subscription is independent of which app a person just copied.
  let channel =
    readUpdateMarker(options.dataRoot)?.channel ??
    resolveUpdateChannel(options.dataRoot, options.currentVersion);
  // Persist before any check: a promoted stable must not turn an alpha subscriber into stable.
  let saved = false;
  let generation = 0;
  let checkedAt: number | undefined;
  let checking: Promise<UpdateStatus> | undefined;
  let download: AbortController | undefined;
  let phase: NonNullable<UpdateStatus["phase"]> = "idle";
  let percent: number | undefined;
  let problem: string | undefined;
  let offer: MacUpdateOffer | null = null;

  function status(): UpdateStatus {
    const available = offer !== null && isNewerVersion(offer.version, options.currentVersion);
    return {
      currentVersion: options.currentVersion,
      channel,
      latestVersion: offer?.version ?? null,
      updateAvailable: available,
      releaseUrl: offer?.releaseUrl ?? options.releasesUrl,
      upgradeCommand: "",
      channelChoice: true,
      phase,
      ...(available ? { install: { asksPassword: false, restarts: true } } : {}),
      ...(percent === undefined ? {} : { percent }),
      ...(problem ? { problem } : {}),
      ...(phase === "idle" && !available
        ? {
            notice: !offer
              ? "No release is available on this channel yet."
              : isNewerVersion(options.currentVersion, offer.version)
                ? "This copy is ahead of this channel. It will wait for a newer release, without downgrading."
                : "You have the latest release on this channel.",
          }
        : {}),
    };
  }

  function persist(): void {
    if (saved) return;
    const marker = readUpdateMarker(options.dataRoot);
    if (!marker || marker.version || marker.cameThroughOldCask)
      saveMacUpdateChannel(options.dataRoot, channel);
    saved = true;
  }

  async function getStatus(): Promise<UpdateStatus> {
    if (phase === "downloading" || phase === "installing" || phase === "ready") return status();
    if (checking) return checking;
    if (checkedAt !== undefined && now() - checkedAt < 4 * 60 * 60 * 1000) return status();
    const reading = generation;
    const wanted = channel;
    checking = Promise.resolve().then(async () => {
      phase = "checking";
      try {
        persist();
        const next = await options.driver.check(wanted);
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
          offer = null;
          phase = "error";
          problem = "Updates could not be checked. Try again, or open the releases page.";
        }
      } finally {
        if (reading === generation) checking = undefined;
      }
      return status();
    });
    return checking;
  }

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
    percent = undefined;
    problem = undefined;
    phase = "idle";
    return getStatus();
  }

  function isInstalling(): boolean {
    return download !== undefined || phase === "installing";
  }

  async function install(): Promise<UpdateInstallResult> {
    if (isInstalling()) return { ok: false, problem: "The update is already installing." };
    const consent = generation;
    const current = await getStatus();
    if (consent !== generation)
      return { ok: false, problem: "The channel changed, so the previous update was cancelled." };
    if (isInstalling()) return { ok: false, problem: "The update is already installing." };
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
      if (!alreadyStaged)
        await options.driver.download(
          wanted,
          (value) => {
            if (consent === generation && Number.isFinite(value))
              percent = Math.max(0, Math.min(100, value));
          },
          controller.signal,
        );
      if (consent !== generation || controller.signal.aborted)
        return { ok: false, problem: "The channel changed, so the previous update was cancelled." };
      phase = "installing";
      await options.driver.install();
      return { ok: true };
    } catch (error) {
      const message = controller.signal.aborted
        ? "The channel changed, so the previous update was cancelled."
        : error instanceof MacUpdateProblem
          ? error.message
          : "The update could not be installed. Try again, or download the disk image from the releases page.";
      if (consent === generation) {
        phase = error instanceof MacUpdateReadyProblem ? "ready" : "error";
        problem = message;
      }
      return { ok: false, problem: message };
    } finally {
      if (download === controller) download = undefined;
    }
  }

  return {
    getStatus,
    setChannel,
    install,
    openReleasePage: async () => {
      await options.openExternal(offer?.releaseUrl ?? options.releasesUrl);
    },
  };
}
