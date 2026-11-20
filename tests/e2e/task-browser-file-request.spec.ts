import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CrewmateBrowser, TaskBrowsers } from "../../src/core/browser/taskBrowsers";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { closeSite, pageSays } from "./taskBrowser";

// A filing site like the one in INB-26: its file field is hidden behind a
// "Select files..." button, and it offers printing and a color field.
const SITE = `<!doctype html><title>Filing</title>
<style>body{font:20px sans-serif;margin:0}button,input{font:inherit;position:absolute;left:20px;width:220px;height:40px}</style>
<input type="file" id="file" style="display:none">
<button id="pick" style="top:20px" onclick="file.click()">Select files...</button>
<button id="print" style="top:80px" onclick="window.print();printed.textContent='Print answered'">Print receipt</button>
<input type="color" id="color" aria-label="Seal color" style="top:140px">
<p id="chosen" style="margin-top:220px">No file</p><p id="printed">Not printed</p><p id="picker">No picker</p>
<script>file.onchange=()=>{chosen.textContent=[...file.files].map(f=>f.name+' '+f.size).join(', ')||'No file'};
color.addEventListener('click',e=>setTimeout(()=>{picker.textContent=e.defaultPrevented?'Picker refused':'Picker opened'}))</script>`;

// The captain's words (INF-1454, INF task 86922ffe): "shouldn't task browser
// be invisible on my desktop?", and their choice that the crewmate attaches a
// file from its own working copy. This journey runs the real core and the
// real Electron host in the hermetic launcher; the captain's picker is the
// one stand-in, since a real one would wait for a person.
test("a page's file request never shows its window: the crewmate attaches from its working copy and the captain from the app's picker", async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(120_000);
  const dir = scratchDir("infinitary-browser-files-");
  const workingCopy = join(dir, "work");
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(workingCopy);
  mkdirSync(elsewhere);
  writeFileSync(join(workingCopy, "certificate.pdf"), "%PDF-1.4 certificate");
  writeFileSync(join(elsewhere, "private.txt"), "not the task's");
  symlinkSync(join(elsewhere, "private.txt"), join(workingCopy, "link.txt"));
  const captainFile = join(elsewhere, "captain-receipt.pdf");
  writeFileSync(captainFile, "%PDF-1.4 the captain's own");
  const require = createRequire(import.meta.url);
  const fromVite = createRequire(require.resolve("vite"));
  const { build } = fromVite("esbuild") as { build: (options: unknown) => Promise<unknown> };
  const bundle = join(dir, "probe.cjs");
  await build({
    stdin: {
      contents: `export { TaskBrowsers } from './src/core/browser/taskBrowsers'; export { createTaskBrowserHost, isTaskBrowserWindow } from './src/main/host/taskBrowser';`,
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
  const server = createServer((_req, res) => res.end(SITE));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no site address");
  const url = `http://127.0.0.1:${address.port}/`;
  const launched = await launchApp();
  const transcript: string[] = [];
  type Probe = { browsers: TaskBrowsers; picks: number; shown: () => Promise<number> };
  try {
    await launched.app.evaluate(
      async ({ app, BrowserWindow }, input) => {
        const { createRequire } = process.getBuiltinModule("node:module");
        const require = createRequire(`${app.getAppPath()}/package.json`);
        const { TaskBrowsers, createTaskBrowserHost, isTaskBrowserWindow } = require(input.bundle);
        const probe: Probe = {
          picks: 0,
          // Every task page's window that is on the desktop: none, ever. On
          // the Chrome engine, a Chrome window that is not in the Dock.
          shown: async () => {
            type Reading = { shown: () => Promise<boolean> };
            const engines = (
              globalThis as Record<symbol, Set<{ pages: () => Reading[] }> | undefined>
            )[Symbol.for("infinitary.taskBrowser.chromeEngines")];
            const inChrome = await Promise.all(
              [...(engines ?? [])].flatMap((engine) => engine.pages().map((page) => page.shown())),
            );
            return (
              BrowserWindow.getAllWindows().filter(
                (win: Electron.BrowserWindow) => isTaskBrowserWindow(win) && win.isVisible(),
              ).length + inChrome.filter(Boolean).length
            );
          },
          browsers: new TaskBrowsers({
            host: createTaskBrowserHost(async () => {
              probe.picks += 1;
              return [input.captainFile];
            }),
            evidenceDir: () => input.evidence,
            workingCopy: () => input.workingCopy,
          }),
        };
        (globalThis as typeof globalThis & { __filesProbe: Probe }).__filesProbe = probe;
      },
      { bundle, evidence: process.env.FM_FILES_EVIDENCE ?? dir, workingCopy, captainFile },
    );
    const call = async (method: keyof CrewmateBrowser, input: unknown = {}) => {
      const result = await launched.app.evaluate(
        async (_electron, args) => {
          const probe = (globalThis as typeof globalThis & { __filesProbe: Probe }).__filesProbe;
          const driver = probe.browsers.forTask("files");
          const invoke = driver[args.method] as (input: unknown) => Promise<{ text: string }>;
          return invoke(args.input);
        },
        { method, input },
      );
      transcript.push(`${method} ${JSON.stringify(input)}\n${result.text}`);
      return result as { text: string };
    };
    const shown = () =>
      launched.app.evaluate(() =>
        (globalThis as typeof globalThis & { __filesProbe: Probe }).__filesProbe.shown(),
      );
    const outline = (await call("navigate", { url })).text;
    const ref = (name: string) => {
      const found = outline
        .split("\n")
        .find((line) => line.includes(`"${name}"`))
        ?.match(/\[(g\d+:e\d+)\]/)?.[1];
      if (!found) throw new Error(`No ref for ${name}: ${outline}`);
      return found;
    };

    // The crewmate presses the site's own file button: the page asks for a
    // file, no picker of the Mac's opens and the page's window stays hidden.
    const asked = (await call("act", { action: "click", ref: ref("Select files...") })).text;
    expect(asked).toContain("The page asks for a file");
    expect(await shown()).toBe(0);
    // Only a file inside its working copy, never one a link leads out to.
    expect(
      (await call("act", { action: "upload", files: [join(elsewhere, "private.txt")] })).text,
    ).toContain("not in your working copy");
    expect((await call("act", { action: "upload", files: ["link.txt"] })).text).toContain(
      "not in your working copy",
    );
    expect(await pageSays(launched.app, url, "chosen")).toBe("No file");
    const attached = (await call("act", { action: "upload", files: ["certificate.pdf"] })).text;
    expect(attached).toContain('Attached "certificate.pdf"');
    expect(await pageSays(launched.app, url, "chosen")).toBe("certificate.pdf 20");
    if (process.env.FM_FILES_EVIDENCE) await call("capture", { name: "file-attached" });

    // Printing opens nothing of the Mac's either, and the page goes on:
    // printing would otherwise hold the whole app.
    const printed = (await call("act", { action: "click", ref: ref("Print receipt") })).text;
    expect(printed).toContain("this browser never prints");
    expect(await pageSays(launched.app, url, "printed")).toBe("Print answered");
    expect(await shown()).toBe(0);

    // The captain holds the page and presses the same button: the app's own
    // picker answers, and the page's window still stays hidden. Their press
    // on the color field opens no picker of the Mac's.
    const took = await launched.app.evaluate(() =>
      (globalThis as typeof globalThis & { __filesProbe: Probe }).__filesProbe.browsers.takeControl(
        "files",
      ),
    );
    expect(took).toEqual({ ok: true });
    const press = async (y: number) => {
      for (const type of ["down", "up"] as const) {
        await launched.app.evaluate(
          (_electron, at) =>
            (
              globalThis as typeof globalThis & { __filesProbe: Probe }
            ).__filesProbe.browsers.captainInput("files", {
              kind: "pointer",
              type: at.type,
              x: 60,
              y: at.y,
              button: "left",
              clickCount: 1,
              modifiers: 0,
            }),
          { type, y },
        );
      }
    };
    await press(40);
    await expect.poll(() => pageSays(launched.app, url, "chosen")).toBe("captain-receipt.pdf 26");
    expect(
      await launched.app.evaluate(
        () => (globalThis as typeof globalThis & { __filesProbe: Probe }).__filesProbe.picks,
      ),
    ).toBe(1);
    await press(160);
    await expect.poll(() => pageSays(launched.app, url, "picker")).toBe("Picker refused");
    expect(await shown()).toBe(0);
  } finally {
    writeFileSync(info.outputPath("files-transcript.txt"), transcript.join("\n\n"));
    if (process.env.FM_FILES_EVIDENCE)
      writeFileSync(join(process.env.FM_FILES_EVIDENCE, "transcript.txt"), transcript.join("\n\n"));
    await launched.app.evaluate(() =>
      (globalThis as typeof globalThis & { __filesProbe: Probe }).__filesProbe.browsers.closeAll(),
    );
    await launched.close();
    await closeSite(server);
  }
});
