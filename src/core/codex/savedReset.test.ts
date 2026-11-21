import * as m from "@shared/i18n/messages.generated";
import { CODEX_SAVED_RESET_FLOOR } from "@shared/savedResets";
import { describe, expect, it } from "vitest";
import { STAND_IN_CHATGPT_ID, standInCodex } from "../../../tests/helpers/codexAppServer";
import type { AuthInteractionBridge } from "../pi/piAuth";
import type { CodexCliCheck } from "./codexCli";
import {
  callbackFor,
  loopbackRedirect,
  redeemSavedReset,
  type SavedResetAttempt,
  type SavedResetReach,
} from "./savedReset";

/**
 * Using a saved Codex reset (INF-5478's accepted plan, piece 1;
 * docs/codex-client.md) against a stand-in for Codex's app-server
 * (`tests/helpers/codexAppServer.ts`).
 */

const ACCOUNT = "acct-work";
const CHATGPT_ID = STAND_IN_CHATGPT_ID;

function reachWith(
  stand: ReturnType<typeof standInCodex>,
  options: { cli?: CodexCliCheck; ownId?: string } = {},
) {
  let kept: SavedResetAttempt | undefined;
  const saves: SavedResetAttempt[] = [];
  const reach: SavedResetReach = {
    check: async () =>
      options.cli ?? { state: "ready", executable: "/usr/local/bin/codex", version: "0.155.1" },
    home: (accountId) => `/accounts/${accountId}/codex`,
    ownAccountId: async () => options.ownId ?? CHATGPT_ID,
    attempt: {
      read: () => kept,
      save: (_accountId, attempt) => {
        kept = attempt;
        saves.push(attempt);
      },
      clear: () => {
        kept = undefined;
      },
    },
    version: "0.8.5",
    start: stand.start,
  };
  return { reach, kept: () => kept, saves };
}

const USE = { accountId: ACCOUNT, providerId: "openai-codex", account: "Codex · Work" };

function bridgeRecorder(pasted?: string) {
  const notices: { kind: string; url?: string }[] = [];
  const prompts: string[] = [];
  const opened: string[] = [];
  const bridge: AuthInteractionBridge = {
    notify: (notice) => notices.push(notice),
    prompt: async (prompt) => {
      prompts.push(prompt.message);
      if (pasted === undefined) return new Promise<string>(() => {});
      return pasted;
    },
    openExternal: async (url) => {
      opened.push(url);
    },
  };
  return { bridge, notices, prompts, opened };
}

describe("using a saved Codex reset", () => {
  it("uses the available reset that expires first and says how many are left", async () => {
    const stand = standInCodex({
      available: 3,
      credits: [
        { id: "never", status: "available", expiresAt: null },
        { id: "late", status: "available", expiresAt: 1_800_000_000 },
        { id: "spent", status: "redeemed", expiresAt: 1_700_000_000 },
        { id: "soon", status: "available", expiresAt: 1_790_000_000 },
      ],
    });
    const { reach, kept, saves } = reachWith(stand);
    await expect(redeemSavedReset(reach, USE)).resolves.toEqual({ outcome: "used", left: 2 });
    const consume = stand.sent.find((s) => s.method === "account/rateLimitResetCredit/consume");
    expect(consume?.params?.creditId).toBe("soon");
    // The attempt was kept before it was sent, under the key it was sent with, and cleared after.
    expect(saves).toEqual([{ key: consume?.params?.idempotencyKey, creditId: "soon" }]);
    expect(kept()).toBeUndefined();
    expect(stand.methods()).not.toContain("account/login/start");
    // One process, with its home in the account's own folder.
    expect(stand.homes).toEqual([`/accounts/${ACCOUNT}/codex`]);
  });

  it("refuses with where to install Codex when it is missing or older than the floor, starting nothing", async () => {
    const stand = standInCodex({});
    const missing = reachWith(stand, { cli: { state: "missing" } }).reach;
    await expect(redeemSavedReset(missing, USE)).rejects.toThrow(
      m.accountsSavedResetNoCodex({ floor: CODEX_SAVED_RESET_FLOOR, site: "chatgpt.com" }),
    );
    const old = reachWith(stand, {
      cli: { state: "old", executable: "/usr/local/bin/codex", version: "0.142.0" },
    }).reach;
    await expect(redeemSavedReset(old, USE)).rejects.toThrow(
      m.accountsSavedResetOldCodex({
        floor: CODEX_SAVED_RESET_FLOOR,
        version: "0.142.0",
        site: "chatgpt.com",
      }),
    );
    expect(stand.starts()).toBe(0);
  });

  it("signs Codex out and uses nothing when its sign-in is another ChatGPT account", async () => {
    const stand = standInCodex({ accountId: "someone-else" });
    const { reach, saves } = reachWith(stand);
    await expect(redeemSavedReset(reach, USE)).rejects.toThrow(
      m.accountsSavedResetOtherAccount({ account: USE.account }),
    );
    expect(stand.methods()).toContain("account/logout");
    expect(stand.methods()).not.toContain("account/rateLimitResetCredit/consume");
    expect(saves).toEqual([]);
  });

  it("sends the same key again after Codex stopped mid-use, and clears it after a clear answer", async () => {
    const stand = standInCodex({ consume: "crash" });
    const { reach, kept } = reachWith(stand);
    await expect(redeemSavedReset(reach, USE)).rejects.toThrow(
      m.accountsSavedResetUnclear({ account: USE.account }),
    );
    const first = kept();
    expect(first?.key).toBeTruthy();

    stand.consume = "alreadyRedeemed";
    await expect(redeemSavedReset(reach, USE)).resolves.toMatchObject({ outcome: "used" });
    const keys = stand.sent
      .filter((s) => s.method === "account/rateLimitResetCredit/consume")
      .map((s) => s.params?.idempotencyKey);
    expect(keys).toEqual([first?.key, first?.key]);
    expect(kept()).toBeUndefined();
  });

  it("says nothing was used when no allowance it covers is spent", async () => {
    const stand = standInCodex({ consume: "nothingToReset" });
    const { reach, kept } = reachWith(stand);
    await expect(redeemSavedReset(reach, USE)).resolves.toEqual({ outcome: "nothing-to-reset" });
    expect(kept()).toBeUndefined();
  });

  it("refuses an account Codex is not signed in to when nobody asked for a sign-in", async () => {
    const stand = standInCodex({ signedIn: false });
    const { reach } = reachWith(stand);
    await expect(redeemSavedReset(reach, USE)).rejects.toThrow(
      m.accountsSavedResetSignInFirst({ account: USE.account }),
    );
    expect(stand.methods()).not.toContain("account/login/start");
    expect(stand.methods()).not.toContain("account/rateLimitResetCredit/consume");
  });

  it("signs Codex in through the sign-in's link and prompt first, then uses the reset", async () => {
    const stand = standInCodex({ signedIn: false });
    const { reach } = reachWith(stand);
    const { bridge, notices, prompts, opened } = bridgeRecorder();
    await expect(redeemSavedReset(reach, { ...USE, bridge })).resolves.toMatchObject({
      outcome: "used",
    });
    expect(notices).toEqual([
      expect.objectContaining({ kind: "auth_url", url: expect.stringContaining("auth.openai") }),
    ]);
    expect(opened).toHaveLength(1);
    expect(prompts).toEqual([m.accountsSavedResetPastePrompt()]);
    const methods = stand.methods();
    expect(methods.indexOf("account/login/start")).toBeLessThan(
      methods.indexOf("account/rateLimitResetCredit/consume"),
    );
  });

  it("refuses a second use of the same account while one runs, and the first one alone sends a key", async () => {
    const stand = standInCodex({});
    const { reach, saves } = reachWith(stand);
    const first = redeemSavedReset(reach, USE);
    await expect(redeemSavedReset(reach, USE)).rejects.toThrow(
      m.accountsSavedResetBusy({ account: USE.account }),
    );
    await expect(first).resolves.toMatchObject({ outcome: "used" });
    expect(stand.starts()).toBe(1);
    expect(saves).toHaveLength(1);
    // Once it ended, the account takes a use again.
    await expect(redeemSavedReset(reach, USE)).resolves.toMatchObject({ outcome: "used" });
  });

  it("signs Codex out and in again when the sign-in it kept no longer works, then uses the reset", async () => {
    const stand = standInCodex({ stale: true });
    const { reach } = reachWith(stand);
    const { bridge, notices } = bridgeRecorder();
    await expect(redeemSavedReset(reach, { ...USE, bridge })).resolves.toMatchObject({
      outcome: "used",
    });
    expect(notices).toHaveLength(1);
    const methods = stand.methods();
    expect(methods.indexOf("account/logout")).toBeLessThan(methods.indexOf("account/login/start"));
    expect(methods.indexOf("account/login/start")).toBeLessThan(
      methods.indexOf("account/rateLimitResetCredit/consume"),
    );
  });

  it("says to sign Codex in again on the row when its kept sign-in no longer works and none can be shown", async () => {
    const stand = standInCodex({ stale: true });
    const { reach, saves } = reachWith(stand);
    await expect(redeemSavedReset(reach, USE)).rejects.toThrow(
      m.accountsSavedResetSignInAgain({ account: USE.account }),
    );
    expect(stand.methods()).toContain("account/logout");
    expect(stand.methods()).not.toContain("account/login/start");
    expect(saves).toEqual([]);
  });

  it("uses nothing when Codex's sign-in fails", async () => {
    const stand = standInCodex({ signedIn: false, login: "failure" });
    const { reach } = reachWith(stand);
    const { bridge } = bridgeRecorder();
    await expect(redeemSavedReset(reach, { ...USE, bridge })).rejects.toThrow(
      m.accountsSavedResetSignInFailed(),
    );
    expect(stand.methods()).not.toContain("account/rateLimitResetCredit/consume");
  });
});

describe("the pasted address of Codex's sign-in", () => {
  const authUrl =
    "https://auth.openai.com/oauth/authorize?client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc";

  it("goes back to Codex's own sign-in on this computer with the page's code and state", () => {
    const redirect = loopbackRedirect(authUrl);
    expect(redirect?.toString()).toBe("http://localhost:1455/auth/callback");
    expect(
      callbackFor(
        redirect as URL,
        "  http://localhost:1455/auth/callback?code=c0de&scope=openid&state=abc ",
      ),
    ).toBe("http://localhost:1455/auth/callback?code=c0de&scope=openid&state=abc");
  });

  it("is refused without a code and state, and an address off this computer is never a return address", () => {
    const redirect = loopbackRedirect(authUrl) as URL;
    expect(callbackFor(redirect, "http://localhost:1455/auth/callback?state=abc")).toBeUndefined();
    expect(callbackFor(redirect, "hello")).toBeUndefined();
    expect(
      loopbackRedirect(
        "https://auth.openai.com/oauth/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcb",
      ),
    ).toBeUndefined();
  });
});
