import { FRAME_BRIDGE_VERSION, type FrameAnswer } from "@shared/plugins/bridge";
import { frameCsp } from "@shared/plugins/containment";
import { buildFrameDocument } from "@shared/plugins/frameDocument";
import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { cardStylesheet } from "../../src/renderer/src/cards/prototypeSrcdoc";

/**
 * Unsent picks follow you (INF-5446), for a playable preview. The captain:
 * "can't we sync the settings in a way that behaves as if the user clicked on
 * those setting values and would also trigger the interactive previews to
 * update its state?", choosing to apply synced settings through the
 * preview's own controls. Through the real bridge script and a preview with
 * a script of its own in a sandboxed frame, the test plays the host as
 * FrameController does: another window's setting and one restored at the
 * body's birth move the preview's own dial and reading, and its answers
 * send what the dial shows; a preview that gives no way to apply a setting
 * keeps what it shows and sends.
 */

const FRAME = "preview-settings-card";

const BODY = `
  <p>A glass dial; drag the tilt to try another angle.</p>
  <label>Tilt in degrees <input id="tilt" type="range" min="0" max="90" value="16"></label>
  <output id="reading">16°</output>
  <label>Label on the dial <input id="label" type="text"></label>`;

/** The dial's own script: it stages its tilt, and with `applies` gives the bridge a way to set it. */
const dial = (applies: boolean) => `const tilt = document.getElementById("tilt");
tilt.oninput = function () {
  document.getElementById("reading").textContent = tilt.value + "°";
  inf.stage("look", { tiltDeg: Number(tilt.value) }${applies ? ", function (look) { tilt.value = String(look.tiltDeg); tilt.oninput(); }" : ""});
};
tilt.oninput();`;

const look = (tiltDeg: number): FrameAnswer => ({
  name: "look",
  values: [JSON.stringify({ tiltDeg })],
  changed: true,
  json: true,
});

type Heard = { type: string; answers?: FrameAnswer[] };

async function scriptHash(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

const shown = () =>
  commands.evaluateInFrame(
    FRAME,
    (() => document.getElementById("reading")?.textContent ?? null).toString(),
    null,
  ) as Promise<string | null>;

/** The preview's dial, born with `fill` as the host's draft for it. */
async function preview(script: string, fill: FrameAnswer[] | null) {
  const heard: Heard[] = [];
  const frame = document.createElement("iframe");
  frame.name = FRAME;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "width:480px;height:300px;border:0";
  const post = (message: object) =>
    frame.contentWindow?.postMessage({ fm: FRAME_BRIDGE_VERSION, ...message }, "*");
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as Heard & { document?: unknown };
    heard.push(data);
    if (data.type === "ready") {
      post({ type: "initialize", document: data.document });
      post({ type: "form", fill, preview: true });
    }
  });
  frame.srcdoc = buildFrameDocument({
    csp: frameCsp([await scriptHash(script)]),
    theme: "dark",
    style: cardStylesheet(),
    html: BODY,
    script,
  });
  document.body.replaceChildren(frame);
  await expect.poll(() => heard.some((message) => message.type === "answers")).toBe(true);
  /** The setting the body's latest reading sends. */
  const sent = () =>
    heard.findLast((message) => message.type === "answers")?.answers?.find((a) => a.name === "look")
      ?.values[0] ?? null;
  /** Every message posted to the frame so far has been handled: its answer to a later ping says so. */
  const handled = async () => {
    const seq = Math.random();
    post({ type: "ping", seq });
    await expect
      .poll(() =>
        heard.some(
          (message) => message.type === "pong" && (message as { seq?: number }).seq === seq,
        ),
      )
      .toBe(true);
  };
  return { sent, handled, fill: (answers: FrameAnswer[]) => post({ type: "fill", answers }) };
}

test("another window's preview setting moves the preview's own controls, and the preview sends what it shows", async () => {
  const body = await preview(dial(true), null);
  expect(await shown()).toBe("16°");
  body.fill([look(42)]);
  await expect.poll(shown).toBe("42°");
  await expect.poll(body.sent).toBe(JSON.stringify({ tiltDeg: 42 }));
});

test("a setting restored at the preview's birth shows on its dial and is what it sends", async () => {
  const body = await preview(dial(true), [look(70)]);
  await expect.poll(shown).toBe("70°");
  await expect.poll(body.sent).toBe(JSON.stringify({ tiltDeg: 70 }));
});

test("a preview that gives no way to apply a setting keeps what it shows and sends", async () => {
  const body = await preview(dial(false), [look(70)]);
  body.fill([look(42)]);
  await body.handled();
  expect(await shown()).toBe("16°");
  expect(body.sent()).toBe(JSON.stringify({ tiltDeg: 16 }));
});

test("a preview setting waits while the captain types in the preview, then shows once typing stops", async () => {
  const body = await preview(dial(true), null);
  await commands.evaluateInFrame(
    FRAME,
    (() => (document.getElementById("label") as HTMLInputElement).focus()).toString(),
    null,
  );
  const typing = () =>
    commands.evaluateInFrame(FRAME, (() => document.hasFocus()).toString(), null);
  expect(await typing()).toBe(true);
  body.fill([look(42)]);
  await body.handled();
  expect(await shown()).toBe("16°");
  await commands.evaluateInFrame(
    FRAME,
    (() => (document.getElementById("tilt") as HTMLInputElement).focus()).toString(),
    null,
  );
  await expect.poll(shown).toBe("42°");
});
