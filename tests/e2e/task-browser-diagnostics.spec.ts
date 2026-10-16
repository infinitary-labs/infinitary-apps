import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { CrewmateBrowser, TaskBrowsers } from "../../src/core/browser/taskBrowsers";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { closeSite } from "./taskBrowser";

const SITE = `<!doctype html><title>Diagnostics fixture</title><h1>Diagnostics fixture</h1>
<button onclick="console.info('visible diagnostic');console.warn('warning diagnostic');Promise.all([fetch('/result?token=query-secret#fragment-secret'),fetch('/failed').catch(()=>{})]).then(()=>console.log('request finished'));setTimeout(()=>{throw new Error('uncaught diagnostic')},0)">Generate diagnostics</button>`;

// Real task-browser core and Electron host, isolated by the standard launcher.
test("crewmates read guarded console and network lists", async ({ browserName }, info) => {
  void browserName;
  test.setTimeout(120_000);
  const dir = scratchDir("infinitary-browser-diagnostics-");
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
  const server = createServer((req, res) => {
    if (req.url === "/failed") {
      req.socket.destroy();
      return;
    }
    if (req.url?.startsWith("/result")) {
      res.writeHead(503);
      res.end("body-secret");
    } else res.end(SITE);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no site address");
  const url = `http://127.0.0.1:${address.port}/`;
  const launched = await launchApp();
  const evidence = resolve(process.env.FM_DIAGNOSTICS_EVIDENCE ?? info.outputPath("evidence"));
  mkdirSync(evidence, { recursive: true });
  const transcript: string[] = [];
  try {
    await launched.app.evaluate(
      async ({ app }, input) => {
        const { createRequire } = process.getBuiltinModule("node:module");
        const require = createRequire(`${app.getAppPath()}/package.json`);
        const { TaskBrowsers, createTaskBrowserHost } = require(input.bundle);
        (globalThis as typeof globalThis & { __diagnosticProbe: TaskBrowsers }).__diagnosticProbe =
          new TaskBrowsers({ host: createTaskBrowserHost(), evidenceDir: () => input.evidence });
      },
      { bundle, evidence },
    );
    const call = async (method: keyof CrewmateBrowser, input: unknown = {}) => {
      const result = await launched.app.evaluate(
        async (_electron, args) => {
          const probe = (globalThis as typeof globalThis & { __diagnosticProbe: TaskBrowsers })
            .__diagnosticProbe;
          const invoke = probe.forTask("diagnostics")[args.method] as (
            input: unknown,
          ) => Promise<{ text: string }>;
          return invoke(args.input);
        },
        { method, input },
      );
      transcript.push(`${method} ${JSON.stringify(input)}\n${result.text}`);
      return result.text;
    };
    const opened = await call("navigate", { url });
    const ref = opened.match(/button .*\[(g\d+:e\d+)\]/)?.[1];
    expect(ref).toBeTruthy();
    await call("act", { action: "click", ref });
    await expect.poll(() => call("inspect", { show: "console" })).toContain("request finished");
    const console = await call("inspect", { show: "console" });
    expect(console).toContain("info: visible diagnostic");
    expect(console).toContain("warning: warning diagnostic");
    expect(console).toContain("uncaught diagnostic");
    expect(console).not.toContain("outline:");
    const network = await call("inspect", { show: "network" });
    expect(network).toContain(`${url}result (Fetch; status 503)`);
    expect(network).toContain(`${url}failed (Fetch; failed)`);
    for (const secret of ["query-secret", "fragment-secret", "body-secret"])
      expect(network).not.toContain(secret);
    // A handoff drops both buffers. Activity during captain control is not retained.
    await launched.app.evaluate(async () => {
      const probe = (globalThis as typeof globalThis & { __diagnosticProbe: TaskBrowsers })
        .__diagnosticProbe;
      await probe.takeControl("diagnostics");
    });
    expect(await call("inspect", { show: "console" })).toContain("captain has control");
    await launched.app.evaluate(async ({ webContents }) => {
      const probe = (globalThis as typeof globalThis & { __diagnosticProbe: TaskBrowsers })
        .__diagnosticProbe;
      const page = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith("http://127.0.0.1:"));
      await page?.executeJavaScript(
        "console.error('captain-secret');fetch('/result?captain-secret').then(()=>console.log('captain-done'))",
      );
      await probe.returnControl("diagnostics", { session: probe.session, generation: 1 });
      await page?.executeJavaScript("console.error('returned-secret')");
    });
    const hidden = await call("inspect", { show: "console" });
    expect(hidden).toContain("error: 1");
    for (const secret of [
      "captain-secret",
      "captain-done",
      "returned-secret",
      "visible diagnostic",
    ])
      expect(hidden).not.toContain(secret);
    expect(await call("inspect", { show: "network" })).toContain("0 requests; 0 kept");
    await call("close");
    await call("navigate", { url });
    const restarted = await call("inspect", { show: "console" });
    // A fresh page may log new browser warnings, but no old page message survives.
    for (const old of [
      "visible diagnostic",
      "warning diagnostic",
      "request finished",
      "returned-secret",
    ])
      expect(restarted).not.toContain(old);
  } finally {
    writeFileSync(join(evidence, "diagnostics-transcript.txt"), transcript.join("\n\n"));
    await launched.app.evaluate(() =>
      (
        globalThis as typeof globalThis & { __diagnosticProbe: TaskBrowsers }
      ).__diagnosticProbe.closeAll(),
    );
    await launched.close();
    await closeSite(server);
  }
});
