import { once } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { startConnectionGuard } from "../../src/core/browser/connectionGuard";
import { createTaskBrowserHost } from "../../src/main/host/taskBrowser";

// A standalone observation of the production hidden-page host when the full
// app cannot start. No alternate browser implementation or relaxed sandbox.
const evidence = process.env.FM_WINDOWS_EVIDENCE;
if (!evidence || process.platform !== "win32") throw new Error("Disposable Windows job only");
const stage = (name: string) => appendFileSync(join(evidence, "browser-stages.txt"), `${name}\n`);
stage("entry loaded");
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error) => {
    stage(`${event}: ${String(error)}`);
    app.exit(1);
  });
}
app.setPath("userData", process.env.APPDATA ?? evidence);
// Electron emits ready only after its entry module finishes evaluating.
// Do not await ready at module scope: that would stall our probe, not the browser.
async function observeBrowser(evidence: string) {
  stage("app ready");
  const refusals: unknown[] = [];
  const site = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Windows browser observation</title>
    <h1>Windows browser observation</h1><label>Synthetic name <input></label>
    <button>Keep name</button><p id="result">No input yet</p><p id="boundary"></p>
    <img src="https://private-probe.invalid/image" alt="Refused private-address request">
    <script>
      document.getElementById('boundary').textContent =
        typeof process === 'undefined' && typeof window.infinitary === 'undefined' && typeof window.firstmate === 'undefined'
        ? 'No Node or app bridge' : 'Unexpected app access';
      document.querySelector('button').onclick = event => {
        if(event.isTrusted) {
          localStorage.setItem('name',document.querySelector('input').value);
          document.getElementById('result').textContent='Kept '+localStorage.getItem('name');
        }
      };
    </script>`);
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("No loopback site");
  const origin = `http://127.0.0.1:${address.port}`;
  const guard = await startConnectionGuard({
    onRefused: (refusal) => refusals.push(refusal),
    lookup: async () => ["127.0.0.1"],
  });
  let page: Awaited<ReturnType<ReturnType<typeof createTaskBrowserHost>["open"]>> | undefined;
  try {
    stage("opening page");
    page = await createTaskBrowserHost().open({
      viewport: { width: 1280, height: 720 },
      proxy: guard,
      allow: ({ url }) =>
        url.startsWith(`${origin}/`) || url === "https://private-probe.invalid/image",
      onRefused: (refusal) => refusals.push(refusal),
      onDownload: () => undefined,
      onNavigated: () => {},
      onLoadFailed: () => {},
      onDialog: () => {},
      onFileChooser: () => {},
      onPicker: () => {},
      onPopup: () => undefined,
      onPageError: (error) => refusals.push({ pageError: error }),
      onConsole: () => {},
      onNetwork: () => {},
      onGone: () => {},
      onClosed: () => {},
      onAsk: async () => false,
    });
    stage("loading page");
    const load = await page.load(`${origin}/`);
    stage(`page loaded: ${JSON.stringify(load)}`);
    const nodes = await page.nodes();
    const field = nodes.find((node) => node.role === "textbox");
    const button = nodes.find((node) => node.role === "button");
    if (!field?.target || !button?.target)
      throw new Error("The real outline did not expose the controls");
    await page.focus(field.target);
    await page.insertText("Disposable captain");
    await page.press("Tab");
    await page.press("Enter");
    const after = await page.nodes();
    stage("capturing page after keyboard input");
    const picture = await page.capture({ fullPage: false });
    if (picture) writeFileSync(join(evidence, "windows-browser.png"), picture.png);
    const prefs = BrowserWindow.getAllWindows().map((window) => {
      const contents = window.webContents as unknown as { getLastWebPreferences: () => unknown };
      return { visible: window.isVisible(), prefs: contents.getLastWebPreferences() };
    });
    writeFileSync(
      join(evidence, "browser-result.json"),
      JSON.stringify(
        {
          load,
          after,
          refusals,
          prefs,
          picture: picture && { width: picture.width, height: picture.height },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    writeFileSync(
      join(evidence, "browser-result.json"),
      JSON.stringify({ error: String(error), refusals }),
    );
  } finally {
    stage("closing page");
    page?.close();
    guard.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    app.exit(0);
  }
}
void app
  .whenReady()
  .then(() => observeBrowser(evidence))
  .catch((error) => {
    writeFileSync(join(evidence, "browser-result.json"), JSON.stringify({ error: String(error) }));
    app.exit(1);
  });
