import { FRAME_BRIDGE_VERSION } from "@shared/plugins/bridge";
import { frameCsp } from "@shared/plugins/containment";
import { buildFrameDocument } from "@shared/plugins/frameDocument";
import { expect, test } from "vitest";
import { commands } from "vitest/browser";

/**
 * A past card's body (FI3-579 piece 2) through the real bridge script and
 * the real frame document, in a sandboxed frame as the window draws it: the
 * saved answers come back, every control is disabled, the saved figure
 * still draws, and a body that adds controls or tries to act cannot make the
 * host hear an action. The test plays the host the way FrameController does:
 * it answers `ready` with the `form` and `initialize` messages and records
 * every message the frame posts. The body keeps Firstmate 3000's hooks
 * (`data-fm-*`), as a card saved before the Infinitary rename does, and
 * still answers (FI3-1780 step 8).
 */

const BODY = `
  <h2>Plan</h2>
  <svg viewBox="0 0 240 80" width="100%" role="img" aria-label="Three pieces in merge order">
    <rect data-figure x="0" y="0" width="240" height="80" fill="#345"/>
  </svg>
  <form>
    <fieldset>
      <legend>1. Which direction?</legend>
      <label><input type="radio" name="direction" value="A"> A. The record remembers</label>
      <label><input type="radio" name="direction" value="B"> B. A card history</label>
      <label><input type="radio" name="direction" value="other" data-fm-write-in> Something else</label>
    </fieldset>
    <fieldset>
      <legend>2. Which pace?</legend>
      <label><input type="radio" name="pace" value="slow"> Slow</label>
      <label><input type="radio" name="pace" value="other" data-fm-write-in> Something else</label>
    </fieldset>
    <label>Notes <input type="text" name="notes" value="authored"></label>
    <button type="button" data-fm-action="approve">Approve and build</button>
  </form>
  <div id="slot"></div>`;

const LATE_CONTROLS =
  "setTimeout(function(){document.getElementById('slot').innerHTML='<button id=late type=button data-fm-action=late>Late</button><input id=extra name=extra>'},50);";

const ANSWERS = [
  { name: "direction", values: ["B"], labels: ["B. A card history"], changed: true },
  { name: "pace", values: [], changed: true, written: "One project a week" },
  { name: "notes", values: ["saved words"], changed: true },
];

/** The frame's name, by which the browser reaches into it. */
const FRAME = "past-card";

/** The content policy's hash of an inline script, as the host allows a card's own script. */
async function scriptHash(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

/** Runs `read`, which closes over nothing, inside the card's frame and answers what it returns. */
function inFrame<T>(read: () => T): Promise<T> {
  return commands.evaluateInFrame(FRAME, read.toString()) as Promise<T>;
}

/** What the body shows a person: each control's state, by the words a reader finds it by. */
type Shown = {
  late: boolean;
  checked: Record<string, boolean>;
  notes: string;
  written: { shown: boolean; value: string } | null;
  firstWritten: boolean;
  enabled: string[];
  figure: boolean;
};

function shown(): Promise<Shown> {
  return inFrame(() => {
    const visible = (element: Element | null) =>
      element instanceof HTMLElement && !element.hidden && element.getClientRects().length > 0;
    const radio = (name: string, value: string) =>
      document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)
        ?.checked ?? false;
    // The field under a Something else row is a textbox the bridge adds, named for its question.
    const written = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Your own answer to: 2. Which pace?"]',
    );
    const figure = document.querySelector("rect[data-figure]");
    return {
      late: visible(document.getElementById("late")),
      checked: {
        A: radio("direction", "A"),
        B: radio("direction", "B"),
        paceWriteIn:
          document.querySelector<HTMLInputElement>('input[name="pace"][data-fm-write-in]')
            ?.checked ?? false,
      },
      notes: document.querySelector<HTMLInputElement>('input[name="notes"]')?.value ?? "",
      written: written ? { shown: visible(written), value: written.value } : null,
      firstWritten: [
        ...document.querySelectorAll('textarea[aria-label^="Your own answer to: 1."]'),
      ].some(visible),
      enabled: [
        ...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
          "input, button, select, textarea",
        ),
      ]
        .filter((control) => !control.disabled)
        .map((control) => control.name || control.id || control.textContent || ""),
      figure: (figure?.getClientRects().length ?? 0) > 0,
    };
  });
}

test("a past card's body fills the saved answers, disables every control and keeps its figure", async () => {
  const frameDocument = buildFrameDocument({
    csp: frameCsp([await scriptHash(LATE_CONTROLS)]),
    theme: "dark",
    style: "body{font:14px sans-serif;color:#ddd;background:#111}label{display:block}",
    // The scripted tail adds a control later, as an author's script might.
    html: BODY,
    script: LATE_CONTROLS,
  });
  const frame = document.createElement("iframe");
  frame.name = FRAME;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "width:600px;height:500px;border:0";
  const heard: { type: string }[] = [];
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as { type: string; document?: unknown };
    heard.push(data);
    if (data.type === "ready") {
      frame.contentWindow?.postMessage(
        { fm: FRAME_BRIDGE_VERSION, type: "form", fill: ANSWERS, readOnly: true },
        "*",
      );
      frame.contentWindow?.postMessage(
        { fm: FRAME_BRIDGE_VERSION, type: "initialize", document: data.document },
        "*",
      );
    }
  });
  frame.srcdoc = frameDocument;
  document.body.replaceChildren(frame);
  await expect.poll(async () => (await shown()).late).toBe(true);
  const body = await shown();

  // The saved answers are back.
  expect(body.checked.B).toBe(true);
  expect(body.checked.A).toBe(false);
  expect(body.notes).toBe("saved words");
  // Words written under Something else come back in its field; an unpicked
  // Something else shows none.
  expect(body.checked.paceWriteIn).toBe(true);
  expect(body.written).toEqual({ shown: true, value: "One project a week" });
  expect(body.firstWritten).toBe(false);

  // Every control is disabled, including the one a script added later.
  expect(body.enabled).toEqual([]);
  expect(body.figure).toBe(true);

  // Clicking anything raises no action; the form's reading never reports a change.
  await inFrame(() => {
    for (const target of [
      [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Approve and build"),
      ),
      document.getElementById("late"),
      document.querySelector('input[name="direction"][value="A"]'),
    ])
      (target as HTMLElement).click();
  });
  expect((await shown()).checked.B).toBe(true);
  // One more trip into the frame gives a message a click posted time to reach the host.
  await inFrame(() => new Promise((done) => requestAnimationFrame(done)));
  expect(heard.filter((message) => message.type === "request")).toEqual([]);
  expect(heard.some((message) => message.type === "ready")).toBe(true);
});
