import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PeekSummary } from "../../src/renderer/src/plugins/point/PeekSummary";
import { taskPeek } from "../../src/renderer/src/plugins/point/taskPeek";
import { fakeBridge } from "./bridge";
import { freshHome } from "./freshHome";
import { openSize } from "./window";

/**
 * A Tasks row the pointer rests on keeps its summary while the row stays
 * under the pointer, even when its rail's scroll position changes (the
 * captain's report: the hover preview on a Tasks row disappeared by itself).
 * With the Tasks list scrolled to its end, the panel above it on the rail
 * gets shorter: the Tasks panel's body grows upward, and the browser pulls
 * its scroll position back by as much, so the Tasks frame and the row in it
 * stay where they were. The window hears that clamp as a scroll of the
 * body; nothing moved, so the summary stays. A real scroll of the body
 * afterwards moves the frame and still lets the row go.
 */

/** The rail's height and the panel above the Tasks panel, px, as the captain's window drew them. */
const RAIL_PX = 760;
const ABOVE_PX = 162;

/** The window's frame for one animation frame, so a scroll the browser queued has reached it. */
const nextFrames = () =>
  new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

test("a Tasks row's summary stays when the panel above shrinks and the Tasks list's scroll position is pulled back", async () => {
  const api = Object.freeze(fakeBridge(await freshHome()).api);
  Object.defineProperty(window, "infinitary", { value: api, configurable: false });
  Object.defineProperty(window, "firstmate", { value: api, configurable: false });
  await openSize();

  // Section: a rail with a panel above the Tasks panel, whose body scrolls
  // the Tasks page's frame; the frame's last row sits at the body's end.
  const rail = document.createElement("div");
  rail.style.cssText = `display:flex;flex-direction:column;height:${RAIL_PX}px;width:320px`;
  const above = document.createElement("section");
  above.style.cssText = `flex:none;height:${ABOVE_PX}px`;
  const body = document.createElement("div");
  body.setAttribute("data-side-panel-body", "");
  body.style.cssText = "flex:1;min-height:0;overflow:auto";
  const frame = document.createElement("iframe");
  frame.style.cssText = "display:block;border:0;width:100%;height:1500px";
  body.append(frame);
  rail.append(above, body);
  const host = document.createElement("div");
  document.body.replaceChildren(rail, host);
  const root = createRoot(host);
  flushSync(() => root.render(<PeekSummary />));

  body.scrollTop = body.scrollHeight;
  await nextFrames();
  const end = body.scrollTop;
  expect(end).toBeGreaterThan(ABOVE_PX);

  // Section: the pointer rests on a row near the frame's end, and the
  // Tasks page reports it, as its point.peekTask does.
  const frameBox = frame.getBoundingClientRect();
  const rowTop = 1500 - 120;
  // The body is wholly in view, so hovering through it moves nothing.
  const bodyTop = body.getBoundingClientRect().top;
  await userEvent.hover(page.elementLocator(body), {
    position: { x: 100, y: frameBox.top + rowTop + 16 - bodyTop },
  });
  expect(end).toBe(body.scrollTop);
  const rested = {
    taskId: "t-rested",
    box: { top: rowTop, right: 320, bottom: rowTop + 32, left: 0 },
    page: frame,
    pageFrame: frame,
  };
  taskPeek.set(rested);
  await nextFrames();
  expect(taskPeek.get(), "the row's summary once it rests").toBe(rested);

  // Section: the panel above shrinks away; the body grows upward and its
  // scroll position is pulled back by as much, the frame unmoved.
  above.style.height = "0px";
  await nextFrames();
  expect(body.scrollTop).toBe(end - ABOVE_PX);
  expect(frame.getBoundingClientRect().top).toBe(frameBox.top);
  await nextFrames();
  expect(taskPeek.get(), "the row's summary after the pulled-back scroll").toBe(rested);

  // Section: a real scroll of the body carries the frame, and the row goes.
  body.scrollTop -= 100;
  await expect.poll(() => taskPeek.get()).toBeNull();
  root.unmount();
});
