import type { CustomApiView } from "@shared/customApi";
import type { CustomHomeDefinition } from "@shared/customApiFile";
import type { DeviceView } from "@shared/devices";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { expect, it, vi } from "vitest";
import type { WorkDeviceContact } from "../connection/connection";
import { DeviceSignIns } from "./deviceSignIns";

/**
 * INF-6581's plan, piece 3: the first mate's computer sends a custom
 * connection to each computer that runs work and takes it, and that computer
 * follows its later edits; an older computer is not offered it.
 */

const MINI: DeviceView = { id: "mini", kind: "work", name: "Mac mini", pairedAt: 1 };
const HOME_ACCOUNT = "acct-home-gateway";

/** What the computer says of the connection it approved from the home's, as its sign-ins carry it. */
const followed: CustomApiView = {
  accountId: "acct-there",
  label: "Team gateway",
  baseUrl: "https://llm-gateway.example.com/v1",
  mode: "public",
  protocol: "openai-completions",
  keyPresent: true,
  noKey: false,
  headers: [],
  enabled: true,
  allowStorageDefault: false,
  home: { name: HOME_ACCOUNT, state: "current" },
  certificates: [],
  models: [{ id: "operator-model", context: 65536, output: 1024, checked: true, state: "checked" }],
};

const definition = (label: string): CustomHomeDefinition => ({
  name: HOME_ACCOUNT,
  definition: {
    label,
    baseUrl: "https://llm-gateway.example.com/v1",
    protocol: "openai-completions",
    headers: [{ name: "X-Gateway-Token", secret: true }],
    models: [{ id: "operator-model", context: 65536, output: 1024 }],
  },
});
/** A connection here the computer never approved one of its own from. */
const other: CustomHomeDefinition = {
  ...definition("Other gateway"),
  name: "acct-home-other",
};

function world() {
  const changes: string[] = [];
  const ask = vi.fn(async (_deviceId: string, channel: string, _args: unknown[]) =>
    channel === "inf:sign-ins:list"
      ? { providers: [], accounts: [], quota: null, custom: [followed] }
      : { ok: true },
  );
  let contactOf: ((contact: WorkDeviceContact) => void) | undefined;
  const signIns = new DeviceSignIns({
    devices: () => [MINI],
    work: {
      ask,
      onWorkDevice: (listener) => {
        contactOf = listener;
        return () => {};
      },
      inReach: () => true,
      version: () => ({ contract: PROTOCOL_VERSION, takesWork: true, changes: [...changes] }),
    },
    emit: () => {},
    broadcastEvent: () => {},
  });
  const sent = () =>
    ask.mock.calls
      .filter(([, channel]) => channel === "inf:sign-ins:custom-definitions")
      .map(([, , args]) => args[0]);
  return {
    changes,
    ask,
    signIns,
    sent,
    contact: (contact: WorkDeviceContact) => contactOf?.(contact),
  };
}

it("sends a computer only the home's connections it follows, once it lists the change, and again after its next contact", async () => {
  const { changes, signIns, sent, contact } = world();
  let ours = [definition("Team gateway"), other];
  try {
    await signIns.refresh(MINI.id);
    signIns.followCustomDefinitions(() => ours);
    expect(signIns.view()[0]?.customFromHome).toBeUndefined();
    expect(sent()).toEqual([]);

    changes.push("custom-connection-from-home");
    signIns.sendCustomDefinitions();
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(signIns.view()[0]?.customFromHome).toBe(true);
    // Only the connection it follows, with no key or secret value in it.
    expect(sent()).toEqual([[definition("Team gateway")]]);

    // Nothing new: nothing sent.
    signIns.sendCustomDefinitions();
    await Promise.resolve();
    expect(sent()).toHaveLength(1);

    ours = [definition("Renamed gateway"), other];
    signIns.sendCustomDefinitions();
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual([definition("Renamed gateway")]);

    // Gone here: sent without it, which holds it there as gone.
    ours = [other];
    signIns.sendCustomDefinitions();
    await vi.waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent()[2]).toEqual([]);

    // A computer that comes back may have restarted, holding nothing sent before.
    contact({ deviceId: MINI.id, contact: "in-reach" });
    await signIns.refresh(MINI.id);
    signIns.sendCustomDefinitions();
    await vi.waitFor(() => expect(sent()).toHaveLength(4));
    expect(sent()[3]).toEqual([]);
  } finally {
    signIns.dispose();
  }
});

it("refuses to approve a home's connection on a computer that does not list the change", async () => {
  const { changes, ask, signIns } = world();
  const args = [{ label: "Team gateway", home: HOME_ACCOUNT }];
  try {
    await expect(signIns.custom(MINI.id, "inf:sign-ins:custom-connect", args)).rejects.toThrow(
      "Update Infinitary on Mac mini to use this connection there.",
    );
    expect(ask).not.toHaveBeenCalled();
    changes.push("custom-connection-from-home");
    await signIns.custom(MINI.id, "inf:sign-ins:custom-connect", args).catch(() => undefined);
    expect(ask).toHaveBeenCalledWith(MINI.id, "inf:sign-ins:custom-connect", args);
  } finally {
    signIns.dispose();
  }
});
