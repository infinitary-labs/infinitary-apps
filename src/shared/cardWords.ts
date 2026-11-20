import { ElementType, parseDocument } from "htmlparser2";
import { type DomNode, ELEMENT_TYPES, NON_COPY } from "./cardHeadings";

/** Elements that stand apart from the words around them, as a paragraph does. */
const PARAGRAPHS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

/** Elements that start a line of their own. */
const LINES = new Set(["caption", "dd", "div", "dt", "figcaption", "legend", "summary", "tr"]);

/** What a picture shows the card keeps; its labels are not sentences. */
const DRAWINGS = new Set(["audio", "canvas", "iframe", "img", "object", "svg", "video"]);

const LINE = 1;
const PARAGRAPH = 2;

/** Words, a break of at least that strength, or a list item's mark. */
type Piece = string | typeof LINE | typeof PARAGRAPH | { mark: string };

type Node = DomNode & { attribs?: Record<string, string> };

/** `tight` inside a list item: what would stand apart there only starts a line. */
function pieces(
  nodes: Node[],
  into: Piece[],
  list?: { ordered: boolean; count: number },
  tight = false,
): void {
  for (const node of nodes) {
    if (node.type === ElementType.Text) {
      into.push(node.data ?? "");
      continue;
    }
    if (!ELEMENT_TYPES.has(node.type)) continue;
    const name = node.name?.toLowerCase() ?? "";
    if (NON_COPY.has(name) || DRAWINGS.has(name) || node.attribs?.hidden !== undefined) continue;
    if (name === "br") {
      into.push(LINE);
      continue;
    }
    if (name === "td" || name === "th") {
      pieces(node.children ?? [], into, list, tight);
      into.push(" ");
      continue;
    }
    if (name === "li") {
      if (list) list.count += 1;
      into.push(LINE, { mark: list?.ordered ? `${list.count}. ` : "- " });
      pieces(node.children ?? [], into, undefined, true);
      into.push(LINE);
      continue;
    }
    const gap = PARAGRAPHS.has(name) ? (tight ? LINE : PARAGRAPH) : LINES.has(name) ? LINE : 0;
    if (gap) into.push(gap);
    const inner = name === "ol" || name === "ul" ? { ordered: name === "ol", count: 0 } : list;
    pieces(node.children ?? [], into, inner, tight);
    if (gap) into.push(gap);
  }
}

/**
 * A card body's words, for a place that shows text rather than the card -
 * the task record, where a standalone answer is kept as its note card's
 * body (FI3-904). Paragraphs, headings, lists and figures stand apart, a
 * list item opens its own line with a dash (or its number), and a drawing,
 * a picture or a hidden element says nothing: the card itself keeps them.
 */
export function cardWords(body: string): string {
  const all: Piece[] = [];
  pieces(parseDocument(body, { decodeEntities: true }).children as unknown as Node[], all);
  let words = "";
  let owed = 0;
  let mark = "";
  for (const piece of all) {
    if (typeof piece === "number") {
      owed = Math.max(owed, piece);
      continue;
    }
    if (typeof piece === "object") {
      mark = piece.mark;
      continue;
    }
    const text = piece.replace(/\s+/g, " ");
    if (!text.trim()) {
      // Space between words on one line; a break or a mark replaces it.
      if (words && !owed && !mark) words += " ";
      continue;
    }
    if (!owed && !mark) {
      words += text;
      continue;
    }
    if (words) words = `${words.trimEnd()}${owed === PARAGRAPH ? "\n\n" : "\n"}`;
    words += mark + text.trimStart();
    owed = 0;
    mark = "";
  }
  return words
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .trim();
}
