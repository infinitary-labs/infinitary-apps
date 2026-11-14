import { settingFrom } from "@shared/envSettings";
import type { UpdateChannel, UpdateInstallResult, UpdateStatus } from "@shared/update";
import { UPDATE_LATER, UPDATE_NOTICES, UPDATE_PROBLEMS } from "@shared/updateWords";
import type { HostAppInfo } from "../host";
import { hostEnv } from "../hostEnv";
import { thisDeviceSystem } from "../platform";
import {
  createLinuxInstaller,
  INSTALLS_IN_APP,
  type LinuxInstallation,
  type LinuxInstallPlan,
  linuxUpdateCommand,
  readLinuxInstallation,
  UpdateInstallProblem,
} from "./linuxInstall";
import { createMacUpdateChecker, type MacUpdateDriver } from "./macUpdates";
import { PUBLIC_RELEASE_NAMES, publicBuildsUrl, releaseSource } from "./releaseSource";
import { isAlphaVersion, isNewerVersion, isStableVersion, parseSemver } from "./semver";
import {
  BUILDS_URL,
  type BuildDownload,
  buildOfferFor,
  parseBuilds,
  parseUpdateTargets,
  releasesPageFor,
  resolveUpdateChannel,
  resolveUpdateTap,
  TAP,
  type TapNames,
  targetsUrlOf,
  upgradeCommandFor,
} from "./updateChannels";
import {
  type CrewWorkForUpdate,
  createUpdateSaving,
  type UpdateSaving,
  withUpdateWork,
} from "./updateWork";

// Direct Mac copies use the consented native updater; Homebrew copies keep reading
// their cask's target and offer only its Homebrew command. Linux reads public builds.
// Each Homebrew channel's installable version is the tap's published targets file
// (docs/alpha.md "Update channels"), written with the casks only after the
// download was verified. Until that file exists, a stable installation
// keeps the legacy reader of the tap's release list; an alpha one is
// offered nothing rather than a guess.
//
// A Linux installation reads the builds file beside it instead, keyed by
// system and chip (docs/alpha.md "Updates on Linux"), and is offered its
// own package's build: a deb, an rpm or an AppImage the app installs
// itself, after checking the build's published checksum; an Arch or NixOS
// package the notice names the command for.
//
// A Mac that came to Infinitary through Firstmate 3000's cask (the old-cask
// switch) reads that tap instead, and its notice names that cask's command,
// so it is offered only what the command it uses installs.
const releasesUrlOf = (tap: TapNames) =>
  `https://api.github.com/repos/${tap.repo}/releases?per_page=100`;
// A check at most every 4 hours.
const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000;
const REQUEST_HEADERS = { "User-Agent": "infinitary" };

export type UpdateChecker = {
  /** Returns the cached status for the installed channel, refreshing once it goes stale. */
  getStatus: () => Promise<UpdateStatus>;
  /**
   * A check the person asked for: reads the release source now, past the
   * saved answer, joining one already reading. A failure says so, never "no update".
   */
  checkNow: () => Promise<UpdateStatus>;
  /** Saves this app's subscription and invalidates the previous channel's pending work. */
  setChannel?: (channel: UpdateChannel) => Promise<UpdateStatus>;
  /** Opens the offered version's release page (or the channel's release list). */
  openReleasePage: () => Promise<void>;
  /**
   * Installs the offered version where the app installs its own updates,
   * then starts it; answers only when it could not.
   */
  install: () => Promise<UpdateInstallResult>;
  /**
   * Update later (docs/alpha.md, "Saving work before an update"): lets an
   * update go while it saves the crew's work, so nothing is replaced and
   * the work carries on; nothing happens once the copy is being replaced.
   */
  later?: () => Promise<UpdateStatus>;
};

export type CreateUpdateCheckerOptions = {
  currentVersion: string;
  /**
   * The installation's subscription, asked on every check: the installer
   * owns it and may rewrite it while the app runs.
   */
  channel: () => UpdateChannel;
  /**
   * The tap the installation updates through, asked on every check:
   * this build's own unless its installer came through the old cask.
   */
  tap?: () => TapNames;
  /** The published targets file; the public tap's by default. */
  targetsUrl?: string;
  /** The legacy stable reader's release list; the public tap's by default. */
  releasesUrl?: string;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  openExternal?: (url: string) => void | Promise<void>;
  // Dev affordance: a dev/source build's version is never behind the latest
  // release, so the indicator would never show. When true the checker
  // fabricates an available update for the channel (no network call) so the
  // UI can be exercised in dev mode.
  simulateUpdate?: boolean;
  /**
   * A Linux installation: read the builds file for its chip and package
   * rather than the targets file installed Macs read.
   */
  linux?: LinuxInstallation;
  /** The published builds file; the public tap's by default. */
  buildsUrl?: string;
  /** Installs an offered Linux build (`createLinuxInstaller`); absent, nothing installs. */
  installLinux?: (plan: LinuxInstallPlan, beforeReplace?: () => Promise<void>) => Promise<void>;
  /** Saves the crew's work before an installed build replaces this copy. */
  saving?: UpdateSaving;
};

type Offer = { version: string; url: string | null; download?: BuildDownload | null };

/**
 * The legacy stable reader, for the rollout before the targets file
 * exists: the newest of this app's stable releases in a GitHub
 * releases-list payload. Only the tap's stable tags carrying a stable
 * version count - the tap's other products, drafts, prereleases and alpha
 * tags never do - and "newest" is the highest version, not the list order.
 */
export function pickNewestStableRelease(payload: unknown, tap: TapNames = TAP): Offer | null {
  const prefix = tap.stableTagPrefix;
  if (!Array.isArray(payload)) return null;
  let newest: Offer | null = null;
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.draft === true || record.prerelease === true) continue;
    if (typeof record.tag_name !== "string") continue;
    if (!record.tag_name.startsWith(prefix)) continue;
    const version = record.tag_name.slice(prefix.length);
    if (!isStableVersion(version)) continue;
    if (newest && !isNewerVersion(version, newest.version)) continue;
    const url =
      typeof record.html_url === "string" &&
      record.html_url.startsWith(`https://github.com/${tap.repo}/releases/`)
        ? record.html_url
        : null;
    newest = { version, url };
  }
  return newest;
}

/** A plausible next version on the channel, for the dev affordance only. */
function simulatedNext(currentVersion: string, channel: UpdateChannel): string {
  const parsed = parseSemver(currentVersion);
  if (!parsed) return channel === "alpha" ? "0.0.1-alpha.1" : "0.0.1";
  const nextPatch = `${parsed.major}.${parsed.minor}.${Number(parsed.patch) + 1}`;
  if (channel === "stable") return nextPatch;
  if (isAlphaVersion(currentVersion)) {
    const run = Number(parsed.prerelease[1]) + 1;
    return `${parsed.major}.${parsed.minor}.${parsed.patch}-alpha.${run}`;
  }
  return `${nextPatch}-alpha.1`;
}

export function createUpdateChecker(options: CreateUpdateCheckerOptions): UpdateChecker {
  const tapNow = options.tap ?? (() => TAP);
  const targetsUrlFor = (tap: TapNames) => options.targetsUrl ?? targetsUrlOf(tap);
  const releasesUrlFor = (tap: TapNames) => options.releasesUrl ?? releasesUrlOf(tap);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const openExternal = options.openExternal ?? (() => undefined);

  // Per channel and tap, so switching installations never shows the other
  // channel's, or the other tap's, last answer.
  const lastGood = new Map<string, UpdateStatus>();
  const attemptedAt = new Map<string, number>();
  const keyOf = (channel: UpdateChannel, tap: TapNames) => `${tap.repo} ${channel}`;

  const linux = options.linux;
  const buildsUrl = options.buildsUrl ?? publicBuildsUrl;
  // The offer each channel's last good status was read from, for install().
  const lastOffer = new Map<string, Offer | null>();
  let installing = false;

  const statusFor = (channel: UpdateChannel, tap: TapNames, offer: Offer | null): UpdateStatus => {
    const updateAvailable = offer ? isNewerVersion(offer.version, options.currentVersion) : false;
    const status: UpdateStatus = {
      currentVersion: options.currentVersion,
      channel,
      latestVersion: offer?.version ?? null,
      updateAvailable,
      releaseUrl: offer?.url ?? null,
      upgradeCommand: linux ? "" : upgradeCommandFor(channel, tap),
    };
    if (!linux || !offer?.download) return status;
    const inApp = linux.package ? INSTALLS_IN_APP[linux.package] : undefined;
    return {
      ...status,
      upgradeCommand: linuxUpdateCommand(linux, offer.download) ?? "",
      ...(inApp && updateAvailable && options.installLinux
        ? { install: { asksPassword: inApp.asksPassword } }
        : {}),
    };
  };

  async function readLegacyStable(tap: TapNames): Promise<Offer> {
    const response = await fetchImpl(releasesUrlFor(tap), {
      headers: { Accept: "application/vnd.github+json", ...REQUEST_HEADERS },
    });
    if (!response.ok) throw new Error(`GitHub releases request failed: ${response.status}`);
    const release = pickNewestStableRelease(await response.json(), tap);
    if (!release) throw new Error(`GitHub releases response has no ${tap.stableTagPrefix} tag`);
    return release;
  }

  async function readBuildsOffer(
    channel: UpdateChannel,
    where: LinuxInstallation,
  ): Promise<Offer | null> {
    let response: Response;
    let fromTap = false;
    try {
      response = await fetchImpl(buildsUrl, {
        headers: { Accept: "application/json", ...REQUEST_HEADERS },
      });
    } catch (error) {
      // INF-1613: before the bucket/domain exists, newly released Linux copies still read the tap.
      if (options.buildsUrl) throw error;
      fromTap = true;
      response = await fetchImpl(BUILDS_URL, {
        headers: { Accept: "application/json", ...REQUEST_HEADERS },
      });
    }
    // Keep historical downloads reachable before the new host's first publication.
    if (response.status === 404 && !options.buildsUrl && !fromTap)
      response = await fetchImpl(BUILDS_URL, {
        headers: { Accept: "application/json", ...REQUEST_HEADERS },
      });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Update builds request failed: ${response.status}`);
    const data: unknown = await response.json();
    const builds = parseBuilds(data, PUBLIC_RELEASE_NAMES) ?? parseBuilds(data);
    if (!builds) throw new Error("Update builds are invalid");
    const offer = buildOfferFor(builds, channel, {
      system: "linux",
      chip: where.chip,
      kind: where.package ?? "",
    });
    return offer
      ? { version: offer.version, url: offer.releaseUrl, download: offer.download }
      : null;
  }

  async function readOffer(channel: UpdateChannel, tap: TapNames): Promise<Offer | null> {
    if (linux) return readBuildsOffer(channel, linux);
    const response = await fetchImpl(targetsUrlFor(tap), {
      headers: { Accept: "application/json", ...REQUEST_HEADERS },
    });
    if (response.status === 404) {
      return channel === "stable" ? readLegacyStable(tap) : null;
    }
    if (!response.ok) throw new Error(`Update targets request failed: ${response.status}`);
    const targets = parseUpdateTargets(await response.json(), tap);
    if (!targets) throw new Error("Update targets are invalid");
    // A valid file without this channel's target offers nothing; it never
    // authorizes a guess from the release history.
    const target = targets.targets[channel];
    return target ? { version: target.version, url: target.releaseUrl } : null;
  }

  /** What a successful read says when nothing newer is offered. */
  const noticeFor = (offer: Offer | null, channel: UpdateChannel): Pick<UpdateStatus, "notice"> => {
    if (offer && isNewerVersion(offer.version, options.currentVersion)) return {};
    return {
      notice: !offer
        ? UPDATE_NOTICES.none
        : isNewerVersion(options.currentVersion, offer.version)
          ? UPDATE_NOTICES.ahead
          : UPDATE_NOTICES.latest(channel),
    };
  };

  // One read per channel and tap at a time: a pressed check joins the quiet one.
  const reading = new Map<string, Promise<UpdateStatus>>();
  function read(channel: UpdateChannel, tap: TapNames): Promise<UpdateStatus> {
    const key = keyOf(channel, tap);
    const running = reading.get(key);
    if (running) return running;
    attemptedAt.set(key, now());
    const next = (async () => {
      try {
        const offer = await readOffer(channel, tap);
        const status = {
          ...statusFor(channel, tap, offer),
          ...noticeFor(offer, channel),
          checkedAt: now(),
        };
        lastGood.set(key, status);
        lastOffer.set(key, offer);
        return status;
      } finally {
        reading.delete(key);
      }
    })();
    reading.set(key, next);
    return next;
  }

  /** The dev affordance's offer, or null to read the release source. */
  function simulated(channel: UpdateChannel, tap: TapNames): UpdateStatus | null {
    if (!options.simulateUpdate) return null;
    return {
      ...statusFor(channel, tap, null),
      latestVersion: simulatedNext(options.currentVersion, channel),
      updateAvailable: true,
      releaseUrl: releasesPageFor(channel, tap),
    };
  }

  async function getStatus(): Promise<UpdateStatus> {
    const channel = options.channel();
    // Linux has no casks: an installation there always reads this build's own tap.
    const tap = linux ? TAP : tapNow();
    const fake = simulated(channel, tap);
    if (fake) return fake;
    const key = keyOf(channel, tap);
    const good = lastGood.get(key);
    const attempted = attemptedAt.get(key);
    if (good && attempted !== undefined && now() - attempted < intervalMs) return good;
    if (!fetchImpl) return good ?? statusFor(channel, tap, null);
    try {
      return await read(channel, tap);
    } catch {
      // Update checks are best-effort. Keep the last good status if we have
      // one, otherwise report "no update" so the shell never shows a false
      // positive. Only successes cache: a failure retries on the next ask.
      return good ?? statusFor(channel, tap, null);
    }
  }

  async function checkNow(): Promise<UpdateStatus> {
    const channel = options.channel();
    const tap = linux ? TAP : tapNow();
    const fake = simulated(channel, tap);
    if (fake) return fake;
    const good = lastGood.get(keyOf(channel, tap));
    const failed = (): UpdateStatus => {
      // The last good offer stays; its "up to date" line does not.
      const { notice, ...known } = good ?? statusFor(channel, tap, null);
      return { ...known, phase: "error", problem: UPDATE_PROBLEMS.checkFailed };
    };
    if (!fetchImpl) return failed();
    try {
      return await read(channel, tap);
    } catch {
      return failed();
    }
  }

  async function openReleasePage(): Promise<void> {
    const status = await getStatus();
    await openExternal(
      status.releaseUrl ?? releasesPageFor(status.channel, linux ? TAP : tapNow()),
    );
  }

  const saving = options.saving ?? createUpdateSaving(undefined);

  /**
   * What Install installs: the release source read now, so it installs the
   * newest version, or the version already offered when that read fails.
   */
  async function readBeforeInstall(): Promise<UpdateStatus> {
    const channel = options.channel();
    const tap = linux ? TAP : tapNow();
    if (simulated(channel, tap) || !fetchImpl) return getStatus();
    try {
      return await read(channel, tap);
    } catch {
      return lastGood.get(keyOf(channel, tap)) ?? statusFor(channel, tap, null);
    }
  }

  /** The install under way, which Update later waits on to answer once it let go. */
  let inFlight: Promise<UpdateInstallResult> | undefined;

  function install(): Promise<UpdateInstallResult> {
    if (inFlight) return installOnce();
    const run = installOnce();
    inFlight = run;
    void run.finally(() => {
      if (inFlight === run) inFlight = undefined;
    });
    return run;
  }

  async function installOnce(): Promise<UpdateInstallResult> {
    const status = await readBeforeInstall();
    const offer = lastOffer.get(keyOf(status.channel, TAP));
    if (!linux?.package || !status.install || !offer?.download || !options.installLinux) {
      return { ok: false, problem: "There is no update this app can install itself." };
    }
    if (installing) return { ok: false, problem: "The update is already installing." };
    installing = true;
    let later = false;
    try {
      await options.installLinux(
        {
          package: linux.package,
          version: offer.version,
          channel: status.channel,
          download: offer.download,
          ...(linux.appImage ? { appImage: linux.appImage } : {}),
        },
        // The crew's work stops where nothing is lost before the copy is replaced.
        async () => {
          if (await saving.save()) return;
          later = true;
          throw new UpdateInstallProblem(UPDATE_LATER);
        },
      );
      return { ok: true };
    } catch (caught) {
      if (later) return { ok: false, later: true, problem: UPDATE_LATER };
      // Nothing replaced this copy: the work it stopped carries on.
      saving.release();
      return {
        ok: false,
        problem:
          caught instanceof UpdateInstallProblem
            ? caught.message
            : "The update could not be installed, so nothing changed.",
      };
    } finally {
      installing = false;
    }
  }

  return {
    getStatus: async () => withUpdateWork(await getStatus(), saving),
    checkNow: async () => withUpdateWork(await checkNow(), saving),
    openReleasePage,
    install,
    later: async () => {
      // A save let go ends its install: answer once it has, not while it still says it installs.
      if (saving.later()) await inFlight;
      return withUpdateWork(await getStatus(), saving);
    },
  };
}

export type InstalledUpdateCheckerOptions = {
  macDriver?: MacUpdateDriver;
  app: Pick<HostAppInfo, "version" | "packaged" | "userDataDir"> &
    Partial<Pick<HostAppInfo, "platform" | "resourcesDir">>;
  openExternal: (url: string) => void | Promise<void>;
  /**
   * Quits and starts the app again, from `execPath` when an AppImage was
   * replaced; absent, a Linux installation installs nothing itself.
   */
  relaunch?: (execPath?: string) => void;
  /** Read for the development stand-ins below; the process's own by default. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /**
   * The crew's work on this computer, saved before an update replaces the
   * copy (docs/alpha.md, "Saving work before an update"); an app with no
   * crew of its own has none.
   */
  work?: CrewWorkForUpdate;
};

/**
 * The update checker for the app installed on this computer: its version,
 * the installer's channel marker in its own data root and, on Linux, the
 * package it was installed from. The core makes one, and so does an app
 * controlling Firstmate on another computer, which runs no core and still
 * answers its own update notice (docs/view.md).
 */
export function createInstalledUpdateChecker(
  options: InstalledUpdateCheckerOptions,
): UpdateChecker {
  const { app } = options;
  const env = options.env ?? process.env;
  // Dev/e2e only, like the quota endpoints: a packaged app never reads
  // these, so its update source and installed version cannot be redirected.
  const overrides = app.packaged
    ? {}
    : {
        targetsUrl: settingFrom(env, "UPDATE_TARGETS_URL")?.trim() || undefined,
        releasesUrl: settingFrom(env, "UPDATE_RELEASES_URL")?.trim() || undefined,
        currentVersion: settingFrom(env, "UPDATE_CURRENT_VERSION")?.trim() || undefined,
        buildsUrl: settingFrom(env, "UPDATE_BUILDS_URL")?.trim() || undefined,
        linuxPackage: settingFrom(env, "UPDATE_LINUX_PACKAGE")?.trim() || undefined,
      };
  const currentVersion = overrides.currentVersion ?? app.version;
  const installation = options.macDriver?.installation;
  if (installation?.kind === "unknown") {
    const status: UpdateStatus = {
      currentVersion,
      channel: resolveUpdateChannel(app.userDataDir, currentVersion),
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: releaseSource.releasesUrl,
      upgradeCommand: "",
      problem: UPDATE_PROBLEMS.unknownInstallation,
    };
    return {
      getStatus: async () => status,
      checkNow: async () => status,
      openReleasePage: async () => {
        await options.openExternal(releaseSource.releasesUrl);
      },
      install: async () => ({ ok: false, problem: UPDATE_PROBLEMS.unknownInstallation }),
    };
  }
  const saving = createUpdateSaving(options.work);
  if (options.macDriver && installation?.kind === "direct") {
    return createMacUpdateChecker({
      currentVersion,
      dataRoot: app.userDataDir,
      driver: options.macDriver,
      releasesUrl: releaseSource.releasesUrl,
      openExternal: options.openExternal,
      saving,
    });
  }
  // An installed Linux app knows which package it came from; a run from
  // source is no installation, so it reads what a Mac reads unless a stand-in
  // names a package.
  const resourcesDir = app.resourcesDir ?? "";
  const linux =
    app.platform === "linux" && (app.packaged || overrides.linuxPackage)
      ? readLinuxInstallation({
          chip: thisDeviceSystem(app.platform).chip ?? process.arch,
          resourcesDir,
          execPath: process.execPath,
          env,
          override: overrides.linuxPackage,
        })
      : undefined;
  // The process's fetch, looked up at each download rather than kept from startup.
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return createUpdateChecker({
    currentVersion,
    // The installer's marker in this run's own data root: a dev or
    // isolated run never reads the installed app's subscription. An Arch or
    // NixOS package carries its own beside the app.
    channel: () =>
      installation?.kind === "homebrew"
        ? installation.channel
        : resolveUpdateChannel(app.userDataDir, currentVersion, linux ? resourcesDir : undefined),
    // The running copy's receipt takes priority over another copy's saved subscription.
    tap: () =>
      installation?.kind === "homebrew"
        ? installation.tap
        : resolveUpdateTap(app.userDataDir, currentVersion),
    ...(overrides.targetsUrl ? { targetsUrl: overrides.targetsUrl } : {}),
    ...(overrides.releasesUrl ? { releasesUrl: overrides.releasesUrl } : {}),
    ...(linux ? { linux } : {}),
    ...(overrides.buildsUrl ? { buildsUrl: overrides.buildsUrl } : {}),
    ...(linux && options.relaunch
      ? {
          installLinux: createLinuxInstaller({
            dataRoot: app.userDataDir,
            fetchImpl,
            env: () => hostEnv(),
            relaunch: options.relaunch,
          }),
        }
      : {}),
    openExternal: options.openExternal,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    saving,
    // Dev/source builds are never behind a release, so force the indicator
    // on there to make it visible while developing; e2e opts out.
    simulateUpdate: !app.packaged && settingFrom(env, "SIMULATE_UPDATE") !== "0",
  });
}
