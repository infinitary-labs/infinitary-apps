import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CrewmateBrowser, TaskBrowsers } from "../../src/core/browser/taskBrowsers";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { closeSite, pageSays } from "./taskBrowser";

const SITE = `<!doctype html><title>Browser identity</title>
<p id="user-agent"></p>
<script>document.getElementById("user-agent").textContent = navigator.userAgent;</script>`;

/**
 * INF-985; docs/task-browser.md, "The page itself": sites see an ordinary
 * Chrome user agent, not the app's identity. The real core and Electron
 * host visit a loopback site, reload and navigate to another document. Both
 * the server's request headers and the page's navigator must keep that promise.
 * Runs with the hermetic launcher's disposable HOME, userData and claimed
 * loopback port; no account, public network or shared browser is used.
 */
test("sites see Chrome without the app identity on first load, reload and navigation", async ({
  browserName,
}, info) => {
  void browserName;
  const dir = scratchDir("infinitary-browser-user-agent-");
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("vite"))("esbuild") as {
    build: (options: unknown) => Promise<unknown>;
  };
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
  const requests: { path: string; userAgent: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", userAgent: request.headers["user-agent"] ?? "" });
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(SITE);
  });
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}`;
  const launched = await launchApp();
  const readings: { state: string; userAgent: string | null }[] = [];
  try {
    const chrome = await launched.app.evaluate(
      async ({ app }, input) => {
        const { createRequire } = process.getBuiltinModule("node:module");
        const { TaskBrowsers, createTaskBrowserHost } = createRequire(
          `${app.getAppPath()}/package.json`,
        )(input.bundle);
        (globalThis as typeof globalThis & { __userAgentProbe: TaskBrowsers }).__userAgentProbe =
          new TaskBrowsers({ host: createTaskBrowserHost(), evidenceDir: () => input.dir });
        return `Chrome/${process.versions.chrome}`;
      },
      { bundle, dir },
    );
    const call = (method: keyof CrewmateBrowser, input: unknown) =>
      launched.app.evaluate(
        async (_electron, args) => {
          const browsers = (globalThis as typeof globalThis & { __userAgentProbe: TaskBrowsers })
            .__userAgentProbe;
          const invoke = browsers.forTask("identity")[args.method] as (
            input: unknown,
          ) => Promise<{ text: string }>;
          return invoke(args.input);
        },
        { method, input },
      );
    const checkIdentity = async (state: string, path: string) => {
      const userAgent = await pageSays(launched.app, `${url}${path}`, "user-agent");
      readings.push({ state, userAgent });
      expect(userAgent).toContain(chrome);
      expect(userAgent).toMatch(/^Mozilla\/5\.0 .* AppleWebKit\/\S+ .* Safari\/\S+$/);
      expect(userAgent).not.toMatch(/infinitary|electron|firstmate/i);
      const received = requests.filter((request) => request.path === path);
      expect(received.length).toBeGreaterThan(0);
      for (const request of received) expect(request.userAgent).toBe(userAgent);
    };
    await call("navigate", { url: `${url}/first` });
    await checkIdentity("first load", "/first");
    const beforeReload = requests.filter((request) => request.path === "/first").length;
    await call("navigate", { go: "reload" });
    expect(requests.filter((request) => request.path === "/first").length).toBeGreaterThan(
      beforeReload,
    );
    await checkIdentity("reload", "/first");
    await call("navigate", { url: `${url}/next` });
    await checkIdentity("navigation", "/next");
  } finally {
    writeFileSync(
      info.outputPath("user-agents.json"),
      JSON.stringify({ requests, readings }, null, 2),
    );
    await launched.app.evaluate(() =>
      (
        globalThis as typeof globalThis & { __userAgentProbe: TaskBrowsers }
      ).__userAgentProbe.closeAll(),
    );
    await launched.close();
    await closeSite(server);
  }
});
