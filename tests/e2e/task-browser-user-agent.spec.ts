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
<p id="user-agent"></p><p id="opener"></p><p id="message"></p><p id="fetch-agent"></p>
<a href="/linked" target="_blank">Open link</a>
<button onclick="window.open('/scripted')">Open script</button>
<button onclick="const child = window.open(); child.location = '/blank-opened'">Open blank then navigate</button>
<a href="/redirect" target="_blank">Open redirect</a>
<form action="/submitted" method="post" target="_blank">
  <input name="confirmation" value="draft"><button>Send form</button>
</form>
<button onclick="window.opener.postMessage(location.pathname, location.origin); window.close()">Finish check</button>
<script>
  // Read during the document's first script, not after the host has settled it.
  document.getElementById("user-agent").textContent = navigator.userAgent;
  document.getElementById("opener").textContent = String(!!window.opener);
  document.cookie = 'browser-fixture=shared; SameSite=Lax';
  window.addEventListener('message', event => {
    if (event.origin === location.origin) document.getElementById('message').textContent = event.data;
  });
  fetch('/fetch-agent').then(r => r.text()).then(agent => document.getElementById('fetch-agent').textContent = agent);
</script>`;

/**
 * INF-985; docs/task-browser.md, "The page itself": sites see an ordinary
 * Chrome user agent, not the app's identity. The real core and Electron
 * host visit a loopback site, reload and navigate to another document. Both
 * the server's request headers and the page's navigator must keep that promise.
 * INF-1015: a website-opened page must use that same identity from its first
 * request and first script, without reloading or replaying a submitted form.
 * Native links, window.open (including a blank page), a redirect and a POST
 * keep their usual opener, cookies and one-submission behavior.
 * Runs with the hermetic launcher's disposable HOME, userData and claimed
 * loopback port; no account, public network or shared browser is used.
 */
test("sites and their popups see Chrome from the first request without replaying forms", async ({
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
  const requests: {
    path: string;
    userAgent: string;
    method: string;
    body: string;
    cookie: string;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? "",
      userAgent: request.headers["user-agent"] ?? "",
      method: request.method ?? "",
      body: Buffer.concat(chunks).toString(),
      cookie: request.headers.cookie ?? "",
    });
    response.setHeader("cache-control", "no-store");
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/redirected" });
      response.end();
    } else if (request.url === "/fetch-agent") {
      response.end(request.headers["user-agent"]);
    } else {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(SITE);
    }
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
      await expect
        .poll(() => pageSays(launched.app, `${url}${path}`, "user-agent"))
        .toContain(chrome);
      const userAgent = await pageSays(launched.app, `${url}${path}`, "user-agent");
      readings.push({ state, userAgent });
      expect(userAgent).toContain(chrome);
      expect(userAgent).toMatch(/^Mozilla\/5\.0 .* AppleWebKit\/\S+ .* Safari\/\S+$/);
      expect(userAgent).not.toMatch(/infinitary|electron|firstmate/i);
      const received = requests.filter((request) => request.path === path);
      expect(received.length).toBeGreaterThan(0);
      for (const request of received) expect(request.userAgent).toBe(userAgent);
      await expect
        .poll(() => pageSays(launched.app, `${url}${path}`, "fetch-agent"))
        .toBe(userAgent);
      return userAgent;
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
    const ordinaryAgent = await checkIdentity("navigation", "/next");
    const click = async (label: string) => {
      const outline = await call("inspect", {});
      const ref = outline.text
        .split("\n")
        .find((line) => line.includes(`"${label}"`))
        ?.match(/\[(g\d+:e\d+)\]/)?.[1];
      expect(ref, outline.text).toBeTruthy();
      return call("act", { action: "click", ref });
    };
    for (const [label, path, opener] of [
      ["Open link", "/linked", false],
      ["Open script", "/scripted", true],
      ["Open blank then navigate", "/blank-opened", true],
      ["Open redirect", "/redirected", false],
      ["Send form", "/submitted", false],
    ] as const) {
      await click(label);
      expect(await checkIdentity(label, path)).toBe(ordinaryAgent);
      expect(await pageSays(launched.app, `${url}${path}`, "opener")).toBe(String(opener));
      const received = requests.filter((request) => request.path === path);
      expect(received).toHaveLength(1);
      expect(received[0]?.cookie).toContain("browser-fixture=shared");
      if (path === "/linked") {
        await call("navigate", { go: "reload" });
        expect(await checkIdentity("popup reload", path)).toBe(ordinaryAgent);
        expect(requests.filter((request) => request.path === path)).toHaveLength(2);
        await call("navigate", { url: `${url}/linked-next` });
        expect(await checkIdentity("popup navigation", "/linked-next")).toBe(ordinaryAgent);
      }
      if (path === "/submitted") {
        expect(received[0]?.method).toBe("POST");
        expect(received[0]?.body).toBe("confirmation=draft");
      }
      if (opener) {
        await click("Finish check");
        await expect.poll(() => pageSays(launched.app, `${url}/next`, "message")).toBe(path);
      } else {
        await call("close", { page: 2 });
      }
    }
    expect(requests.filter((request) => request.path === "/redirect")).toHaveLength(1);
    for (const request of requests) expect(request.userAgent).toBe(ordinaryAgent);
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
