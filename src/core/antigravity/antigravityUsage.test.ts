import { ANTIGRAVITY_PROVIDER_ID } from "@shared/antigravity";
import { describe, expect, it, vi } from "vitest";
import type { PushedWindow } from "../quota/pushedQuota";
import { AntigravityAllowance, antigravityAccounts, type UsageRead } from "./antigravityUsage";

/**
 * Intent: INF-3776's approved plan - the Antigravity allowance is read only
 * "when the person opens Subscriptions or presses Recheck allowance, never
 * while signed out", and the reading is kept for the account so Subscriptions
 * shows it with its age.
 */

const WEEKLY: PushedWindow = {
  windowId: "seven_day",
  status: "allowed",
  utilization: 0.25,
  resetsAt: 1_800_000_000_000,
  at: 1_799_000_000_000,
};

function allowance(accounts: { id: string; providerId: string; enabled: boolean }[]) {
  const signedOut = new Set<string>();
  const recorded: [string, PushedWindow][] = [];
  let release: (read: UsageRead) => void = () => {};
  const read = vi.fn(
    () =>
      new Promise<UsageRead>((resolve) => {
        release = resolve;
      }),
  );
  const subject = new AntigravityAllowance({
    accounts: antigravityAccounts(
      () => accounts,
      (id) => signedOut.has(id),
    ),
    record: (accountId, window) => recorded.push([accountId, window]),
    read,
  });
  return { subject, read, recorded, signedOut, answer: (value: UsageRead) => release(value) };
}

describe("the Antigravity allowance", () => {
  it("reads once per press, and keeps the reading for the Antigravity account", async () => {
    const world = allowance([
      { id: "acct_codex", providerId: "openai-codex", enabled: true },
      { id: "acct_agy", providerId: ANTIGRAVITY_PROVIDER_ID, enabled: true },
    ]);

    const first = world.subject.onPress();
    // A second press while the report runs shares it.
    const second = world.subject.onPress();
    world.answer({ status: "ok", windows: [WEEKLY] });

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(world.read).toHaveBeenCalledTimes(1);
    expect(world.recorded).toEqual([["acct_agy", WEEKLY]]);
  });

  it("never runs the report while the account is signed out, or with no account", async () => {
    const world = allowance([
      { id: "acct_agy", providerId: ANTIGRAVITY_PROVIDER_ID, enabled: true },
    ]);
    world.signedOut.add("acct_agy");

    expect(await world.subject.onPress()).toBe(false);
    expect(await allowance([]).subject.onPress()).toBe(false);
    expect(world.read).not.toHaveBeenCalled();
  });

  it("keeps the last reading when a report cannot be read", async () => {
    const world = allowance([
      { id: "acct_agy", providerId: ANTIGRAVITY_PROVIDER_ID, enabled: true },
    ]);

    const pressed = world.subject.onPress();
    world.answer({ status: "unreadable", detail: "exit 1" });

    expect(await pressed).toBe(false);
    expect(world.recorded).toEqual([]);
  });
});
