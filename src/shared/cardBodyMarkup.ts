import { withAppParts } from "./appParts";
import { cardNavigationParts } from "./cardParts";
import { REVISION_TARGETS_MAX } from "./cards";
import { isSafeCardHref, splitCardBodyUrls } from "./linkify";

/**
 * The markup a card body reaches the window as: the window's card frame
 * serves it (`src/renderer/src/cards/prototypeSrcdoc.ts`, `PrototypeBody.tsx`),
 * and the core measures it before a card is shown (`./cardSize`), so the two
 * read one function.
 */

/**
 * The body as markup. A body with no tags at all is legacy plain text -
 * early cards and a few backends still write it - so it becomes paragraphs
 * with its safe URLs linked; anything else is the author's own document.
 */
export function cardBodyHtml(body: string): string {
  return /<[a-z][\s\S]*>/i.test(body) ? body : plainTextBody(body);
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function plainTextBody(text: string): string {
  const linked = splitCardBodyUrls(text)
    .map((part) => {
      const escaped = escapeHtml(part.value);
      return part.type === "url" && isSafeCardHref(part.value)
        ? `<a href="${escaped}">${escaped}</a>`
        : escaped;
    })
    .join("");
  return linked
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("");
}

/**
 * The body as markup with a change bar beside each new part (the design
 * skill's ResponseCard "revised line"; docs/card-authoring.md "What changed
 * since you looked"). `marks` are where each new part's opening tag starts
 * in the body, as the core read it; each such tag gains `data-inf-changed`, and
 * one bar per part, anchored to it, follows the body - so a paragraph, a
 * list item, a table row, a figure and a question are marked alike and
 * nothing inside a part changes. `marked` is false when no offset named a
 * tag, and the markup is then the body's own but for its parts (below).
 * The internal marker is separate from the author's `data-inf-new` picture tag.
 * Last, each app part the body names takes this build's own code in its place
 * (`withAppParts`; docs/card-authoring.md, "Parts by reference"), after every
 * offset above was read against the body as written, so every reader that
 * draws or hashes the body's scripts draws the part's.
 */
export function cardBodyMarkup(
  body: string,
  marks: readonly number[] = [],
): { html: string; marked: boolean } {
  const html = cardBodyHtml(body);
  if (html !== body) return { html, marked: false };
  const parts = cardNavigationParts(body);
  const targets = parts.length <= REVISION_TARGETS_MAX ? parts.map((p) => p.start) : [];
  const starts = [...new Set([...marks, ...targets])].sort((a, b) => b - a);
  let marked = html;
  const bars: number[] = [];
  for (const start of starts) {
    const tag = /^<[a-z][^\s/>]*/i.exec(marked.slice(start, start + 64));
    if (!tag) continue;
    const at = start + tag[0].length;
    const n = bars.length;
    const changed = marks.includes(start);
    marked = `${marked.slice(0, at)}${targets.includes(start) ? ` data-inf-target="${start}"` : ""}${changed ? ` data-inf-changed="${n}"` : ""}${marked.slice(at)}`;
    if (changed) bars.push(n);
  }
  if (bars.length === 0) return { html: withAppParts(marked), marked: false };
  // Each bar needs its own anchor name; the names ride a style block, never
  // the part's own style attribute, which the author may have written.
  const anchors = bars.map((n) => `[data-inf-changed="${n}"]{anchor-name:--fm-new-${n}}`).join("");
  const drawn = bars
    .map((n) => `<i data-inf-bar="" style="position-anchor:--fm-new-${n}"></i>`)
    .join("");
  // i18n-exempt: not shown (markup)
  return {
    html: `${withAppParts(marked)}<style>${anchors}</style><div data-inf-bars="" aria-hidden="true">${drawn}</div>`,
    marked: true,
  };
}
