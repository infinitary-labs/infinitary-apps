import { describe, expect, it } from "vitest";
import { helperWords } from "./words";

/**
 * The words in Terminal (docs/helper.md) name the Mac where Firstmate lives
 * as its person knows it: by its address until it has said its name, and as
 * this Mac when the work runs as another user on it. The agreed wording is
 * the design skill's `components/devices/AddAMac`.
 */

const another = { thisMac: false, host: "192.168.1.20" };
const here = { thisMac: true, host: "127.0.0.1" };

describe("what a person reads in Terminal", () => {
  it("asks to add another Mac by its address, and another user on this Mac by its user", () => {
    expect(helperWords.ask(another, "sam")).toEqual([
      "Infinitary on the computer at 192.168.1.20 asks to add this computer, as the user sam.",
      "It runs only the projects you give it, with sign-ins of its own.",
    ]);
    expect(helperWords.ask(here, "builder")).toEqual([
      "Infinitary on this computer asks the user builder to run its work.",
      "Builder only runs work and cannot control your first mate.",
      "Like every user on this computer, it can read files in your home folder, outside private folders such as Desktop and Documents.",
    ]);
  });

  it("names the other Mac by the name it said once it has said one", () => {
    expect(helperWords.joined(another, "MacBook Pro", "sam", "none")).toEqual([
      "Joined. This computer runs work for MacBook Pro now.",
    ]);
    expect(helperWords.joined(another, null, "sam", "none")).toEqual([
      "Joined. This computer runs work for the computer at 192.168.1.20 now.",
    ]);
    expect(helperWords.outOfReach(another, "MacBook Pro")).toEqual([
      "MacBook Pro is out of reach. This computer keeps trying.",
    ]);
    expect(helperWords.quit(another, "MacBook Pro")).toEqual([
      "Infinitary on MacBook Pro quit. This computer keeps trying.",
    ]);
    expect(helperWords.removed(another, "MacBook Pro")).toEqual([
      "MacBook Pro removed this computer.",
      "A new command from MacBook Pro joins it again.",
    ]);
  });

  it("says its home updated it, and whether it starts again by itself", () => {
    expect(helperWords.updated(another, "MacBook Pro", true)).toEqual([
      "MacBook Pro updated Infinitary on this computer to its version.",
      "It starts again now.",
    ]);
    expect(helperWords.updated(here, null, false)).toEqual([
      "Infinitary on this computer updated this user to its version.",
      "Start it again to run its work.",
    ]);
  });

  it("says once joined that it runs whenever its user is logged in, in the background", () => {
    expect(helperWords.joined(another, "MacBook Pro", "sam", "running")).toEqual([
      "Joined. This computer runs work for MacBook Pro now, whenever sam is logged in.",
    ]);
    expect(helperWords.joined(another, "MacBook Pro", "sam", "at-login")).toEqual([
      "Joined. This computer runs work for MacBook Pro whenever sam is logged in, from the next time sam logs in.",
    ]);
    expect(helperWords.joined(here, null, "builder", "running")).toEqual([
      "Joined. Builder runs work for Infinitary on this computer now.",
      "It runs whenever Builder is logged in, even in the background. You can switch back.",
    ]);
    expect(helperWords.joined(here, null, "builder", "failed")).toEqual([
      "Joined. Builder runs work for Infinitary on this computer now.",
      "It could not set itself to start in the background.",
      "Remove it in Infinitary on this computer, then run a new command to try again.",
    ]);
  });

  it("says a Mac joined may open Firstmate to control its home, with no new link", () => {
    expect(helperWords.joined(another, "MacBook Pro", "sam", "running", true)).toEqual([
      "Joined. This computer runs work for MacBook Pro now, whenever sam is logged in.",
      "Open Infinitary here any time to control it from this computer, with no new link.",
    ]);
    // Another user on the home's own Mac only runs work.
    expect(helperWords.joined(here, null, "builder", "running", true)).toEqual(
      helperWords.joined(here, null, "builder", "running"),
    );
  });

  it("says it found the home again where a new command says, and runs its work as before", () => {
    const moved = { thisMac: false, host: "192.168.1.30" };
    expect(helperWords.foundAgain(moved, "MacBook Pro", "sam", "running")).toEqual([
      "Found MacBook Pro at 192.168.1.30. This computer runs its work as before, whenever sam is logged in.",
    ]);
    expect(helperWords.foundAgain(moved, null, "sam", "at-login")).toEqual([
      "Found the computer at 192.168.1.30. This computer runs its work as before, from the next time sam logs in.",
    ]);
    expect(helperWords.foundAgain(moved, "MacBook Pro", "sam", "failed")).toEqual([
      "Found MacBook Pro at 192.168.1.30. This computer runs its work as before.",
      "It could not set itself to start in the background.",
      "Remove it on MacBook Pro, then run a new command to try again.",
    ]);
    expect(helperWords.foundAgain(here, "MacBook Pro", "builder", "running")).toEqual([
      "Found Infinitary on this computer again. Builder runs its work as before.",
      "It runs whenever Builder is logged in, even in the background. You can switch back.",
    ]);
    expect(helperWords.removedEarlier(moved, "MacBook Pro")).toEqual([
      "MacBook Pro removed this computer earlier.",
    ]);
    expect(helperWords.removedEarlier(here, null)).toEqual([
      "Infinitary on this computer removed this user earlier.",
    ]);
  });

  it("says what removing it took away, and where unmerged work stays", () => {
    expect(helperWords.cleanedUp([])).toEqual([
      "Infinitary removed what it set up here, with its sign-ins.",
    ]);
    expect(helperWords.cleanedUp(["/Users/sam/work/worktrees/t1"])[1]).toBe(
      "Unmerged work it could not bring home stays here, in /Users/sam/work/worktrees/t1.",
    );
  });

  it("reports unreadable history without claiming the work is known to be unmerged", () => {
    expect(helperWords.cleanedUp(["/work/t1"], ["/work/t1"])).toEqual([
      "Infinitary removed what it set up here, with its sign-ins.",
      "Infinitary could not read the work history in /work/t1, so it kept that folder and the projects it needs here.",
    ]);
  });

  it("says what it could not remove yet, and when it tries again, instead of claiming it removed it", () => {
    expect(helperWords.cleanedUp([], [], ["/work/worktrees/t2"])).toEqual([
      "Infinitary could not remove all it set up here yet, in /work/worktrees/t2.",
      "It tries again the next time this user logs in.",
    ]);
    expect(helperWords.left("MacBook Pro", ["/work/worktrees/t2"])).toEqual([
      "MacBook Pro removed this user.",
      "This user has not joined Infinitary since.",
      "Infinitary could not remove all it set up here yet, in /work/worktrees/t2.",
      "It tries again the next time this user logs in.",
    ]);
    // A removal cut off before it could say what it could not remove.
    expect(helperWords.left("MacBook Pro", []).slice(2)).toEqual([
      "Infinitary has not finished removing what it set up here.",
      "It tries again the next time this user logs in.",
    ]);
    expect(helperWords.left("MacBook Pro")).toEqual([
      "MacBook Pro removed this user.",
      "This user has not joined Infinitary since.",
    ]);
    // A join that follows clears the note, so it promises no second try.
    expect(helperWords.cleanedUp([], [], ["/work/worktrees/t2"], { triesAgain: false })).toEqual([
      "Infinitary could not remove all it set up here, in /work/worktrees/t2.",
    ]);
  });

  it("says what became of this user's Claude login, made by Firstmate or there before it", () => {
    expect(helperWords.cleanedUp([], [], [], { claude: "signed-out" })).toEqual([
      "Infinitary removed what it set up here, with its sign-ins.",
      "Infinitary signed this user out of the Claude login it made.",
    ]);
    expect(helperWords.cleanedUp([], [], [], { claude: "kept" })).toEqual([
      "Infinitary removed what it set up here, with its sign-ins.",
      "This user's own Claude login stays, since Infinitary did not make it.",
    ]);
    expect(helperWords.cleanedUp([], [], [], { claude: "not-signed-out" }).slice(1)).toEqual([
      "Infinitary could not sign this user out of the Claude login it made.",
      "To end it, sign out in Claude Code.",
    ]);
    // Begun outside this user's login session: the work's own run signs it out.
    expect(helperWords.cleanedUp([], [], [], { triesAgain: false, claude: "later" })).toEqual([
      "Infinitary removed what it set up here, with its sign-ins.",
      "Infinitary signs this user out of the Claude login it made the next time it runs as this user.",
    ]);
    // `status` says the sign-out that waits, never the record's path.
    expect(helperWords.left("MacBook Pro", [], "removed", true)).toEqual([
      "MacBook Pro removed this user.",
      "This user has not joined Infinitary since.",
      "Infinitary signs this user out of the Claude login it made the next time it runs as this user.",
    ]);
    // The run that signs out a login a join left says it alone.
    expect(helperWords.claudeLogin("signed-out")).toEqual([
      "Infinitary signed this user out of the Claude login it made.",
    ]);
  });

  it("asks before it leaves a home that does not answer, and says it left rather than that it was removed", () => {
    expect(helperWords.askLeave("MacBook Pro")).toEqual([
      "This user runs work for MacBook Pro, which does not answer.",
      "Joining leaves it: Infinitary removes what it set up here for MacBook Pro, with its sign-ins.",
      "Work that never merged stays on this computer.",
    ]);
    expect(helperWords.leftHome("MacBook Pro")).toEqual(["This user left MacBook Pro."]);
    expect(helperWords.left("MacBook Pro", null, "left")).toEqual([
      "This user left MacBook Pro.",
      "This user has not joined Infinitary since.",
    ]);
  });

  it("says where a link came from when it cannot be used", () => {
    expect(helperWords.unreachable(another)).toEqual([
      "Could not reach the computer at 192.168.1.20.",
      "Both computers need the same network, or the same private network.",
    ]);
    expect(helperWords.used(another)[0]).toBe(
      "That command was used already. Make a new one on the computer at 192.168.1.20.",
    );
    expect(helperWords.expired(here)[0]).toBe(
      "That command expired. It lasts ten minutes; make a new one on this computer.",
    );
  });
});
