import { describe, expect, it } from "vitest";
import {
  CAPTAIN_CAPTION,
  RETURNED_CAPTION,
  rememberSignInLabel,
  SIGN_IN_CAPTION,
  savedSignInLabel,
  signInCaption,
  type TaskBrowserFact,
} from "./taskBrowser";

/** What a task's browser says it holds of the captain's own (docs/task-browser.md, "Saved sign-ins"). */

const OPEN: Extract<TaskBrowserFact, { state: "open" }> = {
  state: "open",
  site: "aurora.example",
  url: "https://aurora.example/",
  title: "Aurora",
};

describe("the browser view's foot line", () => {
  it("names a saved sign-in in use, after the captain's own control and before a page he handed back", () => {
    expect(signInCaption(OPEN, false)).toBe(SIGN_IN_CAPTION);
    expect(signInCaption({ ...OPEN, returned: true }, false)).toBe(RETURNED_CAPTION);
    expect(signInCaption({ ...OPEN, returned: true, saved: ["aurora.example"] }, false)).toBe(
      "signed in on aurora.example · saved on this computer",
    );
    expect(signInCaption({ ...OPEN, saved: ["aurora.example", "bank.example"] }, false)).toBe(
      "signed in on aurora.example and bank.example · saved on this computer",
    );
    expect(signInCaption({ ...OPEN, saved: ["aurora.example"] }, true)).toBe(CAPTAIN_CAPTION);
  });

  it("words the tick and the request card's choice by the site", () => {
    expect(rememberSignInLabel("aurora.example")).toBe(
      "Remember my aurora.example sign-in on this computer",
    );
    expect(savedSignInLabel("aurora.example")).toBe("Use my saved aurora.example sign-in");
  });
});
