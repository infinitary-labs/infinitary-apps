import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { BrowserAnswer } from "../../src/core/browser/crewmateCommands";
import {
  type CrewmateBrowser,
  FORM_RESEND_CAPTAIN_WORDS,
  type TaskBrowsers,
} from "../../src/core/browser/taskBrowsers";
import {
  FORM_RESEND,
  type HostBrowserPage,
  type HostLoadOutcome,
  type HostPageEvents,
  type HostTaskBrowser,
} from "../../src/core/host";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { closeSite } from "./taskBrowser";

const CASES = [
  { name: "popup", target: "_blank", rel: "", redirect: 0 },
  { name: "with-opener", target: "_blank", rel: "opener", redirect: 0 },
  { name: "keep-post", target: "_blank", rel: "", redirect: 307 },
  { name: "become-get", target: "_blank", rel: "", redirect: 303 },
  { name: "first-page", target: "_self", rel: "", redirect: 0 },
] as const;
const SEND = "Send draft";
const HASH = "Same document";
const GET = "Ordinary page";
const BODY = "confirmation=draft";
const SITE = `<!doctype html><title>Form result</title>
<a href="#details">${HASH}</a><a href="/ordinary">${GET}</a>`;

type Probe = { browsers: TaskBrowsers; reloads: HostLoadOutcome[] };

/**
 * INF-1113: a POST response opened in a popup refuses reload honestly,
 * without resending its body. The real session sees a noopener popup's
 * first request and commit before the host adopts its window; only a real
 * Electron journey observes that ordering. The server's methods and bodies,
 * the host's FORM_RESEND and both callers' answers are the completion signal.
 * Redirects retaining POST stay guarded; a redirect to GET and navigating
 * away from the response can reload. Same-document movement keeps the guard.
 * Disposable HOME/userData, a claimed loopback port and the hermetic launcher;
 * no account, public site, payment or shared browser is used.
 */
test("POST popups refuse reload for both drivers while GET documents still reload", async ({
  browserName,
}, info) => {
  void browserName;
  const dir = scratchDir("infinitary-form-reload-");
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
  const requests: { path: string; method: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const path = request.url ?? "";
    requests.push({ path, method: request.method ?? "", body: Buffer.concat(chunks).toString() });
    response.setHeader("cache-control", "no-store");
    const example = CASES.find((candidate) => path === `/${candidate.name}`);
    const redirect = CASES.find((candidate) => path === `/${candidate.name}/submit`);
    if (example) {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Draft form</title>
<form action="/${example.name}/submit" method="post" target="${example.target}" rel="${example.rel}">
<input name="confirmation" value="draft"><button>${SEND}</button></form>`);
    } else if (redirect?.redirect) {
      response.writeHead(redirect.redirect, { location: `/${redirect.name}/result` });
      response.end();
    } else {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(SITE);
    }
  });
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}`;
  const launched = await launchApp();
  const answers: { action: string; answer: unknown }[] = [];
  try {
    await launched.app.evaluate(
      ({ app }, input) => {
        const { createRequire } = process.getBuiltinModule("node:module");
        const { TaskBrowsers, createTaskBrowserHost } = createRequire(
          `${app.getAppPath()}/package.json`,
        )(input.bundle);
        const host: HostTaskBrowser = createTaskBrowserHost();
        const reloads: HostLoadOutcome[] = [];
        const observe = (page: HostBrowserPage): HostBrowserPage => ({
          ...page,
          reload: async () => {
            const outcome = await page.reload();
            reloads.push(outcome);
            return outcome;
          },
        });
        const events = (original: HostPageEvents): HostPageEvents => ({
          ...original,
          onPopup: (address) => {
            const popup = original.onPopup(address);
            return popup
              ? {
                  ...popup,
                  events: events(popup.events),
                  opened: (page) => popup.opened(observe(page)),
                }
              : undefined;
          },
        });
        (globalThis as typeof globalThis & { __formProbe: Probe }).__formProbe = {
          reloads,
          browsers: new TaskBrowsers({
            host: {
              open: async (input) => observe(await host.open({ ...input, ...events(input) })),
            } satisfies HostTaskBrowser,
            evidenceDir: () => input.dir,
          }),
        };
      },
      { bundle, dir },
    );
    const call = async (method: keyof CrewmateBrowser, input: unknown): Promise<BrowserAnswer> => {
      const answer = await launched.app.evaluate(
        async (_electron, args) => {
          const { browsers } = (globalThis as typeof globalThis & { __formProbe: Probe })
            .__formProbe;
          const invoke = browsers.forTask("forms")[args.method] as (
            input: unknown,
          ) => Promise<BrowserAnswer>;
          return invoke(args.input);
        },
        { method, input },
      );
      answers.push({ action: `${method} ${JSON.stringify(input)}`, answer });
      return answer;
    };
    const click = async (label: string) => {
      const outline = await call("inspect", {});
      const ref = outline.text
        .split("\n")
        .find((line) => line.includes(`"${label}"`))
        ?.match(/\[(g\d+:e\d+)\]/)?.[1];
      expect(ref, outline.text).toBeTruthy();
      return call("act", { action: "click", ref });
    };
    const lastReload = () =>
      launched.app.evaluate(() =>
        (globalThis as typeof globalThis & { __formProbe: Probe }).__formProbe.reloads.at(-1),
      );
    for (const example of CASES) {
      await test.step(example.name, async () => {
        await call("navigate", { url: `${url}/${example.name}` });
        await click(SEND);
        const path = `/${example.name}/${example.redirect ? "result" : "submit"}`;
        await expect.poll(async () => (await call("inspect", {})).page?.url).toBe(`${url}${path}`);
        expect(requests.filter((request) => request.path === `/${example.name}/submit`)).toEqual([
          { path: `/${example.name}/submit`, method: "POST", body: BODY },
        ]);
        const isPost = example.redirect !== 303;
        await click(HASH);
        const reloaded = await call("navigate", { go: "reload" });
        expect(await lastReload()).toEqual(
          isPost ? { ok: false, code: FORM_RESEND } : { ok: true },
        );
        if (isPost) {
          // taskBrowsers.handoff.test.ts owns the exact refusal wording; the real
          // host's refusal must reach the command's answer about this form.
          expect(reloaded.page?.did).toContain("form");
          const captain = await launched.app.evaluate(async () => {
            const { browsers } = (globalThis as typeof globalThis & { __formProbe: Probe })
              .__formProbe;
            await browsers.takeControl("forms");
            const answer = await browsers.captainInput("forms", { kind: "go", go: "reload" });
            await browsers.returnControl("forms", { session: browsers.session, generation: 1 });
            return answer;
          });
          answers.push({ action: "captain reload", answer: captain });
          expect(captain).toEqual({ ok: false, text: FORM_RESEND_CAPTAIN_WORDS });
          expect(await lastReload()).toEqual({ ok: false, code: FORM_RESEND });
          expect(requests.filter((request) => request.path === path)).toHaveLength(1);
        } else {
          expect(requests.filter((request) => request.path === path)).toEqual([
            { path, method: "GET", body: "" },
            { path, method: "GET", body: "" },
          ]);
        }
        // A real GET navigation clears the guard, unlike a fragment move.
        await click(GET);
        const before = requests.filter((request) => request.path === "/ordinary").length;
        await call("navigate", { go: "reload" });
        expect(await lastReload()).toEqual({ ok: true });
        expect(requests.filter((request) => request.path === "/ordinary")).toHaveLength(before + 1);
        expect(
          requests.filter((request) => request.path === `/${example.name}/submit`),
        ).toHaveLength(1);
        if (example.target === "_blank") await call("close", { page: 2 });
      });
    }
  } finally {
    writeFileSync(
      info.outputPath("form-reloads.json"),
      JSON.stringify({ requests, answers }, null, 2),
    );
    await launched.app.evaluate(() =>
      (globalThis as typeof globalThis & { __formProbe: Probe }).__formProbe.browsers.closeAll(),
    );
    await launched.close();
    await closeSite(server);
  }
});
