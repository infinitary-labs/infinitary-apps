import { describe, expect, it } from "vitest";
import {
  accountIdFromNeedsReauthCard,
  isNeedsReauthRow,
  needsReauthCardId,
  needsReauthCopy,
  REFRESH_TOKEN_LAPSED,
  REJECTED_AFTER_RENEWAL,
  restoreAccountEffect,
} from "./credentialHealth";

describe("credentialHealth (CD-3=A)", () => {
  it("treats only auth_required as the terminal re-auth state", () => {
    expect(isNeedsReauthRow({ status: "auth_required" })).toBe(true);
    expect(isNeedsReauthRow({ status: "unavailable" })).toBe(false);
    expect(isNeedsReauthRow({ status: "ok" })).toBe(false);
    expect(isNeedsReauthRow({ status: "rate_limited" })).toBe(false);
  });

  it("names the account in one sentence and wires a one-step restore effect", () => {
    expect(needsReauthCopy("Claude", "Personal")).toBe(
      "Claude (Personal) needs you to sign in again.",
    );
    expect(needsReauthCardId("acct_cl1")).toBe("card-auth-account-acct_cl1");
    expect(accountIdFromNeedsReauthCard("card-auth-account-acct_cl1")).toBe("acct_cl1");
    // The one way out rides the card's action as a host effect (cards/tasks/
    // agents P1): the account is the effect's argument, never encoded in an id.
    expect(restoreAccountEffect("acct_cl1")).toEqual({
      kind: "host",
      op: "restore-account",
      arg: "acct_cl1",
    });
  });

  it("keeps the two proof reason codes distinct and named", () => {
    expect(REFRESH_TOKEN_LAPSED).toBe("refresh_token_lapsed");
    expect(REJECTED_AFTER_RENEWAL).toBe("rejected_after_renewal");
  });
});
