import { PANEL_FILES_WORDS } from "@shared/personal/panelFiles";
import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * A panel the window could not mount is mounted again when its link to the
 * first mate comes back (a person's report: every panel kept "This panel
 * could not be opened" after an update). Around an update the window and the
 * first mate running beside it can be on different versions for a moment, so
 * the window refuses the first mate's panel files; the first mate then starts
 * again on the window's version and the link comes back with no notice that
 * would start the window over. The refusal must not outlive that gap.
 */

const refused = () => document.querySelectorAll("[data-frame-mount-failed]").length;
const mounted = () => document.querySelectorAll("iframe[data-frame-mount]").length;

test("a refused panel mounts again once the link to the first mate comes back", async () => {
  const home = subscribed(freshHome());
  const bridge = fakeBridge(home);
  const mountAnswer = home["inf:frames:mount"];
  // The first mate is on another version: the window refuses its panels.
  bridge.answer("inf:frames:mount", () => {
    throw new Error(PANEL_FILES_WORDS.otherVersion);
  });
  await openSize();
  await openWindow(bridge);
  await expect.poll(refused).toBeGreaterThan(0);
  const panels = refused();
  expect(mounted()).toBe(0);

  // The first mate started again on the window's version, and the link came back.
  if (typeof mountAnswer !== "function") throw new Error("the fresh home answers every mount");
  bridge.answer("inf:frames:mount", mountAnswer);
  bridge.push("inf:devices:this-mac", { role: "home", left: null, linkBack: 1 });

  await expect.poll(refused).toBe(0);
  expect(mounted()).toBe(panels);
});
