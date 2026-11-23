import { type DomNode, ELEMENT_TYPES, NON_COPY, textOf } from "@shared/cardHeadings";
import { type CardPicture, type CardWidth, isPreviewBody, widerCardWidth } from "@shared/cards";
import { hasHookClass } from "@shared/codeNames";
import { parseDocument } from "htmlparser2";

/** Closed markup facts decide required room; short plain copy is the only narrow exception. */
export const NARROW_COPY_LIMIT = 600;
const PLAIN_TAGS = new Set([
  "p",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "span",
  "div",
  "strong",
  "em",
  "b",
  "i",
  "small",
  "br",
  "hr",
  "mark",
  "kbd",
  "code",
  "details",
  "summary",
  "button",
]);

const COPY_BREAKS = new Set([
  "p",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div",
  "br",
  "hr",
  "details",
  "summary",
]);

/** Count visible copy, not folded details; an unknown/visual/control tag is not plain copy. */
function shortPlainBody(body: string): boolean {
  const document = parseDocument(body, { decodeEntities: true });
  let plain = true;
  const copy: string[] = [];
  const walk = (nodes: Node[], visible = true): void => {
    for (const node of nodes) {
      if (node.type === "text") {
        if (visible) copy.push(node.data ?? "");
        continue;
      }
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const name = node.name?.toLowerCase() ?? "";
      if (!PLAIN_TAGS.has(name)) plain = false;
      if (NON_COPY.has(name)) continue;
      if (visible && COPY_BREAKS.has(name)) copy.push(" ");
      if (name === "details" && node.attribs?.open === undefined) {
        for (const child of node.children ?? []) {
          walk([child as Node], visible && child.name?.toLowerCase() === "summary");
        }
      } else walk((node.children ?? []) as Node[], visible);
      if (visible && COPY_BREAKS.has(name)) copy.push(" ");
    }
  };
  walk(document.children as unknown as Node[]);
  return plain && copy.join("").replace(/\s+/g, " ").trim().length < NARROW_COPY_LIMIT;
}

export const WIDE_TABLE_COLUMNS = 4;
export const FULL_TABLE_COLUMNS = 6;
/** A `<pre>` line longer than this wraps in the usual 510 px column. */
export const WIDE_PRE_CHARS = 60;
export const WIDE_PICTURE_PX = 900;
export const FULL_PICTURE_PX = 1_600;

type Node = DomNode & { attribs?: Record<string, string> };

function rowColumns(row: Node): number {
  let columns = 0;
  for (const cell of row.children ?? []) {
    const name = (cell as Node).name?.toLowerCase();
    if (name !== "td" && name !== "th") continue;
    const span = Number.parseInt((cell as Node).attribs?.colspan ?? "1", 10);
    columns += Number.isFinite(span) && span > 0 ? span : 1;
  }
  return columns;
}

function longestLine(node: Node): number {
  return Math.max(
    0,
    ...textOf(node)
      .split("\n")
      .map((line) => line.trimEnd().length),
  );
}

function markupWidth(body: string): CardWidth {
  const document = parseDocument(body, { decodeEntities: true });
  let width: CardWidth = "regular";
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const name = node.name?.toLowerCase() ?? "";
      if (NON_COPY.has(name)) continue;
      if (name === "tr") {
        const columns = rowColumns(node);
        if (columns >= FULL_TABLE_COLUMNS) width = "full";
        else if (columns >= WIDE_TABLE_COLUMNS) width = widerCardWidth(width, "wide");
      } else if (name === "pre" && longestLine(node) > WIDE_PRE_CHARS) {
        width = widerCardWidth(width, "wide");
      } else if (name === "figure") {
        const pictures = (node.children ?? []).filter(
          (child) => (child as Node).name?.toLowerCase() === "img",
        );
        if (hasHookClass(node.attribs?.class, "pictures") && pictures.length >= 2) {
          width = widerCardWidth(width, "wide");
        }
      }
      walk((node.children ?? []) as Node[]);
    }
  };
  walk(document.children as unknown as Node[]);
  return width;
}

/** The pictures' facts, from the sizes the host verified (never an attribute the body wrote). */
function picturesWidth(pictures: readonly CardPicture[]): CardWidth {
  let width: CardWidth = "regular";
  for (const picture of pictures) {
    if (picture.width >= FULL_PICTURE_PX) return "full";
    if (picture.width >= WIDE_PICTURE_PX) width = "wide";
  }
  return width;
}

/** The width a body's facts ask for, before any hint. */
export function contentCardWidth(body: string, pictures: readonly CardPicture[] = []): CardWidth {
  const facts = widerCardWidth(markupWidth(body), picturesWidth(pictures));
  return isPreviewBody(body) ? widerCardWidth(facts, "wide") : facts;
}

/**
 * The width the host stores on the card: the body's facts, widened by the
 * author's hint and never narrowed by it. Undefined is default-wide; regular is a short plain note.
 */
export function decidedCardWidth(input: {
  body: string;
  pictures?: readonly CardPicture[];
  width?: "wide" | "full";
}): CardWidth | undefined {
  const width = widerCardWidth(contentCardWidth(input.body, input.pictures), input.width);
  if (width !== "regular") return width;
  return !input.pictures?.length && shortPlainBody(input.body) ? "regular" : undefined;
}
