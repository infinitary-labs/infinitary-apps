import { CONTRACT_CHANGES } from "@core/connection/contractChanges";
import type { HomeLinkOptions, HomeLinkState } from "@core/devices/homeLink";
import { JoinedHome } from "@core/devices/joinedHome";
import type { UpdateChecker } from "@core/update/updateChecker";
import { customApiConnectInputSchema } from "@shared/customApi";
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
      state: () => ({ ...state, homeChanges: changes }),
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
    for (const unsupported of [
      null,
      [],
      CONTRACT_CHANGES.names.filter((name) => name !== "custom-token-command"),
    ]) {
      changes = unsupported;
      invoke.mockClear();
      await expect(view.dispatch(channel, args(command))).rejects.toThrow(
        "before saving a token command",
      );
      expect(invoke).not.toHaveBeenCalled();
      await expect(view.dispatch(channel, args(fixed))).resolves.toEqual({ listed: [] });
      expect(invoke).toHaveBeenCalledWith(channel, args(fixed));
    }
    changes = [...CONTRACT_CHANGES.names];
    invoke.mockClear();
    await expect(view.dispatch(channel, args(command))).resolves.toEqual({ listed: [] });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(channel, args(command));
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
          homeVersion: null,
          homeChanges: CONTRACT_CHANGES.names,
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
