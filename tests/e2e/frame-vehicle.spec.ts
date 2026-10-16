import { expect, test } from "@playwright/test";
import { observeBody, observeElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";

/**
 * Frame vehicle v2 against the built app (docs/ui-plugins.md, phase 1).
 * The Observe tab is the first template mount, so it is the probe: the
 * document is served over the host's own scheme with its own CSP, the
 * template script runs by hash, the containment ledger holds exactly as it
 * does for card bodies, the design system's typefaces load inside the
 * frame, and bridge v2 answers every verb from inside the sandbox with the
 * plugin's declaration enforced.
 */

type BridgeProbe = {
  version: unknown;
  parentDomBlocked: boolean;
  fetchBlocked: boolean;
  imgBlocked: boolean;
  injectedScriptRan: boolean;
  uiFontLoaded: boolean;
  monoFontLoaded: boolean;
  href: string;
  sessions: string[];
  undeclaredRead: string;
  unknownRead: string;
  badArgs: string;
  undeclaredAction: string;
  fetchRefusal: string;
  theme: string;
};

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
  const { page } = launched;
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Observe" }).click();
  await expect(observeElement(launched.page)).toBeVisible();
});

test.afterAll(async () => {
  await launched.close();
});

test("serves the template over app-frame: with its own hash-pinned CSP, contained like a card body, fonts inside", async () => {
  const { page } = launched;
  const iframe = observeElement(page);
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("src", /^app-frame:\/\/mount\/[0-9a-f-]+$/);
  const frame = observeBody(page);
  // The template script ran: it painted the list from the pushed read.
  await expect(frame.locator('[data-observe-session="firstmate"]')).toBeVisible();

  const probe = await frame.locator("body").evaluate(async (): Promise<BridgeProbe> => {
    const inf = (window as unknown as { inf: import("@shared/plugins/bridge").FrameBridgeApi }).inf;
    const codeOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return "resolved";
      } catch (caught) {
        return (caught as { code?: string }).code ?? "no code";
      }
    };
    let parentDomBlocked = false;
    try {
      void window.parent.document;
    } catch {
      parentDomBlocked = true;
    }
    let fetchBlocked = false;
    try {
      await fetch("https://example.com/");
    } catch {
      fetchBlocked = true;
    }
    const imgBlocked = await new Promise<boolean>((resolve) => {
      const img = document.createElement("img");
      const timer = setTimeout(() => resolve(true), 2000);
      img.onload = () => {
        clearTimeout(timer);
        resolve(false);
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(true);
      };
      img.src = "https://example.com/pixel.png";
      document.body.appendChild(img);
    });
    // Only the bridge and this mount's own template script are hash-pinned:
    // a script the page injects at run time never executes.
    const marker = "__fm_frame_csp_probe__";
    const injected = document.createElement("script");
    injected.textContent = `window["${marker}"] = true;`;
    document.body.appendChild(injected);
    const injectedScriptRan = (window as unknown as Record<string, unknown>)[marker] === true;
    injected.remove();
    await document.fonts.ready;
    const loaded = (family: string) =>
      [...document.fonts].some((face) => face.family.includes(family) && face.status === "loaded");
    const sessions = await new Promise<string[]>((resolve, reject) => {
      const sub = inf.subscribe<{ id: string }[]>("observe.sessions", {}, (value) => {
        void sub.unsubscribe();
        resolve(value.map((session) => session.id));
      });
      sub.ready.catch(reject);
    });
    return {
      version: inf.version,
      parentDomBlocked,
      fetchBlocked,
      imgBlocked,
      injectedScriptRan,
      uiFontLoaded: loaded("Space Grotesk"),
      monoFontLoaded: loaded("JetBrains Mono"),
      href: location.href,
      sessions,
      // A catalog read the built-in plugin does not declare (its frames read
      // Observe, the feed, and the crew; quota is nobody's yet).
      undeclaredRead: await codeOf(() => inf.subscribe("quota.snapshot", {}, () => {}).ready),
      unknownRead: await codeOf(() => inf.subscribe("cards.list", {}, () => {}).ready),
      badArgs: await codeOf(() => inf.subscribe("observe.session", { id: 42 }, () => {}).ready),
      undeclaredAction: await codeOf(() => inf.action("land")),
      fetchRefusal: await codeOf(() => inf.fetch("jira", { path: "/rest/api/3/myself" })),
      theme: inf.theme,
    };
  });

  expect(probe).toMatchObject({
    version: 2,
    parentDomBlocked: true,
    fetchBlocked: true,
    imgBlocked: true,
    injectedScriptRan: false,
    uiFontLoaded: true,
    monoFontLoaded: true,
    undeclaredRead: "read_not_declared",
    unknownRead: "read_not_declared",
    badArgs: "bad_args",
    undeclaredAction: "action_not_declared",
    fetchRefusal: "capability_not_granted",
    theme: "dark",
  });
  expect(probe.href).toMatch(/^app-frame:\/\/mount\//);
  expect(probe.sessions).toContain("firstmate");
  // S7c retired the supervision session, so a fresh install lists no such
  // row: the read serves what exists, never a placeholder.
  expect(probe.sessions).not.toContain("supervision");

  // Away from the tab and back: the mount is served again and paints.
  await page.getByRole("tab", { name: "General" }).click();
  await expect(iframe).toHaveCount(0);
  await page.getByRole("tab", { name: "Observe" }).click();
  await expect(frame.locator('[data-observe-session="firstmate"]')).toBeVisible();
});
