import type { FrameLocator, Locator, Page } from "@playwright/test";
import knowledgeManifest from "../../src/panels/knowledge/manifest.json" with { type: "json" };
import { bodyIn, drawnFrame, frameIn } from "./frames";
import { SHOWN_ENTRY } from "./stack";

/**
 * The knowledge browser (docs/knowledge.md, "The browser"): the Knowledge
 * panel's card, drawn in a page of its own like any panel's card, read
 * inside that page by its stable hooks - a concept by its id, a connection
 * by its id, a row, a tab, an inspector section - never by its words.
 * Every spec that reads it goes through here.
 */

/** The app's own Knowledge panel, whose card the browser is. */
export const KNOWLEDGE_PANEL = "knowledge";

/** Its one command: puts the browser up at the front with focus on the shown tab's own stop. */
export const OPEN_KNOWLEDGE = "panel:knowledge/open";

const cardSelector = `[data-panel-card="${KNOWLEDGE_PANEL}/browser"]`;

/** Its title, as its manifest names it: its section's name and its header's first words. */
export const KNOWLEDGE_TITLE = knowledgeManifest.title;

/** The Knowledge panel on its rail. */
export function knowledgePanel(page: Page): Locator {
  return page.locator(`[data-side-panel="${KNOWLEDGE_PANEL}"]`);
}

/** The Knowledge panel's header: its title, collapsed its summary beside it, and its buttons. */
export function knowledgeHeader(page: Page): Locator {
  return knowledgePanel(page).locator("header");
}

/** The browser's card while it is the shown entry. */
export function browserCard(page: Page): Locator {
  return page.locator(`${SHOWN_ENTRY} ${cardSelector}`);
}

/** Every knowledge browser on the stage, shown or not: there is never a second. */
export function browsersOnStage(page: Page): Locator {
  return page.locator(`[data-card-layer] ${cardSelector}`);
}

/** The shown browser's own page. */
export function browserPage(page: Page): FrameLocator {
  return drawnFrame(page, `${SHOWN_ENTRY} ${cardSelector} iframe`);
}

/** The browser itself, inside its page. */
export function browser(page: Page): Locator {
  return browserPage(page).locator("[data-knowledge-browser]");
}

/** The graph's drawing: one Tab stop, the concepts its options. */
export function graph(page: Page): Locator {
  return browser(page).locator("[data-knowledge-drawing]");
}

/** A concept on the graph, by its id. */
export function concept(page: Page, id: string): Locator {
  return browser(page).locator(`[data-knowledge-node="${id}"]`);
}

/** A connection's line on the graph, by its id (`claim:<finding>`, `context:<from>:<to>`). */
export function connection(page: Page, id: string): Locator {
  return browser(page).locator(`[data-knowledge-connection="${id}"]`);
}

/** A row of a list - the Connections list, Concepts or Findings - by what it names. */
export function row(page: Page, id: string): Locator {
  return browser(page).locator(`[data-knowledge-row="${id}"]`);
}

export function tab(page: Page, name: "graph" | "concepts" | "findings" | "directions"): Locator {
  return browser(page).locator(`[data-knowledge-tab="${name}"]`);
}

export function inspector(page: Page): Locator {
  return browser(page).locator("[data-knowledge-inspector]");
}

export function section(page: Page, name: "overview" | "evidence" | "history" | "used"): Locator {
  return browser(page).locator(`[data-knowledge-section="${name}"]`);
}

/** The camera as the drawing states it: yaw and pitch in radians, zoom as a fraction. */
export async function camera(page: Page): Promise<{ yaw: number; pitch: number; zoom: number }> {
  const [yaw = 0, pitch = 0, zoom = 0] = (
    (await graph(page).getAttribute("data-knowledge-camera")) ?? ""
  )
    .split(",")
    .map(Number);
  return { yaw, pitch, zoom };
}

/** Where a concept is drawn: its projected place and depth. */
export async function drawnAt(
  page: Page,
  id: string,
): Promise<{ x: number; y: number; depth: number }> {
  const node = concept(page, id);
  return {
    x: Number(await node.getAttribute("data-x")),
    y: Number(await node.getAttribute("data-y")),
    depth: Number(await node.getAttribute("data-depth")),
  };
}

/**
 * What holds the keyboard's focus inside the browser's page: a hook naming
 * the element, or null when the window's focus is not in the page.
 */
export async function focusInBrowser(page: Page): Promise<string | null> {
  const holds = await page.evaluate((selector) => {
    const frame = document.querySelector(selector);
    return frame !== null && document.activeElement === frame;
  }, `${SHOWN_ENTRY} ${cardSelector} iframe`);
  if (!holds || (await browser(page).count()) === 0) return null;
  return browser(page).evaluate((root) => {
    const active = root.ownerDocument.activeElement;
    if (!active) return null;
    for (const name of [
      "data-knowledge-row",
      "data-knowledge-tab",
      "data-knowledge-section",
      "data-knowledge-heading",
      "data-knowledge-find",
      "data-knowledge-scope-select",
    ]) {
      const value = active.getAttribute(name);
      if (value !== null) return `${name.replace("data-knowledge-", "")}:${value}`;
    }
    if (active.matches("[data-knowledge-drawing]")) return "graph";
    return active.tagName.toLowerCase();
  });
}

type HeldFrames = {
  asked: Map<number, FrameRequestCallback>;
  request: typeof requestAnimationFrame;
  cancel: typeof cancelAnimationFrame;
};

/**
 * Holds the animation frames the browser's page asks for until `release`
 * runs them, in the order they were asked for: the order a late frame
 * gives. A virtual Mac's hidden window drew the frame a tab's key had asked
 * for after focus had moved on to a finding row (INF-699), and a journey
 * that holds the frames meets that order on every run.
 */
export async function holdBrowserFrames(page: Page): Promise<{ release: () => Promise<void> }> {
  await browser(page).evaluate((root) => {
    const view = root.ownerDocument.defaultView as (Window & { heldFrames?: HeldFrames }) | null;
    if (!view || view.heldFrames) throw new Error("the browser's frames are already held");
    const held: HeldFrames = {
      asked: new Map(),
      request: view.requestAnimationFrame,
      cancel: view.cancelAnimationFrame,
    };
    let next = 1_000_000;
    view.heldFrames = held;
    view.requestAnimationFrame = (callback) => {
      next += 1;
      held.asked.set(next, callback);
      return next;
    };
    view.cancelAnimationFrame = (id) => {
      if (!held.asked.delete(id)) held.cancel.call(view, id);
    };
  });
  return {
    release: () =>
      browser(page).evaluate((root) => {
        const view = root.ownerDocument.defaultView as
          | (Window & { heldFrames?: HeldFrames })
          | null;
        const held = view?.heldFrames;
        if (!view || !held) throw new Error("the browser's frames are not held");
        view.requestAnimationFrame = held.request;
        view.cancelAnimationFrame = held.cancel;
        delete view.heldFrames;
        const at = view.performance.now();
        for (const callback of held.asked.values()) callback(at);
      }),
  };
}

/**
 * A pointer's drag on the graph, dispatched in the browser's own page as
 * pointer events: Chromium hands a hidden window's native pointer to a
 * sandboxed frame unreliably (docs/architecture.md, sharp edges). `button`
 * 0 is the left button, 2 the right.
 */
export async function dragGraph(
  page: Page,
  dx: number,
  dy: number,
  button: 0 | 2 = 0,
  from: { x: number; y: number } = { x: 24, y: 24 },
): Promise<{ contextMenuSuppressed: boolean }> {
  return graph(page).evaluate(
    (svg, { dx, dy, button, from }) => {
      const box = svg.getBoundingClientRect();
      const at = (x: number, y: number) => ({
        clientX: box.left + x,
        clientY: box.top + y,
        button,
        buttons: button === 2 ? 2 : 1,
        pointerId: 7,
        pointerType: "mouse",
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      // The press lands on whatever is drawn there: a concept, a line or the drawing.
      const pressed =
        svg.ownerDocument.elementFromPoint(box.left + from.x, box.top + from.y) ?? svg;
      pressed.dispatchEvent(new PointerEvent("pointerdown", at(from.x, from.y)));
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        svg.dispatchEvent(
          new PointerEvent("pointermove", at(from.x + (dx * i) / steps, from.y + (dy * i) / steps)),
        );
      }
      svg.dispatchEvent(new PointerEvent("pointerup", at(from.x + dx, from.y + dy)));
      const menu = new MouseEvent("contextmenu", {
        clientX: box.left + from.x + dx,
        clientY: box.top + from.y + dy,
        button: 2,
        bubbles: true,
        cancelable: true,
      });
      svg.dispatchEvent(menu);
      return { contextMenuSuppressed: menu.defaultPrevented };
    },
    { dx, dy, button, from },
  );
}

/** A click on a concept's dot, dispatched in the page as a press that does not move. */
export async function clickConcept(page: Page, id: string): Promise<void> {
  await concept(page, id)
    .locator("[data-knowledge-hit]")
    .evaluate((hit) => {
      const box = hit.getBoundingClientRect();
      const init = {
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
        button: 0,
        buttons: 1,
        pointerId: 8,
        pointerType: "mouse",
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      hit.dispatchEvent(new PointerEvent("pointerdown", init));
      hit.dispatchEvent(new PointerEvent("pointerup", init));
    });
}

/**
 * A wheel turn over the graph, dispatched in the page: whether the page
 * took it (`taken`, its default prevented) and so did not scroll the card.
 */
export async function wheelOnGraph(
  page: Page,
  deltaY: number,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {},
): Promise<{ taken: boolean }> {
  return graph(page).evaluate(
    (svg, { deltaY, modifiers }) => {
      const box = svg.getBoundingClientRect();
      const wheel = new WheelEvent("wheel", {
        deltaY,
        clientX: box.left + 30,
        clientY: box.top + 30,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      svg.dispatchEvent(wheel);
      return { taken: wheel.defaultPrevented };
    },
    { deltaY, modifiers },
  );
}

/**
 * Presses a control in the browser's page as a click does, dispatched in
 * the page itself: Chromium hands a hidden window's focus to and from a
 * native click into a sandboxed frame unreliably.
 */
export async function pressIn(control: Locator): Promise<void> {
  await control.evaluate((element) => (element as HTMLElement).click());
}

/**
 * Presses the Graph link in the Knowledge panel as the captain's click
 * does: the click gives the panel's page the window's focus - a card the
 * panel puts up comes to the front only from his own click or key in it -
 * and presses the link, dispatched in the page itself.
 */
export async function pressKnowledgeGraph(page: Page): Promise<void> {
  await frameIn(knowledgePanel(page)).focus();
  await bodyIn(knowledgePanel(page))
    .locator('[data-knowledge-open="graph"]')
    .evaluate((row) => (row as HTMLElement).click());
}

/** The collapsed count beside the title, through the same owner as other panel summaries. */
export function knowledgeSummary(page: Page): Locator {
  return knowledgePanel(page).locator("[data-panel-summary]");
}

/** Project applicability filters only Directions; the graph stays captain-owned. */
export async function filterDirections(page: Page, scope: string): Promise<void> {
  await pressIn(tab(page, "directions"));
  await browser(page).locator("[data-knowledge-scope-select]").selectOption(scope);
}

/** The knowledge references a card body's frame linked, in the order the body writes them. */
export function linkedReferences(frame: FrameLocator): Locator {
  return frame.locator("a[data-inf-entry]");
}

/** One linked reference, by the entry's id. */
export function reference(frame: FrameLocator, id: string): Locator {
  return frame.locator(`a[data-inf-entry="${id}"]`);
}

/** The inspector's Ask about this. */
export function askAboutThis(page: Page): Locator {
  return browser(page).locator("[data-knowledge-ask]");
}

/** One thing an earlier revision says beside the current one, in the inspector's comparison. */
export function compareRow(
  page: Page,
  name: "title" | "conditions" | "explanation" | "sources",
): Locator {
  return browser(page).locator(`[data-knowledge-compare-row="${name}"]`);
}

/** The revision the inspector reads now, as it states it. */
export async function revisionRead(page: Page): Promise<number> {
  return Number(await inspector(page).getAttribute("data-knowledge-revision-read"));
}

/** A task record's Knowledge used row: one entry, by the revision the work used. */
export function recordUse(record: FrameLocator, id: string, revision: number): Locator {
  return record.locator(`[data-record-use="${id}@${revision}"]`);
}
