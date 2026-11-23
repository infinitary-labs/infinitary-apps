// The docs site's check (docs/docs-site.md, "The check"): it serves the built
// site from dist/ on this computer, opens every page in a browser that may
// reach only that server, and fails on
// - a page that does not answer or does not draw its title,
// - a page that does not name its language and direction, itself as its
//   canonical address, and its version in every shipped language and
//   x-default as alternates (docs/docs-site.md, "Languages"),
// - a shipped language's home page whose language menu cuts its name short,
// - a request to any other host,
// - a cookie,
// - a link between pages, or to a heading, that leads nowhere,
// - a picture that does not draw,
// - a space after a full-width full stop (。), which Chinese and Japanese
//   never put there, though their pages break a line after each sentence,
// - search that draws no search box, or finds nothing, with the network limited to the site itself,
//   in English and, from each shipped language's home page, for a word of
//   one of its page titles, finding that language's own pages,
// - the wordmark drawn in anything but the text color,
// - a first visit that does not follow the visitor's system to dark or light
//   (Starlight opens dark unless the system asks for light; Chromium cannot
//   stand in for a system that states no preference, so that case is not here).
//
//   pnpm --dir docs-site build && pnpm --dir docs-site check
//
// Pages open side by side, a few at a time.
//
// SCREENSHOTS=<folder> also saves the home, Install and First launch pages in dark and light there.
//
// --origin <address> opens the pages there instead of serving dist/, such as
// the live https://docs.getinfinitary.com after a publish or Cloudflare's own
// local runtime serving this Worker (docs/docs-site.md, "Publishing"). The
// pages still come from dist/, so build the version that address serves. A
// page that the site's security policy blocks anything on fails there.

import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
// Starlight's own English words, which a translated page's notices must not show.
import starlightEnglish from "../node_modules/@astrojs/starlight/dist/translations/en.js";
import { pagesFolder, SITE_ORIGIN, segmentOf, shippedLanguages, SOURCE_LANGUAGE, textDirection } from "../languages.ts";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
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

/** How many pages the check opens at once. */
const SIDE_BY_SIDE = 6;

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

/** Each address the built sitemap lists, with the alternates it names for it. */
const SITEMAP = new Map(
  (await readdir(DIST))
    .filter((name) => /^sitemap-\d+\.xml$/.test(name))
    .flatMap((name) => [...readFileSync(join(DIST, name), "utf8").matchAll(/<url>([\s\S]*?)<\/url>/g)])
    .map(([, entry]) => [
      /<loc>([^<]*)<\/loc>/.exec(entry)?.[1],
      Object.fromEntries([...entry.matchAll(/hreflang="([^"]*)" href="([^"]*)"/g)].map(([, lang, href]) => [lang, href])),
    ]),
);

/** An object's entries in name order, to compare two. */
const sortedEntries = (object) => Object.entries(object).sort(([a], [b]) => a.localeCompare(b));

/** The shipped languages, each with its address prefix ("/" for English, "/ar/" for Arabic). */
const LANGUAGES = shippedLanguages().map((tag) => ({
  tag,
  prefix: tag === SOURCE_LANGUAGE ? "/" : `/${segmentOf(tag)}/`,
}));

/** The language a site address is in: the one whose prefix it starts with, English for the rest. */
function languageOf(path) {
  return LANGUAGES.find(({ tag, prefix }) => tag !== SOURCE_LANGUAGE && path.startsWith(prefix)) ?? LANGUAGES[0];
}

/** The same page's address in another language. */
function inLanguage(path, language) {
  return `${language.prefix}${path.slice(languageOf(path).prefix.length)}`;
}

/** What a page says about its language, read in the page. */
function languageMarks() {
  return {
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
    alternates: Object.fromEntries(
      [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((link) => [
        link.getAttribute("hreflang"),
        link.getAttribute("href"),
      ]),
    ),
    // Heading links in the page's own language; What's new's English notes keep English ones.
    anchors: [...document.querySelectorAll(".sl-anchor-link .sr-only")]
      .filter((label) => label.closest("[lang]")?.lang === document.documentElement.lang)
      .map((label) => label.textContent.trim()),
    // The header and the phone-width menu each draw the same select; read one.
    menu: [...(document.querySelector("starlight-lang-select select")?.options ?? [])].map((option) =>
      option.textContent.trim(),
    ),
  };
}

/** How a page's language marks fall short (docs/docs-site.md, "Languages"). */
function languageProblems(path, marks) {
  const language = languageOf(path);
  const problems = [];
  const wantDir = textDirection(language.tag);
  if (marks.lang !== language.tag) problems.push(`${path} says its language is ${marks.lang}, not ${language.tag}`);
  if (marks.dir !== wantDir) problems.push(`${path} runs ${marks.dir}, not ${wantDir}`);
  if (marks.canonical !== `${SITE_ORIGIN}${path}`) problems.push(`${path} names ${marks.canonical} as its address`);
  const want = Object.fromEntries([
    ...LANGUAGES.map((other) => [other.tag, `${SITE_ORIGIN}${inLanguage(path, other)}`]),
    ["x-default", `${SITE_ORIGIN}${inLanguage(path, LANGUAGES[0])}`],
  ]);
  for (const [tag, href] of Object.entries(want)) {
    if (marks.alternates[tag] !== href) problems.push(`${path} names ${marks.alternates[tag]} as its ${tag} version, not ${href}`);
  }
  for (const tag of Object.keys(marks.alternates)) {
    if (!(tag in want)) problems.push(`${path} names a ${tag} version the site does not ship`);
  }
  if (LANGUAGES.length > 1 && marks.menu.length !== LANGUAGES.length) {
    problems.push(`${path}'s language menu lists ${marks.menu.join(", ")}`);
  }
  // A translated page's heading links name their heading in its own language's words, not Starlight's English.
  const english = starlightEnglish["heading.anchorLabel"].split("{{")[0];
  const untranslated = marks.anchors.find((label) => label.startsWith(english));
  if (language.tag !== SOURCE_LANGUAGE && untranslated) problems.push(`${path} labels a heading link "${untranslated}"`);
  return problems;
}

/**
 * The English words of the search window Starlight builds with (Pagefind's
 * default UI, which keeps them in its bundle rather than exporting them): its
 * clear button and each form of its result count, with the count and the
 * searched word taken out, as a page shows them.
 */
function pagefindEnglish() {
  const starlight = realpathSync(fileURLToPath(new URL("../node_modules/@astrojs/starlight/dist/translations/en.js", import.meta.url)));
  const bundle = readFileSync(createRequire(starlight).resolve("@pagefind/default-ui"), "utf8");
  const block = /translations\/en\.json[\s\S]*?var strings\d* = (\{[\s\S]*?\n\});/.exec(bundle)?.[1] ?? "";
  const strings = Object.fromEntries([...block.matchAll(/^\s*(\w+): "(.*)",?$/gm)].map(([, key, value]) => [key, value]));
  if (!strings.clear_search || !strings.one_result || !strings.many_results) {
    throw new Error("Pagefind's English search words could not be read from its bundle");
  }
  const bare = (template) => template.replace("[SEARCH_TERM]", "").replace("[COUNT]", "").trim();
  return { clear: strings.clear_search, counts: new Set([bare(strings.one_result), bare(strings.many_results)]) };
}

/** A word to search for in a language: the longest in the title of its Install page, which every language has. */
function searchWord(language) {
  if (language.tag === SOURCE_LANGUAGE) return "Discord";
  const page = readFileSync(join(pagesFolder(language.tag), "install.md"), "utf8");
  const title = /^title:\s*"?(.+?)"?\s*$/m.exec(page)?.[1] ?? "";
  return title.split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? "";
}

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
  const watch = (page) => {
    page.on("pageerror", (error) => fail(`${page.url()} threw: ${error.message}`));
    // A script, style or font the site's security policy blocks shows only as a console error.
    page.on("console", (message) => {
      if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
        fail(`${page.url()} was blocked by its security policy: ${message.text().slice(0, 160)}`);
      }
    });
    return page;
  };
  const tabs = await Promise.all(Array.from({ length: SIDE_BY_SIDE }, async () => watch(await context.newPage())));
  const page = tabs[0];
  /**
   * Runs each item through a tab of its own, SIDE_BY_SIDE at a time. With fresh, each item opens
   * in a new tab, closed after, instead of one of the tabs that walk page after page.
   */
  const sideBySide = async (items, visit, { fresh = false } = {}) => {
    let next = 0;
    await Promise.all(
      tabs.map(async (walker) => {
        while (next < items.length) {
          const item = items[next++];
          if (!fresh) {
            await visit(walker, item);
            continue;
          }
          const tab = watch(await context.newPage());
          try {
            await visit(tab, item);
          } finally {
            await tab.close();
          }
        }
      }),
    );
  };
  const links = [];

  await sideBySide(pages, async (tab, path) => {
    const response = await tab.goto(origin + path, { waitUntil: "load" });
    if (response?.status() !== 200) fail(`${path} answered ${response?.status()}`);
    const title = (await tab.locator("main h1").first().textContent())?.trim();
    if (!title) fail(`${path} drew no title`);
    if (await tab.evaluate(() => document.cookie)) fail(`${path} set a cookie`);
    // The page's words as the browser draws them, a line break inside a paragraph as a space.
    const spaced = await tab.evaluate(
      () => /.{0,12}。[ \u00a0].{0,12}/u.exec(document.querySelector("main .sl-markdown-content")?.innerText ?? "")?.[0],
    );
    if (spaced) fail(`${path} draws a space after 。: "${spaced}"`);
    const broken = await tab.$$eval("main img", (images) =>
      images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute("src")),
    );
    for (const src of broken) fail(`${path} shows a picture that does not draw: ${src}`);
    for (const href of await tab.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")))) {
      links.push({ from: path, href });
    }
    if (path !== "/404.html") {
      const marks = await tab.evaluate(languageMarks);
      for (const problem of languageProblems(path, marks)) fail(problem);
      // The sitemap names the same alternates as the page's head, x-default included.
      const listed = SITEMAP.get(`${SITE_ORIGIN}${path}`);
      if (!listed) fail(`The sitemap does not list ${path}`);
      else if (JSON.stringify(sortedEntries(listed)) !== JSON.stringify(sortedEntries(marks.alternates))) {
        fail(`The sitemap names ${JSON.stringify(listed)} as ${path}'s alternates, its head ${JSON.stringify(marks.alternates)}`);
      }
    }
  });

  // Every link that stays on this site leads to a page, and a #heading to a heading on it.
  // Each linked page opens once for all the headings linked on it: opening it once per heading
  // loaded the same pages hundreds of times in the same few tabs.
  const headingLinks = new Map();
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
      if (!headingLinks.has(url.pathname)) headingLinks.set(url.pathname, new Map());
      const linked = headingLinks.get(url.pathname);
      if (!linked.has(url.hash)) linked.set(url.hash, []);
      linked.get(url.hash).push({ from, href });
    }
  }
  await sideBySide([...headingLinks], async (tab, [pathname, linked]) => {
    await tab.goto(origin + pathname, { waitUntil: "load" });
    const missing = await tab.evaluate(
      (hashes) => hashes.filter((hash) => document.getElementById(decodeURIComponent(hash.slice(1))) === null),
      [...linked.keys()],
    );
    for (const hash of missing) {
      for (const { from, href } of linked.get(hash)) fail(`${from} links to ${href}, but that page has no ${hash}`);
    }
  });

  // The language menu shows the whole name of each page's language, never cut short with an
  // ellipsis (docs/docs-site.md, "Languages"): the name, in the menu's own type, fits inside it.
  // A select draws only its chosen name, so that name is measured in a span set in the same type.
  if (LANGUAGES.length > 1) {
    await sideBySide(LANGUAGES, async (tab, language) => {
      await tab.goto(`${origin}${language.prefix}`, { waitUntil: "load" });
      await tab.evaluate(() => document.fonts.ready);
      const menu = await tab.evaluate(() => {
        const select = [...document.querySelectorAll("starlight-lang-select select")].find((each) => each.checkVisibility());
        if (!select) return null;
        const style = getComputedStyle(select);
        const name = select.selectedOptions[0]?.textContent.trim() ?? "";
        const probe = document.createElement("span");
        probe.textContent = name;
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        probe.style.whiteSpace = "pre";
        for (const property of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "letterSpacing", "wordSpacing"]) {
          probe.style[property] = style[property];
        }
        select.after(probe);
        const needs = probe.getBoundingClientRect().width;
        probe.remove();
        const sides = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"];
        const holds = select.getBoundingClientRect().width - sides.reduce((sum, side) => sum + parseFloat(style[side]), 0);
        return { name, needs, holds };
      });
      if (!menu) {
        fail(`${language.prefix} draws no language menu`);
      } else if (menu.needs > menu.holds + 0.05) {
        fail(
          `${language.prefix}'s language menu cuts "${menu.name}" short: it needs ${menu.needs.toFixed(1)}px and the menu holds ${menu.holds.toFixed(1)}px`,
        );
      }
    });
  }

  const unknown = await page.goto(`${origin}/no-such-page/`);
  if (unknown?.status() !== 404 || !(await page.locator("main h1").count())) {
    fail("An unknown address does not draw the site's own not-found page");
  }

  // Search runs in the browser from the site's own files, in each language from its own home page,
  // and its window speaks that language: its result count, in either form, and clear button are not Pagefind's English.
  // Starlight builds the search box only when the browser next has idle time. Headless
  // Chromium on a busy computer can stop drawing without ever having had idle time, and
  // nothing then asks it to draw again, as a visitor's pointer would: the box never comes.
  // Waiting on animation frames keeps the page drawing, so the idle time comes.
  // Each search opens in a fresh tab: a tab that walked the pages above keeps them in its
  // browser's memory, and on a busy computer such a tab sometimes never gets that idle time.
  const searchWords = new Map();
  await sideBySide(LANGUAGES, async (tab, language) => {
    const word = searchWord(language);
    await tab.goto(`${origin}${language.prefix}`, { waitUntil: "load" });
    await tab.locator("site-search button[data-open-modal]").first().click();
    const searchBox = await tab
      .waitForFunction(() => document.querySelector("site-search input") !== null, undefined, {
        polling: "raf",
        timeout: 30_000,
      })
      .then(
        () => true,
        () => false,
      );
    if (!searchBox) {
      fail(`Search on ${language.prefix} never drew its search box`);
      return;
    }
    await tab.locator("site-search input").first().fill(word);
    const result = tab.locator(".pagefind-ui__result-link").first();
    try {
      await result.waitFor({ state: "visible", timeout: 10_000 });
      const href = (await result.getAttribute("href")) ?? "";
      if (languageOf(new URL(href, origin).pathname).tag !== language.tag) {
        fail(`Searching for "${word}" on ${language.prefix} led to ${href}, a page in another language`);
      }
      const count = (await tab.locator(".pagefind-ui__message").first().innerText()).replace(word, "").replace(/\p{Nd}+/gu, "");
      const clear = await tab.locator(".pagefind-ui__search-clear").first().innerText();
      searchWords.set(language.tag, { count: count.trim(), clear: clear.trim() });
    } catch {
      fail(`Searching for "${word}" on ${language.prefix} found nothing`);
    }
  }, { fresh: true });
  const englishSearch = pagefindEnglish();
  for (const [tag, words] of searchWords) {
    if (tag === SOURCE_LANGUAGE) continue;
    if (englishSearch.counts.has(words.count) || words.clear === englishSearch.clear) {
      fail(`Search on /${segmentOf(tag)}/ shows its result count or clear button in English ("${words.count}", "${words.clear}")`);
    }
  }

  // What's new stays English in every language (docs/docs-site.md, "Languages"):
  // each language's page shows the English notes, marked English, under
  // Starlight's notice, in that language, that the page is not translated yet.
  await page.goto(`${origin}/whats-new/`, { waitUntil: "load" });
  const notes = await page.locator("main .sl-markdown-content").innerText();
  await sideBySide(
    LANGUAGES.filter(({ tag }) => tag !== SOURCE_LANGUAGE),
    async (tab, language) => {
      const path = `${language.prefix}whats-new/`;
      await tab.goto(origin + path, { waitUntil: "load" });
      if ((await tab.locator("main .sl-markdown-content").innerText()) !== notes) {
        fail(`${path} does not show What's new's English notes`);
      }
      const notesLanguage = await tab
        .locator("main .sl-markdown-content")
        .evaluate((notes) => notes.closest("[lang]")?.getAttribute("lang"));
      if (notesLanguage !== SOURCE_LANGUAGE) fail(`${path} marks its English notes as ${notesLanguage}`);
      const notice = tab.locator("main .fallback-notice");
      const marked = (await notice.count()) === 1 ? await notice.evaluate((element) => [element.lang, element.dir]) : [];
      if (marked[0] !== language.tag || marked[1] !== textDirection(language.tag)) {
        fail(`${path} does not mark its notice as ${language.tag}, ${textDirection(language.tag)}: ${marked.join(", ")}`);
      }
      const words = (await notice.first().textContent())?.trim() ?? "";
      if (!words || words === starlightEnglish["i18n.untranslatedContent"]) {
        fail(`${path} does not say, in its language, that the page is not translated yet: "${words}"`);
      }
    },
  );

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
