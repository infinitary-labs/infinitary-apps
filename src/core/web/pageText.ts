import { ElementType, parseDocument } from "htmlparser2";

/** The parts of a parsed node a page's text is read from. */
type PageNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: PageNode[];
};

/** Elements whose words are never a page's text: code, styles and drawings. */
const SKIPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "head",
  "select",
  "button",
]);

/** Elements that start a line of their own. */
const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "summary",
  "table",
  "tr",
  "ul",
]);

const ELEMENTS = new Set<string>([ElementType.Tag, ElementType.Script, ElementType.Style]);

/**
 * A page's title and its words as plain text: headings marked with `#`,
 * list items with `-`, table cells split by `|`, a link's address after its
 * words, a picture by its description, and preformatted text kept as it is.
 * Scripts, styles and drawings are left out, since no script ever runs.
 */
export function pageText(html: string, base: URL): { title: string; text: string } {
  const document = parseDocument(html, { decodeEntities: true });
  const out: string[] = [];
  let line = "";
  const flush = () => {
    const words = line.replace(/[ \t\f\v ]+/g, " ").trim();
    if (words) out.push(words);
    else if (out.length > 0 && out.at(-1) !== "") out.push("");
    line = "";
  };
  const href = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    try {
      const url = new URL(raw, base);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
  const words = (node: PageNode): string =>
    node.type === ElementType.Text ? (node.data ?? "") : (node.children ?? []).map(words).join("");
  const walk = (nodes: readonly PageNode[]) => {
    for (const node of nodes) {
      if (node.type === ElementType.Text) {
        line += (node.data ?? "").replace(/\s+/g, " ");
        continue;
      }
      if (!ELEMENTS.has(node.type)) continue;
      const name = node.name?.toLowerCase() ?? "";
      if (SKIPPED.has(name) || node.attribs?.hidden !== undefined) continue;
      const children = node.children ?? [];
      if (name === "br") {
        flush();
        continue;
      }
      if (name === "img") {
        const alt = node.attribs?.alt?.trim();
        if (alt) line += ` [picture: ${alt}] `;
        continue;
      }
      if (name === "pre") {
        flush();
        const kept = words(node).replace(/\n+$/, "");
        out.push(...kept.split("\n"));
        flush();
        continue;
      }
      const heading = /^h([1-6])$/.exec(name);
      if (heading || BLOCKS.has(name)) {
        flush();
        if (heading) line = `${"#".repeat(Number(heading[1]))} `;
        else if (name === "li") line = "- ";
        walk(children);
        flush();
        continue;
      }
      if (name === "td" || name === "th") {
        if (line.trim()) line += " | ";
        walk(children);
        continue;
      }
      if (name === "a") {
        const before = line.length;
        walk(children);
        const shown = line.slice(before).trim();
        const target = href(node.attribs?.href);
        if (target && target !== shown) line += ` (${target})`;
        continue;
      }
      walk(children);
    }
  };
  const find = (nodes: readonly PageNode[]): PageNode | undefined => {
    for (const node of nodes) {
      if (node.name?.toLowerCase() === "title") return node;
      const found = find(node.children ?? []);
      if (found) return found;
    }
    return undefined;
  };
  const nodes = document.children as unknown as PageNode[];
  const titled = find(nodes);
  const title = titled ? words(titled).replace(/\s+/g, " ").trim() : "";
  walk(nodes);
  flush();
  while (out.at(-1) === "") out.pop();
  return { title, text: out.join("\n") };
}
