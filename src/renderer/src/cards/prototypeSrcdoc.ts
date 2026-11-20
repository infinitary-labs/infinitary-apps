import { cardBodyMarkup, escapeHtml } from "@shared/cardBodyMarkup";
import { cardTypefaceNames } from "@shared/cardPictures";
import { SRCDOC_FRAME_CSP } from "@shared/plugins/containment";
import {
  buildFrameDocument,
  FRAME_TEMPLATE_MAX_BYTES,
  type FrameTheme,
} from "@shared/plugins/frameDocument";
import { frameStylesheet } from "../plugins/frames/frameStylesheet";

/**
 * A card body is agent-authored HTML, rendered VERBATIM inside an
 * opaque-origin frame. There is no sanitizer (captain decision, 2026-09-15,
 * direction C; `docs/live-prototype-security.md`): the boundary is the
 * `<iframe sandbox="allow-scripts">`, the frame CSP (`default-src 'none'`,
 * every script by hash), and the host's validation of every bridge message.
 * The audit measured that boundary against the whole attack corpus with no
 * sanitizer at all and nothing executed, nothing loaded, nothing left the
 * machine; the allowlists only ever degraded honest markup.
 *
 * Two vehicles, one policy. A body with no `<script>` is data and rides
 * srcdoc under the document this builds, whose CSP pins the bridge alone -
 * so a `<script>` that arrived some other way still cannot run. A body that
 * carries its own inline script takes the mount path instead
 * (`PrototypeBody.tsx`), where the host hashes each script and serves the
 * markup unchanged but for the change bars (`src/main/frames/frameMounts.ts`).
 * So does a body that draws in a project's own font, so the font engine
 * reads a file the app did not make in a renderer process of its own; the
 * srcdoc document's policy admits only the design system's typefaces, so a
 * kept font named some way the vehicle test missed loads nothing there.
 */
export const PROTOTYPE_FRAME_CSP = SRCDOC_FRAME_CSP;

export { cardBodyHtml, cardBodyMarkup, escapeHtml } from "@shared/cardBodyMarkup";

/**
 * Whether a body asks for the mount path: it carries a `<script>` element,
 * or it names a kept project font at the frame scheme's `typefaces` host
 * (docs/card-authoring.md "Fonts by reference").
 */
export function cardBodyMounts(body: string): boolean {
  return /<script[\s>/]/i.test(body) || cardTypefaceNames(body).length > 0;
}

/**
 * Which vehicle draws a body (INF-3887): `srcdoc` for a body that does not
 * mount; `mount` for one that does; `words` for one that would mount but
 * whose served markup is over the limit the host's mount takes
 * (`FRAME_TEMPLATE_MAX_BYTES`). That body rides srcdoc instead, which has no
 * limit and whose policy runs none of its scripts: its words, tables,
 * pictures and still drawings open, under one line saying its drawings are
 * off. `marks` are the change bars the served markup carries.
 */
export function cardBodyVehicle(
  body: string,
  marks: readonly number[] = [],
): "srcdoc" | "mount" | "words" {
  if (!cardBodyMounts(body)) return "srcdoc";
  return cardBodyMarkup(body, marks).html.length > FRAME_TEMPLATE_MAX_BYTES ? "words" : "mount";
}

/**
 * How far the body's text moves right, inside the frame, while it carries
 * change bars, and how far the frame reaches left into the card's padding
 * to make that room - so the text stays exactly where it was.
 */
export const CHANGE_GUTTER_PX = 8;

export function buildPrototypeSrcdoc(
  body: string,
  theme: FrameTheme,
  marks: readonly number[] = [],
  fontStyle = "",
): string {
  return buildFrameDocument({
    csp: PROTOTYPE_FRAME_CSP,
    theme,
    // The window's chosen fonts, after the tokens they set (docs/fonts.md).
    style: fontStyle ? `${cardStylesheet()}\n${fontStyle}` : cardStylesheet(),
    html: cardBodyMarkup(body, marks).html,
    // Its animations wait until the card is shown, as a scripted page's do.
    held: true,
  });
}

/**
 * The measure a card body keeps in any width (the captain's Q7 A of
 * 2026-09-28): prose - paragraphs, lists, headings, captions, summaries -
 * holds a 66-character line, while tables, code, picture groups and figures
 * take the room a wide card gives them. In the usual 510 px column 66
 * characters is wider than the column, so a regular card reads as before.
 * A card's own rule, never a template's: panels and plugin frames lay out
 * their own measure.
 */
export const CARD_MEASURE_STYLE = `
  /* HtmlCardBody owns the vertical inset outside this auto-sized viewport.
     flow-root keeps child margins in the measured body without padding. */
  body { padding-block: 0; display: flow-root; }
  :is(p, ul, ol, dl, blockquote, h1, h2, h3, h4, h5, h6, figcaption, summary) { max-width: 66ch; }
  /* A group's caption is its own line under the strip (flex-basis 100%): a
     narrower box would let it rise beside the thumbnails, so the line keeps
     the group's width and its text keeps the measure. */
  .inf-pictures > figcaption { max-width: none; padding-right: max(0px, calc(100% - 66ch)); }
`;

/**
 * The change bars (design skill ResponseCard, "revised line"): a 2 px
 * `--accent` rule the height of each new part, all in one column in the
 * margin, 8 px left of the text. The body's text moves right by the gutter
 * the frame borrowed from the card's padding, so it does not move on screen.
 * A bar whose part is not drawn - inside a closed `<details>` - is hidden.
 */
export const CARD_CHANGES_STYLE = `
  body:has([data-inf-bars]) { padding-left: calc(var(--space-1) + ${CHANGE_GUTTER_PX}px); }
  [data-inf-bar] {
    position: absolute; left: calc(var(--space-1) - 2px); width: 2px;
    top: anchor(top); bottom: anchor(bottom);
    position-visibility: anchors-visible;
    border-radius: var(--radius-pill); background: var(--accent); pointer-events: none;
  }
`;

/**
 * The spacer a body carries at its start while the card's chrome holds a
 * box over its top right - a merge card's risk chart (docs/card-authoring.md
 * "The risk chart"). It is the app's, never the author's, and empty.
 */
export const INSET_SPACER = '<div data-inf-inset="" aria-hidden="true"></div>';

/**
 * The spacer's box (design skill ResponseCard, "The risk chart"): floated
 * right, as wide and tall as the chrome's box the bridge sets
 * (`--inf-inset-width` from the frame's right edge, less the body's own
 * padding, and `--inf-inset-height` from its top), so the first lines flow
 * around the chrome. From the body's third heading on - Before, After and
 * every section below - a heading clears it, so those take the body's whole
 * width whatever the chrome's height. A section the author wrapped counts
 * by the heading inside it. A bordered panel beside the box keeps its
 * border clear of it too, as its lines do (the merge line of a self-merging
 * task's note, INF-1219).
 */
export const CARD_INSET_STYLE = `
  [data-inf-inset] {
    float: right; clear: right; margin: 0;
    width: max(0px, calc(var(--inf-inset-width, 0px) - var(--space-1)));
    height: var(--inf-inset-height, 0px);
  }
  [data-inf-inset] ~ .inf-panel { display: flow-root; }
  [data-inf-inset] ~ :nth-child(n + 3 of :is(h1, h2, h3, h4, h5, h6, :has(:is(h1, h2, h3, h4, h5, h6)))) {
    clear: right;
  }
`;

/**
 * A merge card's after-merge strip (`afterMergeStrip.ts`; design skill
 * ResponseCard, "After merging"): a panel leading the body, the captain's
 * lead alone in the warning color, each step's title in the body's
 * strongest color and its lines beneath in the body's own.
 */
export const AFTER_MERGE_STYLE = `
  [data-inf-after-merge] { margin: 0 0 var(--space-3); padding: var(--space-2) var(--space-3); color: var(--fg-2); }
  [data-inf-after-merge] p { margin: 0; }
  [data-inf-after-merge] section + section { margin-top: var(--space-2); }
  [data-inf-after-merge-lead] { color: var(--fg-1); }
  [data-inf-after-merge-lead="captain"] { color: var(--warn); }
  [data-inf-after-merge] ul { margin: var(--space-1) 0 0; padding-left: var(--space-4); }
  [data-inf-after-merge] li + li { margin-top: var(--space-2); }
  [data-inf-after-merge] li > span { color: var(--fg-1); }
`;

let cardStyle: string | undefined;

/** The design system's stylesheet and the card's measure; a body's own `<style>` rides its markup. */
export function cardStylesheet(): string {
  cardStyle ??= `${frameStylesheet()}\n${CARD_MEASURE_STYLE}\n${CARD_CHANGES_STYLE}\n${CARD_INSET_STYLE}\n${AFTER_MERGE_STYLE}\n${REVISION_HIGHLIGHT_STYLE}`;
  return cardStyle;
}

export const REVISION_HIGHLIGHT_STYLE = `
  [data-inf-revision-highlight] { background-color: var(--accent-dim); box-shadow: var(--focus-ring-inset); }
`;

/**
 * The stamp a part's full-screen copy opens with, before the body so the
 * part's own script reads it as it starts (`inf.expanded`). A state the copy
 * cannot read opens the part as the body has it.
 */
export function expandedStamp(index: number, state: string): string {
  let opened: unknown = null;
  try {
    opened = JSON.parse(state);
  } catch {
    opened = null;
  }
  // i18n-exempt: not shown (markup)
  return `<i hidden data-inf-expanded="${escapeHtml(JSON.stringify({ index, state: opened }))}"></i>`;
}
