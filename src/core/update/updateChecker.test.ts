import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateChannel } from "@shared/update";
import {
  UPDATE_LATER,
  UPDATE_NOTICES,
  UPDATE_PROBLEMS,
  WINDOWS_HAND_OVER_WORDS,
} from "@shared/updateWords";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { thisDeviceSystem } from "../platform";
import { ACTIVE_MARK_HEADER } from "./activeMark";
import { type LinuxInstallPlan, PACKAGE_TYPE_FILE } from "./linuxInstall";
import type { MacUpdateDriver } from "./macUpdates";
import { BUILDS_URL } from "./releaseBuilds";
import { publicBuildsUrl } from "./releaseSource";
import {
  buildDownloadUrl,
  buildUpdateTarget,
  FIRSTMATE_TAP,
  targetsUrlOf,
  UPDATE_CHANNEL_MARKER,
  type UpdateTarget,
  upgradeCommandFor,
} from "./updateChannels";
import {
  createInstalledUpdateChecker,
  createUpdateChecker,
  openedOnSwitch,
  pickNewestStableRelease,
} from "./updateChecker";
import { UpdateInstallProblem } from "./updateDownload";
import { type CrewWorkForUpdate, createUpdateSaving } from "./updateWork";
import type { WindowsInstallPlan } from "./windowsInstall";

const TARGETS_URL =
  "https://raw.githubusercontent.com/infinitary-labs/homebrew-tap/HEAD/infinitary-updates.json";
const RELEASES_URL =
  "https://api.github.com/repos/infinitary-labs/homebrew-tap/releases?per_page=100";

function target(version: string): UpdateTarget {
  return buildUpdateTarget({
    version,
    assetName: `Infinitary-${version}-universal.zip`,
    sha256: "a".repeat(64),
    sourceCommit: "c".repeat(40),
  });
}

type Reply = { status: number; body?: unknown } | Error;

function tap(replies: { targets: Reply; releases?: Reply }) {
  const requests: string[] = [];
  const answer = (reply: Reply | undefined) => {
    if (!reply) throw new Error("unexpected request");
    if (reply instanceof Error) throw reply;
    return new Response(
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? null),
      { status: reply.status },
    );
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    requests.push(href);
    return answer(href === TARGETS_URL ? replies.targets : replies.releases);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, replies };
}

function checker(
  currentVersion: string,
  channel: UpdateChannel | (() => UpdateChannel),
  fetchImpl: typeof fetch,
  extra: { now?: () => number; opened?: string[] } = {},
) {
  return createUpdateChecker({
    currentVersion,
    channel: typeof channel === "function" ? channel : () => channel,
    fetchImpl,
    intervalMs: 1000,
    ...(extra.now ? { now: extra.now } : {}),
    openExternal: (url) => {
      extra.opened?.push(url);
    },
  });
}

const targets = (entries: Partial<Record<UpdateChannel, UpdateTarget>>) => ({
  status: 200,
  body: { schemaVersion: 1, targets: entries },
});

describe("channel-aware update notices", () => {
  it("offers alpha.10 over alpha.2 with the alpha cask and its release page", async () => {
    const opened: string[] = [];
    const { fetchImpl, requests } = tap({
      targets: targets({ stable: target("0.1.24"), alpha: target("0.1.25-alpha.10") }),
    });
    const updates = checker("0.1.25-alpha.2", "alpha", fetchImpl, { opened });
    expect(await updates.getStatus()).toEqual({
      checkedAt: expect.any(Number),
      currentVersion: "0.1.25-alpha.2",
      channel: "alpha",
      latestVersion: "0.1.25-alpha.10",
      updateAvailable: true,
      releaseUrl: target("0.1.25-alpha.10").releaseUrl,
      upgradeCommand: upgradeCommandFor("alpha"),
    });
    await updates.openReleasePage();
    expect(opened).toEqual([target("0.1.25-alpha.10").releaseUrl]);
    expect(requests).toEqual([TARGETS_URL]);
  });

  it("hands a matching stable to alpha, which then stays alpha for the next alpha", async () => {
    const handedOn = tap({
      targets: targets({ stable: target("0.1.25"), alpha: target("0.1.25") }),
    });
    const onAlpha = await checker("0.1.25-alpha.42", "alpha", handedOn.fetchImpl).getStatus();
    expect(onAlpha).toMatchObject({
      channel: "alpha",
      latestVersion: "0.1.25",
      updateAvailable: true,
      upgradeCommand: upgradeCommandFor("alpha"),
    });
    // Installed through the alpha cask, the stable version keeps the alpha
    // subscription and is offered the next alpha.
    const next = tap({
      targets: targets({ stable: target("0.1.25"), alpha: target("0.1.26-alpha.43") }),
    });
    expect(await checker("0.1.25", "alpha", next.fetchImpl).getStatus()).toMatchObject({
      channel: "alpha",
      latestVersion: "0.1.26-alpha.43",
      updateAvailable: true,
      upgradeCommand: upgradeCommandFor("alpha"),
    });
  });

  it("never offers alpha to a stable installation", async () => {
    const { fetchImpl } = tap({
      targets: targets({ stable: target("0.1.25"), alpha: target("0.1.26-alpha.43") }),
    });
    expect(await checker("0.1.25", "stable", fetchImpl).getStatus()).toEqual({
      checkedAt: expect.any(Number),
      currentVersion: "0.1.25",
      channel: "stable",
      latestVersion: "0.1.25",
      updateAvailable: false,
      releaseUrl: target("0.1.25").releaseUrl,
      upgradeCommand: upgradeCommandFor("stable"),
      // INF-2073: the Version row in Settings says what a read found.
      notice: UPDATE_NOTICES.latest("stable"),
    });
    // Even running an alpha build, a stable subscription never moves back.
    expect(
      (await checker("0.1.26-alpha.43", "stable", fetchImpl).getStatus()).updateAvailable,
    ).toBe(false);
  });

  it("switches notices with the installed marker, never reusing the other channel's answer", async () => {
    let channel: UpdateChannel = "alpha";
    const { fetchImpl } = tap({
      targets: targets({ stable: target("0.1.26"), alpha: target("0.1.26-alpha.44") }),
    });
    const updates = checker("0.1.26-alpha.43", () => channel, fetchImpl, { now: () => 0 });
    expect(await updates.getStatus()).toMatchObject({
      channel: "alpha",
      latestVersion: "0.1.26-alpha.44",
      updateAvailable: true,
    });
    // The stable cask rewrote the marker: within the same check interval the
    // status is stable's, with stable's command.
    channel = "stable";
    expect(await updates.getStatus()).toMatchObject({
      channel: "stable",
      latestVersion: "0.1.26",
      updateAvailable: true,
      upgradeCommand: upgradeCommandFor("stable"),
    });
  });

  it("offers nothing for a channel the valid targets file does not name", async () => {
    const { fetchImpl, requests } = tap({ targets: targets({ stable: target("0.1.26") }) });
    expect(await checker("0.1.25-alpha.2", "alpha", fetchImpl).getStatus()).toEqual({
      checkedAt: expect.any(Number),
      currentVersion: "0.1.25-alpha.2",
      channel: "alpha",
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      upgradeCommand: upgradeCommandFor("alpha"),
      notice: UPDATE_NOTICES.none,
    });
    // No guess from the release history.
    expect(requests).toEqual([TARGETS_URL]);
  });
});

describe("before the targets file exists", () => {
  const releases = {
    status: 200,
    body: [
      // Another product on the tap, newer by date and by version.
      {
        tag_name: "other-tool-v9.0.0",
        html_url: "https://github.com/infinitary-labs/homebrew-tap/releases/tag/other",
      },
      { tag_name: "infinitary-alpha-v0.3.0-alpha.1", prerelease: true },
      { tag_name: "infinitary-v0.2.1", prerelease: true },
      { tag_name: "infinitary-v0.3.0", draft: true },
      { tag_name: "infinitary-v0.2.5-rc.1" },
      {
        tag_name: "infinitary-v0.2.0",
        html_url: "https://github.com/infinitary-labs/homebrew-tap/releases/tag/infinitary-v0.2.0",
      },
      { tag_name: "infinitary-v0.1.0" },
    ],
  };

  it("keeps the legacy stable reader for a stable installation", async () => {
    const { fetchImpl, requests } = tap({ targets: { status: 404 }, releases });
    const opened: string[] = [];
    const updates = checker("0.1.0", "stable", fetchImpl, { opened });
    expect(await updates.getStatus()).toEqual({
      checkedAt: expect.any(Number),
      currentVersion: "0.1.0",
      channel: "stable",
      latestVersion: "0.2.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/infinitary-labs/homebrew-tap/releases/tag/infinitary-v0.2.0",
      upgradeCommand: upgradeCommandFor("stable"),
    });
    expect(requests).toEqual([TARGETS_URL, RELEASES_URL]);
  });

  it("offers an alpha installation nothing and never the stable cask", async () => {
    const { fetchImpl, requests } = tap({ targets: { status: 404 }, releases });
    const opened: string[] = [];
    const updates = checker("0.1.0-alpha.1", "alpha", fetchImpl, { opened });
    expect(await updates.getStatus()).toEqual({
      checkedAt: expect.any(Number),
      currentVersion: "0.1.0-alpha.1",
      channel: "alpha",
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      upgradeCommand: upgradeCommandFor("alpha"),
      notice: UPDATE_NOTICES.none,
    });
    expect(requests).toEqual([TARGETS_URL]);
    await updates.openReleasePage();
    expect(opened).toEqual([
      "https://github.com/infinitary-labs/homebrew-tap/releases?q=infinitary-alpha-v",
    ]);
  });

  it("reads only this app's stable tags", () => {
    expect(pickNewestStableRelease(releases.body)).toEqual({
      version: "0.2.0",
      url: "https://github.com/infinitary-labs/homebrew-tap/releases/tag/infinitary-v0.2.0",
    });
    // A release page off the tap is not opened.
    expect(
      pickNewestStableRelease([
        { tag_name: "infinitary-v1.4.0", html_url: "https://example.com/x" },
      ]),
    ).toEqual({ version: "1.4.0", url: null });
    expect(pickNewestStableRelease([{ tag_name: "other-tool-v1.0.0" }])).toBeNull();
    expect(pickNewestStableRelease({ tag_name: "infinitary-v1.0.0" })).toBeNull();
    expect(pickNewestStableRelease(null)).toBeNull();
  });
});

describe("failures never invent an update", () => {
  it("reports no update when offline, invalid or refused, and opens the channel's releases", async () => {
    for (const reply of [
      new Error("offline"),
      { status: 500 },
      { status: 200, body: "not json" },
      {
        status: 200,
        body: { schemaVersion: 1, targets: { stable: { ...target("9.9.9"), sha256: "x" } } },
      },
    ] satisfies Reply[]) {
      const opened: string[] = [];
      const { fetchImpl, requests } = tap({ targets: reply });
      const updates = checker("0.1.0", "stable", fetchImpl, { opened });
      expect(await updates.getStatus()).toMatchObject({
        channel: "stable",
        latestVersion: null,
        updateAvailable: false,
      });
      // Only a missing file reaches the legacy reader.
      expect(requests.every((url) => url === TARGETS_URL)).toBe(true);
      await updates.openReleasePage();
      expect(opened).toEqual([
        "https://github.com/infinitary-labs/homebrew-tap/releases?q=infinitary-v",
      ]);
    }
  });

  it("keeps the last good answer through a failure, retrying failures but caching successes", async () => {
    let time = 0;
    const { fetchImpl, replies } = tap({ targets: new Error("offline") });
    const updates = checker("0.1.25-alpha.2", "alpha", fetchImpl, { now: () => time });
    expect((await updates.getStatus()).updateAvailable).toBe(false);
    // Only successes cache: a failed check retries on the next ask...
    time = 500;
    replies.targets = targets({ alpha: target("0.1.25-alpha.3") });
    expect((await updates.getStatus()).latestVersion).toBe("0.1.25-alpha.3");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    time = 900;
    await updates.getStatus();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    time = 2000;
    replies.targets = {
      status: 200,
      body: { schemaVersion: 1, targets: { alpha: { version: "x" } } },
    };
    expect(await updates.getStatus()).toMatchObject({
      latestVersion: "0.1.25-alpha.3",
      updateAvailable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

// INF-2073, the captain's direction A: Check for updates in Settings reads the source now.
describe("a pressed check", () => {
  it("reads past the saved answer, replaces it, and says what it found", async () => {
    let time = 0;
    const { fetchImpl, replies } = tap({ targets: targets({ stable: target("0.1.30") }) });
    const updates = checker("0.1.30", "stable", fetchImpl, { now: () => time });
    // The captain's INF-2670 answer: the up-to-date line says when the source last answered.
    expect(await updates.getStatus()).toMatchObject({
      updateAvailable: false,
      notice: UPDATE_NOTICES.latest("stable"),
      checkedAt: 0,
    });
    // Within the interval the quiet check keeps its answer; a press does not.
    time = 500;
    replies.targets = targets({ stable: target("0.1.31") });
    expect((await updates.getStatus()).updateAvailable).toBe(false);
    const found = await updates.checkNow();
    expect(found).toMatchObject({ latestVersion: "0.1.31", updateAvailable: true, checkedAt: 500 });
    expect(found.notice).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await updates.getStatus()).toEqual(found);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("names an ahead copy and a channel with no release", async () => {
    const ahead = tap({ targets: targets({ stable: target("0.1.29") }) });
    expect(await checker("0.1.30", "stable", ahead.fetchImpl).checkNow()).toMatchObject({
      updateAvailable: false,
      notice: UPDATE_NOTICES.ahead,
    });
    const none = tap({ targets: targets({ stable: target("0.1.29") }) });
    expect(await checker("0.1.30-alpha.1", "alpha", none.fetchImpl).checkNow()).toMatchObject({
      latestVersion: null,
      notice: UPDATE_NOTICES.none,
    });
  });

  it("says a failed read could not check, never that the copy is up to date", async () => {
    let time = 0;
    const { fetchImpl, replies } = tap({ targets: targets({ stable: target("0.1.31") }) });
    const updates = checker("0.1.30", "stable", fetchImpl, { now: () => time });
    expect((await updates.getStatus()).updateAvailable).toBe(true);
    time = 500;
    replies.targets = new Error("offline");
    const failed = await updates.checkNow();
    // The known offer stays; the failure is said.
    expect(failed).toMatchObject({
      latestVersion: "0.1.31",
      updateAvailable: true,
      phase: "error",
      problem: UPDATE_PROBLEMS.checkFailed,
    });
    const fresh = tap({ targets: { status: 500 } });
    const never = await checker("0.1.30", "stable", fresh.fetchImpl).checkNow();
    expect(never).toMatchObject({ phase: "error", problem: UPDATE_PROBLEMS.checkFailed });
    expect(never.notice).toBeUndefined();
    // The quiet check stays silent on failure.
    expect((await checker("0.1.30", "stable", fresh.fetchImpl).getStatus()).phase).toBeUndefined();
  });

  it("joins a check already reading", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(targets({ stable: target("0.1.31") }).body));
    }) as unknown as typeof fetch;
    const updates = checker("0.1.30", "stable", fetchImpl);
    const first = updates.checkNow();
    const second = updates.checkNow();
    const quiet = updates.getStatus();
    release();
    expect(await second).toEqual(await first);
    expect(await quiet).toEqual(await first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("the installed app's checker", () => {
  const STAND_IN_TARGETS = "http://127.0.0.1:9/targets";
  const standIns = {
    INFINITARY_SIMULATE_UPDATE: "0",
    INFINITARY_UPDATE_TARGETS_URL: STAND_IN_TARGETS,
    INFINITARY_UPDATE_CURRENT_VERSION: "0.1.25-alpha.2",
  };
  const alphaRoot = () => {
    const root = scratchDir("infinitary-update-root-");
    writeFileSync(
      join(root, UPDATE_CHANNEL_MARKER),
      JSON.stringify({ schemaVersion: 1, channel: "alpha" }),
    );
    return root;
  };
  const installed = (packaged: boolean, env: NodeJS.ProcessEnv) => {
    const requests: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response(JSON.stringify(targets({ alpha: target("0.1.25-alpha.10") }).body));
    }) as typeof fetch;
    const updates = createInstalledUpdateChecker({
      app: { version: "0.1.24", packaged, userDataDir: alphaRoot() },
      openExternal: () => {},
      env,
      fetchImpl,
    });
    return { updates, requests };
  };

  it("reads a development run's stand-in tap and version, and the marker in its own data root", async () => {
    const { updates, requests } = installed(false, standIns);
    expect(await updates.getStatus()).toMatchObject({
      currentVersion: "0.1.25-alpha.2",
      channel: "alpha",
      latestVersion: "0.1.25-alpha.10",
      updateAvailable: true,
    });
    expect(requests).toEqual([STAND_IN_TARGETS]);
  });

  it("never lets a packaged app read a stand-in", async () => {
    const { updates, requests } = installed(true, { ...standIns, INFINITARY_SIMULATE_UPDATE: "1" });
    expect(await updates.getStatus()).toMatchObject({
      currentVersion: "0.1.24",
      channel: "alpha",
      latestVersion: "0.1.25-alpha.10",
    });
    expect(requests).toEqual([TARGETS_URL]);
  });

  // INF-4258: an installed Windows copy reads the builds file for its
  // installer. A window controlling another computer is handed no way to
  // end for the installer, since it also runs that computer's work: it names
  // the version and the downloads page, and installs nothing.
  it("offers a Windows window controlling another computer its version and no install", async () => {
    const requests: string[] = [];
    const version = "0.1.25-alpha.10";
    const chip = thisDeviceSystem("win32").chip ?? process.arch;
    const release = target(version);
    const updates = createInstalledUpdateChecker({
      app: { version: "0.1.24", packaged: true, userDataDir: alphaRoot(), platform: "win32" },
      openExternal: () => {},
      env: {},
      fetchImpl: (async (url: string | URL | Request) => {
        requests.push(String(url));
        return Response.json({
          schemaVersion: 1,
          channels: {
            alpha: {
              version,
              releaseUrl: release.releaseUrl,
              sourceCommit: release.sourceCommit,
              // Keyed by the chip this run reads, so the reader finds an installer.
              systems: {
                windows: {
                  [chip]: {
                    exe: {
                      url: buildDownloadUrl(version, `Infinitary-${version}-windows-x64-setup.exe`),
                      sha256: "b".repeat(64),
                    },
                  },
                },
              },
            },
          },
        });
      }) as typeof fetch,
    });
    const status = await updates.checkNow();
    expect(status).toMatchObject({
      latestVersion: version,
      updateAvailable: true,
      releaseUrl: release.releaseUrl,
      upgradeCommand: "",
    });
    expect(status.install).toBeUndefined();
    expect(requests).toEqual([publicBuildsUrl]);
    expect(await updates.install()).toEqual({
      ok: false,
      problem: "There is no update this app can install itself.",
    });
  });

  // The old-cask switch (FI3-1780's rename, step 10; FI3-1729: "Infinitary
  // must record that it came in through the old cask, so its own update
  // notice keeps showing the same command"): an installation whose marker
  // says so reads Firstmate 3000's tap and names that cask's command, so it
  // is offered only what the command it uses installs.
  it("keeps an installation that came through the old cask on Firstmate 3000's tap and command", async () => {
    const root = scratchDir("infinitary-update-root-");
    writeFileSync(
      join(root, UPDATE_CHANNEL_MARKER),
      JSON.stringify({ schemaVersion: 1, channel: "alpha", cameThroughOldCask: true }),
    );
    const switched = buildUpdateTarget(
      {
        version: "0.4.2-alpha.3",
        assetName: "Infinitary-0.4.2-alpha.3-universal.zip",
        sha256: "a".repeat(64),
        sourceCommit: "c".repeat(40),
      },
      FIRSTMATE_TAP,
    );
    const requests: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response(JSON.stringify(targets({ alpha: switched }).body));
    }) as typeof fetch;
    const updates = createInstalledUpdateChecker({
      app: { version: "0.4.2-alpha.1", packaged: true, userDataDir: root },
      openExternal: () => {},
      env: {},
      fetchImpl,
    });
    expect(await updates.getStatus()).toEqual({
      checkedAt: expect.any(Number),
      currentVersion: "0.4.2-alpha.1",
      channel: "alpha",
      latestVersion: "0.4.2-alpha.3",
      updateAvailable: true,
      releaseUrl:
        "https://github.com/kunchenguid/homebrew-tap/releases/tag/firstmate-3000-alpha-v0.4.2-alpha.3",
      upgradeCommand: upgradeCommandFor("alpha", FIRSTMATE_TAP),
    });
    expect(requests).toEqual([targetsUrlOf(FIRSTMATE_TAP)]);
    // The same file names nothing Infinitary's own tap would offer.
    expect(requests).not.toContain(TARGETS_URL);
  });

  it("simulates the next version in a development run unless told not to", async () => {
    const { updates, requests } = installed(false, {});
    expect(await updates.getStatus()).toMatchObject({
      currentVersion: "0.1.24",
      latestVersion: "0.1.25-alpha.1",
      updateAvailable: true,
    });
    expect(requests).toEqual([]);
  });
});

// INF-2245 (INF-2223's approved stop-and-resume update): an in-app Linux
// update saves the crew's work before it replaces the copy, and Update
// later lets it go with nothing replaced.
describe("saving the crew's work before an in-app Linux update", () => {
  const BUILDS = "https://builds.example.invalid/infinitary-builds.json";
  const download = {
    url: buildDownloadUrl("0.6.3", "infinitary-0.6.3-linux-amd64.deb"),
    sha256: "b".repeat(64),
  };
  const release = target("0.6.3");
  const fetchImpl = (async () =>
    Response.json({
      schemaVersion: 1,
      channels: {
        stable: {
          version: "0.6.3",
          releaseUrl: release.releaseUrl,
          sourceCommit: release.sourceCommit,
          systems: { linux: { x64: { deb: download } } },
        },
      },
    })) as typeof fetch;

  function linuxUpdate(
    installLinux: (plan: LinuxInstallPlan, beforeReplace?: () => Promise<void>) => Promise<void>,
  ) {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work = {
      save: vi.fn<CrewWorkForUpdate["save"]>(({ signal, waiting }) => {
        waiting(["Release notes"]);
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve("withdrawn"), { once: true });
          void finished.then(() => resolve("saved"));
        });
      }),
      release: vi.fn<CrewWorkForUpdate["release"]>(),
      resuming: vi.fn<CrewWorkForUpdate["resuming"]>(() => []),
    };
    const updates = createUpdateChecker({
      currentVersion: "0.6.2",
      channel: () => "stable",
      linux: { chip: "x64", package: "deb" },
      buildsUrl: BUILDS,
      fetchImpl,
      openExternal: () => {},
      installLinux,
      saving: createUpdateSaving(work),
    });
    return { updates, work, finish };
  }

  it("replaces nothing until the work is saved, and nothing at all after Update later", async () => {
    let replaced = 0;
    const f = linuxUpdate(async (_plan, beforeReplace) => {
      await beforeReplace?.();
      replaced += 1;
    });
    expect((await f.updates.getStatus()).install).toBeDefined();
    let settled = false;
    const installing = f.updates.install().finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(f.work.save).toHaveBeenCalledTimes(1));
    expect((await f.updates.getStatus()).work).toEqual({
      state: "saving",
      tasks: ["Release notes"],
    });
    expect((await f.updates.later?.())?.work).toBeUndefined();
    // Update later answers once the install let go, so nothing reads it as still under way.
    expect(settled).toBe(true);
    expect(await installing).toEqual({ ok: false, later: true, problem: UPDATE_LATER });
    expect(replaced).toBe(0);
    expect(f.work.release).not.toHaveBeenCalled();
    const again = f.updates.install();
    await vi.waitFor(() => expect(f.work.save).toHaveBeenCalledTimes(2));
    f.finish();
    expect(await again).toEqual({ ok: true });
    expect(replaced).toBe(1);
  });

  it("lets the saved work carry on when the system's installer refuses", async () => {
    const f = linuxUpdate(async (_plan, beforeReplace) => {
      await beforeReplace?.();
      throw new UpdateInstallProblem("The password prompt was closed, so nothing was installed.");
    });
    f.finish();
    await f.updates.getStatus();
    expect(await f.updates.install()).toEqual({
      ok: false,
      problem: "The password prompt was closed, so nothing was installed.",
    });
    expect(f.work.release).toHaveBeenCalledTimes(1);
  });
});

// INF-3405, the captain's words: "it could be that there's an even newer version". Install
// reads the builds file first, so it installs the newest version, and installs the version
// already offered when that read fails.
describe("Install on Linux reads first", () => {
  const BUILDS = "https://builds.example.invalid/infinitary-builds.json";
  function builds(version: string) {
    const release = target(version);
    return {
      schemaVersion: 1,
      channels: {
        stable: {
          version,
          releaseUrl: release.releaseUrl,
          sourceCommit: release.sourceCommit,
          systems: {
            linux: {
              x64: {
                deb: {
                  url: buildDownloadUrl(version, `infinitary-${version}-linux-amd64.deb`),
                  sha256: "b".repeat(64),
                },
              },
            },
          },
        },
      },
    };
  }

  function linux() {
    const feed: { version: string; offline: boolean } = { version: "0.6.3", offline: false };
    const installed: string[] = [];
    const updates = createUpdateChecker({
      currentVersion: "0.6.2",
      channel: () => "stable",
      linux: { chip: "x64", package: "deb" },
      buildsUrl: BUILDS,
      fetchImpl: (async () => {
        if (feed.offline) throw new Error("offline");
        return Response.json(builds(feed.version));
      }) as typeof fetch,
      openExternal: () => {},
      installLinux: async (plan) => {
        installed.push(plan.version);
      },
    });
    return { updates, feed, installed };
  }

  it("installs a version published since the last read", async () => {
    const f = linux();
    expect((await f.updates.getStatus()).latestVersion).toBe("0.6.3");
    f.feed.version = "0.6.4";
    expect(await f.updates.install()).toEqual({ ok: true });
    expect(f.installed).toEqual(["0.6.4"]);
  });

  it("installs the version already offered when the read fails", async () => {
    const f = linux();
    await f.updates.getStatus();
    f.feed.offline = true;
    expect(await f.updates.install()).toEqual({ ok: true });
    expect(f.installed).toEqual(["0.6.3"]);
  });
});

// INF-4956's approved plan, piece 3: an installed copy's first answered feed
// read of each Pacific day carries the active mark, so the download server can
// count copies with no identifier, whatever Diagnostics says. Only a read of
// the download server carries it: never a Homebrew copy's tap, the Linux
// fallback to the tap, or a development run.
describe("the update check's active mark", () => {
  type Sent = { url: string; mark: string | null };
  function linuxCopy(packaged: boolean, builds: () => Response | Error) {
    const resourcesDir = scratchDir("inf-linux-resources-");
    writeFileSync(join(resourcesDir, PACKAGE_TYPE_FILE), "deb");
    const sent: Sent[] = [];
    const updates = createInstalledUpdateChecker({
      app: {
        version: "0.6.2",
        packaged,
        userDataDir: scratchDir("inf-linux-data-"),
        platform: "linux",
        resourcesDir,
      },
      openExternal: () => {},
      env: packaged
        ? {}
        : { INFINITARY_SIMULATE_UPDATE: "0", INFINITARY_UPDATE_LINUX_PACKAGE: "deb" },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({
          url: String(url),
          mark: new Headers(init?.headers).get(ACTIVE_MARK_HEADER),
        });
        const reply = String(url) === publicBuildsUrl ? builds() : Response.json({});
        if (reply instanceof Error) throw reply;
        return reply;
      }) as typeof fetch,
    });
    return { updates, sent };
  }
  const answered = () => Response.json({ schemaVersion: 1, channels: {} });

  it("marks a Linux copy's first answered read of the builds file, and no later one", async () => {
    const f = linuxCopy(true, answered);
    await f.updates.checkNow();
    await f.updates.checkNow();
    expect(f.sent).toEqual([
      { url: publicBuildsUrl, mark: "day, month" },
      { url: publicBuildsUrl, mark: null },
    ]);
  });

  it("never sends the mark to the tap, and spends it only once the download server answers", async () => {
    let builds: () => Response | Error = () => new Error("offline");
    const f = linuxCopy(true, () => builds());
    await f.updates.checkNow();
    builds = () => new Response("missing", { status: 404 });
    await f.updates.checkNow();
    builds = answered;
    await f.updates.checkNow();
    await f.updates.checkNow();
    expect(f.sent).toEqual([
      { url: publicBuildsUrl, mark: "day, month" },
      { url: BUILDS_URL, mark: null },
      { url: publicBuildsUrl, mark: "day, month" },
      { url: BUILDS_URL, mark: null },
      { url: publicBuildsUrl, mark: "day, month" },
      { url: publicBuildsUrl, mark: null },
    ]);
  });

  it("sends nothing new from a Linux development run", async () => {
    const f = linuxCopy(false, answered);
    await f.updates.checkNow();
    expect(f.sent).toEqual([{ url: publicBuildsUrl, mark: null }]);
  });

  function macCopy(packaged: boolean, installation: MacUpdateDriver["installation"]) {
    const marks: (string | null)[] = [];
    const feed = { offline: false };
    const driver: MacUpdateDriver = {
      installation,
      check: async (_channel, mark) => {
        marks.push(mark?.value ?? null);
        if (feed.offline) throw new Error("offline");
        mark?.answered();
        return null;
      },
      download: async () => {},
      install: async () => {},
    };
    const sent: string[] = [];
    const updates = createInstalledUpdateChecker({
      app: { version: "0.6.2", packaged, userDataDir: scratchDir("inf-mac-data-") },
      openExternal: () => {},
      env: {},
      macDriver: driver,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push(`${String(url)} ${new Headers(init?.headers).get(ACTIVE_MARK_HEADER)}`);
        return Response.json(targets({}).body);
      }) as typeof fetch,
    });
    return { updates, marks, feed, sent };
  }

  it("hands a direct Mac copy's feed read the mark until the feed answered", async () => {
    const f = macCopy(true, { kind: "direct" });
    f.feed.offline = true;
    await f.updates.checkNow();
    f.feed.offline = false;
    await f.updates.checkNow();
    await f.updates.checkNow();
    expect(f.marks).toEqual(["day, month", "day, month", null]);
  });

  it("sends nothing new from a Mac development run or a Homebrew copy", async () => {
    const dev = macCopy(false, { kind: "direct" });
    await dev.updates.checkNow();
    expect(dev.marks).toEqual([null]);
    const homebrew = macCopy(true, { kind: "homebrew", channel: "stable", tap: FIRSTMATE_TAP });
    await homebrew.updates.checkNow();
    expect(homebrew.marks).toEqual([]);
    expect(homebrew.sent).toEqual([`${targetsUrlOf(FIRSTMATE_TAP)} null`]);
  });
});

// INF-4258, as INF-5230's plan re-scoped INF-4243's piece 7: Windows takes
// one-click updates on the alpha and stable channels from the builds file,
// under windows, x64 and exe, each channel its own version's installer.
describe("updates on Windows", () => {
  const BUILDS = "https://builds.example.invalid/infinitary-builds.json";
  const setupOf = (version: string) => ({
    url: buildDownloadUrl(version, `Infinitary-${version}-windows-x64-setup.exe`),
    sha256: "d".repeat(64),
  });
  function entry(version: string, withWindows = true) {
    const release = target(version);
    return {
      version,
      releaseUrl: release.releaseUrl,
      sourceCommit: release.sourceCommit,
      systems: {
        macos: {
          arm64: {
            zip: {
              url: buildDownloadUrl(version, `Infinitary-${version}-universal.zip`),
              sha256: "a".repeat(64),
            },
          },
        },
        linux: {
          x64: {
            deb: {
              url: buildDownloadUrl(version, `infinitary-${version}-linux-amd64.deb`),
              sha256: "b".repeat(64),
            },
          },
        },
        ...(withWindows ? { windows: { x64: { exe: setupOf(version) } } } : {}),
      },
    };
  }

  function windows(
    channel: UpdateChannel,
    channels: Record<string, unknown>,
    handOver?: { problem: string },
  ) {
    const installed: WindowsInstallPlan[] = [];
    const work = {
      save: vi.fn<CrewWorkForUpdate["save"]>(async () => "saved"),
      release: vi.fn<CrewWorkForUpdate["release"]>(),
      resuming: vi.fn<CrewWorkForUpdate["resuming"]>(() => []),
    };
    const order: string[] = [];
    const updates = createUpdateChecker({
      currentVersion: "0.8.3-alpha.1",
      channel: () => channel,
      windows: { chip: "x64" },
      ...(handOver ? { windowsHandOverProblem: handOver.problem } : {}),
      buildsUrl: BUILDS,
      fetchImpl: (async () => Response.json({ schemaVersion: 1, channels })) as typeof fetch,
      openExternal: () => {},
      installWindows: async (plan, beforeReplace) => {
        await beforeReplace?.();
        order.push("installer");
        installed.push(plan);
      },
      saving: createUpdateSaving({
        ...work,
        save: async (options) => {
          order.push("saved");
          return work.save(options);
        },
      }),
    });
    return { updates, installed, order, work };
  }

  it("installs alpha's installer in one click, after the crew's work is saved", async () => {
    const f = windows("alpha", { stable: entry("0.8.2"), alpha: entry("0.8.3-alpha.4") });
    const status = await f.updates.getStatus();
    expect(status).toMatchObject({
      latestVersion: "0.8.3-alpha.4",
      updateAvailable: true,
      upgradeCommand: "",
      install: { asksPassword: false, restarts: true },
    });
    expect(await f.updates.install()).toEqual({ ok: true });
    expect(f.order).toEqual(["saved", "installer"]);
    expect(f.installed).toEqual([
      {
        version: "0.8.3-alpha.4",
        channel: "alpha",
        download: setupOf("0.8.3-alpha.4"),
        page: target("0.8.3-alpha.4").releaseUrl,
      },
    ]);
  });

  it("installs stable's own installer on stable, never alpha's newer one", async () => {
    const f = windows("stable", { stable: entry("0.8.4"), alpha: entry("0.8.5-alpha.1") });
    expect((await f.updates.getStatus()).latestVersion).toBe("0.8.4");
    expect(await f.updates.install()).toEqual({ ok: true });
    expect(f.installed).toEqual([
      {
        version: "0.8.4",
        channel: "stable",
        download: setupOf("0.8.4"),
        page: target("0.8.4").releaseUrl,
      },
    ]);
  });

  it("offers nothing, and keeps working, when the channel's version has no Windows installer", async () => {
    const f = windows("alpha", { alpha: entry("0.8.3-alpha.4", false) });
    const status = await f.updates.checkNow();
    expect(status).toMatchObject({
      updateAvailable: false,
      latestVersion: null,
      notice: UPDATE_NOTICES.none,
    });
    expect(status.install).toBeUndefined();
    expect(status.problem).toBeUndefined();
    expect(await f.updates.install()).toEqual({
      ok: false,
      problem: "There is no update this app can install itself.",
    });
    expect(f.installed).toEqual([]);
  });

  // The captain's choices on the review: a hand-over that did not finish
  // keeps this copy and says so, with Try again, until the next attempt.
  it("says what the hand-over did not finish beside the offer until the next attempt", async () => {
    const problem = WINDOWS_HAND_OVER_WORDS.installFailed;
    const f = windows("alpha", { alpha: entry("0.8.3-alpha.4") }, { problem });
    expect(await f.updates.getStatus()).toMatchObject({
      updateAvailable: true,
      problem,
      install: { asksPassword: false, restarts: true },
    });
    expect(await f.updates.install()).toEqual({ ok: true });
    expect((await f.updates.checkNow()).problem).toBeUndefined();
  });

  it("lets the saved work carry on when the download is refused", async () => {
    const f = windows("alpha", { alpha: entry("0.8.3-alpha.4") });
    const refusing = createUpdateChecker({
      currentVersion: "0.8.3-alpha.1",
      channel: () => "alpha",
      windows: { chip: "x64" },
      buildsUrl: BUILDS,
      fetchImpl: (async () =>
        Response.json({
          schemaVersion: 1,
          channels: { alpha: entry("0.8.3-alpha.4") },
        })) as typeof fetch,
      openExternal: () => {},
      installWindows: async (_plan, beforeReplace) => {
        await beforeReplace?.();
        throw new UpdateInstallProblem("The installer could not start, so nothing was installed.");
      },
      saving: createUpdateSaving(f.work),
    });
    await refusing.getStatus();
    expect(await refusing.install()).toEqual({
      ok: false,
      problem: "The installer could not start, so nothing was installed.",
    });
    expect(f.work.release).toHaveBeenCalledTimes(1);
  });
});

describe("a Windows copy opened on a data folder of its own", () => {
  // The hand-over reopens such a copy on that folder, so the copy reads the
  // switch as Chromium does, or an update opens the person's own folder instead.
  it.each([
    [["Infinitary.exe", "--user-data-dir=C:\\data"], true],
    [["Infinitary.exe", "-user-data-dir=C:\\data"], true],
    [["Infinitary.exe", "/USER-DATA-DIR=C:\\data"], true],
    [["Infinitary.exe", "--user-data-dir"], false],
    [["Infinitary.exe", "--", "--user-data-dir=C:\\data"], false],
    [["Infinitary.exe", "run"], false],
  ])("reads %j as %s", (argv, opened) => {
    expect(openedOnSwitch(argv)).toBe(opened);
  });
});
