import { describe, expect, it } from "vitest";
import { STAND_IN_CHATGPT_ID, standInCodex } from "../../../tests/helpers/codexAppServer";
import type { SavedResetReach } from "./savedReset";
import { SavedResets, type SavedResetVault } from "./savedResets";

/**
 * The home's saved-reset use (INF-5478's accepted plan, piece 1;
 * docs/codex-client.md): after a use it says the outcome in the feed and
 * reads the allowance again, so the spent account serves at once.
 */

const ACCOUNT = "acct-work";

function home(stand: ReturnType<typeof standInCodex>) {
  const notes: string[] = [];
  const events: string[] = [];
  const vault = {
    get: () => ({ providerId: "openai-codex", label: "Work" }),
  } as unknown as SavedResetVault;
  const reach: SavedResetReach = {
    check: async () => ({ state: "ready", executable: "/usr/local/bin/codex", version: "0.155.1" }),
    home: (accountId) => `/accounts/${accountId}/codex`,
    ownAccountId: async () => STAND_IN_CHATGPT_ID,
    attempt: { read: () => undefined, save: () => {}, clear: () => {} },
    version: "0.8.5",
    start: stand.start,
  };
  const resets = new SavedResets({
    vault,
    reach,
    computers: {
      redeemSavedReset: async () => {
        throw new Error("no computer in this test");
      },
      accountOf: () => undefined,
    },
    note: (fact) => notes.push(fact.m),
    recheck: () => events.push("recheck"),
    used: (accountId) => events.push(`used ${accountId}`),
  });
  return { resets, notes, events };
}

describe("the home's saved-reset use", () => {
  it("reads the allowance again and withdraws the run-out card after a reset is used", async () => {
    const { resets, notes, events } = home(standInCodex({}));
    await expect(resets.use(ACCOUNT, {})).resolves.toMatchObject({ outcome: "used" });
    expect(notes).toEqual(["accountsSavedResetUsed"]);
    expect(events).toEqual(["recheck", `used ${ACCOUNT}`]);
  });

  it("reads nothing again and keeps the card when no allowance it covers was spent", async () => {
    const { resets, notes, events } = home(standInCodex({ consume: "nothingToReset" }));
    await expect(resets.use(ACCOUNT, {})).resolves.toEqual({ outcome: "nothing-to-reset" });
    expect(notes).toEqual(["accountsSavedResetNothing"]);
    expect(events).toEqual([]);
  });
});
