import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, type Locator } from "@playwright/test";
import { FRAME_BRIDGE_VERSION } from "../../src/shared/plugins/bridge";
import { frameCsp } from "../../src/shared/plugins/containment";
import { buildFrameDocument } from "../../src/shared/plugins/frameDocument";
import { rendererTest as test } from "./renderer";

/**
 * A past card's body (FI3-579 piece 2) in the app's own Chromium (the shared
 * renderer fixture, so no separately downloaded browser), through the real
 * bridge script and the real frame document: the saved answers come back,
 * every control is disabled, the saved figure still draws, and a body that
 * adds controls or tries to act cannot make the host hear an action. The page
 * plays the host the way FrameController does: it answers `ready` with the
 * `form` and `initialize` messages and records every message the frame posts.
 * The body keeps Firstmate 3000's hooks (`data-fm-*`), as a card saved before
 * the Infinitary rename does, and still answers (FI3-1780 step 8).
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
  <script></script>`;

const LATE_CONTROLS =
  "setTimeout(function(){document.getElementById('slot').innerHTML='<button id=late type=button data-fm-action=late>Late</button><input id=extra name=extra>'},50);";

const ANSWERS = [
  { name: "direction", values: ["B"], labels: ["B. A card history"], changed: true },
  { name: "pace", values: [], changed: true, written: "One project a week" },
  { name: "notes", values: ["saved words"], changed: true },
];

/** Chromium drops native clicks into a hidden window's sandboxed frames. */
async function clickInFrame(target: Locator): Promise<void> {
  await target.evaluate((el) => (el as HTMLElement).click());
}

test("a past card's body fills the saved answers, disables every control and keeps its figure", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 640, height: 600 });
  const frameDocument = buildFrameDocument({
    csp: frameCsp([`sha256-${createHash("sha256").update(LATE_CONTROLS).digest("base64")}`]),
    theme: "dark",
    style: "body{font:14px sans-serif;color:#ddd;background:#111}label{display:block}",
    // The scripted tail adds a control later, as an author's script might.
    html: BODY.replace("<script></script>", '<div id="slot"></div>'),
    script: LATE_CONTROLS,
  });
  await page.setContent(
    // biome-ignore lint/plugin/e2e-frame-door: a bare page holding the frame the spec builds itself, not an app frame.
    `<iframe id="f" sandbox="allow-scripts" style="width:600px;height:500px;border:0"></iframe>
     <script>
       window.heard = [];
       const frame = document.getElementById('f');
       window.addEventListener('message', (event) => {
         if (event.source !== frame.contentWindow) return;
         const data = event.data;
         window.heard.push(data);
         if (data.type === 'ready') {
           frame.contentWindow.postMessage({ fm: ${FRAME_BRIDGE_VERSION}, type: 'form', fill: ${JSON.stringify(ANSWERS)}, readOnly: true }, '*');
           frame.contentWindow.postMessage({ fm: ${FRAME_BRIDGE_VERSION}, type: 'initialize', document: data.document }, '*');
         }
       });
       frame.srcdoc = ${JSON.stringify(frameDocument).replaceAll("<", "\\u003c")};
     </script>`,
  );
  // biome-ignore lint/plugin/e2e-frame-door: the frame the spec built itself above, not an app frame.
  const body = page.frameLocator("#f");
  await expect(body.locator("#late")).toBeVisible();

  // The saved answers are back.
  await expect(body.locator('input[name="direction"][value="B"]')).toBeChecked();
  await expect(body.locator('input[name="direction"][value="A"]')).not.toBeChecked();
  await expect(body.locator('input[name="notes"]')).toHaveValue("saved words");
  // Words written under Something else come back in its field; an unpicked
  // Something else shows none.
  await expect(body.locator('input[name="pace"][data-fm-write-in]')).toBeChecked();
  const written = body.getByRole("textbox", { name: "Your own answer to: 2. Which pace?" });
  await expect(written).toBeVisible();
  await expect(written).toHaveValue("One project a week");
  await expect(body.getByRole("textbox", { name: /^Your own answer to: 1\./ })).toHaveCount(0);

  // Every control is disabled, including the one a script added later.
  const enabled = await body
    .locator("body")
    .evaluate((root) =>
      [
        ...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
          "input, button, select, textarea",
        ),
      ]
        .filter((control) => !control.disabled)
        .map((control) => control.name || control.id || control.textContent),
    );
  expect(enabled).toEqual([]);

  await expect(body.locator("rect[data-figure]")).toBeVisible();

  // Clicking anything raises no action; the form's reading never reports a change.
  await clickInFrame(body.getByRole("button", { name: "Approve and build" }));
  await clickInFrame(body.locator("#late"));
  await clickInFrame(body.locator('input[name="direction"][value="A"]'));
  await expect(body.locator('input[name="direction"][value="B"]')).toBeChecked();
  const heard = await page.evaluate(
    () => (window as unknown as { heard: { type: string; verb?: string }[] }).heard,
  );
  expect(heard.filter((message) => message.type === "request")).toEqual([]);

  await page.screenshot({ path: join(testInfo.outputDir, "past-card-frame.png") });
});
