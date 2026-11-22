import { FRAME_BRIDGE_VERSION } from "@shared/plugins/bridge";
import { frameCsp } from "@shared/plugins/containment";
import { buildFrameDocument } from "@shared/plugins/frameDocument";
import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { phoneTextRule, typeSizes } from "../../ios/Infinitary/CardRuntime/textSize";
import { cardStylesheet } from "../../src/renderer/src/cards/prototypeSrcdoc";

/**
 * The captain's Approve and build on INF-4713 ("can you add font size options for the iOS app too? I feel old
 * squinting at some of the text"): on the phone a card's words follow the device's Text Size, every Mac size times one
 * factor, while a drawing's labels keep the Mac's sizes so none grows into its neighbour; a Text Size change while
 * the card shows redraws it in place. The card's real stylesheet, the phone's rule and the real bridge script, in a
 * sandboxed frame as the phone's card page draws it.
 */

const BODY = `
  <p id="body">Cards and panels follow the device's Text Size.</p>
  <p>Grounded in <span id="key" class="inf-mono">INF-4713</span>.</p>
  <figure aria-label="Card sizes today">
    <svg viewBox="0 0 750 120" width="100%">
      <text id="label" x="20" y="40">A card's body</text>
      <text id="micro" x="20" y="80" style="font-family: var(--font-mono); font-size: var(--text-xs)">14 → 17</text>
    </svg>
    <figcaption id="caption">Today only Infinitary's own words grow.</figcaption>
  </figure>`;

const FRAME = "phone-text-size";

/** The Mac's own size of a type token, read from its typography, never typed here. */
function mac(token: string): number {
  const size = typeSizes().find(([name]) => name === token)?.[1];
  if (size === undefined) throw new Error(`The Mac's typography sets no ${token}`);
  return size;
}

/** Each element's drawn font size in CSS pixels, one per point on the phone. */
function sizes(): Promise<Record<string, number>> {
  return commands.evaluateInFrame(
    FRAME,
    (() => {
      const px = (id: string) =>
        Number.parseFloat(getComputedStyle(document.getElementById(id) as Element).fontSize);
      return {
        body: px("body"),
        key: px("key"),
        caption: px("caption"),
        label: px("label"),
        micro: px("micro"),
      };
    }).toString(),
  ) as Promise<Record<string, number>>;
}

function mount(style: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.name = FRAME;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "width:329px;height:400px;border:0";
  addEventListener("message", (event) => {
    const data = event.data as { type?: string; document?: string };
    if (event.source !== frame.contentWindow || data.type !== "ready") return;
    frame.contentWindow?.postMessage(
      { fm: FRAME_BRIDGE_VERSION, type: "initialize", document: data.document },
      "*",
    );
  });
  frame.srcdoc = buildFrameDocument({ csp: frameCsp([]), theme: "dark", style, html: BODY });
  document.body.replaceChildren(frame);
  return frame;
}

test("a phone card's words follow the device's Text Size while its drawing's labels keep the Mac's sizes", async () => {
  // iOS's body at its default Text Size, over the Mac's 14.
  const frame = mount(`${cardStylesheet()}${phoneTextRule(17 / 14)}`);
  await expect.poll(async () => (await sizes()).body).toBe(17);
  const atDefault = await sizes();
  expect(atDefault.key).toBeCloseTo((mac("--text-sm") * 17) / 14, 2);
  expect(atDefault.caption).toBeCloseTo((mac("--text-sm") * 17) / 14, 2);
  expect(atDefault.label).toBe(mac("--text-sm"));
  expect(atDefault.micro).toBe(mac("--text-xs"));

  // The device moves to iOS's largest standard size while the card shows: it redraws in place.
  frame.contentWindow?.postMessage(
    { fm: FRAME_BRIDGE_VERSION, type: "text-scale", scale: 23 / 14 },
    "*",
  );
  await expect.poll(async () => (await sizes()).body).toBe(23);
  const atLargest = await sizes();
  expect(atLargest.key).toBeCloseTo((mac("--text-sm") * 23) / 14, 2);
  expect(atLargest.label).toBe(mac("--text-sm"));
  expect(atLargest.micro).toBe(mac("--text-xs"));
});

test("the Mac's card stylesheet alone draws at the Mac's sizes and ignores a text-scale message", async () => {
  const frame = mount(cardStylesheet());
  await expect.poll(async () => (await sizes()).body).toBe(mac("--text-base"));
  frame.contentWindow?.postMessage(
    { fm: FRAME_BRIDGE_VERSION, type: "text-scale", scale: 23 / 14 },
    "*",
  );
  // One trip into the frame after the message gives it time to land.
  await commands.evaluateInFrame(
    FRAME,
    (() => new Promise((done) => requestAnimationFrame(done))).toString(),
  );
  expect(await sizes()).toEqual({
    body: mac("--text-base"),
    key: mac("--text-sm"),
    caption: mac("--text-sm"),
    label: mac("--text-sm"),
    micro: mac("--text-xs"),
  });
});
