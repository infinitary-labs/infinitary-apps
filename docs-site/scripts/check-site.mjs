// The docs site's check (docs/docs-site.md, "The check"): it serves the built
// site from dist/ on this computer, opens every page in a browser that may
// reach only that server, and fails on
// - a page that does not answer or does not draw its title,
// - a request to any other host,
// - a cookie,
// - a link between pages, or to a heading, that leads nowhere,
// - a picture that does not draw,
// - search that draws no search box, or finds nothing, with the network limited to the site itself,
// - the wordmark drawn in anything but the text color,
// - a first visit that does not follow the visitor's system to dark or light
//   (Starlight opens dark unless the system asks for light; Chromium cannot
//   stand in for a system that states no preference, so that case is not here).
//
//   pnpm --dir docs-site build && pnpm --dir docs-site check
//
// SCREENSHOTS=<folder> also saves the home, Install and First launch pages in dark and light there.
//
// --origin <address> opens the pages there instead of serving dist/, such as
// the live https://docs.getinfinitary.com after a publish or Cloudflare's own
// local runtime serving this Worker (docs/docs-site.md, "Publishing"). The
// pages still come from dist/, so build the version that address serves. A
// page that the site's security policy blocks anything on fails there.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const SITE_ORIGIN = "https://docs.getinfinitary.com";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

const failures = [];
const fail = (message) => failures.push(message);

/** Every file under dir, as paths relative to dist with forward slashes. */
async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else out.push(relative(DIST, full).split(sep).join("/"));
  }
  return out;
}

/** The built file an address names, or undefined when there is none. */
async function fileFor(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (clean.split("/").includes("..")) return undefined;
  for (const candidate of [clean, join(clean, "index.html"), `${clean}.html`]) {
    const full = join(DIST, candidate);
    try {
      if ((await stat(full)).isFile()) return full;
    } catch {}
  }
  return undefined;
}

/** A static server for dist/ that answers an unknown address with the site's own 404 page, as the host will. */
function serve() {
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const found = await fileFor(pathname);
    const file = found ?? join(DIST, "404.html");
    response.writeHead(found ? 200 : 404, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const { values } = parseArgs({ options: { origin: { type: "string" } } });
const server = values.origin ? undefined : await serve();
const origin = values.origin
  ? new URL(values.origin).origin
  : `http://127.0.0.1:${server.address().port}`;
const pages = (await files(DIST))
  .filter((file) => file.endsWith(".html"))
  .map((file) => `/${file.replace(/(^|\/)index\.html$/, "$1")}`);

const browser = await chromium.launch();

/** A browser context whose only reachable host is the local server; anything else fails the check. */
async function siteOnlyContext(options = {}) {
  const context = await browser.newContext(options);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === "data:" || url.protocol === "blob:") {
      return route.continue();
    }
    fail(`A page asked another host for ${url.href}`);
    return route.abort();
  });
  return context;
}

try {
  const context = await siteOnlyContext({ colorScheme: "dark" });
  const page = await context.newPage();
  page.on("pageerror", (error) => fail(`${page.url()} threw: ${error.message}`));
  // A script, style or font the site's security policy blocks shows only as a console error.
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
      fail(`${page.url()} was blocked by its security policy: ${message.text().slice(0, 160)}`);
    }
  });
  const links = [];

  for (const path of pages) {
    const response = await page.goto(origin + path, { waitUntil: "load" });
    if (response?.status() !== 200) fail(`${path} answered ${response?.status()}`);
    const title = (await page.locator("main h1").first().textContent())?.trim();
    if (!title) fail(`${path} drew no title`);
    if (await page.evaluate(() => document.cookie)) fail(`${path} set a cookie`);
    const broken = await page.$$eval("main img", (images) =>
      images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute("src")),
    );
    for (const src of broken) fail(`${path} shows a picture that does not draw: ${src}`);
    for (const href of await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")))) {
      links.push({ from: path, href });
    }
  }

  // Every link that stays on this site leads to a page, and a #heading to a heading on it.
  for (const { from, href } of links) {
    if (href === null || /^(mailto:|tel:)/.test(href)) continue;
    const url = new URL(href, origin + from);
    const local = url.origin === origin || url.origin === SITE_ORIGIN;
    if (!local) continue;
    const file = await fileFor(url.pathname);
    if (!file) {
      fail(`${from} links to ${href}, which leads nowhere`);
      continue;
    }
    if (url.hash && file.endsWith(".html")) {
      await page.goto(origin + url.pathname, { waitUntil: "load" });
      const id = decodeURIComponent(url.hash.slice(1));
      if (!(await page.evaluate((target) => document.getElementById(target) !== null, id))) {
        fail(`${from} links to ${href}, but that page has no ${url.hash}`);
      }
    }
  }

  const unknown = await page.goto(`${origin}/no-such-page/`);
  if (unknown?.status() !== 404 || !(await page.locator("main h1").count())) {
    fail("An unknown address does not draw the site's own not-found page");
  }

  // Search runs in the browser from the site's own files.
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.locator("site-search button[data-open-modal]").first().click();
  // Starlight builds the search box only when the browser next has idle time. Headless
  // Chromium on a busy computer can stop drawing without ever having had idle time, and
  // nothing then asks it to draw again, as a visitor's pointer would: the box never comes.
  // Waiting on animation frames keeps the page drawing, so the idle time comes.
  const searchBox = await page
    .waitForFunction(() => document.querySelector("site-search input") !== null, undefined, {
      polling: "raf",
      timeout: 30_000,
    })
    .then(
      () => true,
      () => false,
    );
  if (!searchBox) {
    fail("Search never drew its search box");
  } else {
    await page.locator("site-search input").first().fill("Discord");
    const result = page.locator(".pagefind-ui__result-link").first();
    try {
      await result.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      fail('Searching for "Discord" found nothing');
    }
  }

  if ((await context.cookies()).length > 0) fail("The site stored a cookie");
  await context.close();

  // Light follows the visitor's system, and so does dark.
  for (const [scheme, theme] of [
    ["dark", "dark"],
    ["light", "light"],
  ]) {
    const themed = await siteOnlyContext({
      colorScheme: scheme,
      viewport: { width: 1280, height: 800 },
    });
    const view = await themed.newPage();
    await view.goto(`${origin}/`, { waitUntil: "load" });
    await view.evaluate(() => document.fonts.ready);
    const drawn = await view.evaluate(() => {
      const probe = (name) => {
        const element = document.createElement("span");
        element.style.color = `var(${name})`;
        document.body.append(element);
        const color = getComputedStyle(element).color;
        element.remove();
        return color;
      };
      const wordmark = document.querySelector("header .wordmark");
      return {
        theme: document.documentElement.dataset.theme,
        wordmark: wordmark ? getComputedStyle(wordmark).color : null,
        weight: wordmark ? getComputedStyle(wordmark).fontWeight : null,
        text: probe("--fg-1"),
        accent: probe("--accent"),
      };
    });
    if (drawn.theme !== theme) {
      fail(`A visitor whose system asks for ${scheme} sees the ${drawn.theme} theme, not ${theme}`);
    }
    if (drawn.wordmark !== drawn.text || drawn.wordmark === drawn.accent || drawn.weight !== "500") {
      fail(
        `In ${theme}, the wordmark is drawn ${drawn.wordmark} at weight ${drawn.weight}, not the text color ${drawn.text} at 500`,
      );
    }
    if (process.env.SCREENSHOTS) {
      await view.screenshot({ path: join(process.env.SCREENSHOTS, `docs-home-${theme}.png`) });
      await view.goto(`${origin}/install/`, { waitUntil: "load" });
      await view.evaluate(() => document.fonts.ready);
      await view.screenshot({ path: join(process.env.SCREENSHOTS, `docs-install-${theme}.png`) });
      await view.goto(`${origin}/first-launch/`, { waitUntil: "load" });
      await view.evaluate(() => document.fonts.ready);
      await view.screenshot({ path: join(process.env.SCREENSHOTS, `docs-first-launch-${theme}.png`) });
    }
    await themed.close();
  }
} finally {
  await browser.close();
  server?.close();
}

if (failures.length > 0) {
  console.error(`The docs site check failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `The docs site check passed at ${origin}: ${pages.length} pages, every request to the site itself.`,
);
