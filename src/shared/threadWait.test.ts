import { describe, expect, it } from "vitest";
import { type ThreadWait, threadWait, threadWaitWords } from "./threadWait";
import type { WorkPosture } from "./workPosture";

const replied = { author: "crewmate", awaiting: "answer", taskId: "t1" } as const;
const NOW = new Date(2026, 9, 3, 12, 0).getTime();
const AT_1_10 = new Date(2026, 9, 3, 13, 10).getTime();

describe("what a captain reply under a crewmate's card waits on", () => {
  it.each([
    [{ state: "paused", reason: "access" }, { on: "account" }],
    [{ state: "active", reason: "checks" }, { on: "checks" }],
    [{ state: "active", reason: "job" }, { on: "background" }],
    [{ state: "active", reason: "settlement" }, { on: "finishing" }],
    [{ state: "active", reason: "guidance" }, { on: "author" }],
  ] as const)("reads %j as %j", (posture, wait) => {
    expect(threadWait(replied, posture)).toEqual(wait);
  });

  it("carries the account's typed hold", () => {
    const hold = { class: "no_headroom", provider: "Claude", resetsAt: AT_1_10 } as const;
    expect(threadWait(replied, { state: "paused", reason: "access", hold })).toEqual({
      on: "account",
      hold,
    });
  });

  it("has none while a turn runs, on a posture that holds nothing, or when no reply waits", () => {
    const checks: WorkPosture = { state: "active", reason: "checks" };
    expect(threadWait(replied, { state: "active", reason: "turn" })).toBeUndefined();
    expect(threadWait(replied, { state: "idle", reason: "inactive" })).toBeUndefined();
    expect(threadWait(replied, undefined)).toBeUndefined();
    // The author has written since: the card waits for its close-out, not him.
    expect(threadWait({ ...replied, awaiting: "close-out" }, checks)).toBeUndefined();
    expect(threadWait({ ...replied, awaiting: undefined }, checks)).toBeUndefined();
    // The Firstmate answers its own cards; the paused seat says so itself.
    expect(threadWait({ ...replied, author: "firstmate" }, checks)).toBeUndefined();
  });
});

describe("the waiting line's words", () => {
  const words = (wait: ThreadWait) => threadWaitWords(wait, "crewmate 7", NOW);

  it("says the reply is saved and names who goes next", () => {
    expect(words({ on: "checks" })).toBe(
      "Saved. Crewmate 7 is waiting for the checks to finish, then answers.",
    );
    expect(words({ on: "author" })).toBe("Saved. Crewmate 7 has not answered yet.");
    expect(threadWaitWords({ on: "author" }, undefined, NOW)).toBe(
      "Saved. The crewmate has not answered yet.",
    );
  });

  it("names a held account's way back for its class, and never a retry", () => {
    const spent = words({
      on: "account",
      hold: { class: "no_headroom", provider: "Claude", resetsAt: AT_1_10 },
    });
    expect(spent).toBe(
      "Saved, not sent yet: your Claude plan's allowance is used up and resets 1:10pm. It goes to crewmate 7 then, on its own. To go on sooner, ask your first mate to move the work to another model.",
    );
    expect(words({ on: "account", hold: { class: "signed_out", provider: "Claude" } })).toContain(
      "Claude needs you to sign in again. Sign in from Settings, under Intelligence, and it goes to crewmate 7.",
    );
    const refused = words({ on: "account", hold: { class: "refused", provider: "Claude" } });
    expect(refused).toContain("once you sign in to another Claude account or update Claude");
    // Signing in again to the same account does not clear a refusal.
    expect(refused).not.toContain("sign in again");
    for (const line of [spent, refused]) expect(line).not.toMatch(/retry|try again/i);
  });

  it("names the Mac a held account is on, for a task that runs on another Mac", () => {
    const where = "on Mac mini";
    expect(words({ on: "account", hold: { class: "signed_out", provider: "Claude", where } })).toBe(
      "Saved, not sent yet: Claude needs you to sign in again on Mac mini. Sign in from Settings, under Intelligence, and it goes to crewmate 7.",
    );
    expect(
      words({
        on: "account",
        hold: { class: "no_headroom", provider: "Claude", resetsAt: AT_1_10, where },
      }),
    ).toContain("your Claude plan's allowance on Mac mini is used up and resets 1:10pm.");
    expect(
      words({ on: "account", hold: { class: "refused", provider: "Claude", where: "as Builder" } }),
    ).toContain(
      "Claude is refusing this sign-in as Builder. It goes to crewmate 7 once you sign in to another Claude account as Builder or update Claude.",
    );
  });

  it("says when an allowance with no known reset comes back without inventing a time", () => {
    const line = words({ on: "account", hold: { class: "no_headroom", provider: "Claude" } });
    expect(line).toContain("It goes to crewmate 7 once it resets, on its own.");
    expect(line).not.toMatch(/resets \w/);
  });
});
