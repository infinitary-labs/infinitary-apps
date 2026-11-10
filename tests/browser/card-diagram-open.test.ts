import { DRAWING_SOURCE_PREFIX, FRAME_BRIDGE_VERSION } from "@shared/plugins/bridge";
import { frameCsp } from "@shared/plugins/containment";
import { buildFrameDocument } from "@shared/plugins/frameDocument";
import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { cardBodyMarkup, cardStylesheet } from "../../src/renderer/src/cards/prototypeSrcdoc";

/**
 * INF-3107 (the captain's Approve and build: "tapped diagrams now open the
 * viewer"): which drawings in a card body open the picture viewer, through
 * the real bridge script, the real card stylesheet and a sandboxed frame as
 * the window draws it. The test plays the host the way FrameController
 * does: it answers `ready`, asks for pictures with the `keys` message, and
 * records every `image` message the frame posts.
 *
 * A diagram is the outermost drawing in a figure, or one drawn the width of
 * what holds it; a small mark beside words, a drawing inside a control or a
 * caption, and a press the figure's own script took open nothing. What
 * travels is the drawing as it stands, in the card's look, with no script
 * or handler.
 */

const FIGURE_CAPTION = "Three pieces in merge order";
const WIDE_LABEL = "The phone and the Mac read one viewer";

const BODY = `
  <p>The plan has three pieces. <svg id="mark" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="var(--ok)"/></svg> Ready.</p>
  <figure id="figure">
    <svg id="diagram" viewBox="0 0 750 120" width="100%" role="img" aria-label="Pieces" onclick="window.clicked = true">
      <script>window.ranInViewer = true;</script>
      <rect id="piece" x="25" y="30" width="200" height="60" rx="8" fill="var(--bg-2)" stroke="var(--line-2)"/>
      <text id="label" x="125" y="66" text-anchor="middle" fill="var(--fg-1)" font-size="14">Frame</text>
      <svg id="inner" x="300" y="30" width="60" height="60" viewBox="0 0 60 60"><circle cx="30" cy="30" r="20" fill="var(--accent)"/></svg>
    </svg>
    <figcaption>${FIGURE_CAPTION} <svg id="caption-mark" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg></figcaption>
  </figure>
  <svg id="wide" viewBox="0 0 750 90" width="100%" role="img" aria-label="${WIDE_LABEL}"><rect x="0" y="0" width="750" height="90" fill="var(--bg-2)"/></svg>
  <button type="button" id="control"><svg id="control-mark" viewBox="0 0 750 90" width="100%"><rect width="750" height="90"/></svg>Open</button>
  <figure id="moving"><svg id="kept" viewBox="0 0 750 90" width="100%"><rect width="750" height="90"/></svg></figure>`;

/** The figure that moves with its own script takes its own presses. */
const KEEPS_ITS_PRESS =
  "document.getElementById('kept').addEventListener('click', function (event) { event.preventDefault(); });";

/** The frame's name, by which the browser reaches into it. */
const FRAME = "diagram-card";

type Picture = { src: string; alt: string; width: number; height: number };
type Heard = { type: string; index?: number; pictures?: Picture[] };

/** The content policy's hash of an inline script, as the host allows a card's own script. */
async function scriptHash(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

function inFrame<T, A>(read: (argument: A) => T, argument: A): Promise<Awaited<T>> {
  return commands.evaluateInFrame(FRAME, read.toString(), argument) as Promise<Awaited<T>>;
}

/** A click on the element with `id`, as the captain's press reaches the body. */
const press = (id: string) =>
  inFrame((target: string) => {
    document
      .getElementById(target)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return new Promise((done) => requestAnimationFrame(done));
  }, id);

async function mounted(annotations = false): Promise<Heard[]> {
  const heard: Heard[] = [];
  const frame = document.createElement("iframe");
  frame.name = FRAME;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "width:800px;height:700px;border:0";
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as Heard & { document?: unknown };
    heard.push(data);
    if (data.type === "ready") {
      const post = (message: object) =>
        frame.contentWindow?.postMessage({ fm: FRAME_BRIDGE_VERSION, ...message }, "*");
      post({ type: "keys", pictures: true, escape: false });
      post({ type: "initialize", document: data.document });
      if (annotations)
        post({ type: "annotation", document: data.document, mode: false, queued: [] });
    }
  });
  frame.srcdoc = buildFrameDocument({
    csp: frameCsp([await scriptHash(KEEPS_ITS_PRESS)]),
    theme: "dark",
    style: cardStylesheet(),
    html: annotations ? cardBodyMarkup(BODY).html : BODY,
    script: KEEPS_ITS_PRESS,
  });
  document.body.replaceChildren(frame);
  await expect
    .poll(() => inFrame(() => document.getElementById("diagram")?.hasAttribute("tabindex"), null))
    .toBe(true);
  return heard;
}

const opened = (heard: Heard[]) => heard.filter((message) => message.type === "image");

/** A posted drawing, read back as the document a picture of it shows. */
function drawn(picture: Picture): Document {
  expect(picture.src.startsWith(DRAWING_SOURCE_PREFIX)).toBe(true);
  const markup = decodeURIComponent(picture.src.slice(DRAWING_SOURCE_PREFIX.length));
  return new DOMParser().parseFromString(markup, "image/svg+xml");
}

test("a press on a figure's diagram, or on one drawn full width, opens it as it stands", async () => {
  const heard = await mounted();

  // A press anywhere on the figure's drawing, an inner drawing included, opens the whole of it.
  await press("label");
  await press("inner");
  const [figure, inner] = opened(heard);
  expect(figure?.index).toBe(0);
  const diagram = figure?.pictures?.[0] as Picture;
  expect(inner?.pictures?.[0]?.src).toBe(diagram.src);
  expect(diagram.alt).toBe(FIGURE_CAPTION);
  // Its own size, one unit to a pixel.
  expect([diagram.width, diagram.height]).toEqual([750, 120]);
  const picture = drawn(diagram);
  const root = picture.documentElement;
  expect([root.getAttribute("width"), root.getAttribute("height")]).toEqual(["750", "120"]);
  // No script and no handler goes with it.
  expect(picture.querySelector("script")).toBeNull();
  expect(root.hasAttribute("onclick")).toBe(false);
  expect(root.hasAttribute("tabindex")).toBe(false);
  // The card's look goes on each element, its tokens resolved to the colors the card drew.
  const look = await inFrame(
    () => ({
      fill: getComputedStyle(document.getElementById("piece") as Element).fill,
      label: getComputedStyle(document.getElementById("label") as Element).fill,
    }),
    null,
  );
  expect(picture.getElementById("piece")?.getAttribute("style")).toContain(`fill:${look.fill};`);
  expect(picture.getElementById("label")?.getAttribute("style")).toContain(`fill:${look.label};`);
  expect(picture.getElementById("label")?.getAttribute("style")).toContain("font-family:");
  // The card's own typefaces for the families it uses, at the card's own address.
  expect(picture.querySelector("style")?.textContent).toMatch(
    /@font-face[^}]*app-frame:\/\/fonts\/[a-z0-9-]+\.woff2/,
  );

  // A drawing the width of the body opens alone, named by its label.
  await press("wide");
  const wide = opened(heard)[2]?.pictures?.[0];
  expect(wide?.alt).toBe(WIDE_LABEL);
  expect([wide?.width, wide?.height]).toEqual([750, 90]);
});

test("a mark beside words, a control's drawing, a caption's drawing and a press its script took open nothing", async () => {
  const heard = await mounted();
  for (const id of ["mark", "control-mark", "caption-mark", "kept"]) await press(id);
  expect(opened(heard)).toEqual([]);
  // Only diagrams take a keyboard stop of their own.
  const stops = await inFrame(
    () => [...document.querySelectorAll("svg[tabindex]")].map((drawing) => drawing.id),
    null,
  );
  expect(stops).toEqual(["diagram", "wide", "kept"]);
});

test("Enter on a diagram the keyboard reached opens it", async () => {
  const heard = await mounted();
  await inFrame(() => {
    const diagram = document.getElementById("wide") as HTMLElement & SVGElement;
    diagram.focus();
    diagram.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    return new Promise((done) => requestAnimationFrame(done));
  }, null);
  expect(opened(heard)[0]?.pictures?.[0]?.alt).toBe(WIDE_LABEL);
});

/** Intent: the explicit review repair keeps a focused picture's Enter after a text annotation. */
test("Enter on a focused drawing opens it after the text selection is gone", async () => {
  const heard = await mounted(true);
  await inFrame(() => {
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    if (!node) throw new Error("missing actual plan paragraph");
    const words = "three pieces",
      start = (node.textContent ?? "").indexOf(words);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + words.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    paragraph?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }, null);
  await expect.poll(() => heard.filter((message) => message.type === "annotate").length).toBe(1);
  await inFrame(() => {
    window.getSelection()?.removeAllRanges();
    const diagram = document.getElementById("wide") as HTMLElement & SVGElement;
    diagram.focus();
    diagram.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    return new Promise((done) => requestAnimationFrame(done));
  }, null);
  expect(opened(heard)[0]?.pictures?.[0]?.alt).toBe(WIDE_LABEL);
  expect(heard.filter((message) => message.type === "annotate")).toHaveLength(1);
});
