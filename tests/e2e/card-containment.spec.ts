import { expect, type Page, test } from "@playwright/test";
import { frameFontUrl } from "../../src/shared/plugins/frameDocument";
import { cardBody, cardBodyAsHeld, cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  ATTACK_CARD_TITLES,
  ATTACK_CARDS_PROMPT_MARKER,
  ATTACK_MARKER,
  cardContainment,
  PROJECT_FONT_CARD_TITLE,
  PROJECT_FONT_FAMILY,
  PROJECT_FONT_PROMPT_MARKER,
} from "./scenarios/cardContainment";
import { pager, showCard } from "./stack";

/**
 * The containment corpus. There is no card-body sanitizer since the
 * captain's 2026-09-15 decision (direction C, `docs/live-prototype-security.md`):
 * a body renders exactly as its author wrote it, and the boundary is the
 * `<iframe sandbox="allow-scripts">`, the frame CSP (`default-src 'none'`,
 * every script by hash) and the host's validation of every bridge message.
 *
 * So the corpus the sanitizer's unit test used to assert removal of is an
 * e2e now, which is the test that was missing: it measures the boundary
 * that actually holds instead of the allowlist that only ever deleted
 * honest markup, and it does not break when an author writes `<b>`. Every
 * vector runs in the real app, in BOTH vehicles - srcdoc and the app-frame
 * card mount - against a live local server that counts what reaches it.
 */

let launched: LaunchedApp;

/**
 * What the corpus achieved inside one frame: whether any vector executed,
 * whether the app realm is reachable, and how many scripts the document
 * ended up with (the injected one is present in the DOM and inert).
 */
async function probe(page: Page, title: string) {
  await showCard(page, title);
  const frame = cardBody(page, title);
  // Let the loads, the meta refresh and the media elements have their turn.
  await page.waitForTimeout(1_500);
  return frame.locator("body").evaluate(async (body, marker) => {
    const win = window as unknown as Record<string, unknown>;
    // An on* handler and a `javascript:` URL fire only on the event, so
    // raise the ones a body could plausibly get: a click anywhere in it.
    // (An SVG <a> is not an HTMLElement, hence the dispatched event.)
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    const armed = body.querySelectorAll(
      '[onclick],[onmouseover],[ontoggle],[onfocus],a[href^="javascript:"],summary',
    );
    for (const element of armed) {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    body.dispatchEvent(click);
    let parentDomBlocked = false;
    try {
      void window.parent.document;
    } catch {
      parentDomBlocked = true;
    }
    return {
      attackRan: win[marker] === true,
      // The control: the vectors really are in this document and really
      // were poked, so `attackRan: false` means they did nothing.
      armed: armed.length,
      parentDomBlocked,
      // The markup really is verbatim: the vectors are still in the DOM,
      // they simply cannot do anything. The vectors are tags, so every one
      // of each tag is counted - never the first one found.
      // biome-ignore lint/plugin/e2e-structural-selectors: every iframe in the body is an attack vector counted.
      // biome-ignore lint/plugin/e2e-frame-door: the planted iframes are counted in the body, not read.
      iframes: body.querySelectorAll("iframe").length,
      // biome-ignore lint/plugin/e2e-structural-selectors: every image in the body is an attack vector counted.
      images: body.querySelectorAll("img").length,
      // biome-ignore lint/plugin/e2e-structural-selectors: every image in the body is an attack vector checked.
      loadedImages: [...body.querySelectorAll("img")].filter(
        (img) => img.complete && img.naturalWidth > 0,
      ).length,
      href: location.href,
    };
  }, ATTACK_MARKER);
}

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [cardContainment] });
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`commission a crewmate: ${ATTACK_CARDS_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await launched.close();
});

test("the whole corpus executes nothing and reaches nothing, on the srcdoc vehicle", async () => {
  const { page, mockProvider } = launched;
  const iframe = cardBodyElement(page, ATTACK_CARD_TITLES.srcdoc);
  await showCard(page, ATTACK_CARD_TITLES.srcdoc);
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  // A body with no <script> is data: it rides srcdoc, never a mount.
  await expect(iframe).not.toHaveAttribute("src", /./);

  const result = await probe(page, ATTACK_CARD_TITLES.srcdoc);
  expect(result.armed).toBeGreaterThan(5);
  expect(result.attackRan).toBe(false);
  expect(result.parentDomBlocked).toBe(true);
  // The markup arrived whole - the frame is what contains it, not a filter.
  expect(result.iframes).toBeGreaterThan(0);
  expect(result.images).toBeGreaterThan(0);
  expect(result.loadedImages).toBe(0);
  expect(mockProvider?.cardFetchProbeHits()).toBe(0);
});

test("the same corpus with scripts runs only the card's own, on the mount vehicle", async () => {
  const { page, mockProvider } = launched;
  const iframe = cardBodyElement(page, ATTACK_CARD_TITLES.mount);
  await showCard(page, ATTACK_CARD_TITLES.mount);
  // A body carrying <script> is served at a card host of its own.
  await expect(iframe).toHaveAttribute("src", /^app-frame:\/\/card-[0-9a-f-]{36}\/$/);
  const frame = cardBody(page, ATTACK_CARD_TITLES.mount);
  // The card's own inline script is hash-pinned by the host and runs (WI-16).
  await expect(frame.getByRole("status")).toHaveText("ran", { timeout: 20_000 });

  const result = await probe(page, ATTACK_CARD_TITLES.mount);
  expect(result.armed).toBeGreaterThan(5);
  // A <script src> and a script injected at run time both lack a hash.
  expect(result.attackRan).toBe(false);
  expect(result.parentDomBlocked).toBe(true);
  expect(result.loadedImages).toBe(0);
  // Not one of fetch, WebSocket, beacon, img, iframe, object, embed, link,
  // @import, form, media, meta refresh, base or SVG image arrived anywhere.
  expect(mockProvider?.cardFetchProbeHits()).toBe(0);
});

test("a body that navigates its own frame reaches no network and wrecks only itself", async () => {
  const { page, mockProvider } = launched;
  await showCard(page, ATTACK_CARD_TITLES.selfNav);
  // The card ends showing an error page, which is not a drawn body.
  const frame = cardBodyAsHeld(page, ATTACK_CARD_TITLES.selfNav);
  // The one residual the corpus found, and it is self-inflicted: a meta
  // refresh does navigate the frame, the app CSP's `frame-src` refuses the
  // destination, and the card is left showing an error page. Nothing
  // reached the server, and the blast radius is this card's own body -
  // the same class of nuisance as a runaway script.
  await expect
    .poll(
      () =>
        frame
          .locator("body")
          .evaluate(() => location.href)
          .catch(() => "gone"),
      {
        timeout: 15_000,
      },
    )
    .not.toBe("about:srcdoc");
  expect(mockProvider?.cardFetchProbeHits()).toBe(0);

  // The app, and every sibling card, is untouched.
  const input = promptInput(page);
  await input.fill("still here");
  await expect(input).toHaveValue("still here");
  await input.fill("");
});

test("a body's own data: image renders, and it is the only image source there is", async () => {
  const { page, mockProvider } = launched;
  await showCard(page, ATTACK_CARD_TITLES.image);
  const image = cardBody(page, ATTACK_CARD_TITLES.image).locator("img");
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(2);
  expect(mockProvider?.cardFetchProbeHits()).toBe(0);
});

// INF-128's plan, approved by the captain with "Yes: a project font draws, a
// broken one is refused at send, and the card still loads nothing else".
test("a preview draws its project's own font file, a damaged one is refused when sent, and nothing else loads", async () => {
  const { page, mockProvider } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${PROJECT_FONT_PROMPT_MARKER}`);
  await input.press("Enter");
  // The crewmate first names a copy damaged inside its compressed data,
  // which the host's font engine refuses with what to fix; only reading that
  // refusal does it send the preview again, naming the real file.
  await expect(() => showCard(page, PROJECT_FONT_CARD_TITLE)).toPass({ timeout: 60_000 });
  // A body that draws in a project's font rides a card host, and so a
  // renderer process, of its own - though it carries no script.
  await expect(cardBodyElement(page, PROJECT_FONT_CARD_TITLE)).toHaveAttribute(
    "src",
    /^app-frame:\/\/card-[0-9a-f-]{36}\/$/,
  );
  const faces = () =>
    cardBody(page, PROJECT_FONT_CARD_TITLE)
      .locator("body")
      .evaluate(async (_body, family) => {
        await document.fonts.ready;
        const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
        const named = (rule: CSSRule) =>
          rule instanceof CSSFontFaceRule &&
          rule.style.getPropertyValue("font-family").replaceAll('"', "") === family;
        return {
          loaded: [...document.fonts]
            .filter((face) => face.family.replaceAll('"', "") === family)
            .map((face) => face.status),
          src: rules
            .filter(named)
            .map((rule) => (rule as CSSFontFaceRule).style.getPropertyValue("src")),
        };
      }, PROJECT_FONT_FAMILY);
  await expect.poll(async () => (await faces()).loaded, { timeout: 15_000 }).toEqual(["loaded"]);
  // It loaded from the host's kept copy, never from the working copy's path.
  const { src } = await faces();
  expect(src).toHaveLength(1);
  const kept = /^url\("(app-frame:\/\/typefaces\/[A-Za-z0-9_-]+-[0-9a-f]{32}\.woff2)"\)/.exec(
    src[0] ?? "",
  )?.[1];
  expect(kept).toBeDefined();
  // The same sheet's face named by a web address reached nothing.
  expect(mockProvider?.cardFetchProbeHits()).toBe(0);

  // INF-145's review, decided for the captain's security ask: a body on the
  // srcdoc vehicle draws the app's own typefaces and loads no kept font,
  // however a body comes to name its address.
  await showCard(page, ATTACK_CARD_TITLES.srcdoc);
  const loads = (url: string) =>
    cardBody(page, ATTACK_CARD_TITLES.srcdoc)
      .locator("body")
      .evaluate(
        (_body, file) =>
          new FontFace("probe", `url(${file})`).load().then(
            () => "loaded",
            () => "refused",
          ),
        url,
      );
  expect(await loads(frameFontUrl("spacegrotesk-latin.woff2"))).toBe("loaded");
  expect(await loads(kept as string)).toBe("refused");
});
