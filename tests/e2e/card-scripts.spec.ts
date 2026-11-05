import { expect, test } from "@playwright/test";
import { CARD_BODY_WORDS } from "../../src/renderer/src/cards/cardBodyWords";
import { FRAME_BRIDGE_SHA256 } from "../../src/shared/plugins/frameScript";
import { cardBody, cardBodyElement, cardBodySelector } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { SCRIPT_CARD_TITLES } from "./mockProvider";
import { measured, PERF_TAG } from "./perf";
import { promptInput } from "./prompt";
import { SCRIPT_CARDS_PROMPT_MARKER, scriptCards } from "./scenarios/scriptCards";
import { pager, showCard, shownEntry } from "./stack";

/**
 * WI-16: the agent's own inline script runs inside a card body, under the
 * unchanged sandbox and CSP (docs/live-prototype-security.md). A scripted
 * body is served as a per-card mount at a host of its own; its script runs
 * by hash; it still reaches no network; and a runaway script is torn down
 * by the frame watchdog without taking the app - or a sibling frame - down.
 */

/**
 * FRAME_WATCHDOG_INTERVAL_MS x (FRAME_WATCHDOG_MISSES + 1), plus slack: the
 * budget a perf run holds the teardown to (./perf.ts). Every run measures it.
 */
const WATCHDOG_WINDOW_MS = 1_000 * 5 + 3_000;

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [scriptCards] });
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`commission a crewmate: ${SCRIPT_CARDS_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await launched.close();
});

test("a card's own script paints a canvas inside the unchanged sandbox", async () => {
  const { page } = launched;
  await showCard(page, SCRIPT_CARD_TITLES.canvas);
  const iframe = cardBodyElement(page, SCRIPT_CARD_TITLES.canvas);
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("src", /^app-frame:\/\/card-[0-9a-f-]{36}\/$/);

  const canvas = cardBody(page, SCRIPT_CARD_TITLES.canvas).locator("canvas");
  await expect
    .poll(() =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const pen = element.getContext("2d");
        if (!pen) return -1;
        const { data } = pen.getImageData(0, 0, element.width, element.height);
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) painted += 1;
        return painted;
      }),
    )
    .toBe(120 * 40);

  // The document's own policy pins the bridge and the card's own script,
  // which the host hashed where its author put it. An injected script still
  // never runs.
  const probe = await canvas.evaluate(() => {
    const marker = "__injected";
    const injected = document.createElement("script");
    injected.textContent = `window.${marker} = true;`;
    document.body.appendChild(injected);
    let parentDomBlocked = false;
    try {
      void window.parent.document;
    } catch {
      parentDomBlocked = true;
    }
    return {
      injectedRan: (window as unknown as Record<string, unknown>)[marker] === true,
      parentDomBlocked,
      // Every script element counts: the injected one must still be there, inert.
      // biome-ignore lint/plugin/e2e-structural-selectors: every script in the document is counted, not the first.
      scripts: document.querySelectorAll("script").length,
    };
  });
  // Bridge, the card's own script, and the injected one.
  expect(probe).toEqual({ injectedRan: false, parentDomBlocked: true, scripts: 3 });
  const served = await launched.app.evaluate(
    async ({ session }, url) => {
      const response = await session.defaultSession.fetch(url);
      return response.headers.get("content-security-policy");
    },
    (await iframe.getAttribute("src")) as string,
  );
  const policy =
    // e2e-typed-words: the frame's CSP is the security boundary under test, stated independently of containment.ts.
    "default-src 'none'; style-src 'unsafe-inline'; font-src app-frame:; img-src data: app-frame:; script-src ";
  expect(served?.startsWith(policy)).toBe(true);
  const scripts = served?.slice(policy.length).split(" ") ?? [];
  expect(scripts[0]).toBe(`'${FRAME_BRIDGE_SHA256}'`);
  expect(scripts).toHaveLength(2);
  expect(scripts[1]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
});

test("a runaway script is torn down by the watchdog and the app stays responsive", {
  tag: PERF_TAG,
}, async () => {
  const { page } = launched;
  // Both moments are stamped on the page's clock as they happen - the
  // runaway frame going in, the stopped line coming up - so the teardown
  // time is the app's, not the runner's observation of it.
  await page.evaluate(
    ({ bodySelector, stoppedLine }) => {
      const stamps: { mounted?: number; stopped?: number } = {};
      (window as { __watchdogStamps?: typeof stamps }).__watchdogStamps = stamps;
      const look = () => {
        stamps.mounted ??= document.querySelector(bodySelector) ? performance.now() : undefined;
        stamps.stopped ??= document.body.innerText.includes(stoppedLine)
          ? performance.now()
          : undefined;
      };
      new MutationObserver(look).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    },
    {
      bodySelector: cardBodySelector(SCRIPT_CARD_TITLES.runaway),
      stoppedLine: CARD_BODY_WORDS.stopped,
    },
  );
  await showCard(page, SCRIPT_CARD_TITLES.runaway);
  const iframe = cardBodyElement(page, SCRIPT_CARD_TITLES.runaway);
  await expect(iframe).toBeVisible();
  const stopped = shownEntry(page).getByText(CARD_BODY_WORDS.stopped);
  await expect(stopped).toBeVisible({ timeout: 30_000 });
  await expect(iframe).toHaveCount(0);
  const stamps = await page.evaluate(
    () =>
      (window as { __watchdogStamps?: { mounted?: number; stopped?: number } }).__watchdogStamps,
  );
  // Torn down after it went in, never instead of it.
  expect(stamps?.mounted).toBeDefined();
  expect(stamps?.stopped).toBeGreaterThan(stamps?.mounted ?? Number.POSITIVE_INFINITY);
  measured(
    "card:watchdog teardown",
    [(stamps?.stopped ?? Number.NaN) - (stamps?.mounted ?? Number.NaN)],
    WATCHDOG_WINDOW_MS,
  );
  await page.screenshot({ path: test.info().outputPath("card-stopped-responding.png") });

  // The app answers: the input takes text, the pager moves, and a sibling
  // scripted card mounts and paints while the wedged process is reaped.
  const input = promptInput(page);
  await input.fill("still here");
  await expect(input).toHaveValue("still here");
  await input.fill("");
  await showCard(page, SCRIPT_CARD_TITLES.canvas);
  const canvas = cardBody(page, SCRIPT_CARD_TITLES.canvas).locator("canvas");
  // The sibling mounts a fresh process while the wedged one is still being
  // reaped: on a loaded machine that can outlast the default 5 s, and this
  // assertion is about responsiveness, not a timing contract (the watchdog
  // teardown above is the measured one).
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // Retry mounts a fresh document; the same runaway is torn down again.
  await showCard(page, SCRIPT_CARD_TITLES.runaway);
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible({ timeout: 30_000 });
  await retry.click();
  await expect(iframe).toBeVisible();
  await expect(stopped).toBeVisible({ timeout: 30_000 });
});
