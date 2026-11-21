import {
  TASK_BROWSER_PLACES_MAX,
  type TaskBrowserPlace,
  type TaskBrowserSize,
} from "@shared/taskBrowser";
import { hideKeys } from "../keyFormats";
import type { BrowserNode } from "./outline";

/**
 * What a page's outline names on screen (docs/task-browser.md, "Pointing at
 * a page"): each thing by its role and name, with the box its window shows
 * it in, in the outline's own order. The captain's Point at reads it once to
 * say what is under a mark, and to step through the page by keys.
 *
 * Names only. A value typed into the page is never read, and nothing inside
 * a typed field or an editable part of the page is listed, since that text
 * is what someone typed there. Pure: it reads the nodes the host already
 * read for the outline.
 */

/** Roles that hold others and name nothing a person would point at. */
const HOLDERS = new Set([
  "RootWebArea",
  "WebArea",
  "generic",
  "none",
  "presentation",
  "InlineTextBox",
  "LineBreak",
  "ListMarker",
]);

/** Roles a person points at even when the page gives them no name. */
const CONTROLS = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "image",
  "img",
  "slider",
  "switch",
  "tab",
  "menuitem",
  "textbox",
  "searchbox",
  "spinbutton",
]);

/** A field or part of the page someone types into (`outline.ts`, `typedInto`). */
const TYPED = new Set(["textbox", "searchbox", "spinbutton"]);

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

export type PlacesOptions = {
  /** A key in a format a service issues reads as hidden, as in the outline: the page may show one the captain made. */
  hideKeys?: boolean;
};

export function pagePlaces(
  nodes: readonly BrowserNode[],
  viewport: TaskBrowserSize,
  options: PlacesOptions = {},
): TaskBrowserPlace[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Set(nodes.flatMap((node) => node.childIds));
  const places: TaskBrowserPlace[] = [];
  const seen = new Set<string>();
  const visit = (node: BrowserNode, typed: boolean, above: string): void => {
    if (places.length >= TASK_BROWSER_PLACES_MAX || seen.has(node.id)) return;
    seen.add(node.id);
    const text = node.role === "StaticText";
    const named = squash(node.name);
    const name = (options.hideKeys ? hideKeys(named) : named).slice(0, 240);
    const role = (text ? "text" : node.role).slice(0, 64);
    const editable = Boolean(node.properties.editable);
    const listed =
      !node.ignored &&
      !typed &&
      !HOLDERS.has(node.role) &&
      // An editable part that is no field may be named by the text typed into it.
      (!editable || TYPED.has(node.role) || node.role === "combobox") &&
      // Text a named thing already says, such as a button's own words, is that thing.
      (text ? name !== "" && name !== above : name !== "" || CONTROLS.has(node.role));
    const box = listed && node.onScreen === true ? shown(node.box, viewport) : undefined;
    if (box) places.push({ role, name, ...box });
    const within = typed || TYPED.has(node.role) || editable;
    for (const id of node.childIds) {
      const child = byId.get(id);
      if (child) visit(child, within, listed && name !== "" ? name : above);
    }
  };
  for (const node of nodes) if (!children.has(node.id)) visit(node, false, "");
  return places;
}

/** The part of a box the window shows, in whole pixels; nothing for a part too small to point at. */
function shown(
  box: BrowserNode["box"],
  viewport: TaskBrowserSize,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!box) return undefined;
  const left = Math.max(0, Math.round(box.x));
  const top = Math.max(0, Math.round(box.y));
  const right = Math.min(viewport.width, Math.round(box.x + box.width));
  const bottom = Math.min(viewport.height, Math.round(box.y + box.height));
  if (right - left < 1 || bottom - top < 1) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
