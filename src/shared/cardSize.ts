import { parseDocument } from "htmlparser2";
import { cardBodyMarkup } from "./cardBodyMarkup";
import { type DomNode, ELEMENT_TYPES } from "./cardHeadings";
import { cardNavigationParts } from "./cardParts";
import { servedNumber } from "./i18n/format";
import { FRAME_TEMPLATE_MAX_BYTES } from "./plugins/frameDocument";

/**
 * Every card is measured before it is shown (INF-3887): the window refuses a
 * card frame whose markup is longer than `FRAME_TEMPLATE_MAX_BYTES`, so a card
 * past it is handed back to its author with its size, the limit and each
 * part's size, and the captain never sees a card that cannot open. The
 * measure reads the same markup function and the same limit the window does.
 */

type Element = DomNode & {
  attribs?: Record<string, string>;
  startIndex?: number | null;
  endIndex?: number | null;
};

/** One top-level part of a body and how many characters of it reach the window. */
export type CardSizePart = { label: string; length: number };

/** The parts a refusal names, largest first; the rest are counted together. */
const NAMED_PARTS = 6;

/**
 * How long the card's markup is as the window's card frame receives it: the
 * body as markup with every change bar it could carry, since a later revision
 * marks its new parts. Characters, as the window's limit counts them.
 */
export function cardWindowLength(body: string): number {
  const starts = cardNavigationParts(body).map((part) => part.start);
  return cardBodyMarkup(body, starts).html.length;
}

const words = (node: Element): string =>
  node.type === "text"
    ? ((node as { data?: string }).data ?? "")
    : (node.children ?? []).map((child) => words(child as Element)).join(" ");

/** Whether a part carries the architecture map part's data block (`@shared/mapPart`). */
function holdsMapData(node: Element): boolean {
  if (node.name === "script" && Object.hasOwn(node.attribs ?? {}, "data-map")) return true;
  return (node.children ?? []).some((child) => holdsMapData(child as Element));
}

/** A part's name in a refusal: what the host marked it, else its own first words, else its tag. */
function partLabel(node: Element, heading: string | undefined): string {
  const name = node.name?.toLowerCase() ?? "";
  const attribs = node.attribs ?? {};
  const kind = Object.hasOwn(attribs, "data-live-validation")
    ? "live validation table"
    : holdsMapData(node)
      ? "architecture map"
      : undefined;
  const said = words(node).replace(/\s+/g, " ").trim();
  const own = said.length > 48 ? `${said.slice(0, 47)}…` : said;
  const label = kind ?? (own ? `<${name}> "${own}"` : `<${name}>`);
  return heading && !/^h[1-6]$/.test(name) ? `${label} under "${heading}"` : label;
}

/**
 * The body's top-level parts by size, largest first. A body wrapped whole in
 * one element is read one level in, so its parts are the wrapper's own.
 */
export function cardSizeParts(body: string): CardSizePart[] {
  const document = parseDocument(body, { withStartIndices: true, withEndIndices: true });
  let nodes = (document.children as unknown as Element[]).filter((node) =>
    ELEMENT_TYPES.has(node.type),
  );
  while (nodes.length === 1 && nodes[0]?.children?.length) {
    nodes = (nodes[0].children as Element[]).filter((node) => ELEMENT_TYPES.has(node.type));
  }
  let heading: string | undefined;
  const parts: CardSizePart[] = [];
  for (const node of nodes) {
    const start = node.startIndex ?? 0;
    const end = node.endIndex ?? start;
    if (/^h[1-6]$/.test(node.name?.toLowerCase() ?? "")) {
      heading = words(node).replace(/\s+/g, " ").trim() || heading;
    }
    parts.push({ label: partLabel(node, heading), length: end - start + 1 });
  }
  return parts.sort((a, b) => b.length - a.length);
}

const count = (n: number) => servedNumber(n);

/**
 * Undefined when the window opens the card; otherwise the refusal its author
 * reads: the card's size as the window would receive it, the limit, and each
 * part's size, largest first. `shrink` says how this author makes it smaller.
 */
export function cardSizeRefusal(
  body: string,
  shrink = "Make its largest parts smaller, then show the card again.",
): string | undefined {
  const length = cardWindowLength(body);
  if (length <= FRAME_TEMPLATE_MAX_BYTES) return undefined;
  const parts = cardSizeParts(body);
  const named = parts.slice(0, NAMED_PARTS).map((part) => `${part.label}: ${count(part.length)}`);
  const rest = parts.slice(NAMED_PARTS);
  if (rest.length)
    named.push(
      `${rest.length} smaller ${rest.length === 1 ? "part" : "parts"}: ${count(rest.reduce((sum, part) => sum + part.length, 0))}`,
    );
  return `Card refused: the window would receive it at ${count(length)} characters, over its limit of ${count(FRAME_TEMPLATE_MAX_BYTES)}, so it could not open. Its parts by size, in characters: ${named.join("; ")}. ${shrink}`;
}
