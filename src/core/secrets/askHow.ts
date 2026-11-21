import { isSafeCardHref } from "@shared/linkify";
import { ElementType, parseDocument } from "htmlparser2";

/**
 * The "How to get it" part of an ask to keep a secret (docs/secrets.md,
 * "Asking to keep a secret"; INF-5516's plan with the captain's write-in):
 * an HTML fragment the asker designs, such as numbered steps, a table of
 * scopes or a folded section, drawn on Infinitary's own card. The asker
 * chooses its shape; the host only checks closed facts about it and draws
 * it again from its parsed elements, never the asker's own string:
 *
 * - only the elements and attributes below, so the part holds no script,
 *   style, form field, picture or hook into the card's own controls;
 * - a class only from the frame stylesheet's layout classes;
 * - every link a safe address (`isSafeCardHref`) whose text is the address
 *   itself, so the captain sees where it goes before signing in there.
 *
 * Nothing here reads the words.
 */
export type SecretAskHow = { html: string } | { problem: string };

/** What the parser hands back, read structurally (as `cardLint.ts` reads it). */
type DomNode = {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
};

/** Each element the part may hold, and the attributes it may carry beside `class`. */
const ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  p: [],
  br: [],
  hr: [],
  ol: [],
  ul: [],
  li: [],
  dl: [],
  dt: [],
  dd: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  code: [],
  kbd: [],
  mark: [],
  pre: [],
  blockquote: [],
  h3: [],
  h4: [],
  h5: [],
  small: [],
  sub: [],
  sup: [],
  span: [],
  div: [],
  section: [],
  a: ["href"],
  table: [],
  caption: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
  details: ["open"],
  summary: [],
  figure: [],
  figcaption: [],
};
/** The frame stylesheet's layout classes (`frameStylesheet.ts`); none of them draws a host line. */
const CLASSES = new Set(["inf-mono", "inf-muted", "inf-row", "inf-grid", "inf-panel"]);
const VOID = new Set(["br", "hr"]);
/** Attributes whose value is a small whole number, or none at all. */
const NUMBERED = new Set(["colspan", "rowspan"]);

// i18n-exempt: served to the asking agent, which reads English
const ALLOWED_WORDS =
  "Use only text, headings, paragraphs, lists, tables, details, code, kbd, mark and links.";

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");

/**
 * A link's own text: a link holds text alone, so nothing inside it, such as a
 * closed <details>, can hide part of the address it shows.
 */
function linkText(nodes: readonly DomNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === ElementType.Text) text += node.data ?? "";
    else if (node.type !== ElementType.Comment)
      throw new Refused(
        // i18n-exempt: served to the asking agent, which reads English
        "A link in the how-to holds only its address as text, with no element inside it. Put any words or formatting outside the link.",
      );
  }
  return text;
}

/** An address as a link's text may show it: with or without its https:// and a last slash. */
function sameAddress(text: string, href: string): boolean {
  const bare = (value: string) =>
    value
      .trim()
      .replace(/^https:\/\//i, "")
      .replace(/\/$/, "");
  return bare(text) === bare(href) && bare(text) !== "";
}

class Refused extends Error {}

function element(node: DomNode): string {
  const name = (node.name ?? "").toLowerCase();
  const attribs = node.attribs ?? {};
  const children = node.children ?? [];
  const allowed = ELEMENTS[name];
  if (!allowed)
    // i18n-exempt: served to the asking agent, which reads English
    throw new Refused(
      `The how-to holds <${name}>, which a card asking for a secret does not take. ${ALLOWED_WORDS}`,
    );
  const attributes: string[] = [];
  for (const [rawKey, value] of Object.entries(attribs)) {
    const key = rawKey.toLowerCase();
    if (key === "class") {
      const classes = value.split(/\s+/).filter(Boolean);
      const other = classes.find((one) => !CLASSES.has(one));
      if (other)
        // i18n-exempt: served to the asking agent, which reads English
        throw new Refused(
          `The how-to's class "${other}" is not one it may use: only ${[...CLASSES].join(", ")}. It takes no style of its own.`,
        );
      if (classes.length) attributes.push(`class="${escapeAttribute(classes.join(" "))}"`);
      continue;
    }
    if (!allowed.includes(key))
      // i18n-exempt: served to the asking agent, which reads English
      throw new Refused(
        `The how-to's <${name}> carries the attribute ${key}, which it may not: no style, id, data-, on- or other attribute beyond class, a link's href, a cell's colspan or rowspan and details' open.`,
      );
    if (key === "open") {
      attributes.push("open");
      continue;
    }
    if (NUMBERED.has(key)) {
      if (!/^\d{1,3}$/.test(value.trim()))
        // i18n-exempt: served to the asking agent, which reads English
        throw new Refused(`The how-to's ${key} must be a whole number.`);
      attributes.push(`${key}="${value.trim()}"`);
      continue;
    }
    // href, on a link alone.
    const href = value.trim();
    if (!isSafeCardHref(href))
      // i18n-exempt: served to the asking agent, which reads English
      throw new Refused(
        `The how-to links to "${href}", which is not a secure web address: give each link as https://... in full.`,
      );
    if (!sameAddress(linkText(children), href))
      // i18n-exempt: served to the asking agent, which reads English
      throw new Refused(
        `A link in the how-to must show its own address as its text, so the captain sees where it goes before signing in: <a href="${href}">${href}</a>. Put any words about it outside the link.`,
      );
    attributes.push(`href="${escapeAttribute(href)}"`);
  }
  if (name === "a" && !("href" in attribs))
    // i18n-exempt: served to the asking agent, which reads English
    throw new Refused("A link in the how-to needs its href.");
  const open = `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
  if (VOID.has(name)) return open;
  return `${open}${nodes(children)}</${name}>`;
}

function nodes(list: readonly DomNode[]): string {
  let html = "";
  for (const node of list) {
    if (node.type === ElementType.Text) html += escapeText(node.data ?? "");
    else if (node.type === ElementType.Comment) continue;
    else if (
      node.type === ElementType.Tag ||
      node.type === ElementType.Script ||
      node.type === ElementType.Style
    )
      html += element(node);
    else
      throw new Refused(
        // i18n-exempt: served to the asking agent, which reads English
        `The how-to holds markup that is not an element or text, such as a doctype or CDATA. ${ALLOWED_WORDS}`,
      );
  }
  return html;
}

/**
 * The how-to as the card draws it, or why it is refused, in words for the
 * asker. An empty one is no how-to at all.
 */
export function secretAskHow(fragment: string): SecretAskHow | undefined {
  if (!fragment.trim()) return undefined;
  try {
    const html = nodes(
      parseDocument(fragment, { lowerCaseAttributeNames: true }).children as DomNode[],
    );
    return html.trim() ? { html } : undefined;
  } catch (error) {
    if (error instanceof Refused) return { problem: error.message };
    throw error;
  }
}
