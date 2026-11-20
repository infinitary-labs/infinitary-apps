import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { BrowserViewer } from "@core/browser/browserViews";
import type { HomeConnection } from "@core/connection/connection";
import { CONTRACT_CHANGES } from "@core/connection/contractChanges";
import { claimLink, dialHome } from "@core/devices/dial";
import { HomeLink } from "@core/devices/homeLink";
import { JoinedHome } from "@core/devices/joinedHome";
import { lockFolder } from "@core/helper/lock";
import type { HomeHandOver } from "@core/homeMove/outgoing";
import { CardNotifier } from "@core/notifications";
import { upgradeCommandFor } from "@core/update/updateChannels";
import type { Card } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import type { ThisMac } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { PROTOCOL_MAJORS_BEHIND, PROTOCOL_VERSION } from "@shared/ipc";
import { DEFAULT_SAVED_KEYMAP, presetKeymap } from "@shared/keymap";
import type { PersonalExtensionView } from "@shared/personal/manifest";
import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { claimedPort } from "../../tests/helpers/claimedPort";
import {
  answerInOwnWords,
  CAPTAIN,
  OWN_READS,
  ownCards,
  ownWords,
} from "../../tests/helpers/firstMatesOwnWords";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  OFFERED,
  otherMac,
  ownCore,
  ownUpdates,
  shown,
  stopEachTest,
  stops,
} from "../../tests/helpers/shellStandIns";
import { Shell, type ShellOptions } from "./shell";
import { namedHere } from "./view/namedHere";

/**
 * What this app is, and the switch between holding Firstmate and controlling
 * it on another Mac (docs/view.md): the shell against a real other Mac - the
 * real connection and pairing over a stand-in core - with a stand-in for
 * this Mac's own core. The window on the first mate's own computer is
 * shell.localWindow.test.ts, and the window beside a command's first mate
 * shell.beside.test.ts.
 */

stopEachTest();

function shell(
  joinedDir = join(scratchDir("infinitary-shell-"), "joined"),
  work?: ShellOptions["work"],
) {
  const own = ownCore();
  // This Mac's Notification Center, and whether its window is in front.
  const notified: { title: string; body: string }[] = [];
  const window = { focused: false };
  // The view's own sockets to the other Mac, so a test can drop one.
  const sockets: WebSocket[] = [];
  const ownApp = ownUpdates();
  const startCore = vi.fn(async () => own.core);
  const closeConnection = vi.fn(async () => {});
  const restartWindows = vi.fn();
  const relaunch = vi.fn();
  const pushes: { channel: string; payload: unknown }[] = [];
  // The pages this Mac opened in its browser for the other Mac.
  const opened: string[] = [];
  const joined = new JoinedHome(joinedDir, () => {});
  const startConnectionSpy = vi.fn(
    (): HomeConnection => ({
      close: closeConnection,
      runningVersions: () => [],
      listening: () => [],
      localDoor: () => null,
      settled: async () => {},
      ask: () => Promise.reject(new Error("Nothing is connected.")),
      onWorkDevice: () => () => {},
      onViewDevice: () => () => {},
      onWorkVersion: () => () => {},
      welcomedNow: () => ({ versions: [], work: [], views: [] }),
      onListening: () => () => {},
      onAppSent: () => () => {},
      hold: () => {},
      moved: async () => {},
      goodbye: async () => {},
      routes: async () => {},
      liveToView: () => false,
    }),
  );
  const made = new Shell({
    joined,
    ...(work ? { work } : {}),
    startCore,
    startConnection: startConnectionSpy,
    broadcast: (channel, payload) => pushes.push({ channel, payload }),
    notifications: {
      supported: () => true,
      focused: () => window.focused,
      show: (notification) => notified.push(notification),
    },
    deviceName: async () => "MacBook Air",
    openPage: async (url) => {
      opened.push(url);
    },
    restartWindows,
    relaunch,
    view: {
      link: (options) =>
        new HomeLink({
          ...options,
          dial: async (grant) => {
            const socket = await dialHome(grant);
            sockets.push(socket);
            return socket;
          },
          retryMs: [20],
        }),
    },
    updates: ownApp.updates,
  });
  stops.push(() => made.dispose());
  const until = async (check: () => boolean) => {
    await expect.poll(check, { timeout: 4_000, interval: 10 }).toBe(true);
  };
  const view = () => made.thisMac() as Extract<ThisMac, { role: "view" }>;
  return {
    shell: made,
    joined,
    own,
    startCore,
    closeConnection,
    startConnectionSpy,
    restartWindows,
    relaunch,
    pushes,
    opened,
    notified,
    window,
    sockets,
    until,
    view,
    ownApp,
  };
}

describe("the app as a view of another Mac", () => {
  it("joins with a pasted link: stops its own Firstmate and asks the other Mac instead", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    expect(air.shell.thisMac()).toEqual({ role: "home", left: null });
    expect(await air.shell.dispatch("inf:app:healthcheck", [])).toEqual({
      ownCore: "inf:app:healthcheck",
    });
    // The core reaches the computers that run work through the connection,
    // and keeps its own SSH connection to each it added by its address, paused in sleep.
    expect(air.own.attach).toHaveBeenCalledWith(air.startConnectionSpy.mock.results[0]?.value);
    expect(air.own.ssh.start).toHaveBeenCalledTimes(1);
    // Pairing follows this Mac's network, so the connection listens where this Mac is now.
    expect(air.own.follow).toHaveBeenCalledTimes(1);
    air.shell.suspended();
    air.shell.resumed();
    expect(air.own.ssh.suspend).toHaveBeenCalledTimes(1);
    // Each device hears that this Mac goes to sleep (docs/devices.md, "Taking over").
    expect(air.own.goodbye).toHaveBeenCalledTimes(1);
    expect(air.own.ssh.resume).toHaveBeenCalledTimes(1);

    // A size key asks its own core as the captain, as the Size picker does,
    // so the catalog leaves the step's trail.
    air.shell.size["size.larger"]();
    await air.until(() =>
      air.own.dispatch.mock.calls.some(([channel]) => channel === "inf:settings:appearance:set"),
    );
    expect(
      air.own.dispatch.mock.calls.find(([channel]) => channel === "inf:settings:appearance:set"),
    ).toEqual([
      "inf:settings:appearance:set",
      [{ ...DEFAULT_SHELL_PREFERENCES.appearance, size: 110 }],
      { kind: "captain" },
      undefined,
    ]);

    // This Mac's own keys, kept by its own core.
    const own = {
      ...DEFAULT_SAVED_KEYMAP,
      keys: { "commands.search": [{ key: "p", meta: true }] },
    };
    air.shell.keymap.save(own);
    expect(air.shell.keymap.bindings()["commands.search"]).toEqual([{ key: "p", meta: true }]);

    await expect(air.shell.join(await pro.link())).resolves.toEqual({ ok: true });
    await air.until(() => air.restartWindows.mock.calls.length === 1);
    // Its own core and connection stopped, its SSH connections first, and nothing listens for devices here.
    expect(air.own.dispose).toHaveBeenCalledTimes(1);
    expect(air.own.stopSsh).toHaveBeenCalledTimes(1);
    expect(air.closeConnection).toHaveBeenCalledTimes(1);
    expect(air.own.unreach).toHaveBeenCalledTimes(1);
    expect(air.own.unfollow).toHaveBeenCalledTimes(1);
    expect(air.shell.core()).toBeNull();
    expect(air.shell.dictationEnabled()).toBe(false);
    await air.until(() => air.view().contact === "in-reach");
    expect(air.view()).toMatchObject({ role: "view", name: "MacBook Pro", address: "127.0.0.1" });
    expect(pro.pairing.list().map((device) => device.name)).toEqual(["MacBook Air"]);

    // What a view may ask goes to the other Mac.
    expect(await air.shell.dispatch("inf:app:healthcheck", [])).toMatchObject({
      platform: "other-os",
    });
    // What stays there is refused here, and never sent.
    await expect(air.shell.dispatch("inf:voice:status", [])).rejects.toThrow(
      "answered only on the computer where your first mate lives",
    );
    expect(pro.asked).not.toContain("inf:voice:status");
    // Its computers and phones are asked there (INF-1352's plan, piece 2).
    await expect(air.shell.dispatch("inf:devices:list", [])).rejects.toThrow("malformed request");
    expect(pro.asked).toContain("inf:devices:list");
    // Its look starts from the other Mac's, then is its own.
    expect((await air.shell.dispatch("inf:shell:preferences", [])).appearance).toMatchObject({
      theme: "light",
      size: 125,
    });
    await air.shell.dispatch("inf:settings:appearance:set", [{ theme: "dark", size: 110 }]);
    expect(air.shell.preferences.get().appearance).toEqual({ theme: "dark", size: 110 });
    expect(pro.asked.filter((channel) => channel.startsWith("inf:settings:"))).toEqual([]);
    // INF-3660's plan, "Your panels, in every window": "the first mate would
    // send each panel's built files over the window's connection, instead of
    // naming a folder", so this Mac asks there, and the panels switch it
    // shows is the first mate's.
    pro.stage.panel = { builtFor: "9.9.9", files: [{ path: "panel.mjs", data: "ZXhwb3J0IHt9" }] };
    const notes = { source: "yours" as const, id: "notes", version: "0".repeat(16) };
    expect(await air.shell.panelFiles(notes)).toEqual(pro.stage.panel);
    expect(pro.asked).toContain("inf:plugins:files");
    await air.until(() => air.shell.preferences.get().panels.enabled);
    // Its keys are this Mac's own here too: a new profile's preset to start, kept in its own look.
    expect(air.shell.keymap.current().saved).toEqual(presetKeymap("vim"));
    const here = { ...presetKeymap("vim"), keys: { "settings.open": [] } };
    air.shell.keymap.save(here);
    expect(air.joined.look()?.keyboard).toEqual(here);
    expect(air.own.core.services.preferences.keymap().saved).toEqual(own);
    expect(pro.asked.filter((channel) => channel.includes("keyboard"))).toEqual([]);

    // A push the stage shows reaches the window; the other Mac's look never does.
    pro.events.emit("inf:models:changed", { ok: true });
    pro.events.emit("inf:shell:preferences", DEFAULT_SHELL_PREFERENCES);
    pro.events.emit("inf:voice:progress", {
      file: "model.onnx",
      fileIndex: 0,
      fileCount: 1,
      fraction: 0.5,
    });
    await air.until(() => air.pushes.some((push) => push.channel === "inf:models:changed"));
    // The look told here is this Mac's own; the one the other Mac just sent
    // (the catalog's size) never is, though its panels switch is followed.
    const looks = air.pushes
      .filter((push) => push.channel === "inf:shell:preferences")
      .map((push) => (push.payload as ShellPreferences).appearance);
    expect(looks.at(-1)).toEqual({ theme: "dark", size: 110 });
    expect(looks.filter((look) => look.size === DEFAULT_SHELL_PREFERENCES.appearance.size)).toEqual(
      [],
    );

    // INF-3660's plan: "Panels being built ... stay with a window on the first
    // mate's computer", so this Mac hears the captain's panels and none being built.
    const panel: PersonalExtensionView = {
      id: "notes",
      source: "yours",
      by: null,
      title: "Notes",
      placement: { x: "left", y: "top" },
      order: 100,
      size: "content",
      present: true,
      ownPresence: false,
      moves: false,
      running: false,
      reads: [],
      sql: [],
      panel: null,
      frame: { version: "0".repeat(16) },
      server: null,
      cardViews: [],
      cards: {},
      header: [],
      commands: [],
      error: null,
    };
    pro.events.emit("inf:plugins:personal", {
      extensions: [panel],
      drafts: [{ ...panel, id: "notes-being-built", running: true }],
    });
    await air.until(() => air.pushes.some((push) => push.channel === "inf:plugins:personal"));
    expect(air.pushes.find((push) => push.channel === "inf:plugins:personal")?.payload).toEqual({
      extensions: [panel],
    });

    // Its size keys step this Mac's own look, through the same door, and never ask there.
    air.shell.size["size.larger"]();
    await air.until(() => air.shell.preferences.get().appearance.size === 125);
    expect(pro.asked.filter((channel) => channel.startsWith("inf:settings:"))).toEqual([]);
  });

  it("starts as a view after joining, with no core, and Leave brings its own Firstmate back in place", async () => {
    const pro = await otherMac();
    const dir = join(scratchDir("infinitary-shell-"), "joined");
    new JoinedHome(dir).join(
      await claimLink(await pro.link(), { kind: "view", name: "MacBook Air" }),
      Date.UTC(2026, 9, 3, 14, 6),
    );
    const air = shell(dir);
    await air.shell.start();
    expect(air.startCore).not.toHaveBeenCalled();
    await air.until(() => air.view().contact === "in-reach");

    await air.shell.leave();
    // The other Mac heard it, and lists it no more.
    expect(pro.pairing.list()).toEqual([]);
    // This Mac's own Firstmate starts here, the first time this process runs it.
    expect(air.startCore).toHaveBeenCalledTimes(1);
    expect(air.relaunch).not.toHaveBeenCalled();
    expect(air.restartWindows).toHaveBeenCalledTimes(1);
    expect(air.shell.thisMac()).toMatchObject({
      role: "home",
      left: { name: "MacBook Pro", reason: "left" },
    });
    // The grant and its key are gone.
    expect(air.joined.read()).toBeNull();
  });

  it("starts the app again to bring its own Firstmate back when this process already ran it", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");
    await air.shell.leave();
    expect(air.startCore).toHaveBeenCalledTimes(1);
    expect(air.relaunch).toHaveBeenCalledTimes(1);
  });

  // INF-3307's audit, row 10: two joins answered together each switched the
  // window to a view, and the first view stayed open beside the second.
  it("joins once when two links are pasted together, and leaves no second view open", async () => {
    const pro = await otherMac();
    const studio = await otherMac();
    const air = shell();
    await air.shell.start();
    const [first, second] = await Promise.all([
      air.shell.join(await pro.link()),
      air.shell.join(await studio.link()),
    ]);
    expect([first, second]).toEqual([{ ok: true }, { ok: false, refused: "other" }]);
    // The second link is never used, so the other computer keeps no device for it.
    expect(studio.pairing.list()).toEqual([]);
    await air.until(() => air.restartWindows.mock.calls.length === 1);
    await air.until(() => air.view().contact === "in-reach");
    // One view, with its one connection open to the Mac it joined.
    expect(air.sockets.filter((socket) => socket.readyState === socket.OPEN)).toHaveLength(1);
    expect(pro.pairing.list().map((device) => device.name)).toEqual(["MacBook Air"]);
    expect(air.own.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns to its own first launch, saying so, when the other Mac removes it", async () => {
    const pro = await otherMac();
    const dir = join(scratchDir("infinitary-shell-"), "joined");
    const grant = await claimLink(await pro.link(), { kind: "view", name: "MacBook Air" });
    new JoinedHome(dir).join(grant, Date.now());
    const air = shell(dir);
    await air.shell.start();
    await air.until(() => air.view().contact === "in-reach");
    pro.pairing.remove(grant.deviceId);
    await air.until(() => air.shell.thisMac().role === "home");
    expect(air.shell.thisMac()).toMatchObject({
      left: { name: "MacBook Pro", reason: "removed" },
    });
    expect(air.joined.read()).toBeNull();
  });

  it("steps down for a takeover it hears as its first mate starts only once it holds it: the record goes aside and the first mate stops", async () => {
    const pro = await otherMac();
    const grant = await claimLink(await pro.link(), { kind: "view", name: "MacBook Air" });
    const userData = scratchDir("infinitary-shell-home-");
    writeFileSync(join(userData, "firstmate.db"), "the record");
    const air = shell();
    (air.own.core.paths as { userData?: string }).userData = userData;
    // The copy that took over answers as the core starts, before this app holds it.
    air.startCore.mockImplementation((async (hooks?: {
      onHomeMoved?: (handOver: HomeHandOver | null) => void;
    }) => {
      hooks?.onHomeMoved?.({ move: "took-over-1", grant, homeNumber: 2, name: "Mac Studio" });
      return air.own.core;
    }) as unknown as () => Promise<typeof air.own.core>);
    await air.shell.start();
    await air.until(() => air.relaunch.mock.calls.length === 1);
    expect(air.own.dispose).toHaveBeenCalledTimes(1);
    expect(existsSync(join(userData, "firstmate.db"))).toBe(false);
    expect(readFileSync(join(userData, "moved-away", "took-over-1", "firstmate.db"), "utf8")).toBe(
      "the record",
    );
    expect(air.joined.read()?.grant.deviceId).toBe(grant.deviceId);
    expect(air.joined.homeNumber()).toBe(2);
  });

  it("refuses a change at once while the other Mac is out of reach, and says as of when", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");
    await pro.quit();
    await air.until(() => air.view().contact === "closed");
    expect(air.view().heardAt).not.toBeNull();
    await expect(air.shell.dispatch("inf:cards:close", ["card-1"])).rejects.toThrow("out of reach");
    expect(pro.asked).not.toContain("inf:cards:close");
    // The window hears each change of what this app is.
    expect(
      air.pushes.some(
        (push) =>
          push.channel === "inf:devices:this-mac" &&
          (push.payload as ThisMac).role === "view" &&
          (push.payload as { contact: string }).contact === "closed",
      ),
    ).toBe(true);
  });

  // INF-1352's plan, the captain's answer one_rule=every-view: this Mac does what the first
  // mate's own window would, whatever started it.
  it("asks what the first mate's own window would and opens the pages it sends", async () => {
    const mini = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await mini.link());
    await air.until(() => air.view().contact === "in-reach");

    // Its Settings are asked there; the stand-in core's refusal is its answer.
    await expect(air.shell.dispatch("inf:settings:routing:get", [])).rejects.toThrow(
      "malformed request",
    );
    expect(mini.asked).toContain("inf:settings:routing:get");
    // This Mac's own look stays here, and its devices are asked there.
    await air.shell.dispatch("inf:settings:appearance:set", [{ theme: "dark", size: 110 }]);
    expect(air.shell.preferences.get().appearance).toEqual({ theme: "dark", size: 110 });
    await expect(
      air.shell.dispatch("inf:devices:invite", [{ kind: "view", at: "127.0.0.1:1" }]),
    ).rejects.toThrow("malformed request");
    expect(mini.asked.filter((channel) => /appearance/.test(channel))).toEqual([]);
    expect(mini.asked).toContain("inf:devices:invite");

    // A sign-in's steps reach the window, and its page opens in this Mac's browser.
    const page = "https://auth.openai.com/oauth/authorize?client_id=app";
    mini.events.emit("inf:auth:notice", {
      providerId: "openai-codex",
      kind: "auth_url",
      message: "Finish signing in with your browser.",
      url: page,
    });
    mini.events.emit("inf:app:open-page", { url: page });
    await air.until(() => air.opened.length === 1);
    expect(air.opened).toEqual([page]);
    expect(air.pushes.map((push) => push.channel)).toContain("inf:auth:notice");
    expect(air.pushes.map((push) => push.channel)).not.toContain("inf:app:open-page");

    // One sent while this Mac was away is old news when the welcome replays it.
    air.sockets.at(-1)?.terminate();
    mini.events.emit("inf:app:open-page", { url: `${page}&again` });
    mini.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.some((push) => push.channel === "inf:models:changed"));
    expect(air.opened).toEqual([page]);
  });

  // INF-3486: a sentence the first mate's computer writes of itself as this computer names
  // that computer on one that controls it, and the captain's own words stay as they are.
  it("names that Mac where its own refusals and feed lines say this computer", async () => {
    const mini = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await mini.link());
    await air.until(() => air.view().contact === "in-reach");
    const named = ownWords("MacBook Pro");

    expect(await air.shell.dispatch("inf:feed:recent", [])).toEqual([
      { kind: "info", text: named.note, at: 1, taskKey: "HAR-1", event: "note", saidHere: true },
      { ...CAPTAIN, at: 2 },
    ]);
    expect(await air.shell.dispatch("inf:cards:open-page", ["page-card"])).toEqual({
      refusal: named.openPage,
    });
    expect(await air.shell.dispatch("inf:browser:reopen", ["sign-up"])).toEqual({
      ok: false,
      text: named.reopen,
    });
    const refused = await air.shell.dispatch("inf:browser:stop", ["sign-up"]).catch((e) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(refused.message).toContain(named.stop);
    expect(refused.message).not.toContain(HERE.This);

    // INF-3676: a task's record and the cards it wrote itself, read or pushed, are named too
    // (`namedHere.test.ts` owns what each names); a crewmate's card stays as it was.
    mini.show(ownCards());
    await air.until(() => air.pushes.some((push) => push.channel === "inf:cards"));
    for (const [channel, args] of OWN_READS) {
      const answer = await air.shell.dispatch(channel, [...args]);
      expect(answer).toEqual(namedHere(channel, answerInOwnWords(channel), () => "MacBook Pro"));
      expect(answer).not.toEqual(answerInOwnWords(channel));
    }
    expect(air.pushes.find((push) => push.channel === "inf:cards")?.payload).toEqual(
      namedHere("inf:cards:list", ownCards(), () => "MacBook Pro"),
    );
  });

  // The captain's answer on the review of one rule for every view: a home too old to list the
  // change is told apart, so the window can say it needs an update instead of asking.
  it("knows when the first mate there is too old to answer what every view asks", async () => {
    // Major 16 folded these names in, so the older first mates here are on major 15.
    const older = await otherMac({ protocolVersion: "15.0.0", changes: [] });
    const air = shell();
    await air.shell.start();
    await air.shell.join(await older.link());
    await air.until(() => air.view().contact === "in-reach");
    await air.until(() => air.shell.thisMac().role === "view");
    expect(air.shell.thisMac()).toMatchObject({
      role: "view",
      needsUpdateThere: true,
      returnsNeedUpdateThere: true,
      devicesNeedUpdateThere: true,
    });

    // One that answers every view's settings but not yet its devices (INF-1352's plan, piece 2).
    const before = await otherMac({ protocolVersion: "15.0.0", changes: ["every-view-asks"] });
    const mini = shell();
    await mini.shell.start();
    await mini.shell.join(await before.link());
    await mini.until(() => mini.view().contact === "in-reach");
    await mini.until(() => mini.shell.thisMac().role === "view");
    expect(mini.shell.thisMac()).toMatchObject({ role: "view", devicesNeedUpdateThere: true });
    expect(mini.shell.thisMac()).not.toHaveProperty("needsUpdateThere");
    // A first mate that sends no panel's files yet leaves the captain's
    // panels off here, as before (INF-3660's plan, "Your panels, in every window").
    await mini.until(() => before.asked.includes("inf:cards:list"));
    expect(mini.shell.preferences.get().panels.enabled).toBe(false);

    const current = await otherMac();
    const pro = shell();
    await pro.shell.start();
    await pro.shell.join(await current.link());
    await pro.until(() => pro.view().contact === "in-reach");
    expect(pro.shell.thisMac()).not.toHaveProperty("needsUpdateThere");
    expect(pro.shell.thisMac()).not.toHaveProperty("devicesNeedUpdateThere");
    expect(pro.shell.thisMac()).not.toHaveProperty("returnsNeedUpdateThere");
  });

  // INF-3454's plan, the captain's answer direction=catch-here: a sign-in page whose browser
  // comes back to the other computer's loopback address is caught here at its port and
  // handed back; when the port is taken here, the window asks for the address instead.
  it("catches a sign-in's return at its port here and hands it to the other computer, once", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");

    const port = await claimedPort();
    const page = "https://accounts.google.com/o/oauth2/v2/auth?client_id=app";
    pro.events.emit("inf:app:sign-in-page", { url: page, id: "return-1", port });
    await air.until(() => air.opened.includes(page));
    expect(air.view().signInReturn).toEqual({ id: "return-1", caught: true });
    expect(air.pushes.map((push) => push.channel)).not.toContain("inf:app:sign-in-page");

    // The browser here comes back from Google's page.
    const back = await fetch(`http://127.0.0.1:${port}/?state=s1&code=4%2F0Aan&scope=gmail`);
    expect(back.status).toBe(200);
    expect(await back.text()).toBe("Signed in to Google.");
    expect(pro.returns).toEqual([
      { id: "return-1", address: "/?state=s1&code=4%2F0Aan&scope=gmail" },
    ]);
    // Taken once: nothing more reaches the other computer through here.
    await expect(fetch(`http://127.0.0.1:${port}/?state=s1&code=again`)).rejects.toThrow();
    expect(pro.returns).toHaveLength(1);

    pro.events.emit("inf:app:sign-in-ended", { id: "return-1" });
    await air.until(() => air.view().signInReturn === undefined);
  });

  it("asks for the address when something here already holds the sign-in's port", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");

    const holder = createServer((_request, response) => response.end("someone else"));
    const port = await claimedPort();
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
    stops.push(() => new Promise<void>((resolve) => holder.close(() => resolve())));
    const page = "https://accounts.google.com/o/oauth2/v2/auth?client_id=app&taken";
    pro.events.emit("inf:app:sign-in-page", { url: page, id: "return-2", port });
    await air.until(() => air.opened.includes(page));
    expect(air.view().signInReturn).toEqual({ id: "return-2", caught: false });
    // The program that holds it still answers its own, and nothing is handed on.
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("someone else");
    expect(pro.returns).toEqual([]);

    // The sign-in's end there clears the ask here.
    pro.events.emit("inf:app:sign-in-ended", { id: "return-2" });
    await air.until(() => air.view().signInReturn === undefined);
  });

  // INF-1352's plan, piece 3: any view watches a task's browser as pictures over the
  // connection, and a view of an older first mate says to update it instead.
  it("shows a task's browser from the other Mac in each window that watches it, and watches again after a drop", async () => {
    const mini = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await mini.link());
    await air.until(() => air.view().contact === "in-reach");
    expect(air.shell.thisMac()).not.toHaveProperty("browserNeedsUpdateThere");

    // Two windows here watch the same task: the other Mac hears one watch.
    const window = (): BrowserViewer & { seen: string[]; close: () => void } => {
      const gone: (() => void)[] = [];
      const seen: string[] = [];
      return {
        seen,
        show: (frame) => seen.push(`${frame.taskId}:${frame.data}`),
        onGone: (listener) => gone.push(listener),
        close: () => {
          for (const listener of gone.splice(0)) listener();
        },
      };
    };
    const first = window();
    const second = window();
    expect(await air.shell.dispatch("inf:browser:watch", ["t1"], first)).toEqual({
      watching: true,
    });
    expect(await air.shell.dispatch("inf:browser:watch", ["t1"], second)).toEqual({
      watching: true,
    });
    expect(mini.asked.filter((channel) => channel === "inf:browser:watch")).toHaveLength(1);
    expect(mini.pages.watchers("t1")).toBe(1);
    mini.pages.paint("t1", "page-1");
    await air.until(() => first.seen.length === 1 && second.seen.length === 1);
    expect(first.seen).toEqual(["t1:page-1"]);

    // Only a window that watches gives the page its room.
    const room = { width: 1200, height: 760 };
    await air.shell.dispatch("inf:browser:size", ["t2", room], first);
    await air.shell.dispatch("inf:browser:size", ["t1", room], first);
    await air.until(() => mini.pages.rooms.length === 1);
    expect(mini.pages.rooms).toEqual([{ taskId: "t1", size: room }]);

    // The connection drops: the other Mac forgets the watch, and the welcome asks it again.
    air.sockets.at(-1)?.terminate();
    await air.until(() => mini.pages.log.length === 3);
    expect(mini.pages.log).toEqual(["+t1", "-t1", "+t1"]);
    await air.until(() => mini.pages.rooms.length === 2);
    expect(mini.pages.rooms[1]).toEqual({ taskId: "t1", size: room });
    mini.pages.paint("t1", "page-2");
    await air.until(() => second.seen.length === 2);

    // A window that closes stops watching; when the last one goes, the other Mac stops sending.
    first.close();
    mini.pages.paint("t1", "page-3");
    await air.until(() => second.seen.length === 3);
    expect(first.seen).toEqual(["t1:page-1", "t1:page-2"]);
    await air.shell.dispatch("inf:browser:unwatch", ["t1"], second);
    await air.until(() => mini.pages.watchers("t1") === 0);
  });

  it("says to update an older first mate before it shows its task's browser here", async () => {
    const older = await otherMac({ protocolVersion: "15.0.0", changes: [] });
    const air = shell();
    await air.shell.start();
    await air.shell.join(await older.link());
    await air.until(() => air.view().contact === "in-reach");
    expect(air.shell.thisMac()).toMatchObject({ role: "view", browserNeedsUpdateThere: true });
    const viewer: BrowserViewer = { show: () => {}, onGone: () => {} };
    expect(await air.shell.dispatch("inf:browser:watch", ["t1"], viewer)).toEqual({
      watching: false,
    });
    expect(older.asked).not.toContain("inf:browser:watch");
  });

  // The other computer's look and voice are its own: they never reach this window.
  it("shows what its Settings follow and none of the other computer's own look", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");
    pro.events.emit("inf:auth:notice", {
      providerId: "openai-codex",
      kind: "info",
      message: "Signing in.",
    });
    pro.events.emit("inf:shell:preferences", DEFAULT_SHELL_PREFERENCES);
    pro.events.emit("inf:voice:progress", {
      file: "model.onnx",
      fileIndex: 0,
      fileCount: 1,
      fraction: 0.5,
    });
    // Its computers and phones, which its Devices follows (INF-1352's plan, piece 2).
    pro.events.emit("inf:devices", []);
    pro.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.some((push) => push.channel === "inf:models:changed"));
    expect(air.pushes.map((push) => push.channel)).toContain("inf:auth:notice");
    expect(air.pushes.map((push) => push.channel)).toContain("inf:devices");
    expect(air.pushes.map((push) => push.channel)).not.toContain("inf:voice:progress");
    // This view's look started from the other Mac's saved one (light), so a
    // push in the catalog's theme would be the look the other Mac just sent.
    expect(
      air.pushes.filter(
        (push) =>
          push.channel === "inf:shell:preferences" &&
          (push.payload as ShellPreferences).appearance.theme ===
            DEFAULT_SHELL_PREFERENCES.appearance.theme,
      ),
    ).toEqual([]);
  });

  it("answers this Mac's own update notice while the other Mac is newer, and never asks it", async () => {
    // Beyond the supported window there: this Mac only reads until it is updated.
    const newerMajor = Number(PROTOCOL_VERSION.split(".")[0]) + PROTOCOL_MAJORS_BEHIND + 1;
    const newerVersion = `${newerMajor}.0.0`;
    // A major that broke views moves the floor to itself (docs/contract.md).
    const pro = await otherMac({ protocolVersion: newerVersion, viewFloor: newerMajor });
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach" && air.view().readOnly !== null);
    expect(air.view().readOnly).toBe("newer-there");
    // The notice is this Mac's own installed app's, as the Mac where Firstmate lives shows its own.
    expect(await air.shell.dispatch("inf:update:status", [])).toEqual({
      currentVersion: "0.1.28-alpha.3",
      channel: "alpha",
      latestVersion: "0.1.30-alpha.5",
      updateAvailable: true,
      releaseUrl: OFFERED.releaseUrl,
      upgradeCommand: upgradeCommandFor("alpha"),
      checkedAt: expect.any(Number),
    });
    // The offered version's link opens that version's page here, though changes there are refused.
    expect(await air.shell.dispatch("inf:update:open-release", [])).toEqual({ ok: true });
    expect(air.ownApp.opened).toEqual([OFFERED.releaseUrl]);
    await expect(air.shell.dispatch("inf:cards:close", ["card-1"])).rejects.toThrow(
      `only reads from a home on ${newerVersion}`,
    );
    expect(pro.asked.filter((channel) => channel.startsWith("inf:update:"))).toEqual([]);
  });

  it("says why a pasted link did not join, and stays as it was", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    expect(await air.shell.join("https://example.com/not-a-link")).toEqual({
      ok: false,
      refused: "not-a-link",
    });
    expect(await air.shell.join(await pro.link("work"))).toEqual({ ok: false, refused: "kind" });
    const used = await pro.link();
    await claimLink(used, { kind: "view", name: "Someone else" });
    expect(await air.shell.join(used)).toEqual({ ok: false, refused: "used" });
    const away = await pro.link();
    await pro.quit();
    expect(await air.shell.join(away)).toEqual({ ok: false, refused: "unreachable" });
    expect(air.shell.thisMac()).toEqual({ role: "home", left: null });
    expect(air.own.dispose).not.toHaveBeenCalled();
  });
});

/**
 * A Mac that both controls Firstmate on another and runs its work (docs/view.md, "A Mac that
 * runs work"): one device on that Mac's list, whose window and work keep the same grant.
 */
describe("a Mac that controls another and runs its work", () => {
  const workDir = () => join(scratchDir("infinitary-shell-work-"), "work");
  const sam = { name: "sam", uid: 501 };

  it("joins with a link for a Mac: controls it, and its work keeps the same grant and starts in the background", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    // The run the background starts takes the work folder, as a real one does.
    const background = vi.fn(async () => {
      lockFolder(dataDir);
      return "running" as const;
    });
    const air = shell(undefined, { dataDir, background });
    await air.shell.start();
    expect(await air.shell.join(await pro.link("mac"))).toEqual({ ok: true });
    await air.until(() => air.shell.thisMac().role === "view");
    await air.until(() => air.view().contact === "in-reach");
    expect(air.view().runsWork).toBe(true);
    expect(pro.pairing.list()).toEqual([
      expect.objectContaining({ kind: "mac", name: "MacBook Air", user: userInfo().username }),
    ]);
    await expect.poll(() => background.mock.calls.length).toBe(1);
    // The background starts this app itself: no copy to keep.
    expect(background).toHaveBeenCalledWith({ launcher: null, app: null });
    const work = new JoinedHome(dataDir).read()?.grant;
    expect({ ...air.joined.read()?.grant, also: undefined }).toEqual(work);
  });

  // The captain's ask (INF-4835): "Set it up again by itself, and say why when it still cannot".
  it("says why its work could not be set up, tells its home, and sets it up again on the home's Fix it", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    // macOS refuses the background item once, as while Login Items keeps it out.
    const answers: ("failed" | "running")[] = ["failed", "running"];
    const background = vi.fn(async () => {
      const answer = answers.shift() ?? "running";
      if (answer === "running") lockFolder(dataDir);
      return answer;
    });
    const air = shell(undefined, { dataDir, background });
    await air.shell.start();
    expect(await air.shell.join(await pro.link("mac"))).toEqual({ ok: true });
    await air.until(() => air.view().contact === "in-reach");
    await air.until(() => air.view().workSetup?.reason === "background-off");
    expect(air.view().workSetup).toEqual({ state: "blocked", reason: "background-off" });
    const deviceId = air.joined.read()?.grant.deviceId;
    await expect
      .poll(() => pro.workSetups.at(-1))
      .toEqual({ view: deviceId, report: { state: "blocked", reason: "background-off" } });
    // The grant was written into the work folder even though the background refused.
    expect(new JoinedHome(dataDir).read()?.grant.deviceId).toBe(deviceId);

    expect(pro.fixWork(deviceId as string)).toBe(true);
    await expect.poll(() => background.mock.calls.length).toBe(2);
    await air.until(() => air.view().workSetup === undefined);
    await expect
      .poll(() => pro.workSetups.at(-1))
      .toEqual({ view: deviceId, report: { state: "running" } });
  });

  // A person's report: "no way to dismiss this alert". After a trip to System
  // Settings the window comes back to the front, and the notice clears by itself.
  it("checks its work again as its window comes back to the front while the work could not start", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    const answers: ("failed" | "running")[] = ["failed", "running"];
    const background = vi.fn(async () => {
      const answer = answers.shift() ?? "running";
      if (answer === "running") lockFolder(dataDir);
      return answer;
    });
    const air = shell(undefined, { dataDir, background });
    await air.shell.start();
    expect(await air.shell.join(await pro.link("mac"))).toEqual({ ok: true });
    await air.until(() => air.view().workSetup?.reason === "background-off");
    const checks = vi.spyOn(air.shell, "checkWork");
    // Leaving the front checks nothing.
    air.shell.windowFront(false);
    expect(checks).not.toHaveBeenCalled();

    air.shell.windowFront(true);
    expect(checks).toHaveBeenCalledTimes(1);
    await air.until(() => air.view().workSetup === undefined);
    expect(background).toHaveBeenCalledTimes(2);
    // Once its work runs, coming back to the front checks nothing more.
    air.shell.windowFront(false);
    air.shell.windowFront(true);
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it("still says why on its own window when its home is from before and does not listen for it", async () => {
    const pro = await otherMac({ changes: [] }, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    const background = vi.fn(async () => "failed" as const);
    const air = shell(undefined, { dataDir, background });
    await air.shell.start();
    expect(await air.shell.join(await pro.link("mac"))).toEqual({ ok: true });
    await air.until(() => air.view().contact === "in-reach");
    await air.until(() => air.view().workSetup?.reason === "background-off");
    expect(pro.asked).not.toContain("inf:devices:work-setup");
  });

  // INF-5468's plan, piece 2: a home from before the newer-work reason hears what it can read.
  it("names work a newer Infinitary saved, and tells a home from before that reason only that its work is not reached", async () => {
    const pro = await otherMac(
      { changes: CONTRACT_CHANGES.names.filter((name) => name !== "work-setup-newer-work") },
      { joinsFromAnotherMac: true },
    );
    const dataDir = workDir();
    // The work folder holds a grant a newer Infinitary saved, on a record version this one does not know.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "home.json"), `${JSON.stringify({ version: 2 })}\n`);
    const background = vi.fn(async () => "running" as const);
    const air = shell(undefined, { dataDir, background });
    await air.shell.start();
    expect(await air.shell.join(await pro.link("mac"))).toEqual({ ok: true });
    await air.until(() => air.view().workSetup?.reason === "newer-work");
    const deviceId = air.joined.read()?.grant.deviceId;
    await expect
      .poll(() => pro.workSetups.at(-1))
      .toEqual({ view: deviceId, report: { state: "blocked", reason: "not-reached" } });
    expect(background).not.toHaveBeenCalled();
    expect(readFileSync(join(dataDir, "home.json"), "utf8")).toBe('{"version":2}\n');
  });

  it("sets its work up again at launch when the work folder lost its grant", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    const grant = await claimLink(await pro.link("mac"), {
      kind: "mac",
      name: "MacBook Air",
      user: sam,
    });
    const joinedDir = join(scratchDir("infinitary-shell-"), "joined");
    new JoinedHome(joinedDir).join(grant, Date.UTC(2026, 9, 3, 14, 6));
    const background = vi.fn(async () => {
      lockFolder(dataDir);
      return "running" as const;
    });
    const air = shell(joinedDir, { dataDir, background });
    await air.shell.start();
    await air.until(() => air.view().contact === "in-reach");
    await expect.poll(() => background.mock.calls.length).toBe(1);
    expect(new JoinedHome(dataDir).read()?.grant).toEqual(grant);
    await expect
      .poll(() => pro.workSetups.at(-1))
      .toEqual({ view: grant.deviceId, report: { state: "running" } });
  });

  // The captain's pick on the review (INF-4850): "Wait for the first connection, then set the work up".
  it("sets nothing up again at launch for a Mac its home removed while its app was closed", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    const grant = await claimLink(await pro.link("mac"), {
      kind: "mac",
      name: "MacBook Air",
      user: sam,
    });
    const joinedDir = join(scratchDir("infinitary-shell-"), "joined");
    new JoinedHome(joinedDir).join(grant, Date.UTC(2026, 9, 3, 14, 6));
    // Removed while its app was closed: its work cleaned its folder up, and
    // the window hears it the next time it dials.
    pro.pairing.remove(grant.deviceId, { farewell: true });
    const background = vi.fn(async () => "running" as const);
    const air = shell(joinedDir, { dataDir, background });
    await air.shell.start();
    await air.until(() => air.shell.thisMac().role === "home");
    expect(background).not.toHaveBeenCalled();
    expect(new JoinedHome(dataDir).read()).toBeNull();
  });

  it("opens as a view of the home its work runs for, with no new link, and never again as the device it left", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    const grant = await claimLink(await pro.link("mac"), {
      kind: "mac",
      name: "Mac mini",
      user: sam,
    });
    new JoinedHome(dataDir).join(grant, Date.UTC(2026, 9, 3, 14, 6));
    const joinedDir = join(scratchDir("infinitary-shell-"), "joined");
    const mini = shell(joinedDir, { dataDir });
    // Its own first mate reads, at its first launch, that nothing was done here.
    mini.own.dispatch.mockImplementation((async (channel: string) =>
      channel === "inf:app:first-run"
        ? { gateOpen: true, firstTurnAt: null, untouched: true }
        : { ownCore: channel }) as never);
    await mini.shell.start();
    // Startup finished the switch: the empty first mate it asked stopped, and the window is a view.
    expect(mini.own.dispose).toHaveBeenCalledTimes(1);
    expect(mini.shell.thisMac().role).toBe("view");
    await mini.until(() => mini.view().contact === "in-reach");
    expect(mini.view()).toMatchObject({ name: "MacBook Pro", runsWork: true });
    expect({ ...mini.joined.read()?.grant, also: undefined }).toEqual(grant);

    await mini.shell.leave();
    // Its work keeps the grant until it hears it was removed; Firstmate
    // opened here again is this Mac's own.
    expect(new JoinedHome(dataDir).read()?.grant.deviceId).toBe(grant.deviceId);
    const again = shell(joinedDir, { dataDir });
    await again.shell.start();
    expect(again.startCore).toHaveBeenCalledTimes(1);
    expect(again.shell.thisMac()).toMatchObject({ role: "home", left: { reason: "left" } });
  });

  // INF-4835's plan, piece 3: "Removing an entry never returns a window to its first screen while
  // that Mac's work still runs for the same main Mac under another entry."
  it("carries on as the entry its work keeps when the other Mac removes the one it held, and says so", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    // Its window joined as one entry, and its work as another, as two
    // joins of an older version could leave this Mac.
    const held = await claimLink(await pro.link("mac"), {
      kind: "mac",
      name: "MacBook Air",
      window: true,
      user: sam,
    });
    const joinedDir = join(scratchDir("infinitary-shell-"), "joined");
    new JoinedHome(joinedDir).join(held, Date.now());
    const dataDir = workDir();
    const works = await claimLink(await pro.link("mac"), {
      kind: "mac",
      name: "MacBook Air",
      user: sam,
    });
    new JoinedHome(dataDir).join(works, Date.now());
    const air = shell(joinedDir, { dataDir });
    await air.shell.start();
    await air.until(() => air.view().contact === "in-reach");
    expect(air.joined.read()?.grant.deviceId).toBe(held.deviceId);
    const caughtUp = air.view().caughtUp;
    const seen: string[] = [];
    const viewer: BrowserViewer = {
      show: (frame) => seen.push(`${frame.taskId}:${frame.data}`),
      onGone: () => {},
    };
    await air.shell.dispatch("inf:browser:watch", ["t1"], viewer);
    await air.until(() => pro.pages.watchers("t1") === 1);

    pro.pairing.remove(held.deviceId);
    await air.until(() => air.joined.read()?.grant.deviceId === works.deviceId);
    await air.until(() => air.view().contact === "in-reach");
    // The windows that stayed catch up again from the new connection, which
    // asks again for the task's browser they watched.
    expect(air.view().caughtUp).toBeGreaterThan(caughtUp);
    await air.until(() => pro.pages.log.at(-1) === "+t1");
    pro.pages.paint("t1", "page-1");
    await air.until(() => seen.length === 1);
    expect(air.startCore).not.toHaveBeenCalled();
    // The same home: its windows stay open as they are.
    expect(air.restartWindows).not.toHaveBeenCalled();
    expect(air.view()).toMatchObject({
      name: "MacBook Pro",
      carriedOn: { at: expect.any(Number) },
    });
    expect(air.joined.left()).toBeNull();

    // With its work's entry removed too, it returns to its own first launch.
    pro.pairing.remove(works.deviceId);
    await air.until(() => air.shell.thisMac().role === "home");
    expect(air.shell.thisMac()).toMatchObject({ left: { reason: "removed" } });
  });

  // INF-4931's plan, step 1: "while the gate is up and nothing has been done here, an address add
  // from another home turns the window into a view without a relaunch".
  it("follows along when its home adds it by its address while its first launch is still up", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    const mini = shell(undefined, { dataDir });
    const firstRun = { gateOpen: true, firstTurnAt: null, untouched: true };
    mini.own.dispatch.mockImplementation((async (channel: string) =>
      channel === "inf:app:first-run" ? firstRun : { ownCore: channel }) as never);
    await mini.shell.start();
    expect(mini.shell.thisMac().role).toBe("home");
    const asked = () =>
      mini.own.dispatch.mock.calls.filter(([channel]) => channel === "inf:app:first-run").length;
    const before = asked();
    // Nothing has been added yet: it stays this computer's own first launch, and a poll with no
    // grant waiting asks its first mate nothing.
    expect(await mini.shell.followAdded()).toBe(false);
    expect(asked()).toBe(before);
    expect(mini.own.dispose).not.toHaveBeenCalled();

    // The home sets this computer up over SSH, which leaves the grant in its work folder.
    const grant = await claimLink(await pro.link("mac"), {
      kind: "mac",
      name: "Mac mini",
      user: sam,
    });
    new JoinedHome(dataDir).join(grant, Date.now());
    expect(await mini.shell.followAdded()).toBe(true);
    await mini.until(() => mini.shell.thisMac().role === "view");
    await mini.until(() => mini.view().contact === "in-reach");
    expect(mini.view()).toMatchObject({ name: "MacBook Pro", runsWork: true });
    // The empty first mate beside it stops, and the window starts over with no relaunch.
    expect(mini.own.dispose).toHaveBeenCalledTimes(1);
    expect(mini.restartWindows).toHaveBeenCalled();
    expect(mini.relaunch).not.toHaveBeenCalled();
    // A computer that was not open when the home added it opens as that home's view once its
    // own first mate says nothing was done here, before its startup ends.
    const fresh = shell(undefined, { dataDir });
    fresh.own.dispatch.mockImplementation((async (channel: string) =>
      channel === "inf:app:first-run" ? firstRun : { ownCore: channel }) as never);
    await fresh.shell.start();
    expect(fresh.shell.thisMac().role).toBe("view");
    expect(fresh.own.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not follow along once something was done here, after a restart too", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    const joinedDir = join(scratchDir("infinitary-shell-"), "joined");
    const mini = shell(joinedDir, { dataDir });
    // The person saved a sign-in or a project here, though the first launch is still up: its core
    // answers the gate open with no turn yet, and without `untouched`.
    mini.own.dispatch.mockImplementation((async (channel: string) =>
      channel === "inf:app:first-run"
        ? { gateOpen: true, firstTurnAt: null }
        : { ownCore: channel }) as never);
    await mini.shell.start();
    const grant = await claimLink(await pro.link("mac"), {
      kind: "mac",
      name: "Mac mini",
      user: sam,
    });
    new JoinedHome(dataDir).join(grant, Date.now());
    expect(await mini.shell.followAdded()).toBe(false);
    expect(mini.shell.thisMac().role).toBe("home");
    expect(mini.own.dispose).not.toHaveBeenCalled();
    expect(mini.shell.followsAdded()).toEqual({ follows: true, joins: true });

    // The review of INF-5409: reopened with that grant still waiting, it stays its own first mate,
    // and a poll asks nothing more of it.
    await mini.shell.dispose();
    const again = shell(joinedDir, { dataDir });
    await again.shell.start();
    expect(again.shell.thisMac().role).toBe("home");
    expect(again.startCore).toHaveBeenCalledTimes(1);
    expect(await again.shell.followAdded()).toBe(false);
    expect(
      again.own.dispatch.mock.calls.filter(([channel]) => channel === "inf:app:first-run"),
    ).toEqual([]);
  });

  // The review of INF-5409: a grant that arrived while the window was closed, with no first-launch
  // poll to refuse it, opens the window only once its own first mate says nothing was done here.
  it("opens over a grant that waited while it was closed only where nothing was done here", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    for (const untouched of [false, true]) {
      const dataDir = workDir();
      const grant = await claimLink(await pro.link("mac"), {
        kind: "mac",
        name: "Mac mini",
        user: sam,
      });
      new JoinedHome(dataDir).join(grant, Date.now());
      const joinedDir = join(scratchDir("infinitary-shell-"), "joined");
      // A note of an earlier refusal that cannot be read refuses nothing by itself.
      mkdirSync(joinedDir, { recursive: true });
      writeFileSync(join(joinedDir, "kept-own.json"), "{broken");
      // Its own first mate keeps a record here already: something may have been done.
      const mini = shell(joinedDir, { dataDir });
      mini.own.dispatch.mockImplementation((async (channel: string) =>
        channel === "inf:app:first-run"
          ? { gateOpen: true, firstTurnAt: null, ...(untouched ? { untouched: true } : {}) }
          : { ownCore: channel }) as never);
      await mini.shell.start();
      expect(mini.startCore).toHaveBeenCalledTimes(1);
      if (untouched) {
        // Nothing was done here: it follows along, and its own first mate stops.
        await mini.until(() => mini.shell.thisMac().role === "view");
        expect(mini.joined.read()?.grant.deviceId).toBe(grant.deviceId);
        expect(mini.own.dispose).toHaveBeenCalledTimes(1);
      } else {
        // Configured here: it stays its own first mate, with the grant left unused, and a
        // restart keeps it so without asking again.
        expect(mini.shell.thisMac().role).toBe("home");
        expect(mini.joined.read()).toBeNull();
        expect(mini.own.dispose).not.toHaveBeenCalled();
        await mini.shell.dispose();
        const again = shell(joinedDir, { dataDir });
        await again.shell.start();
        expect(again.shell.thisMac().role).toBe("home");
        expect(
          again.own.dispatch.mock.calls.filter(([channel]) => channel === "inf:app:first-run"),
        ).toEqual([]);
      }
    }
  });

  it("stays its own Firstmate when the work here only runs work", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    // Another user on that Mac, or a Mac added before a Mac could do both.
    const grant = await claimLink(await pro.link("work"), {
      kind: "work",
      name: "Mini",
      user: sam,
    });
    new JoinedHome(dataDir).join(grant, Date.now());
    const mini = shell(undefined, { dataDir });
    await mini.shell.start();
    expect(mini.startCore).toHaveBeenCalledTimes(1);
    expect(mini.shell.thisMac()).toEqual({ role: "home", left: null });
  });
});

/**
 * A view's notifications (docs/view.md, "Notifications"): the other Mac's
 * cards reach this Mac's Notification Center as they reach that Mac's, while
 * this Mac's window is in the background and that Mac's own switch is on.
 */
describe("notifications on a view of another Mac", () => {
  /** This Mac, joined to the other and in reach, having read what it shows. */
  async function joined(pro: Awaited<ReturnType<typeof otherMac>>) {
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");
    await air.until(() => pro.asked.includes("inf:cards:list"));
    // Asked after that read on the same connection, so answered after it too.
    await air.shell.dispatch("inf:app:healthcheck", []);
    return air;
  }
  /** Until a push of the other Mac's stage holding this card reached the window here. */
  const heard = (air: ReturnType<typeof shell>, id: string) =>
    air.until(() =>
      air.pushes.some(
        (push) =>
          push.channel === "inf:cards" && (push.payload as Card[]).some((card) => card.id === id),
      ),
    );

  it("posts the other Mac's new card as that Mac does, only while this window is in the background", async () => {
    const pro = await otherMac();
    const old = shown("old", { title: "Already there" });
    pro.show([old]);
    const air = await joined(pro);
    // What the other Mac's own notifier makes of the same pushes.
    const there: { title: string; body: string }[] = [];
    const home = new CardNotifier({
      enabled: () => true,
      focused: () => false,
      show: (notification) => there.push(notification),
    });
    home.observe(pro.stage.cards);

    const decision = shown("decision", {
      title: "Two ways to fix the flaky test",
      body: "<p>Mock the clock, or await the queue.</p><p>The second is smaller.</p>",
      actions: [{ id: "queue", label: "Await the queue", default: true }],
    });
    // Its card rides along, so a click opens that card (INF-4243's plan, piece 5).
    // A view reads no task record: the card's own title names it, with no project.
    const decisionText = "Two ways to fix the flaky test\nMock the clock, or await the queue.";
    pro.show([old, decision]);
    home.observe(pro.stage.cards);
    await air.until(() => air.notified.length === 1);
    expect(air.notified).toEqual([
      {
        kind: "card",
        title: m.uiCardKindDecision(),
        body: decisionText,
        cardId: "decision",
      },
    ]);
    expect(air.notified).toEqual(there);

    // A new report arrives ready; later body updates are not new notifications.
    const report = shown("report", { title: "Tests fixed", body: "<p>All green.</p>" });
    pro.show([old, decision, report]);
    home.observe(pro.stage.cards);
    await air.until(() => air.notified.length === 2);
    expect(air.notified[1]).toEqual({
      kind: "card",
      title: m.uiCardKindNote(),
      body: "Tests fixed\nAll green.",
      cardId: "report",
    });
    expect(air.notified).toEqual(there);
    pro.show([old, decision, { ...report, body: "<p>All green, checked again.</p>" }]);
    home.observe(pro.stage.cards);
    await air.shell.dispatch("inf:app:healthcheck", []);
    expect(air.notified).toHaveLength(2);
    expect(air.notified).toEqual(there);

    // With this Mac's window in front, the person is looking at it already.
    air.window.focused = true;
    pro.show([...pro.stage.cards, shown("seen-here")]);
    await heard(air, "seen-here");
    expect(air.notified).toHaveLength(2);
    // The card that was there before this Mac joined never posts.
    expect(air.notified.map((notification) => notification.body.split("\n")[0])).not.toContain(
      "Already there",
    );
  });

  it("follows the other Mac's own Notifications switch", async () => {
    const pro = await otherMac();
    const air = await joined(pro);
    pro.stage.notifications = false;
    pro.show([shown("quiet", { title: "Turned off there" })]);
    await air.until(
      () =>
        pro.asked.filter((channel) => channel === "inf:settings:notifications:get").length === 1,
    );
    pro.stage.notifications = true;
    pro.show([...pro.stage.cards, shown("loud", { title: "Turned on there" })]);
    await air.until(() => air.notified.length === 1);
    // Asked in order on one connection: the first card's answer came first.
    expect(air.notified.map((notification) => notification.body.split("\n")[0])).toEqual([
      "Turned on there",
    ]);
  });

  it("posts a card that became ready while the connection dropped, and treats a full read as old news", async () => {
    const pro = await otherMac();
    const air = await joined(pro);
    // This Mac's socket drops; the other Mac keeps numbering what it misses.
    air.sockets.at(-1)?.terminate();
    pro.show([shown("while-away", { title: "Born while away" })]);
    await air.until(() => air.notified.length === 1);
    expect(air.notified[0]?.body.split("\n")[0]).toBe("Born while away");

    // Firstmate restarts there with a card this Mac never heard: it reads
    // everything again, and what it reads is old news, as at the other Mac.
    await pro.quit();
    await air.until(() => air.view().contact === "closed");
    pro.stage.cards = [...pro.stage.cards, shown("restored", { title: "Restored there" })];
    pro.restart();
    await air.until(() => air.view().contact === "in-reach");
    await air.until(() => pro.asked.filter((channel) => channel === "inf:cards:list").length === 2);
    await air.shell.dispatch("inf:app:healthcheck", []);
    pro.show([...pro.stage.cards, shown("after", { title: "After the restart" })]);
    await air.until(() => air.notified.length === 2);
    expect(air.notified.map((notification) => notification.body.split("\n")[0])).toEqual([
      "Born while away",
      "After the restart",
    ]);
  });
});
