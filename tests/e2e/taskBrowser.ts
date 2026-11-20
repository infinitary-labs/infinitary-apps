import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import { atRest } from "./layout";
import { SHOWN_ENTRY } from "./stack";
import { pressKey, typeInto } from "./windowKeys";

/**
 * A task's own browser as the journeys read it (docs/task-browser.md): the
 * view on the stage by its typed hooks, the pictures it drew, and the
 * task's hidden page itself, which only the main process can reach. Every
 * task browser spec reads them through here.
 */

/** The task browser view on the stage, its parts by their typed hooks. */
export const browserView = (page: Page, taskId: string): Locator =>
  page.locator(`${SHOWN_ENTRY} [data-task-browser="${taskId}"]`);

/**
 * The task card's tab strip on the stage (docs/task-card-tabs.md): its tabs
 * by their typed hooks, so a journey reads Info and the Browser tabs the
 * same way on the record and on the browser view.
 */
export function taskTabs(page: Page): { strip: Locator; tabs: Locator; selected: Locator } {
  const strip = page.locator(`${SHOWN_ENTRY} [data-task-tabs]`);
  return {
    strip,
    tabs: strip.locator('[role="tab"]'),
    selected: strip.locator('[role="tab"][aria-selected="true"]'),
  };
}

/**
 * From the selected tab, the arrows along the strip to one kind of tab, then
 * Enter (docs/task-card-tabs.md: Info, Cards, Activity, Crewmate, then
 * Browser, INF-2261). The strip's order is the task's, so the presses are
 * counted from where that tab sits, never typed.
 */
export async function showTabByKeys(page: Page, kind: string): Promise<void> {
  const { strip, tabs, selected } = taskTabs(page);
  // The strip draws after the card does: wait for the tab before counting.
  await expect(strip.locator(`[data-task-tab="${kind}"]`)).toBeVisible();
  await expect(selected).toHaveCount(1);
  const kinds = await tabs.evaluateAll((all) =>
    all.map((tab) => tab.getAttribute("data-task-tab")),
  );
  const from = kinds.indexOf(await selected.getAttribute("data-task-tab"));
  const to = kinds.indexOf(kind);
  if (from < 0 || to < 0) throw new Error(`No ${kind} tab on the strip: ${kinds.join(", ")}`);
  for (let at = from; at !== to; at += to > from ? 1 : -1)
    await pressKey(tabs.nth(at), to > from ? "ArrowRight" : "ArrowLeft");
  await pressKey(tabs.nth(to), "Enter");
}

/** The view's live page: how many pictures it drew, and the colour at its centre. */
export function canvasReading(
  page: Page,
): Promise<{ frames: number; size: string; centre: number[] }> {
  return page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    if (!canvas) return { frames: 0, size: "", centre: [] };
    const pixel = canvas
      .getContext("2d")
      ?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return {
      frames: Number(canvas.dataset.browserFrames ?? 0),
      size: canvas.dataset.browserFrameSize ?? "",
      centre: pixel ? Array.from(pixel.slice(0, 3)) : [],
    };
  }, `${SHOWN_ENTRY} [data-browser-canvas]`);
}

/**
 * What an expression reads in the task's hidden page at an address, or null
 * with no such page: the page Electron draws, or the one Google Chrome draws
 * when the journey runs on the Chrome engine (docs/task-browser.md, "Google
 * Chrome as a second engine"), which a source build lists for its journeys.
 * Every read of a task's page goes through here, so each journey reads it
 * the same way on both engines.
 */
export function onPage(
  app: ElectronApplication,
  siteUrl: string,
  expression: string,
): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, wanted) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(wanted.siteUrl));
      if (contents) return (await contents.executeJavaScript(wanted.expression)) as unknown;
      type Reading = { url: () => string; evaluate: (expression: string) => Promise<unknown> };
      const engines = (globalThis as Record<symbol, Set<{ pages: () => Reading[] }> | undefined>)[
        Symbol.for("infinitary.taskBrowser.chromeEngines")
      ];
      for (const engine of engines ?? []) {
        const page = engine.pages().find((candidate) => candidate.url().startsWith(wanted.siteUrl));
        if (page) return page.evaluate(wanted.expression);
      }
      return null;
    },
    { siteUrl, expression },
  );
}

/**
 * The names of the cookies the browser of the task's hidden page at an
 * address holds, its sign-ins included, read as `onPage` reads the page.
 */
export function pageCookieNames(app: ElectronApplication, siteUrl: string): Promise<string[]> {
  return app.evaluate(async ({ webContents }, wanted) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL().startsWith(wanted));
    if (contents) return (await contents.session.cookies.get({})).map((cookie) => cookie.name);
    type Reading = { url: () => string; cookieNames: () => Promise<string[]> };
    const engines = (globalThis as Record<symbol, Set<{ pages: () => Reading[] }> | undefined>)[
      Symbol.for("infinitary.taskBrowser.chromeEngines")
    ];
    for (const engine of engines ?? []) {
      const page = engine.pages().find((candidate) => candidate.url().startsWith(wanted));
      if (page) return page.cookieNames();
    }
    return [];
  }, siteUrl);
}

/**
 * What the task's hidden page at an address says in one element, read from
 * its own document: its text, or with `value` what a field holds.
 */
export async function pageSays(
  app: ElectronApplication,
  siteUrl: string,
  id: string,
  read: "textContent" | "value" = "textContent",
): Promise<string | null> {
  return (await onPage(
    app,
    siteUrl,
    `document.getElementById(${JSON.stringify(id)})?.${read} ?? null`,
  )) as string | null;
}

/** The size the task's hidden page at an address lays out at, as its own document reads it. */
export async function pageLaidOutAt(app: ElectronApplication, siteUrl: string): Promise<string> {
  const size = (await onPage(app, siteUrl, "innerWidth + 'x' + innerHeight")) as string | null;
  if (!size) throw new Error(`no page at ${siteUrl}`);
  return size;
}

/**
 * Whether a task's page fills its view: the size the page lays out at, as
 * its own document reads it, when it is the view's room and the picture the
 * view drew; otherwise all three, for the poll's message.
 */
export async function pageFillsView(
  page: Page,
  app: ElectronApplication,
  taskId: string,
  pageUrl: string,
): Promise<string> {
  const room = await browserView(page, taskId)
    .locator("[data-browser-page]")
    .evaluate((node) => `${node.clientWidth}x${node.clientHeight}`);
  const laidOut = await pageLaidOutAt(app, pageUrl);
  const drawn = (await canvasReading(page)).size;
  return room === laidOut && laidOut === drawn ? laidOut : `${room} / ${laidOut} / ${drawn}`;
}

/** A size as `pageFillsView` answers it when the page fills its view: width by height. */
export const SIZE = /^(\d+)x(\d+)$/;

/**
 * Click an element of a task's hidden page, as the captain does: on the
 * view's picture of it, once the picture holds still. A view that has just
 * come up may still be easing into place - after a take its card settles
 * to its new height and the picture slides up the stage - so a point
 * measured one frame and clicked the next lands beside the element. The
 * picture is clicked through its locator, which waits until it is stable
 * and nothing covers the point, at the element's place on it.
 */
export async function clickOnPage(
  app: ElectronApplication,
  page: Page,
  taskId: string,
  siteUrl: string,
  id: string,
): Promise<void> {
  // A page the view just opened, such as one moved into the kept profile,
  // may not hold the element yet: wait until it does.
  const where = () =>
    onPage(
      app,
      siteUrl,
      `(() => { const node = document.getElementById(${JSON.stringify(id)}); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    ) as Promise<{ x: number; y: number } | null>;
  await expect.poll(where, { message: `no ${id} on the page` }).not.toBeNull();
  const box = (await where()) as { x: number; y: number };
  const canvas = browserView(page, taskId).locator("[data-browser-canvas]");
  await atRest(canvas);
  // The picture's own size is the page's, whatever room the view gives it.
  const size = await canvas.evaluate((node: HTMLCanvasElement) => {
    const drawn = node.getBoundingClientRect();
    return {
      width: drawn.width,
      height: drawn.height,
      pageWidth: node.width,
      pageHeight: node.height,
    };
  });
  await canvas.click({
    position: {
      x: (box.x * size.width) / size.pageWidth,
      y: (box.y * size.height) / size.pageHeight,
    },
  });
}

/**
 * Types into an element of a task's hidden page, as the captain does: a
 * click on it in the view's picture, then the keys, once the page's own focus
 * is on that element and the view holds the window's (`typeInto`).
 */
export async function typeOnPage(
  app: ElectronApplication,
  page: Page,
  taskId: string,
  siteUrl: string,
  id: string,
  text: string,
): Promise<void> {
  await clickOnPage(app, page, taskId, siteUrl, id);
  await expect.poll(() => onPage(app, siteUrl, "document.activeElement?.id ?? null")).toBe(id);
  await typeInto(browserView(page, taskId).locator("[data-browser-page]"), text);
}

/**
 * The captain's paste on the view, holding the captain's own computer's
 * words: the window's paste key, ⌘V on a Mac and Ctrl+V on Linux, with the
 * window's own paste carrying `text`. One test process shares one
 * clipboard with every page it opens, so the paste the key brings has its
 * words swapped for `text` rather than the computer's clipboard written:
 * the page's computer then holds other words, as another computer would.
 */
export async function pasteOnView(view: Locator, text: string): Promise<void> {
  await view.evaluate((node, words) => {
    const swap = (event: ClipboardEvent) => {
      if (!event.isTrusted) return;
      window.removeEventListener("paste", swap, true);
      event.stopImmediatePropagation();
      event.preventDefault();
      const data = new DataTransfer();
      data.setData("text/plain", words);
      node.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    };
    window.addEventListener("paste", swap, true);
  }, text);
  await pressKey(view, "ControlOrMeta+v");
}

/**
 * Windows the app holds, its own and the task browsers' hidden pages alike:
 * on the Chrome engine each of Chrome's task pages counts as the window the
 * built-in engine would give it.
 */
export function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => {
    const engines = (globalThis as Record<symbol, Set<{ pages: () => unknown[] }> | undefined>)[
      Symbol.for("infinitary.taskBrowser.chromeEngines")
    ];
    let chromePages = 0;
    for (const engine of engines ?? []) chromePages += engine.pages().length;
    return BrowserWindow.getAllWindows().length + chromePages;
  });
}

/**
 * Stop every task browser the app runs, as the captain's Stop browser does:
 * a journey that opens browsers of its own makes room under the cap of four
 * (docs/task-browser.md, "What a crewmate has") rather than borrowing what
 * an earlier journey left open.
 */
export async function stopTaskBrowsers(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { tasks } = await window.infinitary.tasks.board();
    for (const task of tasks) await window.infinitary.browser.stop(task.id);
  });
}

/**
 * Close a site a task's browser reached. A browser's session can keep a
 * connection it opened and never sent a request on, a stopped browser's
 * too, and a server's close keeps waiting for that one; so the site ends
 * every connection it still holds.
 */
export async function closeSite(server: {
  close(done: () => void): unknown;
  closeAllConnections(): void;
}): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

/** Every file under a folder that holds these bytes: what the captain typed must be in none. */
export function filesHolding(root: string, needle: string): string[] {
  const found: string[] = [];
  const bytes = Buffer.from(needle);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && stat.size < 64 * 1024 * 1024 && readFileSync(path).includes(bytes))
        found.push(path);
    }
  };
  walk(root);
  return found;
}
