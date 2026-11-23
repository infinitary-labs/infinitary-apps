import { ElementType, parseDocument } from "htmlparser2";
import { type DomNode, ELEMENT_TYPES, NON_COPY } from "./cardHeadings";
import {
  CARD_MEDIA_HOST,
  CARD_PICTURE_HOST,
  parseCardMediaFileName,
  parseCardPictureFileName,
} from "./cardPictures";
import { hookAttributes } from "./codeNames";
import { APP_FRAME_SCHEME } from "./csp";

/** The elements a part is, by the plan's five words. */
const PART_TAGS = new Set([
  // paragraph
  "p",
  "pre",
  "blockquote",
  // list item
  "li",
  "dt",
  "dd",
  // table row
  "tr",
  // figure
  "figure",
  "img",
  "svg",
  "canvas",
  "picture",
  // question
  "fieldset",
  "label",
]);

/** A container a question is drawn as without a fieldset (the bridge reads these too). */
const QUESTION_ROLES = new Set(["group", "radiogroup"]);

/** The host's own fragments on a settle card (`SettleFacts.strip`, `SettleFacts.followupNotice`). */
const HOST_FRAGMENTS = ["data-facts", "data-followups"];

const PICTURE_PREFIX = `${APP_FRAME_SCHEME}://${CARD_PICTURE_HOST}/`;
const MEDIA_PREFIX = `${APP_FRAME_SCHEME}://${CARD_MEDIA_HOST}/`;

type Element = DomNode & { attribs?: Record<string, string>; startIndex?: number | null };

/** One part of a body: where its opening tag starts, and what it says. */
export type CardPart = { start: number; key: string };

function isPart(node: Element, name: string): boolean {
  if (PART_TAGS.has(name)) return true;
  const role = node.attribs?.role?.trim().toLowerCase();
  return role !== undefined && QUESTION_ROLES.has(role);
}

function attributeValue(name: string, value: string): string {
  // A picture's copy is renamed on every call: the same picture, a new name.
  if (name === "src" && value.startsWith(PICTURE_PREFIX)) {
    if (parseCardPictureFileName(value.slice(PICTURE_PREFIX.length))) return "picture";
  }
  if (hookAttributes("demo").includes(name) && value.startsWith(MEDIA_PREFIX)) {
    if (parseCardMediaFileName(value.slice(MEDIA_PREFIX.length))) return "recording";
  }
  return value.replace(/\s+/g, " ").trim();
}

/** A part's markup, normalized: what two versions of it are compared by. */
function keyOf(node: Element, media?: ReadonlyMap<string, string>, includeScripts = false): string {
  if (node.type === ElementType.Text) return (node.data ?? "").replace(/\s+/g, " ").trim();
  if (!ELEMENT_TYPES.has(node.type)) return "";
  const name = node.name?.toLowerCase() ?? "";
  if (HOST_FRAGMENTS.some((attribute) => node.attribs?.[attribute] !== undefined)) return "";
  if (!includeScripts && NON_COPY.has(name)) return "";
  const attributes = Object.entries(node.attribs ?? {})
    .map(
      ([key, value]) =>
        [key.toLowerCase(), media?.get(value) ?? attributeValue(key.toLowerCase(), value)] as const,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  const keys = (node.children ?? [])
    .map((child) => keyOf(child as Element, media, includeScripts))
    .filter(Boolean);
  // A preview's part moves do not change its copy; inline text keeps its order.
  if (
    includeScripts &&
    !(node.children ?? []).some(
      (child) => child.type === ElementType.Text && ((child as Element).data ?? "").trim(),
    )
  )
    keys.sort();
  const inner = keys.join(" ");
  return `<${name}${attributes ? ` ${attributes}` : ""}>${inner}</${name}>`;
}

export function cardParts(body: string, media?: ReadonlyMap<string, string>): CardPart[] {
  const document = parseDocument(body, { decodeEntities: true, withStartIndices: true });
  const parts: CardPart[] = [];
  const walk = (nodes: Element[]): void => {
    for (const node of nodes) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const name = node.name?.toLowerCase() ?? "";
      if (NON_COPY.has(name)) continue;
      if (HOST_FRAGMENTS.some((attribute) => node.attribs?.[attribute] !== undefined)) continue;
      if (isPart(node, name) && typeof node.startIndex === "number") {
        parts.push({ start: node.startIndex, key: keyOf(node, media) });
        continue;
      }
      walk((node.children ?? []) as Element[]);
    }
  };
  walk(document.children as unknown as Element[]);
  return parts;
}

export type CardArea = { start: number; label: string; path: string; stableId?: string };
export type NavigationPart = CardPart & { heading: boolean; area?: CardArea };

/** The same normalized parts, extended with heading context for navigation alone. */
export function cardNavigationParts(
  body: string,
  media?: ReadonlyMap<string, string>,
): NavigationPart[] {
  const document = parseDocument(body, { decodeEntities: true, withStartIndices: true });
  const result: NavigationPart[] = [];
  const headings: Array<{ level: number; area: CardArea }> = [];
  const words = (node: Element): string =>
    node.type === ElementType.Text
      ? (node.data ?? "")
      : NON_COPY.has(node.name ?? "")
        ? ""
        : (node.children ?? []).map((child) => words(child as Element)).join(" ");
  const walk = (nodes: Element[], ownerId?: string): void => {
    for (const node of nodes) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const name = node.name?.toLowerCase() ?? "";
      if (
        NON_COPY.has(name) ||
        HOST_FRAGMENTS.some((attribute) => node.attribs?.[attribute] !== undefined)
      )
        continue;
      const start = node.startIndex;
      const level = /^h[1-6]$/.test(name) ? Number(name[1]) : 0;
      if (level && typeof start === "number") {
        const label = words(node).replace(/\s+/g, " ").trim();
        while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
        const area: CardArea = {
          start,
          label,
          path: JSON.stringify([...headings.map((h) => h.area.label), label]),
          ...(node.attribs?.id || ownerId ? { stableId: node.attribs?.id || ownerId } : {}),
        };
        headings.push({ level, area });
        result.push({ start, key: keyOf(node, media), heading: true, area });
      } else if (isPart(node, name) && typeof start === "number") {
        result.push({
          start,
          key: keyOf(node, media),
          heading: false,
          ...(headings.at(-1) ? { area: headings.at(-1)!.area } : {}),
        });
      } else walk((node.children ?? []) as Element[], node.attribs?.id || ownerId);
    }
  };
  walk(document.children as unknown as Element[]);
  return result;
}

/** Multiset matching is shared with the visual bars: moves are not changes. */
export function unmatchedParts<T extends CardPart>(
  before: readonly CardPart[],
  after: readonly T[],
): { added: T[]; removed: number } {
  const remaining = new Map<string, number>();
  for (const part of before) remaining.set(part.key, (remaining.get(part.key) ?? 0) + 1);
  const added: T[] = [];
  for (const part of after) {
    const left = remaining.get(part.key) ?? 0;
    if (left) remaining.set(part.key, left - 1);
    else added.push(part);
  }
  return { added, removed: [...remaining.values()].reduce((a, b) => a + b, 0) };
}

/** Preview changes can live outside ordinary parts, in their script or style. */
export function normalizedCardMarkup(body: string, media?: ReadonlyMap<string, string>): string {
  const document = parseDocument(body, { decodeEntities: true });
  return document.children
    .map((node) => keyOf(node as Element, media, true))
    .filter(Boolean)
    .sort()
    .join(" ");
}
