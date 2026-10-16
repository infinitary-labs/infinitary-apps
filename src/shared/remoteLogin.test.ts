import { describe, expect, it } from "vitest";
import {
  readWorkOutcome,
  remoteLoginRefusalLines,
  remoteLoginWords,
  workOutcomeLine,
} from "./remoteLogin";

describe("a refusal's lines", () => {
  it("reads the two lines a refusal's message carries, and one line when it has no break", () => {
    const [what, todo] = remoteLoginWords.refused("unreachable", { address: "sam@mini.local" });
    expect(remoteLoginRefusalLines(`${what}\n${todo}`)).toEqual([what, todo]);
    expect(remoteLoginRefusalLines("That is not an address.")).toEqual(["That is not an address."]);
  });
});

describe("work removal outcomes", () => {
  it("carries the folders kept because their history was unreadable", () => {
    const outcome = {
      firstmate: "removed" as const,
      kept: ["/work/worktrees/t-dirty", "/work/worktrees/t-unreadable"],
      unreadable: ["/work/worktrees/t-unreadable"],
    };
    expect(readWorkOutcome(`earlier output\n${workOutcomeLine(outcome)}\n`)).toEqual(outcome);
  });

  it("still reads removal outcomes without unreadable folders", () => {
    expect(readWorkOutcome('{"firstmate":"removed","kept":[]}\n')).toEqual({
      firstmate: "removed",
      kept: [],
    });
  });

  it("refuses malformed unreadable folder reports", () => {
    expect(readWorkOutcome('{"firstmate":"removed","kept":[],"unreadable":false}\n')).toBeNull();
  });

  it("carries what a removal could not remove yet", () => {
    const outcome = {
      firstmate: "removed" as const,
      kept: [],
      unremoved: ["/work/worktrees/t-clean"],
    };
    expect(readWorkOutcome(`${workOutcomeLine(outcome)}\n`)).toEqual(outcome);
  });

  it("carries that a join left another Firstmate first, and what it kept", () => {
    const outcome = {
      firstmate: "joined" as const,
      background: "running" as const,
      left: { kept: 1, unremoved: 0 },
    };
    expect(readWorkOutcome(`${workOutcomeLine(outcome)}\n`)).toEqual(outcome);
    expect(readWorkOutcome('{"firstmate":"joined","background":"running","left":{}}\n')).toBeNull();
  });
});

describe("what the home says when a removal there could not finish", () => {
  const mini = { name: "Mac mini", user: "sam" };
  it("says it could not remove all of it yet, and that the Mac tries again at its user's next login", () => {
    expect(remoteLoginWords.notAllRemovedThere(mini, 0)).toEqual([
      "Could not remove all that Infinitary set up on Mac mini yet.",
      "Mac mini tries again the next time sam logs in there.",
    ]);
    expect(remoteLoginWords.notAllRemovedThere(mini, 1)[0]).toBe(
      "Could not remove all that Infinitary set up on Mac mini yet. Its unmerged work stays there.",
    );
  });
});

describe("what the home says when it adds a Mac that runs work already", () => {
  const mini = { name: "Mac mini", user: "sam" };
  const address = "sam@mini.local";

  it("tells one of its own where this Mac is now, on the feed and on its row", () => {
    expect(remoteLoginWords.finding(mini)).toBe("Telling Mac mini where this computer is now.");
    expect(remoteLoginWords.findingRow(mini)).toBe("Telling Mac mini where this computer is now…");
  });

  it("names another Firstmate's Mac as another's, and leaves one of its own in reach as it is", () => {
    expect(remoteLoginWords.refused("already-joined", { address })).toEqual([
      "sam@mini.local already runs work for another first mate.",
      "Remove it from that first mate, then ask again.",
    ]);
    expect(remoteLoginWords.refused("in-reach", { address, name: "Mac mini" })).toEqual([
      "Mac mini already runs work for your first mate, and is in reach.",
      "Nothing changed there.",
    ]);
  });

  it("asks once about another Firstmate's Mac, and says what leaving it did", () => {
    expect(remoteLoginWords.leaveQuestion({ address, name: "Mac mini" })).toEqual([
      "sam@mini.local runs work for another first mate.",
      "If that first mate is gone for good, adding Mac mini leaves it: Infinitary removes what it set up there for that one, with its sign-ins.",
      "Work that never merged stays there. If that first mate still answers, nothing changes.",
    ]);
    expect(remoteLoginWords.leaveQuestion({ address })[1]).toContain("adding it leaves it");
    expect(remoteLoginWords.leftOther(mini, { kept: 0, unremoved: 0 })).toEqual([
      "Mac mini left the other first mate it ran work for.",
    ]);
    expect(remoteLoginWords.leftOther(mini, { kept: 2, unremoved: 1 })).toEqual([
      "Mac mini left the other first mate it ran work for. Its unmerged work stays there.",
      "Infinitary could not remove all it set up on Mac mini for the other one.",
    ]);
    expect(remoteLoginWords.refused("still-answers", { address })).toEqual([
      "sam@mini.local runs work for another first mate, which still answers.",
      "Remove it from that first mate, then ask again.",
    ]);
  });

  it("never advises removing a Mac of this Firstmate to try its background again", () => {
    expect(remoteLoginWords.notInBackground(mini, "add")).toEqual([
      "Mac mini could not set itself to start in the background, so it runs no work for now.",
      "Ask again to add it.",
    ]);
    expect(remoteLoginWords.notInBackground(mini, "update")[1]).toBe("Ask again to update it.");
  });
});
