import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { actionOf, HAND_OVER_ADDRESS, type HandOverView, handOverBody } from "./handOverPage";

const names = { from: "Firstmate 3000", to: "Infinitary" };

/** The page as a person reads it: its heading, its words, and each button with what it asks. */
function read(view: HandOverView) {
  const document = parseDocument(handOverBody(view, names));
  const text = (name: string) =>
    DomUtils.findAll((element) => element.name === name, document.children).map((element) =>
      DomUtils.textContent(element).trim(),
    );
  const buttons = DomUtils.findAll((element) => element.name === "button", document.children).map(
    (button) => ({ label: DomUtils.textContent(button).trim(), asks: button.attribs.value }),
  );
  const form = DomUtils.findOne((element) => element.name === "form", document.children);
  return {
    heading: text("h1")[0],
    words: text("p").join(" "),
    buttons,
    action: form?.attribs.action,
  };
}

describe("the hand-over window's page", () => {
  it("asks which work to open when both folders hold some, with three choices", () => {
    const page = read({
      kind: "ask",
      from: { path: "/a", lastOpened: 0 },
      to: { path: "/b", lastOpened: undefined },
    });
    expect(page.heading).toBe("Infinitary found saved work in two places");
    expect(page.buttons).toEqual([
      { label: "Bring Firstmate 3000's work", asks: "bring" },
      { label: "Keep Infinitary's work", asks: "keep" },
      { label: "Decide later", asks: "later" },
    ]);
    expect(page.action).toBe(HAND_OVER_ADDRESS);
  });

  it("offers Try again where waiting can mend the refusal, and Quit alone where it cannot", () => {
    const room = read({
      kind: "refused",
      refusal: { reason: "no-space", needed: 4_800_000_000, free: 1_200_000_000 },
    });
    expect(room.words).toContain("4.8 GB");
    expect(room.words).toContain("1.2 GB");
    expect(room.buttons.map((button) => button.asks)).toEqual(["again", "quit"]);
    const newer = read({ kind: "refused", refusal: { reason: "unsupported" } });
    expect(newer.buttons.map((button) => button.asks)).toEqual(["quit"]);
    // INF-5226: trying again cannot move the app out of the folder it runs from.
    const inside = read({ kind: "refused", refusal: { reason: "app-runs-inside" } });
    expect(inside.buttons.map((button) => button.asks)).toEqual(["quit"]);
    const working = read({ kind: "refused", refusal: { reason: "own-work-running" } });
    expect(working.buttons.map((button) => button.asks)).toEqual(["again", "quit"]);
  });

  // INF-5468's plan, piece 3: an older copy running with no window is asked
  // to stop, and only the person's click ends one that did not.
  it("says it is stopping the older copy, then asks before ending one that did not stop", () => {
    const stopping = read({ kind: "stopping" });
    expect(stopping.heading).toBe("Stopping Firstmate 3000's background work");
    expect(stopping.buttons).toEqual([]);
    const wontStop = read({ kind: "wont-stop" });
    expect(wontStop.heading).toBe("Firstmate 3000 has not stopped");
    expect(wontStop.buttons).toEqual([
      { label: "Stop it now", asks: "force" },
      { label: "Quit", asks: "quit" },
    ]);
    expect(actionOf(`${HAND_OVER_ADDRESS}?do=force`)).toBe("force");
  });

  it("reads each button's navigation and nothing else", () => {
    expect(actionOf(`${HAND_OVER_ADDRESS}?do=bring`)).toBe("bring");
    expect(actionOf(`${HAND_OVER_ADDRESS}?do=delete`)).toBeUndefined();
    expect(actionOf("https://example.com/?do=bring")).toBeUndefined();
    expect(actionOf("not a url")).toBeUndefined();
  });

  // INF-967, as the captain approved it: the four steps with the current one lit, the item
  // being copied by kind and count with the task's short name, files done of the total,
  // elapsed time and an estimate, why it takes this long, and a safe quit.
  it("says which step the move is on, what it copies, how far and how long, and offers a safe quit", () => {
    const counted = {
      entries: 374_761,
      files: 324_350,
      bytes: 15_300_000_000,
      workingCopies: 7,
      workingCopyFiles: 287_000,
    };
    const view: HandOverView = {
      kind: "working",
      progress: {
        phase: "copying",
        done: 132_400,
        total: 374_761,
        counted,
        item: { kind: "working-copy", name: "1a5a170a", index: 3, of: 7, files: 41_000 },
      },
      clock: { elapsedMs: 65_000, stepElapsedMs: 40_000 },
    };
    const document = parseDocument(handOverBody(view, names));
    const steps = DomUtils.findAll((element) => element.name === "li", document.children);
    expect(steps.map((step) => [DomUtils.textContent(step), step.attribs.class])).toEqual([
      ["Counting: 324,350 files, 15.3 GB", "done"],
      ["Copying, step 2 of 4", "current"],
      ["Checking the copy", "next"],
      ["Finishing", "next"],
    ]);
    const page = read(view);
    expect(page.words).toContain(
      "Copying the working copy of task 1a5a170a, 3 of 7, with 41,000 files",
    );
    const name = DomUtils.findOne(
      (element) => element.attribs.class === "mono" && DomUtils.textContent(element) === "1a5a170a",
      document.children,
    );
    expect(name).not.toBeNull();
    // 132,400 entries in 40 s: the other 242,361 at that pace take 73 s more.
    expect(page.words).toContain(
      "132,400 of 374,761 files and folders · 1 min 05 s so far · about 1 min 13 s left in this step",
    );
    expect(page.words).toContain(
      "Most of this time is your 7 working copies, which hold 287,000 of the 324,350 files.",
    );
    expect(page.words).toContain("nothing changes until the copy has been checked");
    expect(page.buttons).toEqual([{ label: "Quit, continue later", asks: "quit" }]);
  });

  it("says no estimate before a step has a pace, and offers no quit once the copy is checked", () => {
    const early = read({
      kind: "working",
      progress: { phase: "verifying", done: 10, total: 100 },
      clock: { elapsedMs: 1_000, stepElapsedMs: 1_000 },
    });
    expect(early.words).toContain("10 of 100 files and folders · 1 s so far");
    expect(early.words).not.toContain("left");
    const finishing = parseDocument(
      handOverBody({ kind: "working", progress: { phase: "finishing", done: 0, total: 0 } }, names),
    );
    const leave = DomUtils.findOne((element) => element.attribs.id === "leave", finishing.children);
    expect(leave?.attribs.hidden).toBeDefined();
  });
});
