import { OWN_WINDOW_WORDS, type OwnWindowAsked } from "@shared/ownWindow";
import { describe, expect, it } from "vitest";
import type { BrowserViewer } from "./browser/browserViews";
import { OwnWindow } from "./ownWindow";

// INF-3660's plan, the rule the captain approved: a first mate a command started keeps the
// settings, and only this computer's window touches the desktop (docs/run.md, "The window
// opened beside it").
describe("this computer's window, as a first mate a command started asks it", () => {
  /** A window's connection, which the first mate hears drop. */
  function connection() {
    const gone: (() => void)[] = [];
    const viewer: BrowserViewer = { show: () => {}, onGone: (listener) => gone.push(listener) };
    return {
      viewer,
      drop: () => {
        for (const listener of gone.splice(0)) listener();
      },
    };
  }

  function firstMate() {
    const sent: OwnWindowAsked[] = [];
    return { sent, own: new OwnWindow((asked) => sent.push(asked)) };
  }

  it("says plainly that no window is open to ask", async () => {
    const { own, sent } = firstMate();
    expect(own.open()).toBe(false);
    await expect(own.ask({ kind: "start-at-login" })).rejects.toThrow(OWN_WINDOW_WORDS.noWindow);
    expect(sent).toEqual([]);
  });

  it("asks the window that said it is open, and hears its answer", async () => {
    const { own, sent } = firstMate();
    own.here(connection().viewer);
    expect(own.open()).toBe(true);
    const asked = own.ask({ kind: "start-at-login", set: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ask).toEqual({ kind: "start-at-login", set: true });
    // An answer to nothing asked, or of another kind, changes nothing.
    own.answer("nobody", { kind: "start-at-login", enabled: false });
    own.answer(sent[0]?.id ?? "", { kind: "choose-files", paths: [] });
    own.answer(sent[0]?.id ?? "", { kind: "start-at-login", enabled: true });
    await expect(asked).resolves.toEqual({ kind: "start-at-login", enabled: true });
  });

  it("passes on what the window could not do, in the window's words", async () => {
    const { own, sent } = firstMate();
    own.here(connection().viewer);
    const asked = own.ask({ kind: "choose-files", multiple: false });
    own.answer(sent[0]?.id ?? "", { kind: "failed", message: "The picker could not open." });
    await expect(asked).rejects.toThrow("The picker could not open.");
  });

  it("forgets a window whose connection dropped, and ends what it was asked", async () => {
    const { own } = firstMate();
    const window = connection();
    own.here(window.viewer);
    const asked = own.ask({ kind: "choose-files", multiple: true });
    window.drop();
    await expect(asked).rejects.toThrow(OWN_WINDOW_WORDS.windowLeft);
    expect(own.open()).toBe(false);
    // The window opened again is asked on its new connection; the old one's drop is old news.
    const again = connection();
    own.here(again.viewer);
    window.drop();
    expect(own.open()).toBe(true);
  });
});
