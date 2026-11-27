import { FRAME_BRIDGE_VERSION } from "@shared/plugins/bridge";
import { frameCsp } from "@shared/plugins/containment";
import { buildFrameDocument } from "@shared/plugins/frameDocument";
import { expect, test } from "vitest";
import { commands } from "vitest/browser";

/**
 * An address a card body writes as words is a link (INF-7045, the captain:
 * "make sure all https urls in card bodies are clickable", after a Secrets
 * ask whose step "Open https://openrouter.ai/settings/keys and sign in."
 * showed the address as plain text). The body goes through the real bridge
 * script and frame document in a sandboxed frame, and the test plays the host
 * as a card's mount does: it answers `ready` with `keys` saying `addresses`,
 * then `tasks` naming a recorded task, and records what the frame posts. A panel's mount says no `addresses`, and
 * its words stay as written.
 */

const STEP = "Open https://openrouter.ai/settings/keys and sign in.";

const BODY = `
  <ol><li id="step">${STEP}</li></ol>
  <p id="tracked">Tracked at https://acme.atlassian.net/browse/INF-12 as INF-12.</p>
  <p>Run <code>curl https://openrouter.ai/api/v1/models</code> (see https://en.wikipedia.org/wiki/API_(disambiguation)).</p>
  <form><fieldset><legend>1. Which model?</legend>
    <label><input type="radio" name="model" value="neon"> Neon, listed at https://openrouter.ai/neon</label>
  </fieldset></form>
  <p>
    <a href="https://openrouter.ai/docs">https://openrouter.ai/docs</a>
    <button type="button">https://openrouter.ai/button</button>
    <details><summary>https://openrouter.ai/summary</summary>Folded</details>
    <svg viewBox="0 0 10 10"><text>https://openrouter.ai/drawing</text></svg>
    Public http://openrouter.ai/plain and openrouter.ai/bare stay words; http://localhost:5173/ opens here.
  </p>
  <p id="late"></p>`;

const LATE_WORDS =
  "setTimeout(function(){document.getElementById('late').textContent='Later: https://openrouter.ai/activity'},50);";

/** The content policy's hash of an inline script, as the host allows a card's own script. */
async function scriptHash(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

type Heard = { type: string; href?: string };

/** Mounts the body in a frame named `name`, the host saying `addresses` or not, and answers what the frame posts. */
async function mount(name: string, addresses: boolean): Promise<Heard[]> {
  const frameDocument = buildFrameDocument({
    csp: frameCsp([await scriptHash(LATE_WORDS)]),
    theme: "dark",
    style: "body{font:14px sans-serif;color:#ddd;background:#111}",
    html: BODY,
    script: LATE_WORDS,
  });
  const frame = document.createElement("iframe");
  frame.name = name;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "width:600px;height:400px;border:0";
  const heard: Heard[] = [];
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as Heard & { document?: unknown };
    heard.push(data);
    if (data.type !== "ready") return;
    frame.contentWindow?.postMessage(
      {
        fm: FRAME_BRIDGE_VERSION,
        type: "keys",
        pictures: true,
        escape: false,
        ...(addresses ? { addresses: true } : {}),
      },
      "*",
    );
    frame.contentWindow?.postMessage(
      { fm: FRAME_BRIDGE_VERSION, type: "tasks", keys: ["INF-12"] },
      "*",
    );
    frame.contentWindow?.postMessage(
      { fm: FRAME_BRIDGE_VERSION, type: "initialize", document: data.document },
      "*",
    );
  });
  frame.srcdoc = frameDocument;
  document.body.replaceChildren(frame);
  return heard;
}

/** Runs `read`, which closes over nothing, inside the frame named `name`. */
function inFrame<T>(name: string, read: () => T): Promise<T> {
  return commands.evaluateInFrame(name, read.toString()) as Promise<T>;
}

/** Each address the bridge linked, by its href and words, in the body's order. */
function linked(name: string) {
  return inFrame(name, () =>
    [...document.querySelectorAll("a[data-inf-address]")].map((link) => ({
      href: link.getAttribute("href"),
      words: link.textContent,
    })),
  );
}

test("a card body's addresses written as words become links whose press posts the address", async () => {
  const heard = await mount("addresses-card", true);
  const address = (href: string) => ({ href, words: href });
  await expect
    .poll(() => linked("addresses-card"))
    .toEqual([
      address("https://openrouter.ai/settings/keys"),
      address("https://acme.atlassian.net/browse/INF-12"),
      address("https://openrouter.ai/api/v1/models"),
      address("https://en.wikipedia.org/wiki/API_(disambiguation)"),
      address("https://openrouter.ai/neon"),
      address("http://localhost:5173/"),
      address("https://openrouter.ai/activity"),
    ]);
  // Linking moves no words: the step reads as written, its period outside the link.
  expect(
    await inFrame("addresses-card", () => {
      const step = document.getElementById("step");
      return { text: step?.textContent, after: step?.querySelector("a")?.nextSibling?.nodeValue };
    }),
  ).toEqual({ text: STEP, after: " and sign in." });
  // A recorded task's key inside an address stays part of it; the key in the words beside it links to the task.
  expect(
    await inFrame("addresses-card", () =>
      [...document.querySelectorAll("#tracked a[data-inf-task]")].map((key) => key.textContent),
    ),
  ).toEqual(["INF-12"]);

  // A press on the step's address posts it as the host's link message.
  await inFrame("addresses-card", () =>
    document.querySelector<HTMLElement>('a[href="https://openrouter.ai/settings/keys"]')?.click(),
  );
  // A press on the address in a choice's label opens it and leaves the choice unpicked.
  const picked = await inFrame("addresses-card", () => {
    document.querySelector<HTMLElement>("label a[data-inf-address]")?.click();
    return document.querySelector<HTMLInputElement>('input[name="model"]')?.checked;
  });
  expect(picked).toBe(false);
  // One more trip into the frame gives a message a click posted time to reach the host.
  await inFrame("addresses-card", () => new Promise((done) => requestAnimationFrame(done)));
  expect(heard.filter((message) => message.type === "link").map((message) => message.href)).toEqual(
    ["https://openrouter.ai/settings/keys", "https://openrouter.ai/neon"],
  );
});

test("a panel's mount, which says no addresses, leaves its addresses as words", async () => {
  await mount("addresses-panel", false);
  await expect
    .poll(() =>
      inFrame("addresses-panel", () => document.getElementById("late")?.textContent ?? ""),
    )
    .toContain("https://openrouter.ai/activity");
  expect(await linked("addresses-panel")).toEqual([]);
});
