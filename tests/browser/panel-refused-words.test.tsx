import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { notesFailedText, notesWindow, RAW_MOUNT_WORDS } from "./notesPanel";
import { openSize, openWindow } from "./window";

/**
 * A panel the window cannot open says why in plain words (INF-7112's
 * reproduction; INF-7113's approved plan, Part 1). A window on another
 * version from its first mate showed "Error invoking remote method
 * 'inf:frames:mount': PanelMountError: ..." in the panel's place. The host
 * now answers a typed reason, which the window words from its catalog.
 */

test("a panel refused across versions says only that the versions must match", async () => {
  const bridge = notesWindow(() => ({ refused: "other-version" }));
  await openSize();
  await openWindow(bridge);
  await expect.poll(notesFailedText).not.toBe("");
  expect(notesFailedText()).toBe(
    "This panel opens once Infinitary here and on the computer where your first mate lives are on the same version.",
  );
  for (const raw of RAW_MOUNT_WORDS) expect(notesFailedText()).not.toContain(raw);
  // A new version on either side comes with a link that returns, which mounts it again.
  expect(page.getByRole("button", { name: "Retry" }).query()).toBeNull();
});
