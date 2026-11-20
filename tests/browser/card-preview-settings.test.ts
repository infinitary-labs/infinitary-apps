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
 * body's birth move the preview's own dial and reading, and a press sends
 * what the dial shows; a preview that gives no way to apply a setting, or
 * refuses or fails on one, keeps what it shows and sends; and words the
 * captain types in the preview stay theirs.
 */

const FRAME = "preview-settings-card";

const BODY = `
  <p>A glass dial; drag the tilt to try another angle.</p>
  <label>Tilt in degrees <input id="tilt" type="range" min="0" max="90" value="16"></label>
  <output id="reading">16°</output>
  <label>Label on the dial <input id="label" type="text"></label>`;

/**
 * The dial's own script: it stages its tilt and label, the label only once
 * the captain leaves its field, and gives the bridge `apply` to set both;
 * none, or one that throws, as `applies` says.
 */
const dial = (applies: "sets" | "none" | "throws") => `const tilt = document.getElementById("tilt");
const label = document.getElementById("label");
const apply = ${
  applies === "sets"
    ? `function (look) { tilt.value = String(look.tiltDeg); label.value = look.label; stage(); }`
    : applies === "throws"
      ? `function () { throw new Error("This preview no longer knows that setting"); }`
      : "undefined"
};
function stage() {
  document.getElementById("reading").textContent = tilt.value + "°";
  inf.stage("look", { tiltDeg: Number(tilt.value), label: label.value }, apply);
}
tilt.oninput = stage;
label.onchange = stage;
stage();`;

const look = (tiltDeg: number, label = ""): FrameAnswer => ({
  name: "look",
  values: [JSON.stringify({ tiltDeg, label })],
  changed: true,
  json: true,
});

const inFrame = <A = null>(run: (argument: A) => unknown, argument: A | null = null) =>
  commands.evaluateInFrame(FRAME, run.toString(), argument);

type Heard = { type: string; seq?: number; answers?: FrameAnswer[] };

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
  /** What a press of the card sends of the setting, as the host collects it at a press. */
  const press = async () => {
    const seq = Math.random();
    post({ type: "collect", seq, focusUnpicked: false });
    await expect
      .poll(() => heard.some((message) => message.type === "answers" && message.seq === seq))
      .toBe(true);
    const answers = heard.find((message) => message.type === "answers" && message.seq === seq);
    const value = answers?.answers?.find((answer) => answer.name === "look")?.values[0];
    return value ? (JSON.parse(value) as { tiltDeg: number; label: string }) : null;
  };
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
  return { press, handled, fill: (answers: FrameAnswer[]) => post({ type: "fill", answers }) };
}

test("another window's preview setting moves the preview's own controls, and a press sends what it shows", async () => {
  const body = await preview(dial("sets"), null);
  expect(await shown()).toBe("16°");
  body.fill([look(42, "North")]);
  await expect.poll(shown).toBe("42°");
  expect(await body.press()).toEqual({ tiltDeg: 42, label: "North" });
});

test("a setting restored at the preview's birth shows on its dial and is what a press sends", async () => {
  const body = await preview(dial("sets"), [look(70)]);
  await expect.poll(shown).toBe("70°");
  expect(await body.press()).toEqual({ tiltDeg: 70, label: "" });
});

test("a preview that gives no way to apply a setting, or fails on one, keeps what it shows and sends", async () => {
  for (const applies of ["none", "throws"] as const) {
    const body = await preview(dial(applies), [look(70)]);
    body.fill([look(42)]);
    await body.handled();
    expect(await shown()).toBe("16°");
    expect(await body.press()).toEqual({ tiltDeg: 16, label: "" });
  }
});

test("a preview setting waits while the captain types in the preview, and words typed after it arrived stay theirs", async () => {
  const body = await preview(dial("sets"), null);
  await inFrame(() => (document.getElementById("label") as HTMLInputElement).focus());
  expect(await inFrame(() => document.hasFocus())).toBe(true);
  const type = (words: string) =>
    inFrame((typed: string) => {
      const label = document.getElementById("label") as HTMLInputElement;
      label.value += typed;
      label.dispatchEvent(new Event("input", { bubbles: true }));
    }, words);
  await type("Sou");
  body.fill([look(42, "From the other window")]);
  await body.handled();
  expect(await shown()).toBe("16°");
  // Still typing after the setting arrived; the preview stages the label only on leaving it.
  await type("th");
  await inFrame(() => (document.getElementById("tilt") as HTMLInputElement).focus());
  await body.handled();
  expect(await inFrame(() => (document.getElementById("label") as HTMLInputElement).value)).toBe(
    "South",
  );
  expect(await shown()).toBe("16°");
  // The preview stages the words it now holds, as a field's change on leaving it does.
  await inFrame(() =>
    document.getElementById("label")?.dispatchEvent(new Event("change", { bubbles: true })),
  );
  expect(await body.press()).toEqual({ tiltDeg: 16, label: "South" });
});

test("a preview setting that waited shows once the captain leaves the preview's field without typing more", async () => {
  const body = await preview(dial("sets"), null);
  await inFrame(() => (document.getElementById("label") as HTMLInputElement).focus());
  body.fill([look(42, "North")]);
  await body.handled();
  expect(await shown()).toBe("16°");
  await inFrame(() => (document.getElementById("tilt") as HTMLInputElement).focus());
  await expect.poll(shown).toBe("42°");
  expect(await body.press()).toEqual({ tiltDeg: 42, label: "North" });
});
