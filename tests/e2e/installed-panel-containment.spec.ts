import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { panelAddedLine } from "../../src/core/personal/panelLines";
import { panelConsentTitle } from "../../src/core/plugins/consentWords";
import { scratchDir } from "../helpers/scratchDirs";
import { frameIn, panelBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { CARD_FETCH_PROBE_PATH } from "./mockProvider";
import { promptInput } from "./prompt";
import { feedLine } from "./rails";
import { ADD_PANEL_PROMPT_MARKER, installPanel } from "./scenarios/installPanel";
import { shownCard } from "./stack";

/**
 * The frame realm's containment, measured through the real path (one plugin
 * vehicle, Phase A item 4; docs/live-prototype-security.md "The frame
 * realm"). This is the first time the app runs code someone else wrote, so
 * the boundary is proven the way the card corpus proves the card frame's:
 * a HOSTILE panel is added by talking, exactly as a real one would be -
 * fetched from a folder, checked, consented on the host's card - and then,
 * running in its frame, it tries every way out it can reach and reports
 * what happened. Every way is refused, and the live local server that the
 * network attempts aim at counts zero requests.
 *
 * The panel is written to get past the install-time tidy-up (the URL is
 * assembled at run time, the app's API named in pieces): the tidy-up is a
 * courtesy to honest authors, and the frame is what has to hold against a
 * dishonest one. A second panel runs away (`while (true)`), and must cost
 * only itself: torn down to a quiet line with a Retry while its sibling
 * keeps drawing.
 */

let launched: LaunchedApp;

async function say(page: Page, words: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(words);
  await input.press("Enter");
}

/** Adds the folder as a panel by talking and the captain's click on the host's card. */
async function addPanel(page: Page, folder: string, title: string, by: string): Promise<void> {
  await say(page, `${ADD_PANEL_PROMPT_MARKER}${folder}`);
  await expect(shownCard(page, panelConsentTitle(title, by))).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Add it", exact: true }).click();
  await expect(feedLine(page, panelAddedLine(title, by))).toBeVisible({
    timeout: 30_000,
  });
}

function writePanel(dir: string, manifest: object, panel: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "panel.tsx"), panel);
}

/**
 * The hostile panel. Each probe resolves to "refused" or to what got
 * through; the panel renders one row per probe for the test to read.
 */
function hostilePanel(port: number): string {
  // biome-ignore lint/plugin/e2e-frame-door: the hostile panel plants an iframe of its own; the spec reads no frame here.
  return `import { useEffect, useState } from "react";

const SCHEME = ["ht", "tp", "://"].join("");
const PROBE = SCHEME + "127.0.0.1:${port}${CARD_FETCH_PROBE_PATH}";
const API = ["first", "mate"].join("");

type Results = Record<string, string>;

/** Resolves on the script's own load or error event; a policy refusal fires error. */
function tryScript(src: string): Promise<string> {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = src;
    script.onload = () => resolve("LOADED");
    script.onerror = () => resolve("refused");
    document.head.append(script);
  });
}

function tryImage(src: string): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve("LOADED");
    image.onerror = () => resolve("refused");
    image.src = src;
  });
}

/** The policy's own report that it blocked a URL carrying this marker. */
const blocked: string[] = [];
const blockedWaiters: (() => void)[] = [];
document.addEventListener("securitypolicyviolation", (event) => {
  blocked.push(event.blockedURI);
  for (const wake of blockedWaiters.splice(0)) wake();
});
async function policyBlocked(marker: string): Promise<void> {
  while (!blocked.some((uri) => uri.includes(marker))) {
    await new Promise<void>((wake) => blockedWaiters.push(wake));
  }
}

async function refusedIfThrows(run: () => unknown | Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return value === undefined || value === null || value === false ? "refused" : "REACHED " + String(value);
  } catch {
    return "refused";
  }
}

async function probe(show: (results: Results) => void): Promise<Results> {
  const w = window as unknown as Record<string, any>;
  const fm = w.fm;
  // Shown as it goes, so a probe that never settles names itself.
  const results: Results = new Proxy({} as Results, {
    set(target, key, value) {
      target[key as string] = value;
      show({ ...target });
      return true;
    },
  });
  results.fetch = await refusedIfThrows(() => fetch(PROBE + "?fetch").then((r) => r.status));
  // A beacon is queued whatever happens to it, so the policy's own report
  // is what says it went nowhere.
  navigator.sendBeacon(PROBE + "?beacon", "x");
  await policyBlocked("?beacon");
  results.beacon = "refused";
  results.websocket = await new Promise<string>((resolve) => {
    try {
      const socket = new WebSocket(["w", "s://127.0.0.1:${port}/ws"].join(""));
      socket.onopen = () => resolve("REACHED");
      socket.onerror = () => resolve("refused");
    } catch {
      resolve("refused");
    }
  });
  results.image = await tryImage(PROBE + "?img");
  results.frame = await new Promise<string>((resolve) => {
    const frame = document.createElement("iframe");
    frame.src = PROBE + "?iframe";
    // A refused frame still fires load, on an error page this frame cannot read.
    frame.onload = () => {
      resolve(frame.contentDocument ? "REACHED" : "refused");
      frame.remove();
    };
    document.body.append(frame);
  });
  results.topNavigation = await refusedIfThrows(() => {
    (window.top as Window).location.href = PROBE + "?top";
    return "navigated";
  });
  results.popup = await refusedIfThrows(() => window.open(PROBE + "?popup"));
  results.parent = await refusedIfThrows(() => window.parent.document.title);
  results.eval = await refusedIfThrows(() => w["ev" + "al"]("1 + 1"));
  results.newFunction = await refusedIfThrows(() => new Function("return 2")());
  results.storage = await refusedIfThrows(() => window.localStorage.length + 1);
  results.appApi = w[API] === undefined ? "refused" : "REACHED";
  // The controls: what the frame IS allowed loads, so a refusal below is
  // the boundary and not a broken probe.
  results.pinnedLib = await tryScript("app-frame://lib/react.mjs");
  results.inlineImage = await tryImage(
    "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
  );
  results.unpinnedLib = await tryScript("app-frame://lib/evil.mjs");
  results.otherHost = await tryScript("app-frame://mount/any");
  results.fonts = await tryScript("app-frame://fonts/spacegrotesk-latin.woff2");
  results.appPlugin = await tryScript("app-plugin://host/react.mjs");
  results.undeclaredRead = await refusedIfThrows(async () => {
    const sub = inf.subscribe("tasks.board", {}, () => {});
    await sub.ready;
    return "subscribed";
  });
  results.gesture = await refusedIfThrows(async () => {
    await inf.action("open", { taskId: "t" });
    return "acted";
  });
  results.mediatedFetch = await refusedIfThrows(async () => {
    await inf.fetch("any", { path: "/" });
    return "fetched";
  });
  // Another panel's store slice: the request names one, the host ignores it.
  results.otherSlice = await refusedIfThrows(async () => {
    const answer = await inf.store({ op: "get", key: "secret", extensionId: "victim" });
    return answer.value;
  });
  await inf.store({ op: "set", key: "secret", value: "overwritten", extensionId: "victim" });
  return results;
}

export default function Panel() {
  const [results, setResults] = useState<Results>({});
  const [done, setDone] = useState(false);
  useEffect(() => {
    void probe(setResults).then(() => setDone(true));
  }, []);
  return (
    <ul data-probes={done ? "done" : "running"}>
      {Object.entries(results).map(([name, result]) => (
        <li key={name} data-probe={name} data-result={result}>
          {name}: {result}
        </li>
      ))}
    </ul>
  );
}
`;
}

const RUNAWAY_PANEL = `import { useEffect, useState } from "react";

export default function Panel() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), 200);
    return () => clearTimeout(timer);
  }, []);
  if (armed) {
    for (;;) {}
  }
  return <p>about to run away</p>;
}
`;

test.describe
  .serial("a panel someone else made cannot leave its frame", () => {
    test.beforeAll(async () => {
      launched = await launchApp({ scenarios: [installPanel], withMockProvider: true });
    });

    test.afterAll(async () => {
      await launched.close();
    });

    test("every way out is refused, and nothing reaches the network", async () => {
      const { page, mockProvider } = launched;
      if (!mockProvider) throw new Error("the containment probe needs the mock provider");
      // Another panel's slice, holding something the hostile one must not read.
      await page.evaluate(() =>
        window.infinitary.plugins.db.request({
          op: "set",
          extensionId: "victim",
          key: "secret",
          value: "kept",
        }),
      );

      const folder = join(scratchDir("infinitary-e2e-hostile-"), "mallory");
      writePanel(
        folder,
        { name: "Mallory", version: "1.0.0", title: "Probe" },
        hostilePanel(mockProvider.port),
      );
      await addPanel(page, folder, "Probe", "Mallory");

      const panel = page.locator('[data-side-panel="mallory"]');
      await expect(frameIn(panel)).toHaveAttribute("sandbox", "allow-scripts");
      await expect(frameIn(panel)).toHaveAttribute("src", /^app-frame:\/\/panel-[0-9a-f-]+\/$/);
      const frame = panelBody(page, "mallory");
      await expect(frame.locator("[data-probes]")).toHaveAttribute("data-probes", "done", {
        timeout: 30_000,
      });
      const results = Object.fromEntries(
        await frame
          .locator("[data-probe]")
          .evaluateAll((rows) =>
            rows.map((row) => [row.getAttribute("data-probe"), row.getAttribute("data-result")]),
          ),
      );
      expect(results).toEqual({
        fetch: "refused",
        beacon: "refused",
        websocket: "refused",
        image: "refused",
        frame: "refused",
        topNavigation: "refused",
        popup: "refused",
        parent: "refused",
        eval: "refused",
        newFunction: "refused",
        storage: "refused",
        appApi: "refused",
        pinnedLib: "LOADED",
        inlineImage: "LOADED",
        unpinnedLib: "refused",
        otherHost: "refused",
        fonts: "refused",
        appPlugin: "refused",
        undeclaredRead: "refused",
        gesture: "refused",
        mediatedFetch: "refused",
        otherSlice: "refused",
      });
      // Nothing it tried reached the machine's own server.
      expect(mockProvider.cardFetchProbeHits()).toBe(0);
      // The slice it named is untouched; what it wrote landed in its own.
      const slices = await page.evaluate(async () => {
        const { db } = window.infinitary.plugins;
        return {
          victim: (await db.request({ op: "get", extensionId: "victim", key: "secret" })).value,
          own: (await db.request({ op: "get", extensionId: "mallory", key: "secret" })).value,
        };
      });
      expect(slices).toEqual({ victim: "kept", own: "overwritten" });
      // The app's window is where it was.
      expect(page.url()).not.toContain(CARD_FETCH_PROBE_PATH);
      // No inner vertical scroll hides any of the panel's content.
      await expect
        .poll(() =>
          frame.locator("html").evaluate((html) => html.scrollHeight <= html.clientHeight),
        )
        .toBe(true);
      await page.screenshot({ path: test.info().outputPath("installed-panel-contained.png") });
    });

    test("a panel that runs away is torn down to a line with a Retry, and costs its sibling nothing", async () => {
      const { page, mockProvider } = launched;
      if (!mockProvider) throw new Error("the probe sibling needs the mock provider");
      // Its sibling is the probe panel: the test before adds it, and this
      // test adds it itself when it runs alone.
      if ((await page.locator('[data-side-panel="mallory"]').count()) === 0) {
        const probe = join(scratchDir("infinitary-e2e-hostile-"), "mallory");
        writePanel(
          probe,
          { name: "Mallory", version: "1.0.0", title: "Probe" },
          hostilePanel(mockProvider.port),
        );
        await addPanel(page, probe, "Probe", "Mallory");
      }
      const folder = join(scratchDir("infinitary-e2e-runaway-"), "spinner");
      writePanel(folder, { name: "Mallory", version: "1.0.0", title: "Spinner" }, RUNAWAY_PANEL);
      await addPanel(page, folder, "Spinner", "Mallory");

      const runaway = page.locator('[data-side-panel="spinner"]');
      await expect(runaway.getByText("This panel stopped responding.")).toBeVisible({
        timeout: 20_000,
      });
      await expect(runaway.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(frameIn(runaway)).toHaveCount(0);
      // Its sibling in the frame realm still draws and answers.
      const sibling = panelBody(page, "mallory");
      await expect(sibling.locator('[data-probe="fetch"]')).toHaveText("fetch: refused");
      // And the app is still the app.
      const input = promptInput(page);
      await input.fill("still here");
      await expect(input).toHaveValue("still here");
      await input.fill("");
    });
  });
