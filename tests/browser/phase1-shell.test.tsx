import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";
import { messageBox } from "./prompt";
import { openSize, openWindow } from "./window";

const screenLabel = () =>
  document.querySelector("[data-screen-label]")?.getAttribute("data-screen-label");

test("settings opens as its own state, and the keyboard leaves it", async () => {
  // The ungated home: a subscription that answers.
  const bridge = fakeBridge(subscribed(freshHome()));
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => document.body.dataset.theme).toBe("dark");
  await expect.poll(() => messageBox()?.disabled).toBe(false);

  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await expect.poll(screenLabel).toBe("Settings");
  // Focus lands on the back control, so a keyboard user leaves the way they came.
  await expect.element(page.getByRole("button", { name: "Back", exact: true })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(screenLabel).toBe("Null state");
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
