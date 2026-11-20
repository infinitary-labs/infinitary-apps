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
  const told: AppFollowReport[] = [];
  let ready: (result: AppFollowResult) => void = () => {};
  const follow = vi.fn<NonNullable<UpdateChecker["follow"]>>(
    () => new Promise((resolve) => (ready = resolve)),
  );
  const install = vi.fn<UpdateChecker["install"]>(
    // A release quits to start again and never answers.
    () => new Promise<UpdateInstallResult>(() => {}),
  );
  const updates: UpdateChecker = {
    getStatus: async () => status(options.own ?? "0.8.3"),
    checkNow: async () => status(options.own ?? "0.8.3"),
    openReleasePage: async () => {},
    install,
    follow,
  };
  const follows = new AppFollowsHome({
    updates,
    homeVersion: async () => (options.home === undefined ? "0.8.4-alpha.649" : options.home),
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
    settle,
    ready: async (result: AppFollowResult) => {
      ready(result);
      await settle();
    },
    leave: () => {
      nobody = true;
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
    expect(a.told.at(-1)).toEqual({ version: "0.8.4-alpha.649", step: "restarting" });
  });

  it("starts again as soon as the version is here after Update app, whoever uses it", async () => {
    const a = app();
    a.follows.askedNow();
    await a.settle();
    await a.ready({ ok: true });
    expect(a.install).toHaveBeenCalledTimes(1);
    expect(a.told.map((report) => report.step)).toEqual(["getting", "restarting"]);
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
