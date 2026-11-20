import { describe, expect, it } from "vitest";
import {
  CAPTAIN_CAPTION,
  OWN_CAPTION,
  RETURNED_CAPTION,
  SIGN_IN_CAPTION,
  savedSignInLabel,
  signInCaption,
  signInRuleLegend,
  type TaskBrowserFact,
} from "./taskBrowser";

/** What a task's browser says it holds of the captain's own (docs/task-browser.md, "Signed-in sites"). */

const OPEN: Extract<TaskBrowserFact, { state: "open" }> = {
  state: "open",
  site: "aurora.example",
  url: "https://aurora.example/",
  title: "Aurora",
};

describe("the browser view's foot line", () => {
  it("names a kept sign-in in use, after the captain's own control and before a page the captain handed back", () => {
    expect(signInCaption(OPEN, false)).toBe(SIGN_IN_CAPTION);
    expect(signInCaption({ ...OPEN, returned: true }, false)).toBe(RETURNED_CAPTION);
    expect(signInCaption({ ...OPEN, returned: true, saved: ["aurora.example"] }, false)).toBe(
      "signed in on aurora.example · kept on this computer",
    );
    expect(signInCaption({ ...OPEN, saved: ["aurora.example", "bank.example"] }, false)).toBe(
      "signed in on aurora.example and bank.example · kept on this computer",
    );
    expect(signInCaption({ ...OPEN, saved: ["aurora.example"] }, true)).toBe(CAPTAIN_CAPTION);
  });

  // The captain's answer on INF-4597's review: "Say the sign-in stays."
  it("says what the captain signs in to in the kept profile stays, while they hold it and once handed back", () => {
    expect(signInCaption({ ...OPEN, kept: true }, true)).toBe(
      "what you sign in to here stays on this computer",
    );
    expect(signInCaption({ ...OPEN, kept: true, returned: true }, false)).toBe(
      "what you signed in to here stays on this computer",
    );
    expect(signInCaption({ ...OPEN, kept: true, saved: ["aurora.example"] }, false)).toBe(
      "signed in on aurora.example · kept on this computer",
    );
    expect(signInCaption({ ...OPEN, kept: true, own: true }, true)).toBe(OWN_CAPTION);
  });

  it("words the return question and the request card's choice by the site", () => {
    expect(signInRuleLegend("aurora.example")).toBe(
      "Your aurora.example sign-in stays on this computer. Later tasks:",
    );
    expect(savedSignInLabel("aurora.example")).toBe("Use my aurora.example sign-in");
  });

  // The captain's answer on INF-1358's review: "Name the first mate's
  // computer, as other words on a second computer already do."
  it("names the first mate's computer where a sign-in is kept, on a computer that controls it", () => {
    const place = { this: "Mac mini" };
    expect(signInRuleLegend("aurora.example", place)).toBe(
      "Your aurora.example sign-in stays on Mac mini. Later tasks:",
    );
    expect(signInCaption({ ...OPEN, saved: ["aurora.example"] }, false, place)).toBe(
      "signed in on aurora.example · kept on Mac mini",
    );
  });
});
