import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { openSize, openWindow } from "./window";

// Cost per task's Projects and Kinds menus were reported broken: on the
// see-through window they showed the readouts and the line through them,
// and one stayed open under the other. Each menu closes on a press outside
// it or when focus moves past it, so only one is ever open, and it paints a
// solid fill over the section's see-through boxes.

function filter(name: "projects" | "kinds"): HTMLDetailsElement {
  const found = document.querySelector<HTMLDetailsElement>(`[data-usage-cost-filter="${name}"]`);
  if (!found) throw new Error(`Usage drew no ${name} filter`);
  return found;
}

function part<T extends Element>(within: Element, selector: string): T {
  const found = within.querySelector<T>(selector);
  if (!found) throw new Error(`Usage drew no ${selector}`);
  return found;
}

const opened = () => ({ projects: filter("projects").open, kinds: filter("kinds").open });

/** A computed color's alpha: `rgb()` is whole, `rgba()` and `color()` name theirs last. */
function alpha(color: string): number {
  const named = color.match(/^rgba\(.*,\s*([\d.]+)\)$/) ?? color.match(/\/\s*([\d.]+)\)$/);
  return named?.[1] === undefined ? 1 : Number(named[1]);
}

test("Cost per task's filter menus close on a press or focus outside, one at a time, and paint solid over the see-through section", async () => {
  const bridge = fakeBridge(await seededHome());
  await openSize();
  await openWindow(bridge);
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await userEvent.click(page.getByRole("tab", { name: "Usage", exact: true }));
  const section = document.querySelector<HTMLElement>('[data-settings-section="usage"]');
  if (!section) throw new Error("Settings drew no Usage section");
  await expect.poll(() => section.querySelector("[data-usage-cost-filter]")).not.toBeNull();
  const projects = filter("projects");
  const kinds = filter("kinds");
  const heading = page.getByRole("heading", { name: m.settingsUsageCostHeading() });

  // Opening Kinds is a press outside Projects, which closes it.
  await userEvent.click(part(projects, "summary"));
  expect(opened()).toEqual({ projects: true, kinds: false });
  await userEvent.click(part(kinds, "summary"));
  await expect.poll(opened).toEqual({ projects: false, kinds: true });

  // A press anywhere else in the section closes the open menu.
  await userEvent.click(heading);
  await expect.poll(opened).toEqual({ projects: false, kinds: false });

  // A press on a choice inside the menu ticks it and leaves the menu open.
  await userEvent.click(part(projects, "summary"));
  const choice = part<HTMLInputElement>(projects, "input[value]:not([data-usage-cost-all])");
  await userEvent.click(choice);
  expect(choice.checked).toBe(true);
  expect(opened()).toEqual({ projects: true, kinds: false });
  await userEvent.click(heading);
  await expect.poll(opened).toEqual({ projects: false, kinds: false });

  // A press on a choice's name ticks it too and leaves the menu open. The
  // name takes no focus, so the press focuses the Settings panel around the
  // menu; closing the menu then hid the pressed text mid-press, and Chromium
  // crashed the page as it began selecting it.
  for (const menu of [projects, kinds]) {
    await userEvent.click(part(menu, "summary"));
    const name = part<HTMLElement>(menu, "input[value]:not(:checked) + span");
    const named = part<HTMLInputElement>(menu, "input[value]:not(:checked)");
    await userEvent.click(name);
    await expect.poll(() => named.checked).toBe(true);
    expect(menu.open).toBe(true);
    await userEvent.click(heading);
    await expect.poll(() => menu.open).toBe(false);
  }

  // From the keyboard, Tab past the last choice closes the menu as focus
  // reaches the Kinds row.
  part<HTMLElement>(projects, "summary").focus();
  await userEvent.keyboard("{Enter}");
  expect(opened()).toEqual({ projects: true, kinds: false });
  const stops = projects.querySelectorAll("input").length;
  for (let step = 0; step < stops; step++) await userEvent.keyboard("{Tab}");
  expect(projects.open).toBe(true);
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(part(kinds, "summary"));
  await expect.poll(opened).toEqual({ projects: false, kinds: false });

  // On the see-through window Settings' boxes take 55% fills, the filter's
  // own row among them; the open menu over the readouts stays solid.
  document.documentElement.setAttribute("data-window-material", "translucent");
  try {
    await userEvent.click(part(projects, "summary"));
    const row = getComputedStyle(projects).backgroundColor;
    const menu = getComputedStyle(part(projects, "fieldset")).backgroundColor;
    expect(alpha(row), `the filter's row (${row}) takes the see-through fill`).toBeLessThan(1);
    expect(alpha(menu), `the open menu (${menu}) is solid`).toBe(1);
  } finally {
    document.documentElement.removeAttribute("data-window-material");
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
