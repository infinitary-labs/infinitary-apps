import { CONTRACT_CHANGES } from "@core/connection/contractChanges";
import type { HomeLinkOptions, HomeLinkState } from "@core/devices/homeLink";
import { JoinedHome } from "@core/devices/joinedHome";
import type { UpdateChecker } from "@core/update/updateChecker";
import { customApiConnectInputSchema } from "@shared/customApi";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import { afterEach, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ViewBackend } from "./viewBackend";

const views: ViewBackend[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
});

// Accepted token-command plan forbids silent fixed-key fallback; INF-3508 found
// optional-field stripping at an older home, on both local and work-account routes.
it("refuses command settings before forwarding to an old or unknown home, without changing fixed-key calls", async () => {
  let changes: HomeLinkState["homeChanges"] = null;
  let homeVersion: HomeLinkState["homeVersion"] = null;
  const invoke = vi.fn(async () => ({ listed: [] }));
  const state: HomeLinkState = {
    contact: "in-reach",
    access: "full",
    homeVersion: null,
    homeChanges: null,
    name: null,
    takesWork: null,
    onHomeMac: null,
    heardAt: null,
    removed: false,
  };
  const view = new ViewBackend({
    joined: new JoinedHome(scratchDir("view-command-")),
    record: {
      version: 1,
      grant: {
        at: "127.0.0.1:1",
        homeKey: "unused",
        deviceId: "view",
        kind: "view",
        key: "unused",
        cert: "unused",
      },
      name: null,
      joinedAt: 1,
    },
    broadcast: () => {},
    notifications: { supported: () => false, focused: () => true, show: () => {} },
    onThisMac: () => {},
    onRemoved: () => {},
    // No update action is used by connect dispatch.
    updates: {} as UpdateChecker,
    link: () => ({
      start: () => {},
      state: () => ({ ...state, homeVersion, homeChanges: changes }),
      invoke: invoke as never,
      leave: async () => true,
      close: () => {},
    }),
  });
  views.push(view);
  const command = customApiConnectInputSchema.parse({
    label: "Company gateway",
    baseUrl: "https://gateway.example/v1",
    protocol: "anthropic-messages",
    key: "",
    noKey: false,
    headers: [],
    tokenCommand: { command: "company-token --audience claude", refreshSeconds: 300 },
    replaceAccountId: "existing-fixed-key",
    models: [],
    approvedDestination: "https://gateway.example/v1",
    unencryptedLocalApproved: false,
    allowStorageDefault: false,
    storageApproved: false,
  });
  const { tokenCommand: _command, ...fixed } = command;
  fixed.key = "disposable-fixed-key";
  for (const channel of ["inf:accounts:custom:connect", "inf:devices:custom:connect"] as const) {
    const args = (input: unknown) =>
      channel === "inf:accounts:custom:connect" ? [input] : ["work", input];
    // Before the home's welcome, and a home on major 15 that does not name the token command.
    for (const unsupported of [
      { version: null, changes: null },
      { version: "15.0.0", changes: [] },
      { version: "15.0.0", changes: ["font-choice", "sign-in-return"] },
    ]) {
      homeVersion = unsupported.version;
      changes = unsupported.changes;
      invoke.mockClear();
      await expect(view.dispatch(channel, args(command))).rejects.toThrow(
        "before saving a token command",
      );
      expect(invoke).not.toHaveBeenCalled();
      await expect(view.dispatch(channel, args(fixed))).resolves.toEqual({ listed: [] });
      expect(invoke).toHaveBeenCalledWith(channel, args(fixed));
    }
    // A home on major 15 that names it, and every home from major 16 on, which folded the name in.
    for (const supported of [
      { version: "15.0.0", changes: ["custom-token-command"] },
      { version: PROTOCOL_VERSION, changes: [] },
    ]) {
      homeVersion = supported.version;
      changes = supported.changes;
      invoke.mockClear();
      await expect(view.dispatch(channel, args(command))).resolves.toEqual({ listed: [] });
      expect(invoke).toHaveBeenCalledExactlyOnceWith(channel, args(command));
    }
  }
});

// INF-3750's option D: the home sends streamed reply pieces and tool starts and ends as `live` frames, and the
// window's crewmate transcript and Observe read them as events, as they did numbered. INF-3851's piece 3 sends the
// computers' readings live too, and the window's computer screens and panels read them as they did numbered.
it("hands a streamed reply piece and a computers' reading the home sent live to this Mac's windows", () => {
  const sent: [string, unknown][] = [];
  let hear: HomeLinkOptions["onLive"];
  const view = new ViewBackend({
    joined: new JoinedHome(scratchDir("view-live-")),
    record: {
      version: 1,
      grant: {
        at: "127.0.0.1:1",
        homeKey: "unused",
        deviceId: "view",
        kind: "view",
        key: "unused",
        cert: "unused",
      },
      name: null,
      joinedAt: 1,
    },
    broadcast: (channel, payload) => sent.push([channel, payload]),
    notifications: { supported: () => false, focused: () => true, show: () => {} },
    onThisMac: () => {},
    onRemoved: () => {},
    // No update action is used here.
    updates: {} as UpdateChecker,
    link: (options) => {
      hear = options.onLive;
      return {
        start: () => {},
        state: () => ({
          contact: "in-reach",
          access: "full",
          // A home on this major, which has by its version what major 16 folded in.
          homeVersion: PROTOCOL_VERSION,
          homeChanges: [],
          name: null,
          takesWork: null,
          onHomeMac: null,
          heardAt: null,
          removed: false,
        }),
        invoke: (async () => null) as never,
        leave: async () => true,
        close: () => {},
      };
    },
  });
  views.push(view);
  const piece = {
    type: "assistant_delta",
    taskId: "t1",
    text: "The harbour opens at six.",
  } as const;
  hear?.("inf:event", piece);
  const reading = {
    computers: [
      { computerId: null, label: "Mac mini", reading: { status: "unknown", reason: "missing" } },
    ],
  };
  hear?.("inf:computers:resources", reading);
  expect(sent).toEqual([
    ["inf:event", piece],
    ["inf:computers:resources", reading],
  ]);
});

/**
 * A view of another Mac whose saved look - light at 125%, with its panels switch on - answers only
 * when the test says so. Closing the view refuses that answer, as closing the connection refuses
 * every request still waiting.
 */
function viewWithHeldLook() {
  const sent: ShellPreferences[] = [];
  let hear: HomeLinkOptions["onPush"] = () => {};
  let answerLook = () => {};
  let refuseLook = (_error: Error) => {};
  const looked = new Promise<void>((resolve, reject) => {
    answerLook = resolve;
    refuseLook = reject;
  });
  const saved: ShellPreferences = {
    ...DEFAULT_SHELL_PREFERENCES,
    appearance: { ...DEFAULT_SHELL_PREFERENCES.appearance, theme: "light", size: 125 },
  };
  const view = new ViewBackend({
    joined: new JoinedHome(scratchDir("view-look-")),
    record: {
      version: 1,
      grant: {
        at: "127.0.0.1:1",
        homeKey: "unused",
        deviceId: "view",
        kind: "view",
        key: "unused",
        cert: "unused",
      },
      name: null,
      joinedAt: 1,
    },
    broadcast: (channel, payload) => {
      if (channel === "inf:shell:preferences") sent.push(payload as ShellPreferences);
    },
    notifications: { supported: () => false, focused: () => true, show: () => {} },
    onThisMac: () => {},
    onRemoved: () => {},
    // No update action is used here.
    updates: {} as UpdateChecker,
    link: (options) => {
      hear = options.onPush;
      return {
        start: () => {},
        state: () => ({
          contact: "in-reach",
          access: "full",
          // A home on this major, which has by its version what major 16 folded in.
          homeVersion: PROTOCOL_VERSION,
          homeChanges: [],
          name: null,
          takesWork: null,
          onHomeMac: null,
          heardAt: null,
          removed: false,
        }),
        invoke: (async (channel: string) => {
          if (channel !== "inf:shell:preferences") throw new Error(`Unasked ${channel}`);
          await looked;
          return saved;
        }) as never,
        leave: async () => true,
        close: () => refuseLook(new Error("The connection went mid-request.")),
      };
    },
  });
  views.push(view);
  return {
    view,
    sent,
    saved,
    answerLook,
    /** The other Mac's panels switch, pushed as it changes there. */
    hearPanels: () => hear("inf:shell:preferences", saved, false),
  };
}

// docs/view.md, "The switch and the layout": this Mac takes the other Mac's saved look once, and a
// panels switch pushed before that look answers waits for it, so the window is never drawn in the
// catalog's look first. The ordering the merge queue's batch hit, held here so it runs every time.
it("tells a panels switch heard before the other Mac's look answers only after that look", async () => {
  const { sent, saved, answerLook, hearPanels } = viewWithHeldLook();
  hearPanels();
  expect(sent).toEqual([]);
  answerLook();
  await vi.waitFor(() => expect(sent.at(-1)?.panels.enabled).toBe(true));
  expect(sent.map((value) => value.appearance)).toEqual(sent.map(() => saved.appearance));
});

// The review of that fix: a switch still waiting when this view is closed - leaving the other Mac,
// or removed from it - would tell the windows the catalog's look as the look's answer is refused.
it("tells no waiting panels switch once the view is closed", async () => {
  const { view, sent, hearPanels } = viewWithHeldLook();
  hearPanels();
  view.dispose();
  // The refusal's work all runs before the next turn of the event loop.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sent).toEqual([]);
});

// INF-4175: a choice's record names what pressed its button. An older home
// reads the press's submission strictly and would take one naming its input
// as unreadable, so a view leaves the input out there and sends it to a home
// that lists the change.
it("sends what pressed a card's button only to a home that reads it", async () => {
  let changes: HomeLinkState["homeChanges"] = null;
  const invoke = vi.fn(async () => ({}));
  const view = new ViewBackend({
    joined: new JoinedHome(scratchDir("view-press-input-")),
    record: {
      version: 1,
      grant: {
        at: "127.0.0.1:1",
        homeKey: "unused",
        deviceId: "view",
        kind: "view",
        key: "unused",
        cert: "unused",
      },
      name: null,
      joinedAt: 1,
    },
    broadcast: () => {},
    notifications: { supported: () => false, focused: () => true, show: () => {} },
    onThisMac: () => {},
    onRemoved: () => {},
    // No update action is used by a card's press.
    updates: {} as UpdateChecker,
    link: () => ({
      start: () => {},
      state: () => ({
        contact: "in-reach",
        access: "full",
        homeVersion: null,
        homeChanges: changes,
        name: null,
        takesWork: null,
        onHomeMac: null,
        heardAt: null,
        removed: false,
      }),
      invoke: invoke as never,
      leave: async () => true,
      close: () => {},
    }),
  });
  views.push(view);
  const pressed = { id: "862e395c997ddf0c7f20cc8187ca2157", offerId: "offer-1" };
  const input = { kind: "pointer", pointer: "mouse" } as const;
  const act = (submission: object) => ["card-1", "start", "chrome", undefined, submission];
  const noteDone = (submission: object) => ["card-1", submission];
  for (const older of [
    null,
    CONTRACT_CHANGES.names.filter((name) => name !== "card-press-input"),
  ]) {
    changes = older;
    invoke.mockClear();
    await view.dispatch("inf:cards:act", act({ ...pressed, input }) as never);
    await view.dispatch("inf:cards:note-done", noteDone({ ...pressed, input }) as never);
    expect(invoke.mock.calls).toEqual([
      ["inf:cards:act", act(pressed)],
      ["inf:cards:note-done", noteDone(pressed)],
    ]);
  }
  changes = [...CONTRACT_CHANGES.names];
  invoke.mockClear();
  await view.dispatch("inf:cards:act", act({ ...pressed, input }) as never);
  await view.dispatch("inf:cards:note-done", noteDone({ ...pressed, input }) as never);
  expect(invoke.mock.calls).toEqual([
    ["inf:cards:act", act({ ...pressed, input })],
    ["inf:cards:note-done", noteDone({ ...pressed, input })],
  ]);
});
