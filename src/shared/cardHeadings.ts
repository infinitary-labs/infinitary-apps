import { ElementType, parseDocument } from "htmlparser2";

/**
 * What a card body's headings ARE, in one place (delivery rigor phase 4).
 *
 * The emit-card shape lint reads them through htmlparser2, never a regex
 * over markup; completion cards have their own outline, while the rigor
 * numbers continue to read the report's five evidence headings.
 *
 * Plain and alias-free on purpose: the offline exporters import this file
 * by relative path under Node's type stripping.
 */

/** Finished code-work cards' loose outline, not the report's evidence contract. */
export const COMPLETION_CARD_HEADINGS = ["Why", "What changed", "Before", "After"] as const;

/** Elements whose text is never card copy. */
export const NON_COPY = new Set(["script", "style", "template"]);

export const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** htmlparser2 types script and style elements apart from other tags. */
export const ELEMENT_TYPES = new Set<string>([
  ElementType.Tag,
  ElementType.Script,
  ElementType.Style,
]);

/** The slice of an htmlparser2 node the shape rules read. */
export type DomNode = { type: string; data?: string; name?: string; children?: DomNode[] };

/** Every visible text node under one element, joined - script and style excluded. */
export function textOf(node: DomNode): string {
  if (node.type === ElementType.Text) return node.data ?? "";
  if (!ELEMENT_TYPES.has(node.type) || NON_COPY.has(node.name?.toLowerCase() ?? "")) return "";
  return (node.children ?? []).map(textOf).join(" ");
}

/**
 * Every heading element's text in document order, whitespace-collapsed. A
 * heading inside script, style or template is not copy and is not one.
 */
export function bodyHeadings(body: string): string[] {
  const document = parseDocument(body, { decodeEntities: true });
  const headings: string[] = [];
  const walk = (nodes: DomNode[]): void => {
    for (const node of nodes) {
      if (!ELEMENT_TYPES.has(node.type)) continue;
      const name = node.name?.toLowerCase() ?? "";
      if (NON_COPY.has(name)) continue;
      if (HEADING_TAGS.has(name)) headings.push(textOf(node).replace(/\s+/g, " ").trim());
      walk(node.children ?? []);
    }
  };
  walk(document.children as unknown as DomNode[]);
  return headings;
}
