import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { freshPage } from "./freshPage";

/**
 * Each browser test file starts from a page as fresh as a launched app's
 * window: nothing an earlier file kept, and no Node or window bridge until
 * the file opens its window. A browser session runs its files one after
 * another in one page, so without the fresh page an earlier file's storage,
 * cookies and motion setting reached the next.
 */

function kept() {
  return {
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    cookies: document.cookie,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

const NOTHING_KEPT = { localStorage: 0, sessionStorage: 0, cookies: "", reducedMotion: false };

test("a file starts with no storage, cookies or bridge an earlier file left", () => {
  expect(kept()).toEqual(NOTHING_KEPT);
  expect(
    ["infinitary", "firstmate", "require", "process"].filter((name) => name in window),
  ).toEqual([]);
});

test("a fresh page clears what a file kept", async () => {
  localStorage.setItem("left-behind", "yes");
  sessionStorage.setItem("left-behind", "yes");
  // biome-ignore lint/suspicious/noDocumentCookie: a cookie a file sets, as a page does.
  document.cookie = "left_behind=yes";
  await commands.emulateReducedMotion("reduce");
  expect(kept()).toEqual({
    localStorage: 1,
    sessionStorage: 1,
    cookies: "left_behind=yes",
    reducedMotion: true,
  });

  await freshPage();
  expect(kept()).toEqual(NOTHING_KEPT);
});
