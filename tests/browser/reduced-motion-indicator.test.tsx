import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { freshHome } from "./freshHome";
import { openWindow } from "./window";

test("someone who reduces motion on their Mac sees why Firstmate holds still, and only then", async () => {
  await commands.emulateReducedMotion("no-preference");
  await openWindow(fakeBridge(freshHome()));
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const badge = page.getByRole("button", { name: "Reduced motion", exact: true });
  // The explanation the badge opens.
  const panel = page.getByRole("tooltip");
  const back = page.getByRole("button", { name: "Back" });

  await expect.element(settings).toBeVisible();
  await expect.element(badge).not.toBeInTheDocument();

  // Turning the Mac setting on shows the badge at once.
  await commands.emulateReducedMotion("reduce");
  await expect.element(badge).toBeVisible();

  // Hovering it opens the explanation; leaving closes it.
  await expect.element(panel).not.toBeInTheDocument();
  await userEvent.hover(badge);
  await expect.element(panel).toBeVisible();
  await userEvent.unhover(badge);
  await expect.element(panel).not.toBeInTheDocument();

  // A click keeps it open until Esc.
  await userEvent.click(badge);
  await userEvent.unhover(badge);
  await expect.element(panel).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(panel).not.toBeInTheDocument();

  // Settings has no gear, and no badge either.
  await userEvent.click(settings);
  await expect.element(back).toBeVisible();
  await expect.element(badge).not.toBeInTheDocument();
  await userEvent.click(back);

  // Turning it off removes the badge again.
  await commands.emulateReducedMotion("no-preference");
  await expect.element(settings).toBeVisible();
  await expect.element(badge).not.toBeInTheDocument();
});
