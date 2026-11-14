import * as m from "@shared/i18n/messages.generated";
import type { UpdateInstallResult, UpdateStatus } from "@shared/update";
import { UPDATE_PROBLEMS } from "@shared/updateWords";
import { describe, expect, it, vi } from "vitest";
import { createHomeUpdates, type UpdatingWindow } from "./homeUpdate";
import type { UpdateChecker } from "./updateChecker";

// INF-4012's direction 1, which the captain chose with "1 and 2 together": a paired phone or Mac
// sees the first mate's computer's update and presses Update or Update later. It offers only what
// that computer's own Version row offers, and runs that computer's own install, which saves the
// crew's work first (docs/view.md, "Updating the first mate's computer").

/** An installed alpha on a Mac, as its updater reads it with a newer alpha out. */
function macStatus(extra: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    currentVersion: "0.7.2-alpha.577",
    channel: "alpha",
    latestVersion: "0.7.2-alpha.590",
    updateAvailable: true,
    releaseUrl: null,
    upgradeCommand: "",
    install: { asksPassword: false, restarts: true },
    phase: "idle",
    ...extra,
  };
}

/** An updater whose install the test ends, and whose status it moves along. */
function updater(initial: UpdateStatus) {
  let status = initial;
  let end: (result: UpdateInstallResult) => void = () => {};
  const install = vi.fn(
    () =>
      new Promise<UpdateInstallResult>((resolve) => {
        end = resolve;
      }),
  );
  const later = vi.fn(async () => status);
  const updates: UpdateChecker = {
    getStatus: async () => status,
    checkNow: async () => status,
    openReleasePage: async () => {},
    install,
    later,
  };
  return {
    updates,
    install,
    later,
    move: (next: Partial<UpdateStatus>) => {
      status = { ...status, ...next };
    },
    end: (result: UpdateInstallResult) => end(result),
  };
}

const stops = () => ({ tasks: ["Fix the flaky test"], jobs: 2 });

describe("the first mate's computer's update, as a paired view sees it", () => {
  it("offers only what that computer's own Version row offers", async () => {
    // Homebrew: the updater offers no install, so the view is told it happens at the computer.
    const brew = createHomeUpdates({
      updates: updater(macStatus({ install: undefined, upgradeCommand: "brew upgrade" })).updates,
      stops,
    });
    expect(await brew.status()).toMatchObject({
      step: "elsewhere",
      offered: null,
      problem: m.viewHomeUpdateAtComputer(),
    });
    // A Linux package that asks for a password installs only at the computer.
    const password = createHomeUpdates({
      updates: updater(macStatus({ install: { asksPassword: true } })).updates,
      stops,
    });
    expect(await password.status()).toMatchObject({
      step: "elsewhere",
      offered: null,
      problem: m.viewHomeUpdateAsksPassword(),
    });
    const mac = createHomeUpdates({ updates: updater(macStatus()).updates, stops });
    expect(await mac.status()).toEqual({
      version: "0.7.2-alpha.577",
      channel: "alpha",
      offered: "0.7.2-alpha.590",
      step: "offered",
      waitingFor: [],
      stops: { tasks: ["Fix the flaky test"], jobs: 2 },
      problem: null,
    });
  });

  it("calls a check that could not reach the releases no failed update", async () => {
    const offline = createHomeUpdates({
      updates: updater(macStatus({ phase: "error", problem: UPDATE_PROBLEMS.checkFailed })).updates,
      stops,
    });
    expect(await offline.status()).toMatchObject({ step: "offered", problem: null });
    const nothingKnown = createHomeUpdates({
      updates: updater(
        macStatus({
          updateAvailable: false,
          latestVersion: null,
          phase: "error",
          problem: UPDATE_PROBLEMS.checkFailed,
        }),
      ).updates,
      stops,
    });
    expect(await nothingKnown.status()).toMatchObject({ step: "current", offered: null });
  });

  it("starts nothing when nothing newer is offered", async () => {
    const mac = updater(macStatus({ updateAvailable: false, latestVersion: "0.7.2-alpha.577" }));
    const home = createHomeUpdates({ updates: mac.updates, stops });
    expect(await home.install("the phone")).toMatchObject({ step: "current", offered: null });
    expect(mac.install).not.toHaveBeenCalled();
  });

  it("runs the computer's own install for the view, says what it waits for, and keeps how it failed", async () => {
    const mac = updater(macStatus());
    const asked = vi.fn();
    const home = createHomeUpdates({ updates: mac.updates, stops, asked });
    // The install answers before the updater moves: the view sees it starting and keeps reading.
    expect(await home.install("the phone")).toMatchObject({ step: "starting" });
    expect(mac.install).toHaveBeenCalledTimes(1);
    // The computer's own window hears who started it, so someone there can choose Update later.
    expect(asked).toHaveBeenCalledWith("the phone");
    expect(await home.own()).toMatchObject({ askedFrom: "the phone" });
    // A second press while it runs starts nothing twice.
    mac.move({ work: { state: "saving", tasks: ["Fix the flaky test"] } });
    expect(await home.install("the phone")).toMatchObject({
      step: "saving",
      waitingFor: ["Fix the flaky test"],
    });
    expect(mac.install).toHaveBeenCalledTimes(1);
    mac.move({ work: undefined, phase: "idle" });
    mac.end({ ok: false, problem: "The download could not be verified." });
    await vi.waitFor(async () =>
      expect(await home.status()).toMatchObject({
        step: "failed",
        offered: "0.7.2-alpha.590",
        problem: "The download could not be verified.",
      }),
    );
    expect((await home.own()).askedFrom).toBeUndefined();
    // Someone at the computer presses Update and restart: its notice and every view follow that
    // install, never the remote one's old failure.
    mac.move({ phase: "downloading", percent: 40 });
    expect(await home.own()).toMatchObject({ phase: "downloading", percent: 40 });
    expect(await home.status()).toMatchObject({ step: "downloading", problem: null });
    mac.move({ phase: "idle", percent: undefined });
    expect(await home.status()).toMatchObject({ step: "offered", problem: null });
  });

  it("counts Update later at the computer as no failure", async () => {
    const mac = updater(macStatus());
    const home = createHomeUpdates({ updates: mac.updates, stops });
    await home.install("the phone");
    mac.end({ ok: false, problem: "Update later", later: true });
    await vi.waitFor(async () => expect((await home.own()).askedFrom).toBeUndefined());
    expect(await home.status()).toMatchObject({ step: "offered", problem: null });
    await home.later();
    expect(mac.later).toHaveBeenCalledTimes(1);
  });
});

describe("a Mac whose first mate a command started", () => {
  /** The window beside the first mate, closed until it is started. */
  function besideWindow(comes: boolean) {
    let open = false;
    const ask = vi.fn(async (_step: "status" | "install" | "later", _from?: string) => macStatus());
    const window: UpdatingWindow = {
      open: () => open,
      ask,
      start: vi.fn(() => {
        if (comes) setTimeout(() => (open = true), 5);
      }),
    };
    return { window, ask };
  }

  it("opens its closed window and asks it to install, naming the view", async () => {
    const mac = updater(macStatus());
    const { window, ask } = besideWindow(true);
    const home = createHomeUpdates({ updates: mac.updates, window, stops, windowEveryMs: 1 });
    expect(await home.install("the phone")).toMatchObject({ step: "starting" });
    expect(window.start).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledWith("install", "the phone"));
    // The first mate never installs the copy itself: only the window does.
    expect(mac.install).not.toHaveBeenCalled();
  });

  it("says the update did not start when the window never opens", async () => {
    const mac = updater(macStatus());
    const { window, ask } = besideWindow(false);
    const home = createHomeUpdates({
      updates: mac.updates,
      window,
      stops,
      windowWaitMs: 20,
      windowEveryMs: 1,
    });
    await home.install("the phone");
    await vi.waitFor(async () =>
      expect(await home.status()).toMatchObject({
        step: "failed",
        problem: m.viewHomeUpdateNoWindow(),
      }),
    );
    expect(ask).not.toHaveBeenCalledWith("install", expect.anything());
    expect(mac.install).not.toHaveBeenCalled();
  });
});
