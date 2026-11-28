import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { notesFailedText, notesWindow, RAW_MOUNT_WORDS } from "./notesPanel";
import { openSize, openWindow } from "./window";

/**
 * A panel mount that fails for no reason the host typed shows one plain line
 * and Retry, never the rejection's own text (INF-7113's approved plan,
 * Part 1). The text below is what Electron handed the preload for a refused
 * panel before the reason was typed (INF-7112's reproduction).
 */
const ELECTRON_REJECTION =
  "Error invoking remote method 'inf:frames:mount': PanelMountError: This panel shows once Infinitary here and on the computer where your first mate lives are on the same version.";

test("a mount that fails for no typed reason shows one plain line, and Retry asks again", async () => {
  // The window may mount a panel more than once as it settles; each fails until Retry.
  let failing = true;
  const bridge = notesWindow(() => {
    if (failing) throw new Error(ELECTRON_REJECTION);
    return { mountId: "notes-1", url: "app-frame://panel-notes-1/" };
  });
  await openSize();
  await openWindow(bridge);
  await expect.poll(notesFailedText).not.toBe("");
  expect(notesFailedText()).toBe("This panel could not be opened.Retry");
  for (const raw of RAW_MOUNT_WORDS) expect(notesFailedText()).not.toContain(raw);

  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => document.querySelector("[data-frame-mount-failed]")).toBeNull();
  expect(document.querySelector('iframe[data-frame-mount="notes-1"]')).not.toBeNull();
});
