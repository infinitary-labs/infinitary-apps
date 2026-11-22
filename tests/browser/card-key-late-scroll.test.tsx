import type { TaskBoard } from "@shared/tasks";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { messageBoxLocator } from "./prompt";
import { answerStack, bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * A task key the keyboard brings into view in a card's body opens its
 * summary though the stage moved the card between the key's report and the
 * scroll that brought it there (the late-scroll journey in
 * tests/e2e/card-keyboard.spec.ts timed out on a Mac waiting for the summary).
 * Shift+Tab onto the key scrolls the card's body, and the body's frame
 * reports the key two frames later; the window hears the scroll at its own
 * next frame, which under load comes after the report. Meanwhile the stage
 * was still easing into place and moved the frame by a fraction of a pixel
 * with nothing scrolled: the window read that move as the late scroll's and
 * let the key go. Here the stage eases as the message box grows a line, as
 * it does whenever the box grows; the test holds that easing where it stood
 * when the key reported itself, lets it land, then lets the scroll reach the
 * window, so that order is the order of every run. A real scroll of the body
 * afterwards still lets the key go (docs/crew-orbits.md).
 */

const TITLE = "Pick the launch window";

/** The summary the window shows beside a key the keyboard rests on. */
const keySummary = () => document.querySelector("[data-key-summary]");

/** The task key the card's body linked, or the one the keyboard rests on there. */
const linkedKey = () =>
  inCardBody(TITLE, () => document.querySelector("a[data-inf-task]")?.textContent ?? null);
const focusedKey = () =>
  inCardBody(TITLE, () => document.activeElement?.getAttribute("data-inf-task") ?? null);

/** The window's scroller around the card's body. */
function bodyScroller(frame: HTMLIFrameElement): HTMLElement {
  const scroller = frame.closest<HTMLElement>("[data-card-body]");
  if (!scroller) throw new Error("The card's body frame sits in no scroller");
  return scroller;
}

/**
 * The stage's easing, held once it starts; whether the key has reported
 * itself; how many scrolls the window has held; and whether they went on.
 */
type Hold = { eased: Animation | null; rested: boolean; held: number; released: boolean };

test("a task key the keyboard brings into view opens its summary though the stage moved the card before the window heard the scroll", async () => {
  const home = subscribed(await seededHome({ title: TITLE }));
  const [task] = (home["inf:tasks:board"] as TaskBoard).tasks;
  if (!task) throw new Error("The seeded home's board lists no task");
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await openSize();
  await openWindow(bridge);
  const frame = await bodyDrawn(TITLE);
  await stageAtRest();
  await expect.poll(linkedKey).toBe(task.key);
  const body = page.frameLocator(page.elementLocator(frame));
  const scroller = bodyScroller(frame);
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);

  // Section: the stage starts easing as the message box grows a line, and
  // is held where it stood: the card layer's lift is a transition of its top.
  const layer = frame.closest<HTMLElement>("[data-card-layer]");
  if (!layer) throw new Error("The card's body sits in no card layer");
  const hold: Hold = { eased: null, rested: false, held: 0, released: false };
  layer.addEventListener("transitionrun", (event) => {
    if (event.target !== layer || event.propertyName !== "top" || hold.eased) return;
    hold.eased =
      layer
        .getAnimations()
        .find((moving) => (moving as CSSTransition).transitionProperty === "top") ?? null;
    hold.eased?.pause();
  });
  await userEvent.click(messageBoxLocator());
  await userEvent.keyboard("The launch note{Shift>}{Enter}{/Shift}and its second line");
  await expect.poll(() => hold.eased?.playState).toBe("paused");

  // Section: the keyboard in the note at the end of the body, which the body
  // scrolls to; the key is then out of view above it. The pointer goes back
  // to the message box, where nothing the stage moves passes under it: the
  // body's frame lets its key go when the pointer comes over anything else.
  await body.getByRole("textbox", { name: "Note" }).click();
  await userEvent.hover(messageBoxLocator());
  await expect.poll(() => scroller.scrollTop).toBeGreaterThan(0);
  expect(hold.eased?.playState).toBe("paused");

  // Section: the window holds the scrolls it hears until the key has
  // reported itself; then the stage lands, and in a later task the held
  // scrolls reach the window.
  const targets: EventTarget[] = [];
  let releasing = false;
  const release = () => {
    if (releasing || !hold.rested || hold.held === 0) return;
    releasing = true;
    setTimeout(() => {
      hold.eased?.finish();
      setTimeout(() => {
        window.removeEventListener("scroll", holdScroll, { capture: true });
        for (const target of targets) target.dispatchEvent(new Event("scroll"));
        hold.released = true;
      });
    });
  };
  const holdScroll = (event: Event) => {
    if (!event.isTrusted) return;
    event.stopImmediatePropagation();
    if (event.target) targets.push(event.target);
    hold.held += 1;
    release();
  };
  window.addEventListener("scroll", holdScroll, { capture: true });
  window.addEventListener("message", (event) => {
    const data = event.data as { type?: string; gesture?: string } | null;
    if (event.source !== frame.contentWindow || data?.type !== "task" || data.gesture !== "rest")
      return;
    hold.rested = true;
    release();
  });
  const noted = scroller.scrollTop;
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.poll(focusedKey).toBe(task.key);
  await expect.poll(() => hold.released).toBe(true);
  expect(hold.held).toBeGreaterThan(0);
  expect(scroller.scrollTop).toBeLessThan(noted);
  expect(hold.eased?.playState).toBe("finished");
  await expect.poll(() => keySummary()?.getAttribute("data-key-summary")).toBe(task.id);

  // Section: a real scroll of the body afterwards carries the key away, and
  // the summary goes with it.
  scroller.scrollTop = scroller.scrollHeight;
  await expect.poll(keySummary).toBeNull();
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
