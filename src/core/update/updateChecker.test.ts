import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateChannel } from "@shared/update";
import { UPDATE_LATER, UPDATE_NOTICES, UPDATE_PROBLEMS } from "@shared/updateWords";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type LinuxInstallPlan, UpdateInstallProblem } from "./linuxInstall";
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
  pickNewestStableRelease,
} from "./updateChecker";
import { type CrewWorkForUpdate, createUpdateSaving } from "./updateWork";

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

/** The tap as the checker reads it: the targets file and the release list. */
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
      currentVersion: "0.1.25",
      channel: "stable",
      latestVersion: "0.1.25",
      updateAvailable: false,
      releaseUrl: target("0.1.25").releaseUrl,
      upgradeCommand: upgradeCommandFor("stable"),
      // INF-2073: the Version row in Settings says what a read found.
      notice: UPDATE_NOTICES.latest,
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
    // ...a good status holds within the interval...
    time = 900;
    await updates.getStatus();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // ...and survives a later invalid file.
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
    expect(await updates.getStatus()).toMatchObject({
      updateAvailable: false,
      notice: UPDATE_NOTICES.latest,
    });
    // Within the interval the quiet check keeps its answer; a press does not.
    time = 500;
    replies.targets = targets({ stable: target("0.1.31") });
    expect((await updates.getStatus()).updateAvailable).toBe(false);
    const found = await updates.checkNow();
    expect(found).toMatchObject({ latestVersion: "0.1.31", updateAvailable: true });
    expect(found.notice).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The quiet check now answers what the press found.
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
  /** A data root the alpha cask's installer wrote its marker into. */
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
    const installing = f.updates.install();
    await vi.waitFor(() => expect(f.work.save).toHaveBeenCalledTimes(1));
    expect((await f.updates.getStatus()).work).toEqual({
      state: "saving",
      tasks: ["Release notes"],
    });
    expect((await f.updates.later?.())?.work).toBeUndefined();
    expect(await installing).toEqual({ ok: false, later: true, problem: UPDATE_LATER });
    expect(replaced).toBe(0);
    expect(f.work.release).not.toHaveBeenCalled();
    // Chosen again, it saves and replaces once.
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
