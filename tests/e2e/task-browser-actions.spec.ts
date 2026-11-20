import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { CrewmateBrowser, TaskBrowsers } from "../../src/core/browser/taskBrowsers";
import { TASK_BROWSER_PAGE } from "../../src/shared/taskBrowser";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { closeSite, pageSays } from "./taskBrowser";

const SITE = `<!doctype html><title>Browser actions</title>
<style>body{font:20px sans-serif;padding:24px}button,input{font:inherit}#menu{display:none}#hover:hover+#menu{display:block}#source,#target{display:inline-block;padding:30px;border:2px solid;margin:20px}#pad{height:1800px}</style>
<h1>Browser actions</h1><button id="hover">Show menu</button><p id="menu">Menu opened</p>
<label>Name <input id="name"></label><label>City <input id="city"></label>
<button id="source">Drag item</button><button id="target">Drop here</button><p id="result">Not dropped</p>
<div id="pad"></div><button id="bottom">End of page</button>
<script>let down=false;source.onpointerdown=e=>{down=e.isTrusted};target.onpointerup=e=>{if(down&&e.isTrusted)result.textContent='Dropped with real input';down=false};if(location.search==='?native'){source.draggable=true;target.ondragover=e=>e.preventDefault();target.ondrop=e=>{e.preventDefault();if(e.isTrusted)result.textContent='Dropped with native drag'};}</script>`;

// This journey exercises the real core delegate and Electron host inside the
// hermetic launcher, not a stand-in. The small bundle is test-only and gives
// the test no new production IPC or model tool.
test("guarded browser actions use real input and photograph one element", async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(120_000);
  const dir = scratchDir("infinitary-browser-actions-");
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
  const server = createServer((_req, res) => res.end(SITE));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no site address");
  const url = `http://127.0.0.1:${address.port}/`;
  const launched = await launchApp();
  const transcript: string[] = [];
  const evidence = process.env.FM_ACTION_EVIDENCE ?? info.outputPath("pictures");
  try {
    await launched.app.evaluate(
      async ({ app }, input) => {
        const { createRequire } = process.getBuiltinModule("node:module");
        const require = createRequire(`${app.getAppPath()}/package.json`);
        const { TaskBrowsers, createTaskBrowserHost } = require(input.bundle);
        (globalThis as typeof globalThis & { __actionProbe: TaskBrowsers }).__actionProbe =
          new TaskBrowsers({
            host: createTaskBrowserHost(),
            evidenceDir: () => input.evidence,
          });
      },
      { bundle, evidence: resolve(evidence) },
    );
    const call = async (method: keyof CrewmateBrowser, input: unknown = {}) => {
      const result = await launched.app.evaluate(
        async (_electron, args) => {
          const probe = (globalThis as typeof globalThis & { __actionProbe: TaskBrowsers })
            .__actionProbe;
          const driver = probe.forTask("actions");
          const invoke = driver[args.method] as (input: unknown) => Promise<{ text: string }>;
          return invoke(args.input);
        },
        { method, input },
      );
      transcript.push(`${method} ${JSON.stringify(input)}\n${result.text}`);
      return result as { text: string };
    };
    let outline = (await call("navigate", { url })).text;
    const ref = (name: string) => {
      const found = outline
        .split("\n")
        .find((line) => line.includes(`"${name}"`))
        ?.match(/\[(g\d+:e\d+)\]/)?.[1];
      if (!found) throw new Error(`No ref for ${name}: ${outline}`);
      return found;
    };
    await call("capture", { name: "actions-initial" });
    await call("act", { action: "hover", ref: ref("Show menu") });
    expect(await pageSays(launched.app, url, "menu")).toBe("Menu opened");
    outline = (await call("inspect")).text;
    expect(outline).toContain("Menu opened");
    await call("capture", { name: "hover-after" });
    await call("act", {
      action: "fill",
      fields: [
        { ref: ref("Name"), text: "Ada" },
        { ref: ref("City"), text: "Paris" },
      ],
    });
    expect(await pageSays(launched.app, url, "name", "value")).toBe("Ada");
    expect(await pageSays(launched.app, url, "city", "value")).toBe("Paris");
    await call("act", { action: "drag", ref: ref("Drag item"), to: ref("Drop here") });
    expect(await pageSays(launched.app, url, "result")).toBe("Dropped with real input");
    await call("capture", { name: "actions-after" });
    const picture = await call("capture", { name: "element-after", ref: ref("Drop here") });
    expect(picture.text).toContain("Saved");
    const png = readFileSync(join(evidence, "element-after.png"));
    // PNG dimensions demonstrate a crop, not the page-sized photograph.
    expect(png.readUInt32BE(16)).toBeGreaterThan(0);
    expect(png.readUInt32BE(16)).toBeLessThan(TASK_BROWSER_PAGE.width);
    const bottom = (await call("act", { action: "scroll", direction: "bottom" })).text;
    expect(bottom).toContain("End of page");
    expect(bottom).not.toContain('button "Show menu"');
    await call("capture", { name: "bottom-after" });
    const top = (await call("act", { action: "scroll", direction: "top" })).text;
    expect(top).toContain('button "Show menu"');
    expect(top).not.toContain('button "End of page"');
    await call("capture", { name: "top-after" });
    outline = (await call("navigate", { url: `${url}?native` })).text;
    await call("act", { action: "drag", ref: ref("Drag item"), to: ref("Drop here") });
    expect(await pageSays(launched.app, url, "result")).toBe("Dropped with native drag");
    const stale = ref("Name");
    outline = (await call("navigate", { url: `${url}?new-page` })).text;
    expect(
      (
        await call("act", {
          action: "fill",
          fields: [
            { ref: ref("City"), text: "Changed" },
            { ref: stale, text: "wrong" },
          ],
        })
      ).text,
    ).toContain("ref");
    expect(await pageSays(launched.app, url, "city", "value")).toBe("");
    await call("close");
  } finally {
    writeFileSync(info.outputPath("actions-transcript.txt"), transcript.join("\n\n"));
    if (process.env.FM_ACTION_EVIDENCE)
      writeFileSync(join(evidence, "after-transcript.txt"), transcript.join("\n\n"));
    await launched.app.evaluate(() =>
      (globalThis as typeof globalThis & { __actionProbe: TaskBrowsers }).__actionProbe.closeAll(),
    );
    await launched.close();
    await closeSite(server);
  }
});
