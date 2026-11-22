import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";
import { messageBox } from "./prompt";
import { openSize, openWindow } from "./window";

/**
 * One fallback for the whole shell (`guardLostFocus`,
 * src/renderer/src/app/focusRecovery.ts; docs/keyboard.md): with no usable
 * focused control, focus returns to the available main message, and a live
 * destination is left alone. One fresh window: Back from Settings first,
 * before anything asked for focus, then the fallback itself against every
 * way a control stops being usable, including through its ancestors.
 */

const mainMessageFocused = () =>
  document.activeElement !== null && document.activeElement === messageBox();

/** Two frames: the fallback runs on the next one, so it has run by the second. */
const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/** Each way the focused control, or an ancestor of it, stops being usable. */
const LOSSES = [
  "remove",
  "disable",
  "fieldset",
  "hidden",
  "inert",
  "visibility",
  "display",
] as const;

test("focus lost to an unavailable control returns to the main message, and a live destination keeps it", async () => {
  const bridge = fakeBridge(subscribed(freshHome()));
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => messageBox()?.disabled).toBe(false);

  // Section: Back from Settings returns focus to the main input without a previous request.
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Back", exact: true }));
  await expect.poll(mainMessageFocused).toBe(true);

  // Section: the shared fallback handles unavailable controls but leaves a live destination alone.
  for (const loss of LOSSES) {
    const parent = document.createElement("fieldset");
    const control = document.createElement("button");
    control.textContent = "Focus recovery fixture";
    parent.append(control);
    document.body.append(parent);
    control.focus();
    expect(document.activeElement, `the fixture holds focus before ${loss}`).toBe(control);
    if (loss === "remove") parent.remove();
    else if (loss === "disable") control.disabled = true;
    else if (loss === "fieldset") parent.disabled = true;
    else if (loss === "hidden") parent.hidden = true;
    else if (loss === "inert") parent.inert = true;
    else if (loss === "visibility") parent.style.visibility = "hidden";
    else parent.style.display = "none";
    await expect
      .poll(mainMessageFocused, { message: `focus returns to the main message after ${loss}` })
      .toBe(true);
    parent.remove();
  }
  const field = document.createElement("textarea");
  field.id = "live-focus-fixture";
  document.body.append(field);
  field.focus();
  field.readOnly = true;
  const unrelated = document.createElement("button");
  document.body.append(unrelated);
  unrelated.remove();
  // The fallback looks on the next frame; by the second it has looked and left the field alone.
  await frames();
  await frames();
  expect(document.activeElement).toBe(field);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
