import { type DeviceSsh, type DeviceView, reachFrom } from "@shared/devices";
import { PROTOCOL_VERSION } from "@shared/ipc";
import type { ComputerSignIns } from "@shared/signIns";
import { describe, expect, it, vi } from "vitest";
import { contractChange } from "../connection/contractChanges";
import { DeviceSignIns } from "./deviceSignIns";

/**
 * Every surface that draws a computer out of reach says "connecting" for one
 * whose connection is being made (captain, INF-49); the sign-ins view carries
 * it to Subscriptions, Projects' Runs on and the device forge rows.
 */

const MINI: DeviceView = { id: "mini", kind: "work", name: "Mac mini", pairedAt: 1 };

function view(inReach: boolean, ssh: DeviceSsh | undefined) {
  const signIns = new DeviceSignIns({
    devices: () => [MINI],
    work: {
      ask: async () => {
        throw new Error("not asked");
      },
      onWorkDevice: () => () => {},
      inReach: () => inReach,
      version: () => undefined,
    },
    emit: () => {},
    broadcastEvent: () => {},
    reachOf: () => reachFrom({ inReach, ssh }),
  });
  const [only] = signIns.view();
  signIns.dispose();
  return only;
}

describe("a computer's sign-ins view", () => {
  // Accepted token-command plan: an older work computer must not silently keep a fixed key instead.
  it("forwards a token command only to a computer advertising that capability", async () => {
    const changes: string[] = [];
    const ask = vi.fn(async () => ({ listed: [] }));
    const signIns = new DeviceSignIns({
      devices: () => [MINI],
      work: {
        ask,
        onWorkDevice: () => () => {},
        inReach: () => true,
        version: () => ({ contract: PROTOCOL_VERSION, takesWork: true, changes }),
      },
      emit: () => {},
      broadcastEvent: () => {},
    });
    try {
      const args = [
        { tokenCommand: { command: "company-token --audience claude", refreshSeconds: 300 } },
      ];
      await expect(signIns.custom(MINI.id, "inf:sign-ins:custom-connect", args)).rejects.toThrow(
        "before saving a token command",
      );
      expect(ask).not.toHaveBeenCalled();
      changes.push(contractChange("custom-token-command"));
      await expect(signIns.custom(MINI.id, "inf:sign-ins:custom-connect", args)).resolves.toEqual({
        listed: [],
      });
      expect(ask).toHaveBeenCalledWith(MINI.id, "inf:sign-ins:custom-connect", args);
    } finally {
      signIns.dispose();
    }
  });
  // INF-2186: account posture narrowed the same remote model list for every task row.
  it("narrows each computer's sign-ins once per projection and drops the snapshot after a new answer", () => {
    const model = { provider: "openai-codex", id: "gpt-6.1-sol" };
    const older = { provider: model.provider, id: "gpt-6.0-sol" };
    let kept = [model.id];
    const protectedIds = vi.fn(() => kept);
    const answer: ComputerSignIns = {
      providers: [],
      quota: null,
      accounts: [
        {
          id: "work",
          providerId: model.provider,
          kind: "subscription_oauth",
          label: "Work",
          enabled: true,
          connected: true,
          pinned: false,
          createdAt: 1,
        },
      ],
      served: [{ accountId: "work", models: [model, older], accountList: [model.id] }],
    };
    const signIns = new DeviceSignIns({
      devices: () => [MINI],
      work: {
        ask: async () => {
          throw new Error("read should not ask");
        },
        onWorkDevice: () => () => {},
        inReach: () => true,
        version: () => undefined,
      },
      protectedIds,
      emit: () => {},
      broadcastEvent: () => {},
    });
    try {
      signIns.changed(MINI.id, answer);
      protectedIds.mockClear();
      for (let row = 0; row < 40; row += 1) signIns.lastSaid(MINI.id);
      const baseline = protectedIds.mock.calls.length;
      protectedIds.mockClear();
      signIns.readProjection(() => {
        for (let row = 0; row < 40; row += 1)
          expect(signIns.lastSaid(MINI.id)?.served?.[0]?.models).toEqual([model]);
        expect(protectedIds).toHaveBeenCalledTimes(1);
        signIns.changed(MINI.id, {
          ...answer,
          served: [
            { accountId: "work", models: [model, older], accountList: [model.id, older.id] },
          ],
        });
        expect(signIns.lastSaid(MINI.id)?.served?.[0]?.models).toEqual([model, older]);
        expect(protectedIds).toHaveBeenCalledTimes(2);
      });
      expect(baseline).toBe(40);
      signIns.changed(MINI.id, answer);
      kept = [model.id, older.id];
      // A new projection re-reads the rail; the missing kept model refuses narrowing.
      signIns.readProjection(() =>
        expect(signIns.lastSaid(MINI.id)?.served?.[0]?.models).toEqual([model, older]),
      );
    } finally {
      signIns.dispose();
    }
  });
  it("says connecting only for a computer out of reach whose connection is being made", () => {
    expect(view(false, { state: "connecting" })).toMatchObject({
      reach: "connecting",
    });
    for (const state of ["reconnecting", "at-login", "not-started", "stopped"] as const)
      expect(view(false, { state })?.reach).toBe(
        state === "reconnecting" ? "reconnecting" : "out-of-reach",
      );
    expect(view(false, undefined)?.reach).toBe("out-of-reach");
    expect(view(true, { state: "connecting" })?.reach).toBe("in-reach");
  });
});
