import { join } from "node:path";
import { type HomeConnection, startConnection } from "@core/connection/connection";
import { JoinedHome } from "@core/devices/joinedHome";
import { DevicePairing } from "@core/devices/pairing";
import { describe, expect, it, vi } from "vitest";
import {
  answerInOwnWords,
  OWN_READS,
  ownCards,
  SAID,
} from "../../tests/helpers/firstMatesOwnWords";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { ownCore, ownUpdates, stopEachTest, stops } from "../../tests/helpers/shellStandIns";
import { Shell, type ShellOptions } from "./shell";

/**
 * The window on the first mate's own computer (docs/view.md): the shell
 * against the real connection's local door over a stand-in for this
 * computer's own core, or a stand-in link that never reaches it.
 */

stopEachTest();

// INF-1352's plan, local_path=real-connection (docs/view.md, "The window on the first mate's own
// computer"): the window here asks its first mate over the local door and hears it there, and
// asks directly when the door cannot carry it, reading everything again after any gap.
describe("the window on the first mate's own computer", () => {
  type StandInLink = NonNullable<NonNullable<ShellOptions["localWindow"]>["link"]>;
  type LinkOptions = Parameters<StandInLink>[0];

  function homeShell(options: { link?: StandInLink; readyMs?: number; door?: boolean } = {}) {
    const own = ownCore();
    const pushes: { channel: string; payload: unknown }[] = [];
    const doorDir = join(scratchDir("infinitary-shell-door-"), "local-door");
    const pairing = new DevicePairing({
      dir: join(scratchDir("infinitary-shell-door-"), "devices"),
      onProblem: () => {},
    });
    let connection: HomeConnection | null = null;
    const made = new Shell({
      joined: new JoinedHome(join(scratchDir("infinitary-shell-door-"), "joined"), () => {}),
      startCore: async () => own.core,
      startConnection: (core) => {
        connection = startConnection({
          dispatch: core.dispatch,
          events: core.events,
          devices: pairing,
          localDoor: doorDir,
          port: 0,
          onProblem: () => {},
        });
        return connection;
      },
      localDoor: () => doorDir,
      ...(options.link || options.readyMs !== undefined
        ? {
            localWindow: {
              ...(options.link ? { link: options.link } : {}),
              ...(options.readyMs !== undefined ? { readyMs: options.readyMs } : {}),
            },
          }
        : {}),
      broadcast: (channel, payload) => pushes.push({ channel, payload }),
      notifications: { supported: () => false, focused: () => true, show: () => {} },
      deviceName: async () => "MacBook Pro",
      openPage: async () => {},
      restartWindows: vi.fn(),
      relaunch: vi.fn(),
      updates: ownUpdates().updates,
    });
    stops.push(async () => {
      await made.dispose();
      pairing.dispose();
    });
    return { shell: made, own, pushes, connection: () => connection };
  }

  /** A link that never reaches the door, and hands the test its options to play the first mate's part. */
  function standInLink() {
    const heard: { options: LinkOptions | null; closed: boolean; welcomed: boolean } = {
      options: null,
      closed: false,
      welcomed: false,
    };
    const link: StandInLink = (options) => {
      heard.options = options;
      return {
        start: () => {},
        invoke: async () => {
          throw new Error("Out of reach.");
        },
        state: () => ({ contact: heard.welcomed ? "in-reach" : "reaching" }) as never,
        // One connection, open while welcomed.
        connection: () => (heard.welcomed ? { welcome: 1, run: null } : null),
        close: () => {
          heard.closed = true;
        },
      };
    };
    return { link, heard };
  }

  const pushed = (pushes: { channel: string }[], channel: string) =>
    pushes.filter((push) => push.channel === channel).length;

  it("asks its first mate over the local door, and hears each push once, from there", async () => {
    const at = homeShell();
    await at.shell.start();
    const asked = await at.shell.dispatch("inf:app:healthcheck", []);
    expect(asked).toEqual({ ownCore: "inf:app:healthcheck" });
    // The connection asks as the captain, with that client as the viewer of a task's browser.
    expect(at.own.dispatch.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["inf:app:healthcheck", [], { kind: "captain" }],
    ]);
    at.own.core.events.emit("inf:models:changed", { ok: true });
    await expect.poll(() => pushed(at.pushes, "inf:models:changed")).toBe(1);
    await at.connection()?.close();
    await expect(at.shell.dispatch("inf:app:healthcheck", [])).rejects.toThrow();
  });

  // INF-3486: only a computer that controls the first mate names it; its own window shows
  // what its core wrote.
  it("shows its first mate's own refusals and feed lines as its core wrote them", async () => {
    const at = homeShell();
    at.own.dispatch.mockImplementation(
      async (channel) => answerInOwnWords(channel) ?? { ownCore: channel },
    );
    await at.shell.start();

    expect(await at.shell.dispatch("inf:feed:recent", [])).toEqual(
      answerInOwnWords("inf:feed:recent"),
    );
    expect(await at.shell.dispatch("inf:cards:open-page", ["page-card"])).toEqual({
      refusal: SAID.openPage,
    });
    expect(await at.shell.dispatch("inf:browser:reopen", ["sign-up"])).toEqual({
      ok: false,
      text: SAID.reopen,
    });
    await expect(at.shell.dispatch("inf:browser:stop", ["sign-up"])).rejects.toThrow(SAID.stop);
    // INF-3676: a task's record and the cards it wrote itself, as written too.
    for (const [channel, args] of OWN_READS)
      expect(await at.shell.dispatch(channel, [...args])).toEqual(answerInOwnWords(channel));
    at.own.core.events.emit("inf:cards", ownCards());
    await expect.poll(() => pushed(at.pushes, "inf:cards")).toBe(1);
    expect(at.pushes.find((push) => push.channel === "inf:cards")?.payload).toEqual(ownCards());
    // Every answer came over the local door from its own core.
    expect(at.own.dispatch.mock.calls.map((call) => call[0])).toEqual([
      "inf:feed:recent",
      "inf:cards:open-page",
      "inf:browser:reopen",
      "inf:browser:stop",
      ...OWN_READS.map(([channel]) => channel),
    ]);
  });

  it("asks directly when the door never welcomes the window", async () => {
    const { link, heard } = standInLink();
    const at = homeShell({ link, readyMs: 20 });
    await at.shell.start();
    expect(heard.closed).toBe(true);
    expect(await at.shell.dispatch("inf:app:healthcheck", [])).toEqual({
      ownCore: "inf:app:healthcheck",
    });
    at.own.core.events.emit("inf:models:changed", { ok: true });
    expect(pushed(at.pushes, "inf:models:changed")).toBe(1);
  });

  it("asks directly, and reads everything again, once the door refuses the window", async () => {
    const { link, heard } = standInLink();
    const at = homeShell({ link, readyMs: 1_000 });
    const starting = at.shell.start();
    await expect.poll(() => heard.options !== null).toBe(true);
    heard.welcomed = true;
    heard.options?.onCaughtUp?.("reload");
    await starting;
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null });
    heard.options?.onState?.({ removed: true } as never);
    expect(heard.closed).toBe(true);
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, caughtUp: 1 });
    expect(pushed(at.pushes, "inf:devices:this-mac")).toBe(1);
    expect(await at.shell.dispatch("inf:app:healthcheck", [])).toEqual({
      ownCore: "inf:app:healthcheck",
    });
    at.own.core.events.emit("inf:models:changed", { ok: true });
    expect(pushed(at.pushes, "inf:models:changed")).toBe(1);
  });

  it("reads everything again after a gap its first mate could not replay, but not at the first welcome", async () => {
    const { link, heard } = standInLink();
    const at = homeShell({ link, readyMs: 1_000 });
    const starting = at.shell.start();
    await expect.poll(() => heard.options !== null).toBe(true);
    heard.welcomed = true;
    heard.options?.onCaughtUp?.("reload");
    await starting;
    heard.options?.onCaughtUp?.("replay");
    expect(at.shell.thisMac()).not.toHaveProperty("caughtUp");
    heard.options?.onCaughtUp?.("reload");
    expect(at.shell.thisMac()).toMatchObject({ role: "home", left: null, caughtUp: 1 });
  });

  // INF-3808: a read the drop refused, such as the Version row's notes, was never asked
  // again when the link dialed through and replayed what the window missed.
  it("tells the window each time its link comes back, replayed or not, but not at the first welcome", async () => {
    const { link, heard } = standInLink();
    const at = homeShell({ link, readyMs: 1_000 });
    const starting = at.shell.start();
    await expect.poll(() => heard.options !== null).toBe(true);
    heard.welcomed = true;
    heard.options?.onCaughtUp?.("reload");
    await starting;
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null });
    expect(pushed(at.pushes, "inf:devices:this-mac")).toBe(0);

    heard.options?.onCaughtUp?.("replay");
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, linkBack: 1 });
    expect(at.pushes.at(-1)).toEqual({
      channel: "inf:devices:this-mac",
      payload: { role: "home", left: null, linkBack: 1 },
    });
    heard.options?.onCaughtUp?.("reload");
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, caughtUp: 1, linkBack: 2 });
  });
});
