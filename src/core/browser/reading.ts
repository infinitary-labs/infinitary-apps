/**
 * Facts the host reads off a page and the core folds into the outline
 * (docs/task-browser.md, "What a crewmate reads"): a time element's
 * machine-readable time, a title tooltip, which elements the page's
 * window shows, a whole-page picture's width, and one noisy error a
 * signed-out page logs on its own.
 */

import type { BrowserNode } from "./outline";

/** One element's machine-readable time and title tooltip, keyed by the host's node id. */
export type PageMark = { datetime?: string; title?: string };

/** Copy a snapshot's marks onto the accessibility nodes they belong to. */
export function applyMarks(
  nodes: readonly BrowserNode[],
  marks: ReadonlyMap<number, PageMark>,
): BrowserNode[] {
  if (marks.size === 0) return [...nodes];
  return nodes.map((node) => {
    if (node.target === undefined) return node;
    const mark = marks.get(node.target);
    if (!mark) return node;
    return {
      ...node,
      properties: {
        ...node.properties,
        ...(mark.datetime ? { datetime: mark.datetime } : {}),
        ...(mark.title ? { title: mark.title } : {}),
      },
    };
  });
}

/**
 * The snapshot the host reads (`DOMSnapshot.captureSnapshot`): string
 * indexes, one attribute pair list per node. Only the fields the marks
 * need are read; the rest is ignored.
 */
export type PageSnapshot = {
  documents?: {
    nodes?: {
      nodeName?: number[];
      backendNodeId?: number[];
      attributes?: number[][];
      /** Index of each node's parent in this list, or -1 for a root. */
      parentIndex?: number[];
    };
    /** The laid-out nodes: each one's index in `nodes`, and its box on the page. */
    layout?: { nodeIndex?: number[]; bounds?: number[][] };
    /** How far the document is scrolled, in the page's own pixels. */
    scrollOffsetX?: number;
    scrollOffsetY?: number;
  }[];
  strings?: string[];
};

/** The viewport a check is made at, and the page's own layout size. */
export type PageSize = { width: number; height: number };

/** Which elements the page lays out, and of those, which its window shows now. */
export type PageScreen = { laidOut: Set<number>; onScreen: Set<number> };

/**
 * Which elements of the page's own document the window shows, from a page
 * snapshot: a laid-out element whose box meets the viewport once the
 * document's scroll is taken off. A frame's document is left out, since
 * the outline does not read it.
 */
export function screenFromSnapshot(snapshot: PageSnapshot, viewport: PageSize): PageScreen {
  const laidOut = new Set<number>();
  const onScreen = new Set<number>();
  const document = snapshot.documents?.[0];
  const ids = document?.nodes?.backendNodeId ?? [];
  const indexes = document?.layout?.nodeIndex ?? [];
  const bounds = document?.layout?.bounds ?? [];
  const left = document?.scrollOffsetX ?? 0;
  const top = document?.scrollOffsetY ?? 0;
  for (let at = 0; at < indexes.length; at += 1) {
    const id = ids[indexes[at] ?? -1];
    const box = bounds[at];
    if (id === undefined || !box || box.length < 4) continue;
    laidOut.add(id);
    const [x = 0, y = 0, width = 0, height = 0] = box;
    const meets =
      x - left < viewport.width &&
      x - left + width > 0 &&
      y - top < viewport.height &&
      y - top + height > 0;
    // An empty box meets the window only where it sits inside it.
    if (meets || (width === 0 && height === 0 && y - top >= 0 && y - top < viewport.height)) {
      onScreen.add(id);
    }
  }
  return { laidOut, onScreen };
}

/**
 * Mark each node the page lays out with whether its window shows it now;
 * a node it does not lay out is left unmarked, and reads as where its
 * parent is.
 */
export function applyScreen(nodes: readonly BrowserNode[], screen: PageScreen): BrowserNode[] {
  if (screen.laidOut.size === 0) return [...nodes];
  return nodes.map((node) =>
    node.target !== undefined && screen.laidOut.has(node.target)
      ? { ...node, onScreen: screen.onScreen.has(node.target) }
      : node,
  );
}

function textAt(strings: string[], index: number | undefined): string {
  if (index === undefined || index < 0) return "";
  return strings[index] ?? "";
}

/**
 * The machine-readable time and title tooltip of each element that has
 * one, from a page snapshot. A `time` or `relative-time` element's
 * `datetime`, and any element's `title`.
 */
export function marksFromSnapshot(snapshot: PageSnapshot): Map<number, PageMark> {
  const marks = new Map<number, PageMark>();
  const strings = snapshot.strings ?? [];
  for (const document of snapshot.documents ?? []) {
    const nodes = document.nodes;
    if (!nodes) continue;
    const ids = nodes.backendNodeId ?? [];
    const attributes = nodes.attributes ?? [];
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id === undefined) continue;
      const pairs = attributes[index] ?? [];
      let datetime: string | undefined;
      let title: string | undefined;
      for (let pair = 0; pair + 1 < pairs.length; pair += 2) {
        const key = textAt(strings, pairs[pair]).toLowerCase();
        const value = textAt(strings, pairs[pair + 1]).trim();
        if (!value) continue;
        if (key === "datetime") datetime = value;
        else if (key === "title") title = value;
      }
      if (!datetime && !title) continue;
      const held = marks.get(id);
      marks.set(id, {
        ...(datetime || held?.datetime ? { datetime: datetime ?? held?.datetime } : {}),
        ...(title || held?.title ? { title: title ?? held?.title } : {}),
      });
    }
  }
  return spreadToDescendants(snapshot, marks);
}

/**
 * A time or a title often sits on an element the accessibility tree does
 * not name, while the text inside it does. Copy each mark onto that
 * element's descendants, so the line the crewmate reads carries it.
 */
function spreadToDescendants(
  snapshot: PageSnapshot,
  marks: Map<number, PageMark>,
): Map<number, PageMark> {
  if (marks.size === 0) return marks;
  const spread = new Map(marks);
  for (const document of snapshot.documents ?? []) {
    const nodes = document.nodes;
    if (!nodes) continue;
    const ids = nodes.backendNodeId ?? [];
    const parents = nodes.parentIndex ?? [];
    const children = new Map<number, number[]>();
    for (let index = 0; index < ids.length; index += 1) {
      const parent = parents[index];
      if (parent === undefined || parent < 0) continue;
      const list = children.get(parent) ?? [];
      list.push(index);
      children.set(parent, list);
    }
    const visit = (index: number, mark: PageMark): void => {
      const id = ids[index];
      if (id !== undefined) {
        const held = spread.get(id);
        spread.set(id, {
          ...(mark.datetime || held?.datetime ? { datetime: held?.datetime ?? mark.datetime } : {}),
          ...(mark.title || held?.title ? { title: held?.title ?? mark.title } : {}),
        });
      }
      for (const child of children.get(index) ?? []) visit(child, mark);
    };
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id === undefined) continue;
      const mark = marks.get(id);
      if (mark) visit(index, mark);
    }
  }
  return spread;
}

/**
 * A whole-page picture's size. The page's own width leaves out the
 * scrollbar, so a picture of the check's page is at least as wide as the
 * window it was read in, and never taller than `maxHeight`.
 */
export function fullPageClip(viewport: PageSize, content: PageSize, maxHeight: number): PageSize {
  return {
    width: Math.max(1, viewport.width, Math.ceil(Math.min(content.width, viewport.width * 2))),
    height: Math.max(1, Math.ceil(Math.min(content.height, maxHeight))),
  };
}

/**
 * An error the page logs that says nothing about the page the crewmate
 * opened: a signed-out site asking for its own navigation payload and
 * getting nothing. A real error on that page is still said.
 */
export function isPageNoise(text: string): boolean {
  return text.includes("/_global-navigation/payloads.json") && /\b404\b|Not Found/i.test(text);
}
