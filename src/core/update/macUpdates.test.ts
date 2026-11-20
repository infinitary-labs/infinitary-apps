import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { UpdateChannel } from "../../shared/update";
import { UPDATE_LATER, UPDATE_NOTICES, UPDATE_PROBLEMS } from "../../shared/updateWords";
import {
  DIRECT_MAC_INSTALLATION,
  homebrewInstallationReceipt,
  parseMacInstallation,
} from "./macInstallation";
import {
  createMacUpdateChecker,
  type MacUpdateDriver,
  type MacUpdateOffer,
  MacUpdateProblem,
  MacUpdateReadyProblem,
  saveMacUpdateChannel,
} from "./macUpdates";
import { releaseSource } from "./releaseSource";
import {
  buildUpdateTarget,
  FIRSTMATE_TAP,
  INFINITARY_TAP,
  readUpdateChannelMarker,
  targetsUrlOf,
  UPDATE_CHANNEL_MARKER,
  upgradeCommandFor,
} from "./updateChannels";
import { createInstalledUpdateChecker } from "./updateChecker";
import { type CrewWorkForUpdate, createUpdateSaving } from "./updateWork";

// INF-640 accepted plan: consented updates, persistent subscriptions and forward-only logical versions.
const offer = (version: string): MacUpdateOffer => ({
  version,
  releaseUrl: releaseSource.releaseUrl(version),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  version = "0.5.0-alpha.9",
  dataRoot = scratchDir("inf-mac-updates-"),
  work?: CrewWorkForUpdate,
) {
  const driver = {
    installation: { kind: "direct" as const },
    check: vi.fn<MacUpdateDriver["check"]>(async () => offer("0.5.0-alpha.10")),
    download: vi.fn<MacUpdateDriver["download"]>(async () => {}),
    install: vi.fn<MacUpdateDriver["install"]>(async () => {}),
  };
  const checker = createMacUpdateChecker({
    currentVersion: version,
    dataRoot,
    driver,
    releasesUrl: releaseSource.releasesUrl,
    openExternal: vi.fn(),
    ...(work ? { saving: createUpdateSaving(work) } : {}),
  });
  return { checker, driver, dataRoot };
}

/**
 * The crew's work as an update asks it (`CrewWorkForUpdate`): the save
 * waits on the task the test names until the test finishes it, and the
 * update's Update later withdraws it, as the crew supervisor does.
 */
function crewWork(resuming: string[] = []) {
  const finished = deferred<void>();
  const work = {
    save: vi.fn<CrewWorkForUpdate["save"]>(({ signal, waiting }) => {
      waiting(["Release notes"]);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve("withdrawn"), { once: true });
        void finished.promise.then(() => {
          waiting([]);
          resolve("saved");
        });
      });
    }),
    release: vi.fn<CrewWorkForUpdate["release"]>(),
    resuming: vi.fn<CrewWorkForUpdate["resuming"]>(() => resuming),
  };
  return { work, finish: () => finished.resolve() };
}

describe("INF-640 Mac update consent and channel ownership", () => {
  it.each([
    ["0.5.0", "stable"],
    ["0.5.0-alpha.9", "alpha"],
  ] as const)(
    "remembers fresh %s as %s before its first network check",
    async (version, channel) => {
      const f = fixture(version);
      f.driver.check.mockImplementation(async () => {
        expect(readUpdateChannelMarker(f.dataRoot)).toBe(channel);
        return null;
      });
      expect(await f.checker.getStatus()).toMatchObject({
        channel,
        updateAvailable: false,
        channelChoice: true,
      });
      expect(f.driver.download).not.toHaveBeenCalled();
      expect(f.driver.install).not.toHaveBeenCalled();
    },
  );

  it("keeps the explicit channel and saved work during the old-cask handover", async () => {
    const root = scratchDir("inf-mac-old-cask-");
    writeFileSync(
      join(root, UPDATE_CHANNEL_MARKER),
      JSON.stringify({ schemaVersion: 1, channel: "alpha", cameThroughOldCask: true }),
    );
    writeFileSync(join(root, "work.txt"), "Existing project work");
    const f = fixture("0.5.0", root);
    await f.checker.getStatus();
    expect(JSON.parse(readFileSync(join(root, UPDATE_CHANNEL_MARKER), "utf8"))).toEqual({
      schemaVersion: 1,
      channel: "alpha",
    });
    expect(readFileSync(join(root, "work.txt"), "utf8")).toBe("Existing project work");
  });

  it("adopts an explicit older version-bound subscription when an app is copied by hand", async () => {
    const root = scratchDir("inf-mac-versioned-channel-");
    writeFileSync(
      join(root, UPDATE_CHANNEL_MARKER),
      JSON.stringify({ schemaVersion: 1, channel: "alpha", version: "0.4.1" }),
    );
    const f = fixture("0.5.0", root);
    expect(await f.checker.getStatus()).toMatchObject({ channel: "alpha" });
    expect(JSON.parse(readFileSync(join(root, UPDATE_CHANNEL_MARKER), "utf8"))).toEqual({
      schemaVersion: 1,
      channel: "alpha",
    });
  });

  it("keeps alpha membership through promoted stable and next alpha across restarts", async () => {
    const alpha = fixture();
    alpha.driver.check.mockResolvedValue(offer("0.5.0"));
    expect(await alpha.checker.getStatus()).toMatchObject({
      channel: "alpha",
      latestVersion: "0.5.0",
      updateAvailable: true,
    });
    expect(await alpha.checker.install()).toEqual({ ok: true });
    const stable = fixture("0.5.0", alpha.dataRoot);
    stable.driver.check.mockResolvedValue(offer("0.5.1-alpha.11"));
    expect(await stable.checker.getStatus()).toMatchObject({
      channel: "alpha",
      latestVersion: "0.5.1-alpha.11",
      updateAvailable: true,
    });
    expect(await stable.checker.install()).toEqual({ ok: true });
  });

  it.each(["0.5.0-alpha.10", "0.5.0-beta.1", "not a version"])(
    "refuses %s on stable",
    async (version) => {
      const f = fixture("0.4.1");
      f.driver.check.mockResolvedValue(offer(version));
      expect(await f.checker.getStatus()).toMatchObject({
        channel: "stable",
        updateAvailable: false,
        phase: "error",
      });
      expect((await f.checker.install()).ok).toBe(false);
      expect(f.driver.download).not.toHaveBeenCalled();
    },
  );

  it("switches an ahead alpha to stable without downgrading", async () => {
    const f = fixture();
    f.driver.check.mockImplementation(async (channel) =>
      offer(channel === "stable" ? "0.4.1" : "0.5.0-alpha.10"),
    );
    await f.checker.getStatus();
    expect(await f.checker.setChannel?.("stable")).toMatchObject({
      channel: "stable",
      latestVersion: "0.4.1",
      updateAvailable: false,
    });
    expect((await f.checker.getStatus()).notice).toContain("without downgrading");
    expect((await f.checker.install()).ok).toBe(false);
    expect(f.driver.download).not.toHaveBeenCalled();
    expect(readUpdateChannelMarker(f.dataRoot)).toBe("stable");
  });

  it("reports a missing stable without inventing a target", async () => {
    const f = fixture();
    f.driver.check.mockResolvedValue(null);
    expect(await f.checker.setChannel?.("stable")).toMatchObject({
      latestVersion: null,
      updateAvailable: false,
      notice: "No release is available on this channel yet.",
    });
  });

  it("downloads only after consent and exposes real progress before installing", async () => {
    const f = fixture();
    const downloading = deferred<void>();
    const started = deferred<void>();
    f.driver.download.mockImplementation(async (_, progress) => {
      progress(42);
      started.resolve();
      await downloading.promise;
    });
    await f.checker.getStatus();
    expect(f.driver.download).not.toHaveBeenCalled();
    const installing = f.checker.install();
    await started.promise;
    expect(await f.checker.getStatus()).toMatchObject({ phase: "downloading", percent: 42 });
    expect(f.driver.install).not.toHaveBeenCalled();
    expect((await f.checker.install()).ok).toBe(false);
    downloading.resolve();
    expect(await installing).toEqual({ ok: true });
    expect(f.driver.install).toHaveBeenCalledTimes(1);
  });

  it("cancels the old download and cannot install it after a channel switch", async () => {
    const f = fixture();
    const downloading = deferred<void>();
    const started = deferred<AbortSignal>();
    f.driver.check.mockImplementation(async (channel) =>
      channel === "stable" ? null : offer("0.5.0-alpha.10"),
    );
    f.driver.download.mockImplementation(async (_, progress, signal) => {
      started.resolve(signal);
      await downloading.promise;
      progress(100);
    });
    const installing = f.checker.install();
    const signal = await started.promise;
    await f.checker.setChannel?.("stable");
    expect(signal.aborted).toBe(true);
    downloading.resolve();
    expect((await installing).ok).toBe(false);
    expect(f.driver.install).not.toHaveBeenCalled();
    expect(await f.checker.getStatus()).toMatchObject({
      channel: "stable",
      phase: "idle",
      latestVersion: null,
    });
  });

  it("ignores an old feed read that finishes after the channel changes", async () => {
    const f = fixture();
    const old = deferred<MacUpdateOffer>();
    const started = deferred<void>();
    f.driver.check.mockImplementation(async (channel: UpdateChannel) => {
      if (channel === "alpha") {
        started.resolve();
        return old.promise;
      }
      return offer("0.5.0");
    });
    const checking = f.checker.getStatus();
    await started.promise;
    await f.checker.setChannel?.("stable");
    old.resolve(offer("0.5.1-alpha.11"));
    await checking;
    expect(await f.checker.getStatus()).toMatchObject({
      channel: "stable",
      latestVersion: "0.5.0",
    });
  });

  it("does not transfer installation consent to a channel chosen while checking", async () => {
    const f = fixture();
    const old = deferred<MacUpdateOffer>();
    const started = deferred<void>();
    f.driver.check.mockImplementation(async (channel: UpdateChannel) => {
      if (channel === "alpha") {
        started.resolve();
        return old.promise;
      }
      return offer("0.5.0");
    });
    const installing = f.checker.install();
    await started.promise;
    await f.checker.setChannel?.("stable");
    old.resolve(offer("0.5.0-alpha.10"));
    expect((await installing).ok).toBe(false);
    expect(f.driver.download).not.toHaveBeenCalled();
    expect(f.driver.install).not.toHaveBeenCalled();
    expect(await f.checker.getStatus()).toMatchObject({
      channel: "stable",
      latestVersion: "0.5.0",
      updateAvailable: true,
    });
  });

  it("keeps the chosen channel when saving another fails", async () => {
    const f = fixture();
    await f.checker.getStatus();
    // A read-only installation can be tested without chmod assumptions when tests run as root:
    // an existing directory at the atomic replacement path refuses the write on every platform.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(f.dataRoot, `${UPDATE_CHANNEL_MARKER}.tmp`));
    await expect(f.checker.setChannel?.("stable")).rejects.toThrow();
    expect(readUpdateChannelMarker(f.dataRoot)).toBe("alpha");
    expect((await f.checker.getStatus()).channel).toBe("alpha");
  });

  it("reports permission failure and never calls native installation", async () => {
    const f = fixture();
    f.driver.download.mockRejectedValue(
      new MacUpdateProblem("Copy Infinitary into Applications and open that copy before updating."),
    );
    expect(await f.checker.install()).toEqual({
      ok: false,
      problem: "Copy Infinitary into Applications and open that copy before updating.",
    });
    expect((await f.checker.getStatus()).phase).toBe("error");
    expect(f.driver.install).not.toHaveBeenCalled();
  });

  // The captain's INF-2670 answer: a failure the app cannot fix here withdraws
  // Update and restart for this copy, so the releases page is the way on.
  it("withdraws installing after a problem it cannot fix, through a new check", async () => {
    const f = fixture();
    f.driver.download.mockRejectedValue(new MacUpdateProblem(UPDATE_PROBLEMS.unwritable));
    await f.checker.install();
    const after = await f.checker.checkNow();
    expect(after).toMatchObject({
      updateAvailable: true,
      phase: "idle",
      problem: UPDATE_PROBLEMS.unwritable,
    });
    expect(after.install).toBeUndefined();
    expect(await f.checker.install()).toEqual({ ok: false, problem: UPDATE_PROBLEMS.unwritable });
    expect(f.driver.download).toHaveBeenCalledTimes(1);
  });

  it("cannot change channels after native installation starts", async () => {
    const f = fixture();
    const staged = deferred<void>();
    const started = deferred<void>();
    f.driver.install.mockImplementation(async () => {
      started.resolve();
      await staged.promise;
    });
    const installing = f.checker.install();
    await started.promise;
    await expect(f.checker.setChannel?.("stable")).rejects.toThrow("after Infinitary restarts");
    expect(readUpdateChannelMarker(f.dataRoot)).toBe("alpha");
    staged.resolve();
    await installing;
  });

  it("remembers a manually selected channel across differently named installed builds", async () => {
    const root = scratchDir("inf-mac-channel-");
    saveMacUpdateChannel(root, "stable");
    const f = fixture("0.5.0-alpha.9", root);
    f.driver.check.mockResolvedValue(offer("0.5.0"));
    expect(await f.checker.getStatus()).toMatchObject({
      channel: "stable",
      latestVersion: "0.5.0",
      updateAvailable: true,
    });
  });
  it("keeps a staged update through restart failure and retries shutdown without downloading again", async () => {
    const f = fixture();
    f.driver.install.mockRejectedValueOnce(
      new MacUpdateReadyProblem("The update is ready. Try restarting again."),
    );
    expect((await f.checker.install()).ok).toBe(false);
    expect((await f.checker.getStatus()).phase).toBe("ready");
    await expect(f.checker.setChannel?.("stable")).rejects.toThrow("after Infinitary restarts");
    expect(await f.checker.install()).toEqual({ ok: true });
    expect(f.driver.download).toHaveBeenCalledTimes(1);
    expect(f.driver.install).toHaveBeenCalledTimes(2);
  });
});

// INF-2245 (INF-2223's approved stop-and-resume update): the crew's work
// stops where nothing is lost before the copy is replaced, and Update later
// lets the update go while it waits.
describe("saving the crew's work before a Mac update", () => {
  it("saves after the download and before native installation, naming the work it waits for", async () => {
    const crew = crewWork();
    const f = fixture(undefined, undefined, crew.work);
    const installing = f.checker.install();
    await vi.waitFor(() => expect(crew.work.save).toHaveBeenCalledTimes(1));
    expect(f.driver.download).toHaveBeenCalledTimes(1);
    expect(f.driver.install).not.toHaveBeenCalled();
    expect(await f.checker.getStatus()).toMatchObject({
      phase: "installing",
      work: { state: "saving", tasks: ["Release notes"] },
    });
    crew.finish();
    expect(await installing).toEqual({ ok: true });
    expect(f.driver.install).toHaveBeenCalledTimes(1);
    // The copy is being replaced: nothing reads as resuming before the restart.
    expect((await f.checker.getStatus()).work).toBeUndefined();
    expect(crew.work.release).not.toHaveBeenCalled();
  });

  it("installs nothing after Update later, and the update can be chosen again", async () => {
    const crew = crewWork();
    const f = fixture(undefined, undefined, crew.work);
    const installing = f.checker.install();
    await vi.waitFor(() => expect(crew.work.save).toHaveBeenCalledTimes(1));
    // Update later answers where the let-go update rests, never the installing it left (INF-4014's review).
    expect(await f.checker.later?.()).toMatchObject({ phase: "idle", updateAvailable: true });
    expect((await f.checker.getStatus()).work).toBeUndefined();
    expect(await installing).toEqual({ ok: false, later: true, problem: UPDATE_LATER });
    expect(f.driver.install).not.toHaveBeenCalled();
    expect(await f.checker.getStatus()).toMatchObject({ updateAvailable: true, phase: "idle" });
    // Chosen again, it saves again and installs.
    const again = f.checker.install();
    await vi.waitFor(() => expect(crew.work.save).toHaveBeenCalledTimes(2));
    crew.finish();
    expect(await again).toEqual({ ok: true });
    expect(f.driver.install).toHaveBeenCalledTimes(1);
  });

  it("lets the saved work carry on when native installation fails", async () => {
    const crew = crewWork();
    crew.finish();
    const f = fixture(undefined, undefined, crew.work);
    f.driver.install.mockRejectedValueOnce(
      new MacUpdateReadyProblem("The update is ready. Try restarting again."),
    );
    expect((await f.checker.install()).ok).toBe(false);
    expect(crew.work.release).toHaveBeenCalledTimes(1);
    expect((await f.checker.getStatus()).phase).toBe("ready");
  });

  it("shows the work an update paused as resuming after the restart", async () => {
    const crew = crewWork(["Release notes"]);
    const f = fixture(undefined, undefined, crew.work);
    expect((await f.checker.getStatus()).work).toEqual({
      state: "resuming",
      tasks: ["Release notes"],
    });
  });
});

// Captain's revised INF-643: keep Homebrew installation and updates alongside disk images.
// INF-2073, the captain's direction A: Check for updates in Settings reads the feed now.
describe("a pressed check on a direct Mac copy", () => {
  it("reads the feed again within four hours and finds the new release", async () => {
    const f = fixture("0.5.0-alpha.10");
    expect(await f.checker.getStatus()).toMatchObject({
      updateAvailable: false,
      notice: UPDATE_NOTICES.latest("alpha"),
    });
    f.driver.check.mockImplementation(async () => offer("0.5.0-alpha.11"));
    expect((await f.checker.getStatus()).updateAvailable).toBe(false);
    expect(await f.checker.checkNow()).toMatchObject({
      latestVersion: "0.5.0-alpha.11",
      updateAvailable: true,
      phase: "idle",
    });
    expect(f.driver.check).toHaveBeenCalledTimes(2);
    expect(f.driver.download).not.toHaveBeenCalled();
  });

  // INF-3405: a failed check keeps the update it already found, beside Check for updates.
  it("joins a reading check, reports a failure, and leaves a consented update alone", async () => {
    const f = fixture();
    const reading = deferred<MacUpdateOffer | null>();
    f.driver.check.mockImplementation(() => reading.promise);
    const first = f.checker.checkNow();
    const second = f.checker.checkNow();
    reading.resolve(offer("0.5.0-alpha.10"));
    expect(await second).toEqual(await first);
    expect(f.driver.check).toHaveBeenCalledTimes(1);

    f.driver.check.mockRejectedValueOnce(new Error("offline"));
    expect(await f.checker.checkNow()).toMatchObject({
      phase: "error",
      problem: UPDATE_PROBLEMS.checkFailed,
      latestVersion: "0.5.0-alpha.10",
      updateAvailable: true,
      install: { restarts: true },
    });

    f.driver.check.mockImplementation(async () => offer("0.5.0-alpha.10"));
    await f.checker.checkNow();
    const downloading = deferred<void>();
    f.driver.download.mockImplementation(() => downloading.promise);
    const installing = f.checker.install();
    await vi.waitFor(() => expect(f.driver.download).toHaveBeenCalled());
    const calls = f.driver.check.mock.calls.length;
    expect((await f.checker.checkNow()).phase).toBe("downloading");
    expect(f.driver.check).toHaveBeenCalledTimes(calls);
    downloading.resolve();
    await installing;
  });
});

// INF-3405, the captain's words: "we still need to provide the "check for update" button because
// it could be that there's an even newer version". The quiet read keeps a found update without a
// word, and Update and restart reads first so it installs the newest version.
describe("an offered update on a direct Mac copy", () => {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  function clocked() {
    let at = 1_800_000_000_000;
    const driver = {
      installation: { kind: "direct" as const },
      check: vi.fn<MacUpdateDriver["check"]>(async () => offer("0.5.0-alpha.10")),
      download: vi.fn<MacUpdateDriver["download"]>(async () => {}),
      install: vi.fn<MacUpdateDriver["install"]>(async () => {}),
    };
    const checker = createMacUpdateChecker({
      currentVersion: "0.5.0-alpha.9",
      dataRoot: scratchDir("inf-mac-updates-"),
      driver,
      releasesUrl: releaseSource.releasesUrl,
      openExternal: vi.fn(),
      now: () => at,
    });
    const pass = (ms: number) => {
      at += ms;
    };
    return { checker, driver, pass };
  }

  it("keeps the update without a word when the quiet read fails", async () => {
    const f = clocked();
    const found = await f.checker.getStatus();
    expect(found).toMatchObject({ latestVersion: "0.5.0-alpha.10", updateAvailable: true });
    f.pass(FOUR_HOURS);
    f.driver.check.mockRejectedValueOnce(new Error("offline"));
    expect(await f.checker.getStatus()).toEqual(found);
    expect(f.driver.check).toHaveBeenCalledTimes(2);
  });

  it("says a first quiet read failed, with nothing found to keep", async () => {
    const f = clocked();
    f.driver.check.mockRejectedValueOnce(new Error("offline"));
    expect(await f.checker.getStatus()).toMatchObject({
      phase: "error",
      problem: UPDATE_PROBLEMS.checkFailed,
      updateAvailable: false,
    });
  });

  it("installs the newest version, read when Update and restart is pressed", async () => {
    const f = clocked();
    await f.checker.getStatus();
    f.pass(FOUR_HOURS - 1);
    f.driver.check.mockImplementation(async () => offer("0.5.0-alpha.11"));
    expect(await f.checker.install()).toEqual({ ok: true });
    expect(f.driver.download).toHaveBeenCalledTimes(1);
    expect(f.driver.download.mock.calls[0]?.[0]).toEqual(offer("0.5.0-alpha.11"));
  });

  it("installs the version already offered when the read before it fails", async () => {
    const f = clocked();
    await f.checker.getStatus();
    f.driver.check.mockRejectedValueOnce(new Error("offline"));
    expect(await f.checker.install()).toEqual({ ok: true });
    expect(f.driver.check).toHaveBeenCalledTimes(2);
    expect(f.driver.download.mock.calls[0]?.[0]).toEqual(offer("0.5.0-alpha.10"));
  });
});

describe("per-copy Mac installation routing", () => {
  for (const tap of [INFINITARY_TAP, FIRSTMATE_TAP]) {
    it.each(["stable", "alpha"] as const)(
      `keeps ${tap.tap} %s updates with Homebrew`,
      async (channel) => {
        const f = fixture("0.5.0");
        const marker = JSON.stringify({
          schemaVersion: 1,
          channel: channel === "stable" ? "alpha" : "stable",
        });
        writeFileSync(join(f.dataRoot, UPDATE_CHANNEL_MARKER), marker);
        const target = buildUpdateTarget(
          {
            version: "0.5.1",
            assetName: "Infinitary-0.5.1-universal.zip",
            sha256: "a".repeat(64),
            sourceCommit: "b".repeat(40),
          },
          tap,
        );
        const fetchImpl = vi.fn<typeof fetch>(
          async () =>
            new Response(JSON.stringify({ schemaVersion: 1, targets: { [channel]: target } })),
        );
        const checker = createInstalledUpdateChecker({
          app: { packaged: true, platform: "darwin", version: "0.5.0", userDataDir: f.dataRoot },
          macDriver: {
            ...f.driver,
            installation: parseMacInstallation(homebrewInstallationReceipt(channel, tap)),
          },
          fetchImpl,
          openExternal: vi.fn(),
        });
        const status = await checker.getStatus();
        expect(status).toMatchObject({
          channel,
          latestVersion: target.version,
          updateAvailable: true,
          upgradeCommand: upgradeCommandFor(channel, tap),
        });
        expect(fetchImpl.mock.calls[0]?.[0]).toBe(targetsUrlOf(tap));
        expect(status.install).toBeUndefined();
        expect(checker.setChannel).toBeUndefined();
        expect((await checker.install()).ok).toBe(false);
        expect(f.driver.check).not.toHaveBeenCalled();
        expect(f.driver.download).not.toHaveBeenCalled();
        expect(f.driver.install).not.toHaveBeenCalled();
        expect(readFileSync(join(f.dataRoot, UPDATE_CHANNEL_MARKER), "utf8")).toBe(marker);
      },
    );
  }

  it("routes a direct copy through consented native updates despite an old Homebrew subscription", async () => {
    const f = fixture("0.5.0-alpha.9");
    writeFileSync(
      join(f.dataRoot, UPDATE_CHANNEL_MARKER),
      JSON.stringify({ schemaVersion: 1, channel: "alpha", cameThroughOldCask: true }),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const checker = createInstalledUpdateChecker({
      app: {
        packaged: true,
        platform: "darwin",
        version: "0.5.0-alpha.9",
        userDataDir: f.dataRoot,
      },
      macDriver: { ...f.driver, installation: parseMacInstallation(DIRECT_MAC_INSTALLATION) },
      fetchImpl,
      openExternal: vi.fn(),
    });
    expect(await checker.getStatus()).toMatchObject({
      updateAvailable: true,
      channel: "alpha",
      upgradeCommand: "",
      install: { asksPassword: false, restarts: true },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.driver.download).not.toHaveBeenCalled();
    await checker.install();
    expect(f.driver.download).toHaveBeenCalledOnce();
    expect(f.driver.install).toHaveBeenCalledOnce();
  });

  it("never treats missing or unreadable installation ownership as native-update permission", async () => {
    const f = fixture();
    const checker = createInstalledUpdateChecker({
      app: {
        packaged: true,
        platform: "darwin",
        version: "0.5.0-alpha.9",
        userDataDir: f.dataRoot,
      },
      macDriver: { ...f.driver, installation: parseMacInstallation("") },
      openExternal: vi.fn(),
    });
    expect(await checker.getStatus()).toMatchObject({ updateAvailable: false, upgradeCommand: "" });
    expect((await checker.install()).ok).toBe(false);
    expect(f.driver.check).not.toHaveBeenCalled();
    expect(f.driver.download).not.toHaveBeenCalled();
    expect(f.driver.install).not.toHaveBeenCalled();
  });
});

// INF-5372's plan, piece 2: an app on another computer gets "the home's version", so a Stable app can get an alpha.
describe("following the version of the computer this copy controls", () => {
  function following(version: string) {
    const dataRoot = scratchDir("inf-mac-follow-");
    saveMacUpdateChannel(dataRoot, "stable");
    const f = fixture(version, dataRoot);
    const checkVersion = vi.fn<NonNullable<MacUpdateDriver["checkVersion"]>>(async (exact) =>
      offer(exact),
    );
    const checker = createMacUpdateChecker({
      currentVersion: version,
      dataRoot,
      driver: { ...f.driver, checkVersion },
      releasesUrl: releaseSource.releasesUrl,
      openExternal: vi.fn(),
    });
    const { follow } = checker;
    if (!follow) throw new Error("A direct Mac copy gets one exact version by itself");
    return { ...f, checker, checkVersion, follow };
  }

  it("gets the home's alpha on a Stable copy and installs it with no second download or channel read", async () => {
    const f = following("0.8.3");
    expect(await f.follow("0.8.4-alpha.649")).toEqual({ ok: true });
    expect(f.checkVersion).toHaveBeenCalledWith("0.8.4-alpha.649");
    expect(f.driver.download).toHaveBeenCalledTimes(1);
    expect(f.driver.download.mock.calls[0]?.[0].version).toBe("0.8.4-alpha.649");
    const status = await f.checker.getStatus();
    expect(status).toMatchObject({ latestVersion: "0.8.4-alpha.649", updateAvailable: true });
    expect(await f.checker.install()).toEqual({ ok: true });
    expect(f.driver.download).toHaveBeenCalledTimes(1);
    expect(f.driver.install).toHaveBeenCalledTimes(1);
    expect(f.driver.check).not.toHaveBeenCalled();
  });

  it("answers unpublished for a version the release source never published, downloading nothing", async () => {
    const f = following("0.8.3");
    f.checkVersion.mockResolvedValueOnce(null);
    expect(await f.follow("0.8.4-dev.1")).toEqual({ ok: false, reason: "unpublished" });
    expect(f.driver.download).not.toHaveBeenCalled();
  });

  it("answers that its installation cannot be replaced when the download says so", async () => {
    const f = following("0.8.3");
    f.driver.download.mockRejectedValueOnce(
      new MacUpdateProblem("Copy Infinitary into Applications and open that copy before updating."),
    );
    expect(await f.follow("0.8.4")).toEqual({
      ok: false,
      reason: "installation",
      problem: "Copy Infinitary into Applications and open that copy before updating.",
    });
    expect(f.driver.install).not.toHaveBeenCalled();
  });
});
