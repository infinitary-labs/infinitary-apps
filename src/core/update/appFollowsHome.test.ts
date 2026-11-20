import type { AppFollowReport, AppFollowResult } from "@shared/appFollow";
import type { UpdateInstallResult, UpdateStatus } from "@shared/update";
import { describe, expect, it, vi } from "vitest";
import { AppFollowsHome } from "./appFollowsHome";
import type { UpdateChecker } from "./updateChecker";

// INF-5372's plan, piece 2: the app on another computer updates "by itself" to "the home's
// version" while nobody uses it, and the captain's "i think we should still provide a manual
// update flow in the devices view" starts it again at once.

const status = (currentVersion: string, more: Partial<UpdateStatus> = {}): UpdateStatus => ({
  currentVersion,
  channel: "stable",
  latestVersion: null,
  updateAvailable: false,
  releaseUrl: null,
  upgradeCommand: "",
  ...more,
});

function app(options: { own?: string; home?: string | null; nobody?: boolean } = {}) {
  let nobody = options.nobody ?? false;
  let home = options.home === undefined ? "0.8.4-alpha.649" : options.home;
  const told: AppFollowReport[] = [];
  let ready: (result: AppFollowResult) => void = () => {};
  const follow = vi.fn<NonNullable<UpdateChecker["follow"]>>(
    () => new Promise((resolve) => (ready = resolve)),
  );
  const install = vi.fn<NonNullable<UpdateChecker["installFollowed"]>>(
    // A release quits to start again and never answers.
    () => new Promise<UpdateInstallResult>(() => {}),
  );
  const unfollow = vi.fn();
  const updates: UpdateChecker = {
    getStatus: async () => status(options.own ?? "0.8.3"),
    checkNow: async () => status(options.own ?? "0.8.3"),
    openReleasePage: async () => {},
    // Only the followed version installs; the channel's install is never used.
    install: async () => {
      throw new Error("the channel's newest is never installed when following");
    },
    follow,
    installFollowed: install,
    unfollow,
  };
  const follows = new AppFollowsHome({
    updates,
    homeVersion: async () => home,
    tell: (report) => told.push(report),
    nobodyHere: () => nobody,
    every: () => () => {},
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    follows,
    told,
    follow,
    install,
    unfollow,
    settle,
    ready: async (result: AppFollowResult) => {
      ready(result);
      await settle();
    },
    leave: () => {
      nobody = true;
    },
    back: () => {
      nobody = false;
    },
    homeRuns: (version: string) => {
      home = version;
    },
  };
}

describe("an app following the version of the computer it controls", () => {
  it("gets the home's version, waits while someone uses it, then starts again once nobody does", async () => {
    const a = app();
    a.follows.connected();
    await a.settle();
    expect(a.follow).toHaveBeenCalledWith("0.8.4-alpha.649");
    await a.ready({ ok: true });
    expect(a.install).not.toHaveBeenCalled();
    expect(a.told.map((report) => report.step)).toEqual(["getting", "waiting"]);
    a.leave();
    a.follows.noticed();
    await a.settle();
    expect(a.install).toHaveBeenCalledTimes(1);
    expect(a.install.mock.calls[0]?.[0]).toBe("0.8.4-alpha.649");
    expect(a.told.at(-1)).toEqual({ version: "0.8.4-alpha.649", step: "restarting" });
    // Before it quits, the install asks again whether anybody came back.
    const stillWanted = a.install.mock.calls[0]?.[1];
    expect(stillWanted?.()).toBe(true);
    a.back();
    expect(stillWanted?.()).toBe(false);
  });

  it("starts again as soon as the version is here after Update app, whoever uses it", async () => {
    const a = app();
    a.follows.askedNow();
    await a.settle();
    await a.ready({ ok: true });
    expect(a.install).toHaveBeenCalledTimes(1);
    expect(a.told.map((report) => report.step)).toEqual(["getting", "restarting"]);
    // Asked from the row, it quits whoever uses it.
    expect(a.install.mock.calls[0]?.[1]()).toBe(true);
  });

  it("lets an Update app press go with a catching up that failed, so a later one waits for nobody", async () => {
    const a = app();
    a.follows.askedNow();
    await a.settle();
    await a.ready({ ok: false, failed: "The download stopped." });
    expect(a.told.at(-1)).toMatchObject({ step: "failed" });
    a.follows.connected();
    await a.settle();
    await a.ready({ ok: true });
    expect(a.install).not.toHaveBeenCalled();
    expect(a.told.at(-1)).toMatchObject({ step: "waiting" });
  });

  it("reads the home's version again at each connection and follows its newer one", async () => {
    const a = app();
    a.follows.connected();
    await a.settle();
    await a.ready({ ok: true });
    a.homeRuns("0.8.4-alpha.650");
    a.follows.connected();
    await a.settle();
    expect(a.follow).toHaveBeenLastCalledWith("0.8.4-alpha.650");
    await a.ready({ ok: true });
    a.leave();
    a.follows.noticed();
    await a.settle();
    expect(a.install.mock.calls.map((call) => call[0])).toEqual(["0.8.4-alpha.650"]);
  });

  it("ends what a connection started once it goes or another comes, then reads the home's version again", async () => {
    const a = app({ nobody: true });
    a.follows.connected();
    await a.settle();
    // A new connection while the download runs: the old one's version neither installs nor waits.
    a.homeRuns("0.8.4-alpha.650");
    a.follows.connected();
    await a.ready({ ok: true });
    expect(a.install).not.toHaveBeenCalled();
    expect(a.told.map((report) => report.step)).toEqual(["getting", "getting"]);
    expect(a.follow).toHaveBeenLastCalledWith("0.8.4-alpha.650");
    await a.ready({ ok: true });
    expect(a.install.mock.calls.map((call) => call[0])).toEqual(["0.8.4-alpha.650"]);
    // The connection goes during the install: it is no longer wanted before it quits.
    const stillWanted = a.install.mock.calls[0]?.[1];
    expect(stillWanted?.()).toBe(true);
    a.follows.lost();
    expect(stillWanted?.()).toBe(false);
  });

  it("says why a copy that only refuses cannot follow, in its own reason", async () => {
    const told: AppFollowReport[] = [];
    const follows = new AppFollowsHome({
      updates: {
        getStatus: async () => status("0.8.3"),
        checkNow: async () => status("0.8.3"),
        openReleasePage: async () => {},
        install: async () => ({ ok: false, problem: "no" }),
        follow: async () => ({ ok: false, reason: "package-manager" }),
      },
      homeVersion: async () => "0.8.4",
      tell: (report) => told.push(report),
      nobodyHere: () => true,
      every: () => () => {},
    });
    follows.connected();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(told.at(-1)).toEqual({ version: "0.8.4", step: "cannot", reason: "package-manager" });
  });

  it("stops following once it no longer controls that home, or the home runs its version", async () => {
    const a = app();
    a.follows.connected();
    await a.settle();
    await a.ready({ ok: true });
    a.homeRuns("0.8.3");
    a.follows.connected();
    await a.settle();
    expect(a.unfollow).toHaveBeenCalledTimes(1);
    a.follows.dispose();
    expect(a.unfollow).toHaveBeenCalledTimes(2);
    a.leave();
    a.follows.noticed();
    await a.settle();
    expect(a.install).not.toHaveBeenCalled();
  });

  it("does nothing while it runs the home's version or a newer one", async () => {
    const a = app({ own: "0.8.4-alpha.649" });
    a.follows.connected();
    await a.settle();
    expect(a.follow).not.toHaveBeenCalled();
    expect(a.told).toEqual([]);
  });

  it("tells the home it cannot, and why, so the home's card asks for it there", async () => {
    const a = app();
    a.follows.connected();
    await a.settle();
    await a.ready({ ok: false, reason: "package-manager" });
    expect(a.told.at(-1)).toEqual({
      version: "0.8.4-alpha.649",
      step: "cannot",
      reason: "package-manager",
    });
    expect(a.install).not.toHaveBeenCalled();
  });

  it("waits again when the install answers Update later", async () => {
    const a = app({ nobody: true });
    a.install.mockResolvedValueOnce({ ok: false, problem: "Saving work", later: true });
    a.follows.connected();
    await a.settle();
    await a.ready({ ok: true });
    expect(a.told.map((report) => report.step)).toEqual(["getting", "restarting", "waiting"]);
  });
});
