import { describe, expect, it } from "vitest";
import {
  channelIn,
  hasHook,
  hasHookClass,
  hookSelector,
  hookValue,
  OWN_IDENTITY,
  ownChannel,
  ownHostModule,
  readSpellings,
  spellingFor,
  spellingOfMacApp,
  workLabelOf,
  workLabels,
} from "./codeNames";
import {
  DEV_USER_DATA_FOLDER,
  RELEASE_USER_DATA_FOLDER,
  USER_DATA_FOLDERS,
} from "./userDataFolders";
import { WORK_UPDATE_ORDER } from "./workUpdate";

/**
 * Code names in both spellings (the Infinitary rename, FI3-1780 steps 2 and
 * 8): this build writes Infinitary's and reads Firstmate 3000's too.
 */
describe("code names in two spellings", () => {
  it("reads a channel in either spelling as this build's, and writes it in the one asked", () => {
    expect(ownChannel("fm:cards:reply")).toBe("inf:cards:reply");
    expect(ownChannel("inf:cards:reply")).toBe("inf:cards:reply");
    expect(channelIn("fm:cards", "inf")).toBe("inf:cards");
    expect(channelIn("inf:cards", "fm")).toBe("fm:cards");
    // A name in no spelling it knows is left for the contract to refuse.
    expect(ownChannel("other:cards")).toBe("other:cards");
  });

  it("keeps the update order's one name whichever spelling a side writes", () => {
    expect(channelIn(WORK_UPDATE_ORDER, "inf")).toBe("fm:firstmate:update");
    expect(ownChannel(WORK_UPDATE_ORDER)).toBe("fm:firstmate:update");
    // Another spelling of it is not that order.
    expect(ownChannel("inf:firstmate:update")).toBe("inf:firstmate:update");
  });

  it("writes a side's own spelling only to a side that said it reads it", () => {
    expect(spellingFor(["fm", "inf"], "inf")).toBe("inf");
    expect(spellingFor(["fm"], "inf")).toBe("fm");
    // A side from before the rename says nothing, and reads only the first.
    expect(spellingFor(undefined, "inf")).toBe("fm");
    expect(spellingFor(undefined, "fm")).toBe("fm");
    expect(readSpellings(["inf", "later", "fm"])).toEqual(["inf", "fm"]);
    expect(readSpellings(undefined)).toBeUndefined();
  });

  it("reads a card hook and a stylesheet class in either spelling", () => {
    expect(hasHook({ "data-inf-write-in": "" }, "write-in")).toBe(true);
    expect(hasHook({ "data-fm-write-in": "" }, "write-in")).toBe(true);
    expect(hasHook({ "data-write-in": "" }, "write-in")).toBe(false);
    expect(hookValue({ "data-inf-demo": "b.mp4", "data-fm-demo": "a.mp4" }, "demo")).toBe("b.mp4");
    expect(hookValue({ "data-fm-demo": "a.mp4" }, "demo")).toBe("a.mp4");
    expect(hookSelector("action")).toBe("[data-inf-action],[data-fm-action]");
    expect(hasHookClass("wide inf-pictures", "pictures")).toBe(true);
    expect(hasHookClass("fm-pictures", "pictures")).toBe(true);
    expect(hasHookClass("pictures", "pictures")).toBe(false);
  });

  it("names a panel's host module as this build does", () => {
    expect(ownHostModule("@firstmate/ui")).toBe("@infinitary/ui");
    expect(ownHostModule("@firstmate/contracts")).toBe("@infinitary/contracts");
    expect(ownHostModule("@infinitary/ui")).toBe("@infinitary/ui");
    expect(ownHostModule("react")).toBe("react");
  });

  it("names each app's background work by its bundle id, and its own label first", () => {
    expect(workLabelOf("fm", "release")).toBe("com.kunchenguid.firstmate3000.work");
    expect(workLabelOf("fm", "dev")).toBe("com.kunchenguid.firstmate3000.dev.work");
    expect(workLabelOf("inf", "release")).toBe("com.getinfinitary.infinitary.work");
    expect(workLabelOf("inf", "dev")).toBe("com.getinfinitary.infinitary.dev.work");
    // This build is Infinitary (the rename's step 10): its own label first.
    expect(workLabels("release")).toEqual([
      "com.getinfinitary.infinitary.work",
      "com.kunchenguid.firstmate3000.work",
    ]);
    expect(spellingOfMacApp("Infinitary.app", "release")).toBe("inf");
    expect(spellingOfMacApp("Firstmate 3000 Dev.app", "dev")).toBe("fm");
    expect(spellingOfMacApp("Infinitary.app", "dev")).toBeUndefined();
    expect(spellingOfMacApp("Other.app", "release")).toBeUndefined();
  });

  // The rename's step 10: this build is Infinitary, so it opens Infinitary's
  // folders, which the folder module also writes out for plain-Node scripts.
  it("opens its own identity's folders", () => {
    expect(OWN_IDENTITY).toBe("inf");
    expect(USER_DATA_FOLDERS[OWN_IDENTITY]).toEqual({
      release: RELEASE_USER_DATA_FOLDER,
      dev: DEV_USER_DATA_FOLDER,
    });
  });
});
