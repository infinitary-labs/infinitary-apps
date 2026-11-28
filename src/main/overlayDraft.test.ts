import type { LentDraft, MainDraft } from "@shared/overlayDraft";
import { describe, expect, it } from "vitest";
import { DraftRelay, LEND_LIMIT_MS } from "./overlayDraft";

/**
 * One main message in two places (docs/card-overlay.md, "The message box"):
 * the captain asked for the first mate's message box in the card overlay, and
 * the accepted plan has one draft move between it and the window - lent as
 * the overlay opens, handed back once as it goes, to the window that lent it.
 * On INF-7228's review the captain chose to keep words no window lent for
 * "for the next overlay opening or window".
 */

type Window = { name: string };

function relay(first: Window | null) {
  let lender = first;
  const asked: [string, number][] = [];
  const handed: [string, LentDraft][] = [];
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  let announced = 0;
  const drafts = new DraftRelay<Window>({
    lender: () => lender,
    ask: (window, ask) => asked.push([window.name, ask]),
    handBack: (window, lent) => handed.push([window.name, lent]),
    kept: () => {
      announced += 1;
    },
    later: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      (timer as { cancelled: boolean }).cancelled = true;
    },
  });
  return {
    drafts,
    asked,
    handed,
    timers,
    announced: () => announced,
    windowOpens: (window: Window) => {
      lender = window;
    },
  };
}

const draft = (text: string): MainDraft => ({
  text,
  pastes: [],
  attachments: [],
  lastSent: null,
  replacing: null,
});
const lent = (ask: number, text: string): LentDraft => ({ ask, draft: draft(text) });

describe("DraftRelay", () => {
  it("opens with the main window's words, and hands them back once to that window", async () => {
    const main = { name: "main" };
    const { drafts, asked, handed, timers, announced } = relay(main);
    const opening = drafts.lend();
    expect(asked).toEqual([["main", 1]]);
    drafts.lent(main, lent(1, "half typed"));
    await expect(opening).resolves.toEqual(lent(1, "half typed"));
    expect(timers.map((timer) => timer.cancelled)).toEqual([true]);

    drafts.handBack(lent(1, "half typed and more"));
    drafts.handBack(lent(1, "a second time"));
    expect(handed).toEqual([["main", lent(1, "half typed and more")]]);
    expect(announced()).toBe(0);
    expect(drafts.takeKept()).toBeNull();
  });

  it("with no window open, keeps the overlay's words for the next opening, once", async () => {
    const { drafts, handed, announced } = relay(null);
    await expect(drafts.lend()).resolves.toEqual(lent(1, ""));
    drafts.handBack(lent(1, "typed with no window"));
    expect(handed).toEqual([]);
    expect(announced()).toBe(1);

    await expect(drafts.lend()).resolves.toEqual(lent(2, "typed with no window"));
    await expect(drafts.lend()).resolves.toEqual(lent(3, ""));
  });

  it("keeps nothing when the overlay hands back an empty box", async () => {
    const { drafts, announced } = relay(null);
    await drafts.lend();
    drafts.handBack(lent(1, "   "));
    expect(announced()).toBe(0);
    expect(drafts.takeKept()).toBeNull();
  });

  it("when the window answers too late, keeps the overlay's words for a window to take once, never handing them to the late window", async () => {
    const main = { name: "main" };
    const { drafts, handed, timers, announced } = relay(main);
    const opening = drafts.lend();
    expect(timers.map((timer) => timer.ms)).toEqual([LEND_LIMIT_MS]);
    timers[0]?.run();
    await expect(opening).resolves.toEqual(lent(1, ""));
    drafts.lent(main, lent(1, "the window's own, late"));

    drafts.handBack(lent(1, "typed in the overlay"));
    expect(handed).toEqual([]);
    expect(announced()).toBe(1);
    expect(drafts.takeKept()).toEqual(draft("typed in the overlay"));
    expect(drafts.takeKept()).toBeNull();
  });

  it("gives kept words to the next opening when the window lends an empty box, and hands them back to that window", async () => {
    const main = { name: "main" };
    const { drafts, handed, timers } = relay(main);
    const first = drafts.lend();
    // Section: the first opening's window is too slow, so the overlay's words are kept.
    timers[0]?.run();
    await first;
    drafts.handBack(lent(1, "kept words"));

    // Section: the next opening's window lends its empty box, and the kept words take its place.
    const second = drafts.lend();
    drafts.lent(main, lent(2, ""));
    await expect(second).resolves.toEqual(lent(2, "kept words"));
    drafts.handBack(lent(2, "kept words, edited"));
    expect(handed).toEqual([["main", lent(2, "kept words, edited")]]);
    expect(drafts.takeKept()).toBeNull();
  });

  it("leaves kept words kept when the window lends words of its own", async () => {
    const { drafts, windowOpens } = relay(null);
    await drafts.lend();
    drafts.handBack(lent(1, "kept words"));
    const main = { name: "main" };
    windowOpens(main);
    const opening = drafts.lend();
    drafts.lent(main, lent(2, "the window's own"));
    await expect(opening).resolves.toEqual(lent(2, "the window's own"));
    expect(drafts.takeKept()).toEqual(draft("kept words"));
  });

  it("takes an answer only from the window it asked, and hands back only the newest opening", async () => {
    const main = { name: "main" };
    const { drafts, handed } = relay(main);
    const first = drafts.lend();
    drafts.lent({ name: "other" }, lent(1, "not asked"));
    drafts.lent(main, lent(1, "first"));
    await expect(first).resolves.toEqual(lent(1, "first"));
    const second = drafts.lend();
    drafts.lent(main, lent(2, "second"));
    await second;

    drafts.handBack(lent(1, "first, back late"));
    drafts.handBack(lent(2, "second, back"));
    expect(handed).toEqual([["main", lent(2, "second, back")]]);
  });
});
