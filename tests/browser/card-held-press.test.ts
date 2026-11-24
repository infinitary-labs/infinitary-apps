import { FRAME_BRIDGE_VERSION } from "@shared/plugins/bridge";
import { frameCsp } from "@shared/plugins/containment";
import { buildFrameDocument } from "@shared/plugins/frameDocument";
import { WEBKIT_HIGHLIGHT_DELAY_MS } from "@shared/plugins/framePressScript";
import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { cardBodyMarkup, cardStylesheet } from "../../src/renderer/src/cards/prototypeSrcdoc";

/**
 * INF-1337: a finger's press on a card acts on its own trusted release once
 * it is held from WebKit's 0.12 s press moment up, on pictures, labels and
 * radios alike, because WebKit's press handling on an iPhone or iPad can
 * swallow that press's click. Each press acts exactly once: the click the
 * browser may still send for it is dropped. Through the real bridge script,
 * the real card stylesheet and a sandboxed frame as the window draws it, with
 * the browser's own touch input; the test plays the host the way
 * FrameController does and records every `image` message the frame posts.
 *
 * Where Chromium still clicks after a held touch, as it does on a Mac, the
 * bridge's click and the browser's meet, and a press that acted twice would
 * show: a checkbox back where it was, or a picture opened twice. The
 * swallowed click itself is WebKit's, which the phone's card journeys press,
 * and so is a release that holds no user activation, after which the bridge
 * leaves a picture to WebKit's own click: Chromium gives every touch's
 * release one.
 *
 * On a phone the app's own scrollers and swipes move the whole frame with
 * the finger, so a drag stays on what it went down on and the browser
 * cancels nothing; the phone's host says `press-moved` instead, which the
 * test sends as the host does, during a held press. The bridge then makes no
 * click of its own, which the card's script tells from the browser's: a
 * click the bridge makes is not trusted.
 *
 * INF-6222: in Point at, a press on a part picks it on its own release
 * however briefly it is held. On a busy phone WebKit took a quick tap whose
 * release reached it late for a held press, which clicks nothing on words,
 * while the pointer events still timed it as quick. The card's script can
 * swallow every click the browser sends, as WebKit sent none there, so a
 * pick that still comes is the frame's own.
 */

const FRAME = "held-press-card";

const PICTURE = "Blue harbour survey";

const BODY = `
  <fieldset><legend>Which harbour?</legend>
    <label id="north"><input type="radio" name="harbour" value="north"> North Basin</label>
    <label id="south"><input type="radio" name="harbour" value="south"> South Basin</label>
  </fieldset>
  <label id="tide-words"><input id="tide" type="checkbox" name="tide"> Keep the tide table</label>
  <img id="survey" alt="${PICTURE}" width="240" height="120" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='120'%3E%3Crect width='240' height='120' fill='%232a8fbd'/%3E%3C/svg%3E">
  <figure><svg id="moving" viewBox="0 0 750 120" width="100%" role="img" aria-label="A chart its own script moves"><rect width="750" height="120" fill="var(--bg-2)"/></svg></figure>`;

/** The paragraphs a person points at, above the card's choices and picture. */
const POINTED = `
  <p id="basin">The north basin floods at spring tide, so the survey waits for the neap.</p>
  <p id="chart">Keep the tide table beside the chart.</p>`;

/**
 * The card's own script: it counts the checkbox's changes, the clicks the
 * bridge makes, and, of the browser's own events, its touch starts and ends,
 * mouseups and context menus, and its moving chart takes its own touches, as
 * a drawing a finger drags does. While `swallows` is set it swallows every
 * click the browser sends, after the bridge has heard it and before the
 * card's parts do.
 */
const SCRIPT = `window.heard = { changes: 0, bridged: 0, starts: 0, ends: 0, ups: 0, menus: 0 };
window.swallows = false;
document.getElementById("tide").addEventListener("change", function () { window.heard.changes += 1; });
window.addEventListener("click", function (event) {
  if (!event.isTrusted) window.heard.bridged += 1;
  else if (window.swallows) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
[["touchstart", "starts"], ["touchend", "ends"], ["mouseup", "ups"], ["contextmenu", "menus"]].forEach(function (count) {
  window.addEventListener(count[0], function (event) { if (event.isTrusted) window.heard[count[1]] += 1; }, true);
});
document.getElementById("moving").addEventListener("touchstart", function (event) { event.preventDefault(); }, { passive: false });`;

/** A tap, a press held past WebKit's press moment, and one held past its long press. */
const HOLDS = [50, WEBKIT_HIGHLIGHT_DELAY_MS + 180, 900];

type Heard = {
  type: string;
  token?: number;
  seq?: number;
  pictures?: { alt: string }[];
  target?: { start: number; kind: string; span?: unknown };
  focus?: boolean;
};
type CardHeard = {
  changes: number;
  bridged: number;
  starts: number;
  ends: number;
  ups: number;
  menus: number;
};

/** The content policy's hash of an inline script, as the host allows a card's own script. */
async function scriptHash(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

function inFrame<T, A>(read: (argument: A) => T, argument: A): Promise<Awaited<T>> {
  return commands.evaluateInFrame(FRAME, read.toString(), argument) as Promise<Awaited<T>>;
}

const cardHeard = () => inFrame(() => (window as unknown as { heard: CardHeard }).heard, null);

/** Whether the card's script swallows the clicks the browser sends. */
const swallowClicks = (swallows: boolean) =>
  inFrame((on: boolean) => {
    (window as unknown as { swallows: boolean }).swallows = on;
  }, swallows);

/** The frame answers a ping only after every message the host sent it before. */
async function caughtUp(heard: Heard[]): Promise<void> {
  const frame = document.querySelector<HTMLIFrameElement>(`iframe[name="${FRAME}"]`);
  const seq = Math.random();
  frame?.contentWindow?.postMessage({ fm: FRAME_BRIDGE_VERSION, type: "ping", seq }, "*");
  await expect
    .poll(() => heard.some((message) => message.type === "pong" && message.seq === seq))
    .toBe(true);
}

/**
 * A finger held on `selector` for `hold` ms, done once its touch ended and
 * the browser finished the press its own way: with a mouseup, whose click it
 * sends in the same turn, or with the context menu of a long press, after
 * which it sends no click. By then the press's one click and any the bridge
 * dropped have both been heard.
 */
async function press(selector: string, hold: number): Promise<void> {
  const before = await cardHeard();
  await commands.holdTouchInFrame(FRAME, selector, hold);
  await expect
    .poll(async () => {
      const now = await cardHeard();
      return now.ends > before.ends && now.ups + now.menus > before.ups + before.menus;
    })
    .toBe(true);
}

/**
 * A finger held on `selector` past WebKit's long press that the host says
 * moved on the screen while it is down, as a phone's host does once its own
 * scroller takes the finger, and done as `press` is. The frame's answer to a
 * ping sent after the word shows the word was heard while the finger was
 * still down.
 */
async function movedPress(selector: string, heard: Heard[]): Promise<void> {
  const before = await cardHeard();
  const held = commands.holdTouchInFrame(FRAME, selector, HOLDS[2] as number);
  await expect.poll(async () => (await cardHeard()).starts).toBe(before.starts + 1);
  const frame = document.querySelector<HTMLIFrameElement>(`iframe[name="${FRAME}"]`);
  frame?.contentWindow?.postMessage({ fm: FRAME_BRIDGE_VERSION, type: "press-moved" }, "*");
  await caughtUp(heard);
  expect((await cardHeard()).ends).toBe(before.ends);
  await held;
  await expect
    .poll(async () => {
      const now = await cardHeard();
      return now.ends > before.ends && now.ups + now.menus > before.ups + before.menus;
    })
    .toBe(true);
}

/** Every message the frame posted so far has arrived: the frame's last one says so, in order. */
async function settled(heard: Heard[]): Promise<void> {
  const token = Math.random();
  await inFrame((sent: number) => parent.postMessage({ type: "settled", token: sent }, "*"), token);
  await expect
    .poll(() => heard.some((message) => message.type === "settled" && message.token === token))
    .toBe(true);
}

const opened = (heard: Heard[]) =>
  heard.filter((message) => message.type === "image").map((message) => message.pictures?.[0]?.alt);

/** Every part the frame picked for a note, as the host hears it. */
const picked = (heard: Heard[]) =>
  heard
    .filter((message) => message.type === "annotate")
    .map((message) => ({
      start: message.target?.start,
      kind: message.target?.kind,
      words: message.target?.span !== undefined,
      focus: message.focus,
    }));

/** A whole paragraph picked, its note's comment ready, as Point at picks one. */
const paragraph = (start: number) => ({ start, kind: "paragraph", words: false, focus: true });

const targetOf = (selector: string) =>
  inFrame(
    (found: string) => Number(document.querySelector(found)?.getAttribute("data-inf-target")),
    selector,
  );

/** The card's body, with Point at on as the host turns it on when `pointing`. */
async function mounted(pointing = false): Promise<Heard[]> {
  const heard: Heard[] = [];
  const frame = document.createElement("iframe");
  frame.name = FRAME;
  frame.setAttribute("sandbox", "allow-scripts");
  // As wide as a phone draws a card, inside the test page, so a press on any
  // of its parts lands in the frame rather than off the page or on the
  // page's scrollbar beside it.
  frame.style.cssText = "width:360px;height:700px;border:0";
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as Heard & { document?: unknown };
    heard.push(data);
    if (data.type === "ready") {
      const post = (message: object) =>
        frame.contentWindow?.postMessage({ fm: FRAME_BRIDGE_VERSION, ...message }, "*");
      post({ type: "keys", pictures: true, escape: false });
      post({ type: "initialize", document: data.document });
      if (pointing) post({ type: "annotation", document: data.document, mode: true, queued: [] });
    }
  });
  frame.srcdoc = buildFrameDocument({
    csp: frameCsp([await scriptHash(SCRIPT)]),
    theme: "dark",
    style: cardStylesheet(),
    html: pointing ? cardBodyMarkup(POINTED + BODY).html : BODY,
    script: SCRIPT,
  });
  document.body.replaceChildren(frame);
  await expect
    .poll(() =>
      inFrame(
        () =>
          ["survey", "moving"].every((id) => document.getElementById(id)?.hasAttribute("tabindex")),
        null,
      ),
    )
    .toBe(true);
  if (pointing) await caughtUp(heard);
  return heard;
}

test("a finger's press picks a choice by its words and opens a picture once, however long it is held", async () => {
  const heard = await mounted();
  for (const [index, hold] of HOLDS.entries()) {
    await press("#tide-words", hold);
    const tide = await inFrame(
      () => (document.getElementById("tide") as HTMLInputElement).checked,
      null,
    );
    expect({ changes: (await cardHeard()).changes, checked: tide }).toEqual({
      changes: index + 1,
      checked: index % 2 === 0,
    });

    const harbour = index % 2 === 0 ? "south" : "north";
    await press(`#${harbour}`, hold);
    const picked = await inFrame(
      () =>
        (document.querySelector("input[name=harbour]:checked") as HTMLInputElement | null)?.value,
      null,
    );
    expect(picked).toBe(harbour);

    await press("#survey", hold);
    await settled(heard);
    expect(opened(heard)).toEqual(Array.from({ length: index + 1 }, () => PICTURE));
  }
});

test("a held press on a drawing whose own script takes the touch opens nothing", async () => {
  // INF-3107: a press the figure's own script took opens nothing, held or not.
  const heard = await mounted();
  const { ends } = await cardHeard();
  await commands.holdTouchInFrame(FRAME, "#moving", HOLDS[2] as number);
  await expect.poll(async () => (await cardHeard()).ends).toBe(ends + 1);
  await press("#survey", HOLDS[2] as number);
  await settled(heard);
  expect(opened(heard)).toEqual([PICTURE]);
});

test("a held press the phone says its own scroller took is left to the browser", async () => {
  const heard = await mounted();
  await movedPress("#tide-words", heard);
  await movedPress("#survey", heard);
  await settled(heard);
  const tide = await inFrame(
    () => (document.getElementById("tide") as HTMLInputElement).checked,
    null,
  );
  const { changes, bridged } = await cardHeard();
  // Chromium still clicks a touch that never moved, where the phone's WebKit
  // sent none for a drag its scroller took: either way the click is the
  // browser's.
  expect({ bridged, changes, checked: tide, opened: opened(heard) }).toEqual({
    bridged: 0,
    changes: 1,
    checked: true,
    opened: [PICTURE],
  });
  // The next held press is the bridge's to act on again.
  await press("#survey", HOLDS[2] as number);
  await settled(heard);
  expect({ bridged: (await cardHeard()).bridged, opened: opened(heard) }).toEqual({
    bridged: 1,
    opened: [PICTURE, PICTURE],
  });
});

test("in Point at, a finger's press on a paragraph picks it once on its own release, quick or held", async () => {
  const heard = await mounted(true);
  const basin = await targetOf("#basin");
  await swallowClicks(true);
  for (const [index, hold] of HOLDS.slice(0, 2).entries()) {
    await press("#basin", hold);
    await settled(heard);
    expect(picked(heard)).toEqual(Array.from({ length: index + 1 }, () => paragraph(basin)));
  }
  // Where the browser clicks too, as Chromium does, its click is dropped: one press, one pick.
  await swallowClicks(false);
  await press("#basin", HOLDS[0] as number);
  await settled(heard);
  expect(picked(heard)).toEqual(Array.from({ length: 3 }, () => paragraph(basin)));
  // A choice's words stay the choice's in Point at: they pick it and no part.
  await press("#tide-words", HOLDS[0] as number);
  await settled(heard);
  const tide = await inFrame(
    () => (document.getElementById("tide") as HTMLInputElement).checked,
    null,
  );
  expect({ checked: tide, picks: picked(heard).length }).toEqual({ checked: true, picks: 3 });
});

test("in Point at, a press on a paragraph picks it past words still selected from before", async () => {
  // After a selection's Annotate and Cancel the words stay selected; a tap's own click clears them.
  const heard = await mounted(true);
  const basin = await targetOf("#basin");
  await swallowClicks(true);
  for (const [index, hold] of HOLDS.slice(0, 2).entries()) {
    await inFrame(() => {
      const words = document.getElementById("chart")?.firstChild;
      if (!words) throw new Error("The chart paragraph has no words");
      const range = document.createRange();
      range.setStart(words, 9);
      range.setEnd(words, 19);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }, null);
    await press("#basin", hold);
    await settled(heard);
    expect(picked(heard)).toEqual(Array.from({ length: index + 1 }, () => paragraph(basin)));
  }
});
