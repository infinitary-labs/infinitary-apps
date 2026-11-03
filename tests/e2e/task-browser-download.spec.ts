import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CrewmateBrowser, TaskBrowsers } from "../../src/core/browser/taskBrowsers";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { closeSite } from "./taskBrowser";

// A tax site like the one in INF-1734: a letter offered as a file to save,
// and a table the page builds itself and offers as a download.
const LETTER = "%PDF-1.7\n% Notice CP2000, tax year 2025\n";
const SITE = `<!doctype html><title>Notices</title>
<style>body{font:20px sans-serif;margin:20px}a,button{font:inherit;display:block;margin:12px 0}</style>
<h1>Your notices</h1>
<a href="/letter.pdf">Download notice CP2000</a>
<button onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['date,total\\n2026-11-02,4\\n'],{type:'text/csv'}));a.download='totals.csv';document.body.append(a);a.click()">Export totals</button>`;

// The captain's pick on INF-2442's card, "Attachments, downloads, large
// recordings and the other Mac's record reach the hand-over folder", and
// INF-1734's goal: the task browser saves a file it downloads into the
// task's evidence folder, where the crewmate reads it and hands it on.
// This journey runs the real core and the real Electron host in the
// hermetic launcher; the completion signal is the file on disk and the
// crewmate's answer naming it.
test("a file the task's browser downloads lands in the task's evidence folder, and the crewmate is told where", async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(120_000);
  const dir = scratchDir("infinitary-browser-download-");
  const evidence = join(dir, "evidence");
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
    if (req.url === "/letter.pdf") {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="cp2000.pdf"',
        "content-length": Buffer.byteLength(LETTER),
      });
      res.end(LETTER);
      return;
    }
    res.end(SITE);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no site address");
  const url = `http://127.0.0.1:${address.port}/`;
  const launched = await launchApp();
  const transcript: string[] = [];
  type Probe = { browsers: TaskBrowsers };
  try {
    await launched.app.evaluate(
      async ({ app }, input) => {
        const { createRequire } = process.getBuiltinModule("node:module");
        const require = createRequire(`${app.getAppPath()}/package.json`);
        const { TaskBrowsers, createTaskBrowserHost } = require(input.bundle);
        const probe: Probe = {
          browsers: new TaskBrowsers({
            host: createTaskBrowserHost(),
            evidenceDir: () => input.evidence,
          }),
        };
        (globalThis as typeof globalThis & { __downloadProbe: Probe }).__downloadProbe = probe;
      },
      { bundle, evidence },
    );
    const call = async (method: keyof CrewmateBrowser, input: unknown = {}) => {
      const result = await launched.app.evaluate(
        async (_electron, args) => {
          const probe = (globalThis as typeof globalThis & { __downloadProbe: Probe })
            .__downloadProbe;
          const driver = probe.browsers.forTask("download");
          const invoke = driver[args.method] as (input: unknown) => Promise<{ text: string }>;
          return invoke(args.input);
        },
        { method, input },
      );
      transcript.push(`${method} ${JSON.stringify(input)}\n${result.text}`);
      return result as { text: string };
    };
    const outline = (await call("navigate", { url })).text;
    const ref = (name: string) => {
      const found = outline
        .split("\n")
        .find((line) => line.includes(`"${name}"`))
        ?.match(/\[(g\d+:e\d+)\]/)?.[1];
      if (!found) throw new Error(`No ref for ${name}: ${outline}`);
      return found;
    };
    const downloads = join(evidence, "downloads");
    const letter = join(downloads, "cp2000.pdf");
    /**
     * The answers since `from` (the action's own among them), read again
     * until one names the finished file: the action that started the
     * download may already say it, and each answer says it only once.
     */
    const toldOf = async (path: string, from: number) => {
      await expect.poll(() => existsSync(path) && statSync(path).size > 0).toBe(true);
      const naming = () => transcript.slice(from).find((answer) => answer.includes(`- ${path} (`));
      await expect
        .poll(async () => {
          if (naming()) return true;
          await call("inspect", {});
          return naming() !== undefined;
        })
        .toBe(true);
      return naming() ?? "";
    };

    // The crewmate clicks the site's link to its letter: the file lands in
    // the evidence folder under the site's own name, the owner's alone.
    let from = transcript.length;
    await call("act", { action: "click", ref: ref("Download notice CP2000") });
    const told = await toldOf(letter, from);
    expect(told).toContain("The browser downloaded files into the task's evidence folder");
    expect(readFileSync(letter, "utf8")).toBe(LETTER);
    expect(statSync(letter).mode & 0o777).toBe(0o600);

    // A table the page builds itself downloads the same way, by its own name.
    from = transcript.length;
    await call("act", { action: "click", ref: ref("Export totals") });
    const totals = join(downloads, "totals.csv");
    await toldOf(totals, from);
    expect(readFileSync(totals, "utf8")).toBe("date,total\n2026-11-02,4\n");

    // Opening the letter's own address downloads it again beside the first,
    // never over it. (The unit test owns the words that answer the open.)
    from = transcript.length;
    await call("navigate", { url: `${url}letter.pdf` });
    await toldOf(join(downloads, "cp2000-2.pdf"), from);
    expect(readFileSync(letter, "utf8")).toBe(LETTER);
  } finally {
    writeFileSync(info.outputPath("download-transcript.txt"), transcript.join("\n\n"));
    await launched.app.evaluate(() =>
      (
        globalThis as typeof globalThis & { __downloadProbe?: Probe }
      ).__downloadProbe?.browsers.closeAll(),
    );
    await launched.close();
    await closeSite(server);
  }
});
