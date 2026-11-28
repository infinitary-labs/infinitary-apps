import type { LentDraft } from "@shared/overlayDraft";
import { describe, expect, it } from "vitest";
import { DraftRelay, LEND_LIMIT_MS } from "./overlayDraft";

/**
 * One main message in two places (docs/card-overlay.md, "The message box"):
 * the captain asked for the first mate's message box in the card overlay, and
 * the accepted plan has one draft move between it and the window - lent as
 * the overlay opens, handed back once as it goes, to the window that lent it.
 */

type Window = { name: string };

function relay(lender: Window | null) {
  const asked: [string, number][] = [];
  const handed: [string, LentDraft][] = [];
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const drafts = new DraftRelay<Window>({
    lender: () => lender,
    ask: (window, ask) => asked.push([window.name, ask]),
    handBack: (window, lent) => handed.push([window.name, lent]),
    later: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      (timer as { cancelled: boolean }).cancelled = true;
    },
  });
  return { drafts, asked, handed, timers };
}

const lent = (ask: number, text: string): LentDraft => ({
  ask,
  draft: { text, pastes: [], attachments: [], lastSent: null, replacing: null },
});

describe("DraftRelay", () => {
  it("opens with the main window's words, and hands them back once to that window", async () => {
    const main = { name: "main" };
    const { drafts, asked, handed, timers } = relay(main);
    const opening = drafts.lend();
    expect(asked).toEqual([["main", 1]]);
    drafts.lent(main, lent(1, "half typed"));
    await expect(opening).resolves.toEqual(lent(1, "half typed"));
    expect(timers.map((timer) => timer.cancelled)).toEqual([true]);

    drafts.handBack(lent(1, "half typed and more"));
    drafts.handBack(lent(1, "a second time"));
    expect(handed).toEqual([["main", lent(1, "half typed and more")]]);
  });

  it("opens with an empty box when no window is open or the window does not answer in time", async () => {
    await expect(relay(null).drafts.lend()).resolves.toBeNull();

    const main = { name: "main" };
    const { drafts, handed, timers } = relay(main);
    const opening = drafts.lend();
    expect(timers.map((timer) => timer.ms)).toEqual([LEND_LIMIT_MS]);
    timers[0]?.run();
    await expect(opening).resolves.toBeNull();
    // A late answer and its hand-back reach nothing.
    drafts.lent(main, lent(1, "late"));
    drafts.handBack(lent(1, "late"));
    expect(handed).toEqual([]);
  });

  it("takes an answer only from the window it asked, and hands back only the newest lending", async () => {
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
