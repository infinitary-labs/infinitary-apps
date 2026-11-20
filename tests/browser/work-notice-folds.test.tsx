import type { ThisMac } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { MAXIMIZE_LABEL, RESTORE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * The notice under the main message of a window whose work cannot run
 * (docs/view.md, "A Mac that runs work"; design skill
 * `components/devices/DevicesTab`, "A Mac that has not finished setting
 * up"), from a person's report: "no way to dismiss this alert and it bleeds
 * through cards". A maximized card puts the notice aside with the main
 * message, so nothing of it draws over the card or takes its clicks. Not now
 * folds it into a quiet line in the top bar, which opens it again, until its
 * reason changes or the work runs.
 */

const TITLE = "Footer fix merged";

/** This computer controls MacBook Pro and runs its work, which macOS refused to start. */
const BLOCKED: ThisMac = {
  role: "view",
  name: "MacBook Pro",
  address: "192.168.1.20",
  joinedAt: 1,
  contact: "in-reach",
  readOnly: null,
  heardAt: 1,
  caughtUp: 0,
  runsWork: true,
  workSetup: { state: "blocked", reason: "background-off" },
};

const notice = () => document.querySelector<HTMLElement>("[data-work-setup-notice]");

/** The notice's button whose label reads `words`, its pending label aside. */
const noticeButton = (words: string) =>
  [...(notice()?.querySelectorAll<HTMLElement>("button") ?? [])].find((button) =>
    button.textContent?.startsWith(words),
  ) ?? null;

const tryAgain = () => noticeButton(m.viewWorkTryAgain());

/** Whether `element` draws: neither it nor a parent hides it. */
const draws = (element: HTMLElement | null) =>
  element?.checkVisibility({ visibilityProperty: true, opacityProperty: true }) ?? false;

/** Each piece of text inside `element` that draws, so a hidden parent's shown child is caught. */
const drawnText = (element: HTMLElement | null) =>
  [...(element?.querySelectorAll<HTMLElement>("*") ?? [])].filter(
    (child) =>
      child.childElementCount === 0 &&
      child.textContent?.trim() &&
      getComputedStyle(child).visibility === "visible",
  );

/** Whether a press at the middle of `element` reaches it. */
const takesPress = (element: HTMLElement) => {
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return hit !== null && element.contains(hit);
};

const control = (label: string) =>
  page.getByRole("button", { name: label, exact: true }).query() as HTMLElement | null;

test("the work notice stays aside under a maximized card, folds to a quiet line, and comes back for a new reason", async () => {
  const home = subscribed(await seededHome({ title: TITLE }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  bridge.answer("inf:devices:this-mac", BLOCKED);
  await openSize();
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  await expect.poll(() => draws(tryAgain())).toBe(true);

  // Section: a maximized card puts the notice aside, its Try again included.
  await expect.poll(() => control(MAXIMIZE_LABEL)).not.toBeNull();
  (control(MAXIMIZE_LABEL) as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => control(RESTORE_LABEL)).not.toBeNull();
  await expect.poll(() => draws(notice())).toBe(false);
  expect(drawnText(notice()).map((element) => element.textContent)).toEqual([]);
  expect(takesPress(tryAgain() as HTMLElement)).toBe(false);
  (control(RESTORE_LABEL) as HTMLElement).focus();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => draws(tryAgain())).toBe(true);

  // Section: Not now, from the keyboard, folds the notice into the top bar's quiet line.
  const line = () => document.querySelector<HTMLElement>("[data-work-setup-line]");
  (noticeButton(m.viewWorkNotNow()) as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(notice).toBeNull();
  await expect.poll(() => draws(line())).toBe(true);
  expect(line()?.closest("[data-topbar]")).not.toBeNull();
  expect(line()?.textContent).toBe(m.viewWorkFolded());
  expect(line()?.getAttribute("data-work-setup-line")).toBe("background-off");

  // Section: the quiet line, pressed from the keyboard, opens the notice again.
  (line() as HTMLElement).querySelector("button")?.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => draws(tryAgain())).toBe(true);
  expect(line()).toBeNull();

  // Section: folded again, a new reason brings the notice back whole.
  (noticeButton(m.viewWorkNotNow()) as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(notice).toBeNull();
  bridge.push("inf:devices:this-mac", {
    ...BLOCKED,
    workSetup: { state: "blocked", reason: "local-network" },
  });
  await expect.poll(() => notice()?.getAttribute("data-work-setup-notice")).toBe("local-network");
  expect(line()).toBeNull();

  // Section: once the work runs, a later stop for the same reason shows the notice whole.
  (noticeButton(m.viewWorkNotNow()) as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => draws(line())).toBe(true);
  bridge.push("inf:devices:this-mac", { ...BLOCKED, workSetup: undefined });
  await expect.poll(line).toBeNull();
  bridge.push("inf:devices:this-mac", {
    ...BLOCKED,
    workSetup: { state: "blocked", reason: "local-network" },
  });
  await expect.poll(() => draws(tryAgain())).toBe(true);
});
