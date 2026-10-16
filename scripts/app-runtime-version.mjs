#!/usr/bin/env node
// app-runtime-version.mjs - the version a RUNNING Infinitary reports
// about itself (docs/alpha.md "The signed channel workflow"). An alpha
// carries its logical version X.Y.Z-alpha.N in its packaged package.json and
// only the numeric core X.Y.Z in its two bundle-version fields, so the
// bundle's Info.plist cannot say which version runs; this asks the app.
//
// usage: app-runtime-version.mjs <user-data-dir>
//
// The app must have been started with `--remote-debugging-port=0` and
// `--user-data-dir=<user-data-dir>` (scripts/check-app-launch.sh does both,
// on a throwaway profile). Chromium names the port it chose in the profile's
// DevToolsActivePort file; the probe finds the app's window there and calls
// the app's own healthcheck in it - `window.infinitary.app.healthcheck()`, or
// `window.firstmate`'s for an app from before the Infinitary rename -
// answered in the main process by Electron's `app.getVersion()` - then
// prints the version. Plain Node: the release gates run it on the signing
// runner, against the signed app, with nothing installed for it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_SECONDS = 45;

const profile = process.argv[2];
if (!profile) {
  console.error("usage: app-runtime-version.mjs <user-data-dir>");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function devToolsPort() {
  try {
    const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** One Runtime.evaluate on a page target, or null when the page has no answer yet. */
function evaluate(webSocketDebuggerUrl, expression) {
  return new Promise((resolve) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const done = (value) => {
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 10_000);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      const value = message.result?.result?.value;
      done(message.result?.exceptionDetails || typeof value !== "string" ? null : value);
    });
    socket.addEventListener("error", () => done(null));
  });
}

const HEALTHCHECK =
  "(() => { const api = window.infinitary ?? window.firstmate; return typeof api?.app?.healthcheck === 'function' ? api.app.healthcheck().then((health) => health.version) : null; })()";

const deadline = Date.now() + PROBE_SECONDS * 1000;
let seen = "no DevToolsActivePort in the profile";
while (Date.now() < deadline) {
  const port = devToolsPort();
  if (port) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
      seen = `${pages.length} page(s) on port ${port}, none answering the healthcheck yet`;
      for (const page of pages) {
        const version = await evaluate(page.webSocketDebuggerUrl, HEALTHCHECK);
        if (version) {
          process.stdout.write(`${version}\n`);
          process.exit(0);
        }
      }
    } catch (caught) {
      seen = `port ${port}: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
  }
  await sleep(1000);
}
console.error(`app-runtime-version: no version within ${PROBE_SECONDS}s (${seen})`);
process.exit(1);
