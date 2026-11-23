import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CrewmateBrowser, TaskBrowsers } from "../../src/core/browser/taskBrowsers";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { measured } from "./perf";
import { closeSite } from "./taskBrowser";

/**
 * A crewmate's browser on a page whose form sits in a frame from another
 * site (docs/task-browser.md, "Frames" and "A passkey request"): the shop's
 * page is served by `localhost`, its payment frame by `127.0.0.1`, two
 * sites, so the browser runs the frame apart from the page, as a payment
 * provider's frame runs on a real shop.
 */

const shop = (framePort: number) =>
  // biome-ignore lint/plugin/e2e-frame-door: the site's own frame is this journey's subject, read by the crewmate's browser, never by the spec.
  `<!doctype html><title>Shop</title>
<style>body{font:18px sans-serif;padding:20px}iframe{width:520px;height:300px;border:2px solid #888}</style>
<h1>Checkout</h1><p id="focus">waiting</p>
<iframe title="Card payment" src="http://127.0.0.1:${framePort}/pay"></iframe>
<script>document.getElementById('focus').textContent = 'In front: ' + document.hasFocus();</script>`;

/**
 * The payment provider's frame: a form that answers what it was sent, and
 * a passkey sign-in that races the browser's answer against a second on
 * the frame's own clock and says which came first.
 */
const PAY = `<!doctype html><title>Pay</title>
<style>body{font:18px sans-serif;margin:12px}input,button{font:inherit}</style>
<form id="card"><label>Name on card <input id="name" name="name"></label>
<button>Pay now</button></form><p id="sent">Nothing sent</p>
<button id="passkey" type="button">Sign in with a passkey</button><p id="passkeyAnswer">No passkey asked</p>
<script>
document.getElementById('card').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('sent').textContent = 'Sent for ' + document.getElementById('name').value;
});
document.getElementById('passkey').addEventListener('click', () => {
  const started = performance.now();
  const second = new Promise((done) => setTimeout(() => done('the second passed first'), 1000));
  const asked = navigator.credentials
    .get({ publicKey: { challenge: new Uint8Array(32), timeout: 600000 } })
    .then(() => 'a passkey', (error) => error.name);
  Promise.race([asked, second]).then((first) => {
    const took = Math.round(performance.now() - started);
    document.getElementById('passkeyAnswer').textContent = 'Passkey answer: ' + first + ' after ' + took + ' ms';
  });
});
</script>`;

// This journey drives the real core delegate and Electron host inside the
// hermetic launcher; the small bundle is test-only, as in
// task-browser-actions.spec.ts.
test("a crewmate fills a form in a frame from another site, and a passkey request ends at once", async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(120_000);
  const dir = scratchDir("infinitary-browser-frames-");
  const require = createRequire(import.meta.url);
  const fromVite = createRequire(require.resolve("vite"));
  const { build } = fromVite("esbuild") as { build: (options: unknown) => Promise<unknown> };
  const bundle = join(dir, "probe.cjs");
  await build({
    stdin: {
      contents: `export { TaskBrowsers } from './src/core/browser/taskBrowsers'; export { createTaskBrowserHost } from './src/main/host/taskBrowser';`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    tsconfig: "tsconfig.node.json",
    outfile: bundle,
  });
  const framed = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(PAY);
  });
  await new Promise<void>((done) => framed.listen(0, "127.0.0.1", done));
  const frameAddress = framed.address();
  if (!frameAddress || typeof frameAddress === "string") throw new Error("no frame address");
  const site = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(shop(frameAddress.port));
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const siteAddress = site.address();
  if (!siteAddress || typeof siteAddress === "string") throw new Error("no site address");
  const frameUrl = `http://127.0.0.1:${frameAddress.port}/pay`;
  const shopUrl = `http://localhost:${siteAddress.port}/`;
  const launched = await launchApp();
  const transcript: string[] = [];
  try {
    await launched.app.evaluate(
      async ({ app }, input) => {
        const { createRequire } = process.getBuiltinModule("node:module");
        const require = createRequire(`${app.getAppPath()}/package.json`);
        const { TaskBrowsers, createTaskBrowserHost } = require(input.bundle);
        (globalThis as typeof globalThis & { __framesProbe: TaskBrowsers }).__framesProbe =
          new TaskBrowsers({ host: createTaskBrowserHost(), evidenceDir: () => input.dir });
      },
      { bundle, dir },
    );
    const call = async (method: keyof CrewmateBrowser, input: unknown = {}) => {
      const result = await launched.app.evaluate(
        async (_electron, args) => {
          const probe = (globalThis as typeof globalThis & { __framesProbe: TaskBrowsers })
            .__framesProbe;
          const driver = probe.forTask("frames");
          const invoke = driver[args.method] as (input: unknown) => Promise<{ text: string }>;
          return invoke(args.input);
        },
        { method, input },
      );
      transcript.push(`${method} ${JSON.stringify(input)}\n${result.text}`);
      return result as { text: string };
    };
    let outline = "";
    const ref = (name: string) => {
      const found = outline
        .split("\n")
        .find((line) => line.includes(`"${name}"`))
        ?.match(/\[(g\d+:e\d+)\]/)?.[1];
      if (!found) throw new Error(`No ref for ${name}: ${outline}`);
      return found;
    };
    // The crewmate opens the frame's site first, so the page may load it as a frame.
    await call("navigate", { url: frameUrl });
    await call("navigate", { url: shopUrl });
    // The frame's document reads under a line naming its site, its controls with refs.
    await expect
      .poll(async () => {
        outline = (await call("inspect")).text;
        return outline;
      })
      .toContain('button "Pay now"');
    expect(outline).toMatch(
      new RegExp(`frame "Card payment" from 127\\.0\\.0\\.1:${frameAddress.port}`),
    );
    // Inside the frame's line, under its form.
    expect(outline).toMatch(/^ {4}textbox "Name on card" \[g\d+:e\d+\]/m);
    // The frame's title names the frame, not each line inside it.
    expect(outline).not.toContain('(title: "Card payment")');
    // The page believes it is in front, though its window is hidden.
    expect(outline).toContain("In front: true");
    await call("act", {
      action: "type",
      ref: ref("Name on card"),
      text: "Ada Lovelace",
      submit: true,
    });
    await expect
      .poll(async () => {
        outline = (await call("inspect")).text;
        return outline;
      })
      .toContain("Sent for Ada Lovelace");
    // A passkey request inside the frame ends before a second has passed on
    // the frame's own clock, as not allowed, and the crewmate is told.
    await call("act", { action: "click", ref: ref("Sign in with a passkey") });
    await expect
      .poll(async () => {
        outline = (await call("inspect")).text;
        return outline;
      })
      .toContain("Passkey answer: NotAllowedError after");
    const took = Number(outline.match(/Passkey answer: NotAllowedError after (\d+) ms/)?.[1]);
    measured("passkey request ends", [took], 1000);
    expect(transcript.join("\n")).toContain(
      `127.0.0.1:${frameAddress.port}: it asked for a passkey, which this browser does not have, so it told the site at once that none is available.`,
    );
    await call("capture", { name: "frames-after" });
    await call("close");
  } finally {
    writeFileSync(info.outputPath("frames-transcript.txt"), transcript.join("\n\n"));
    if (process.env.FM_FRAMES_EVIDENCE)
      writeFileSync(
        join(process.env.FM_FRAMES_EVIDENCE, "frames-transcript.txt"),
        transcript.join("\n\n"),
      );
    await launched.app.evaluate(() =>
      (globalThis as typeof globalThis & { __framesProbe: TaskBrowsers }).__framesProbe.closeAll(),
    );
    await launched.close();
    await closeSite(site);
    await closeSite(framed);
  }
});
