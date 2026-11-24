import { AS_BUILT_WORDS, DEFAULT_WORDS } from "@shared/plugins/bridge";
import { frameFontUrl, PANEL_ROOT_ID } from "@shared/plugins/frameDocument";
import revealsCss from "../../design/reveals.css?raw";
import colorsCss from "../../design/tokens/colors.css?raw";
import effectsCss from "../../design/tokens/effects.css?raw";
import fontsCss from "../../design/tokens/fonts.css?raw";
import spacingCss from "../../design/tokens/spacing.css?raw";
import typographyCss from "../../design/tokens/typography.css?raw";

/**
 * The stylesheet every plugin frame carries: the design system's tokens,
 * its typefaces, and the base rules for semantic markup (docs/ui-plugins.md).
 * One stylesheet for card bodies and template mounts alike, so a frame is
 * on-brand by construction and a template styles only what is its own.
 *
 * Fonts are the phase-1 fix for the fonts-in-frames papercut: the vendored
 * `fonts.css` names its files relative to the app's stylesheet, which an
 * opaque-origin frame can neither resolve nor fetch. The frame copy points
 * the same faces at `app-frame://fonts/<file>`, which the host serves with
 * CORS from the one vendored copy (src/main/frames/). The test pins that
 * every face here names a file the directory holds.
 */

const FONT_ASSET_PREFIX = "../assets/fonts/";
const FONT_URL = /url\(\s*['"]?\.\.\/assets\/fonts\/([A-Za-z0-9._-]+)['"]?\s*\)/g;

export function frameFontFaces(css: string = fontsCss): string {
  return css.replaceAll(FONT_URL, (_match, file: string) => `url(${frameFontUrl(file)})`);
}

export function frameFontFileNames(css: string = fontsCss): string[] {
  const names: string[] = [];
  for (const match of css.matchAll(FONT_URL)) {
    const file = match[1];
    if (file && !names.includes(file)) names.push(file);
  }
  return names;
}

export function hasAppRelativeFontUrl(css: string): boolean {
  return css.includes(FONT_ASSET_PREFIX);
}

export const FRAME_BASE_STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--font-text);
    font-size: var(--text-base);
    line-height: var(--leading-body);
    color: var(--fg-2);
    background: transparent;
    padding: var(--space-1);
  }
  h1, h2, h3, h4, h5, h6 { color: var(--fg-1); font-weight: 500; letter-spacing: var(--tracking-display); line-height: var(--leading-tight); margin: 0 0 var(--space-2); }
  h1 { font-size: var(--text-lg); }
  h2 { font-size: var(--text-md); }
  h3, h4 { font-size: var(--text-base); }
  h4 { color: var(--fg-2); }
  h5 { font-size: var(--text-sm); }
  h6 { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  p, ul, ol, pre, blockquote, figure, dl, table, details { margin: 0 0 var(--space-2); }
  figcaption { font-size: var(--text-sm); color: var(--fg-3); margin-top: var(--space-1); }
  /* A quote reads as the captain's words do in the task record: a hairline at its start. */
  blockquote { padding-inline-start: var(--space-3); border-inline-start: 1px solid var(--line-1); }
  blockquote > :last-child { margin-bottom: 0; }
  /* The lit quote: the one passage a card asks the reader to notice, such as the captain's own
     message on the app's unanswered-message notice, with an optional micro label above it. */
  blockquote.inf-lit {
    padding: var(--space-2) var(--space-3); border-inline-start: 2px solid var(--accent);
    background: var(--accent-dim); border-radius: var(--radius-s); color: var(--fg-1);
  }
  .inf-quote-k { display: block; font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; margin-bottom: 2px; }
  mark { color: var(--fg-1); background: var(--accent-dim); border-radius: var(--radius-xs); padding: 0 var(--space-1); }
  kbd {
    font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-2);
    background: var(--bg-3); border: 1px solid var(--line-1); border-bottom-width: 2px;
    border-radius: var(--radius-s); padding: 0 var(--space-1);
  }
  details { border: 1px solid var(--line-1); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); }
  summary {
    display: flex; align-items: center; gap: var(--space-2); list-style: none; cursor: pointer;
    color: var(--fg-1); font-weight: 500;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before {
    content: ""; flex: none; border-left: 5px solid var(--fg-3);
    border-top: 4px solid transparent; border-bottom: 4px solid transparent;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  summary:hover::before { border-left-color: var(--fg-1); }
  details[open] > summary { margin-bottom: var(--space-2); }
  details[open] > summary::before { transform: rotate(90deg); }
  details > :last-child { margin-bottom: 0; }
  svg { max-width: 100%; height: auto; color: var(--fg-2); fill: currentColor; font-family: var(--font-ui); font-size: var(--text-sm); }
  /* Inherited fill closes an open bend into a triangle. Leave intentional
     fills on paths (including arrowheads) and labels/shapes untouched. */
  svg :is(path, polyline, line):not([fill]):not([style*="fill"]) { fill: none; }
  body > svg, figure > svg, details > svg { display: block; }
  body > svg, details > svg { margin: 0 0 var(--space-2); }
  /* A diagram the bridge tagged opens in the picture viewer on a click, as a picture does (INF-3107). */
  svg[data-inf-picture] { cursor: zoom-in; }
  /* A picture never reaches past the body; one that would stand taller than
     360 px shrinks to fit 360 px, whole, letterboxed on --bg-1. A click opens
     it in the picture viewer (the bridge's image message), unless it sits in
     a control, which owns the click. */
  img {
    display: block; max-width: 100%; height: auto;
    max-height: 360px; object-fit: contain; background: var(--bg-1);
    cursor: zoom-in;
  }
  :is(a, button, summary, label, [data-inf-action]) img { cursor: inherit; }
  body > img, details > img { margin: 0 0 var(--space-2); }
  /* A group of pictures (card pictures, phase 2; layout C, lead and strip):
     <figure class="inf-pictures"> around several <img>. The first leads under
     the plain img rule, alone on its line; the rest are 88 x 60 thumbnails
     cropped to their top; five show, and past that a mono "+N" tile counts
     the ones not shown. The author's figcaption is the group's caption. All
     of it is this stylesheet, so a group a body builds from its own data:
     pictures looks the same as one the host verified. */
  .inf-pictures {
    display: flex; flex-wrap: wrap; align-items: flex-start; column-gap: var(--space-2);
    position: relative; margin: 0; counter-reset: inf-pictures-more;
  }
  .inf-pictures > img { flex: none; margin: 0 0 var(--space-2); }
  .inf-pictures > img:first-of-type { order: -2; }
  /* The line break after the lead: an empty line of its own. */
  .inf-pictures::before { content: ""; order: -1; flex: 0 0 100%; height: 0; }
  .inf-pictures > img:nth-of-type(n+2) {
    box-sizing: border-box; width: 88px; height: 60px; max-height: none;
    object-fit: cover; object-position: top;
    border: 1px solid var(--line-1); border-radius: var(--radius-s);
  }
  /* Past the fifth thumbnail a picture is not shown, but still counted and
     still read by a screen reader. */
  .inf-pictures > img:nth-of-type(n+7) {
    position: absolute; width: 1px; height: 1px; margin: 0; border: 0; overflow: hidden;
    clip-path: inset(50%); counter-increment: inf-pictures-more;
  }
  /* The tile takes what is left of the last thumbnail's line, up to a
     thumbnail's width, so it stays beside the fifth instead of wrapping. A
     click on it opens the group at the first picture it counts. */
  .inf-pictures:has(> img:nth-of-type(7))::after {
    content: "+" counter(inf-pictures-more); flex: 1 1 0; box-sizing: border-box;
    min-width: 28px; max-width: 88px; height: 60px; margin: 0 0 var(--space-2);
    display: flex; align-items: center; justify-content: center;
    font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-1);
    background: var(--bg-1); border: 1px solid var(--line-1); border-radius: var(--radius-s);
    cursor: zoom-in;
  }
  .inf-pictures > figcaption { order: 1; flex: 0 0 100%; margin: 0 0 var(--space-2); }
  /* A demo (docs/card-authoring.md "Demo recordings"): its poster shows like
     any picture, and the bridge draws one Play button under it, with the
     recording's length, which opens the viewer playing it. Nothing in the
     body moves. */
  [data-inf-demo-play] {
    display: flex; align-items: center; gap: var(--space-2); width: max-content;
    margin: var(--space-2) 0 0; background: var(--bg-2);
  }
  [data-inf-demo-play]::before {
    content: ""; flex: none; width: 0; height: 0;
    border-style: solid; border-width: 5px 0 5px 8px;
    border-color: transparent transparent transparent currentColor;
  }
  /* A sound clip (docs/card-authoring.md "Sound clips"): the bridge draws a
     Listen button with the clip's length at the start of its figure, above
     its caption; a press plays it in the card's sound strip under the body.
     Nothing in the body plays. */
  figure[data-inf-sound] { margin: var(--space-2) 0; }
  figure[data-inf-sound] > figcaption { margin-top: var(--space-1); }
  [data-inf-sound-play] {
    display: flex; align-items: center; gap: var(--space-2); width: max-content;
    background: var(--bg-2); font-variant-numeric: tabular-nums;
  }
  [data-inf-sound-play]::before {
    content: ""; flex: none; width: 0; height: 0;
    border-style: solid; border-width: 5px 0 5px 8px;
    border-color: transparent transparent transparent currentColor;
  }
  /* Something new (card pictures, contract v4.69): a figure marked
     data-inf-new carries a mono New tag over its first corner, so a picture
     with no before reads as new, never as an omission. */
  [data-inf-new] { position: relative; }
  [data-inf-new]::before {
    content: "New"; position: absolute; top: var(--space-1); left: var(--space-1); z-index: 1;
    padding: 1px var(--space-1); pointer-events: none;
    font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-1);
    background: var(--accent-dim); border: 1px solid var(--accent); border-radius: var(--radius-s);
  }
  /* One picture per theme (the startup note's hero pairs, docs/release-notes.md):
     an element marked data-inf-theme shows only while the frame is in that
     theme, so a dark and a light picture of one view swap when the theme does. */
  :root:not([data-theme="light"]) [data-inf-theme="light"],
  :root[data-theme="light"] [data-inf-theme="dark"] { display: none; }
  /* An ask to keep a secret (docs/secrets.md): its line saying where to type
     the values is for a window or phone that draws no field; this one does. */
  [data-inf-secret-elsewhere] { display: none; }
  ul, ol { padding-left: var(--space-4); }
  li + li { margin-top: var(--space-1); }
  a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  /* A task key the bridge linked (FI3-594) reads as a link in the words around it;
     resting on it marks it with a row's hover surface while its summary is open,
     and so does a rest on the same task elsewhere in the window (data-inf-lit, INF-237). */
  a[data-inf-task] { cursor: pointer; border-radius: var(--radius-s); white-space: nowrap; }
  a[data-inf-task]:hover, a[data-inf-task][data-inf-lit] { background: var(--bg-3); }
  /* A knowledge reference the bridge linked (docs/knowledge.md, "References in an
     answer"): the entry's id as a link, led by a dot in its standing's state color -
     ok for checked with evidence, warn for one to recheck or with differing evidence. */
  a[data-inf-entry] { cursor: pointer; border-radius: var(--radius-s); font-family: var(--font-mono); white-space: nowrap; }
  a[data-inf-entry]:hover { background: var(--bg-3); }
  a[data-inf-entry]::before {
    content: ""; display: inline-block; width: 6px; height: 6px; margin: 0 4px 1px 1px;
    border-radius: 50%; background: var(--fg-3); vertical-align: middle;
  }
  a[data-inf-entry][data-inf-standing="ok"]::before { background: var(--ok); }
  a[data-inf-entry][data-inf-standing="warn"]::before { background: var(--warn); }
  code, pre, .inf-mono { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-1); }
  /* A link in mono - a pull request a body names by its number (FI3-1307) - reads as
     every pull request link the app draws: the accent, underlined only while rested on. */
  a.inf-mono { color: var(--accent); text-decoration: none; }
  a.inf-mono:hover { text-decoration: underline; }
  .inf-muted { color: var(--fg-3); }
  .inf-row { display: flex; align-items: center; gap: var(--space-2); }
  .inf-grid { display: grid; gap: var(--space-2); }
  .inf-panel { padding: var(--space-3); border: 1px solid var(--line-1); border-radius: var(--radius-m); }
  .inf-facts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
  /* Its hairline parts it from a body above; beside a card's buttons it stands alone. */
  * + .inf-facts { border-top: 1px solid var(--line-1); padding-top: var(--space-2); margin: var(--space-3) 0 0; }
  .inf-fact { display: flex; flex-direction: column; min-width: 0; max-width: 100%; }
  .inf-fact-k { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; white-space: nowrap; }
  .inf-fact-v { font-size: var(--text-sm); color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A pull request reads as every pull request link the app draws: underlined only while rested on. */
  .inf-fact-v a { text-decoration: none; }
  .inf-fact-v a:hover { text-decoration: underline; }
  /* The batch's own words on a sent-back change wrap whole, so its link stays in view (INF-3208). */
  .inf-fact[data-fact="batch"] .inf-fact-v { white-space: normal; overflow-wrap: anywhere; }
  .inf-facts > .inf-check-verdict { flex-basis: 100%; min-width: 0; margin: 0; padding: 0; border: 0; font-size: var(--text-sm); }
  .inf-check-verdict summary { overflow-wrap: anywhere; }
  .inf-check-verdict summary > span:last-child { color: var(--fg-2); }
  .inf-check-evidence { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg-3); }
  /* The host's own line under a failed check: main fails it too, in the open. */
  .inf-facts > .inf-check-outside { flex-basis: 100%; min-width: 0; margin: calc(-1 * var(--space-1)) 0 0; font-size: var(--text-sm); color: var(--fg-2); overflow-wrap: anywhere; }
  /* The app's line on a merge card: whether its click closes the task (INF-2490). */
  .inf-facts > .inf-merge-closes { flex-basis: 100%; min-width: 0; margin: 0; font-size: var(--text-sm); color: var(--fg-2); }
  /* A merge card's foot (INF-3709's plan): a status line, one state per fact, the
     reference at its far end, then what needs the captain. The rules above still
     draw the strips saved on past cards and the setup card's cells. */
  .inf-facts > .inf-foot-line { flex-basis: 100%; min-width: 0; max-width: none; margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-5); }
  /* The states take the room the reference leaves, which keeps it at the far end. */
  .inf-foot-states { flex: 1 1 auto; display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-5); min-width: 0; }
  /* A state reads on one line; one wider than the card is cut by an ellipsis, never widening the card.
     Its padding, taken back by its margin, keeps the focus ring clear of its words. */
  .inf-foot-state { max-width: 100%; overflow: hidden; text-overflow: ellipsis; padding: 0 3px; margin: 0 -3px; font-size: var(--text-sm); color: var(--fg-2); white-space: nowrap; border-radius: var(--radius-s); }
  /* What fails or warns reads first: it is sorted first and takes the primary text color. */
  .inf-foot-state[data-level="problem"], .inf-foot-state[data-level="warn"] { color: var(--fg-1); font-weight: 500; }
  .inf-foot-state .inf-fact-dot { margin-right: 6px; }
  /* Words that stand without a label, such as no checks, start the state with a capital. */
  .inf-foot-alone .inf-foot-v { display: inline-block; }
  .inf-foot-alone .inf-foot-v::first-letter { text-transform: uppercase; }
  .inf-foot-age { font-weight: 400; color: var(--fg-3); }
  .inf-foot-line a, .inf-foot-why a { text-decoration: none; }
  .inf-foot-line a:hover, .inf-foot-why a:hover { text-decoration: underline; }
  /* A state's words on rest, for the keyboard: its title is the pointer's. The line
     takes the row under the states without widening them, so the reference stays put. */
  .inf-foot-rest { display: none; order: 1; flex: none; width: 0; min-width: 100%; font-size: var(--text-xs); color: var(--fg-3); overflow-wrap: anywhere; }
  .inf-foot-state:focus-visible + .inf-foot-rest, .inf-foot-state:has(:focus-visible) + .inf-foot-rest { display: block; }
  .inf-foot-ref { min-width: 0; max-width: 100%; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-4); font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); white-space: nowrap; }
  .inf-foot-ref > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .inf-facts > .inf-foot-needs { flex-basis: 100%; min-width: 0; display: grid; gap: 6px; padding-left: var(--space-4); }
  /* Why a state needs the captain, such as the batch's own words, wrapped whole (INF-3208). */
  .inf-foot-why { margin: 0; font-size: var(--text-sm); color: var(--fg-2); max-width: 76ch; overflow-wrap: anywhere; }
  .inf-foot-why a { white-space: nowrap; }
  /* A failed check: the verdict, never broken, then the name on the same line, cut by
     an ellipsis; an open row shows the whole name. */
  .inf-foot-needs > .inf-check-verdict { min-width: 0; max-width: none; margin: 0; padding: 0; border: 0; font-size: var(--text-sm); }
  .inf-foot-needs > details.inf-check-verdict > summary { max-width: none; border-radius: var(--radius-s); display: grid; grid-template-columns: auto max-content minmax(0, 1fr); align-items: center; gap: var(--space-2); font-weight: 400; padding: 0 var(--space-1); margin: 0 calc(-1 * var(--space-1)); }
  .inf-foot-needs > details.inf-check-verdict[open] > summary { margin-bottom: var(--space-1); }
  .inf-foot-needs > p.inf-check-verdict { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: var(--space-2); padding-left: 13px; }
  .inf-foot-needs .inf-check-v { color: var(--fg-1); white-space: nowrap; }
  .inf-foot-needs .inf-check-verdict .inf-check-name { min-width: 0; font-size: var(--text-xs); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .inf-foot-needs details.inf-check-verdict[open] .inf-check-name { white-space: normal; overflow-wrap: anywhere; }
  .inf-foot-needs .inf-check-evidence { margin: 0 0 0 13px; color: var(--fg-2); max-width: 76ch; }
  .inf-foot-needs > .inf-check-outside { min-width: 0; margin: -2px 0 0 13px; font-size: var(--text-sm); color: var(--fg-2); max-width: 76ch; overflow-wrap: anywhere; }
  .inf-followups { margin: var(--space-3) 0 0; }
  .inf-followups-k { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; margin-bottom: 2px; }
  .inf-followup { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: baseline; column-gap: var(--space-2); font-size: var(--text-sm); line-height: 1.8; }
  .inf-followup-key { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); }
  .inf-followup-title { color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .inf-followup-word { color: var(--fg-3); white-space: nowrap; }
  .inf-followup[data-followup="hold"] .inf-followup-word { color: var(--warn); }
  .inf-fact-dot { vertical-align: -1px; margin-right: var(--space-1); }
  /* The rounds a cap counts, after a cell's words (factRoundsSvg), and the word held once the cap stands. */
  .inf-fact-rounds { vertical-align: -1px; margin-left: var(--space-2); }
  .inf-fact-held { color: var(--danger); margin-left: var(--space-1); }
  /* What a card's button sends where the project lives, drawn by the host (FI3-1571). */
  .inf-call { margin: var(--space-3) 0 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--line-1); border-radius: var(--radius-m); }
  .inf-call-k { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; margin-bottom: 2px; }
  .inf-call-line { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-1); overflow-wrap: anywhere; }
  .inf-call pre { margin: var(--space-1) 0 0; padding: var(--space-2); background: var(--bg-1); border-radius: var(--radius-s); max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .inf-call ul { margin: var(--space-1) 0 0; }
  .inf-call li[data-inf-skip="check"] { color: var(--warn); }
  .inf-call-gap details { border: 0; padding: 0; margin: var(--space-2) 0 0; }
  .inf-call-gap fieldset label + details { margin: var(--space-1) 0 var(--space-2) var(--space-5); }
  .inf-call-gap dt { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; margin-top: var(--space-2); }
  .inf-call-gap dd { margin: var(--space-1) 0 0; color: var(--fg-2); }
  .inf-call-gap dd.inf-mono { color: var(--fg-1); }
  .inf-call p { margin: var(--space-1) 0 0; font-size: var(--text-sm); }
  /* The rows of a card listing several asks to one connection (INF-2993): each row is
     one call with a bar on its left and its Allow box on its right, ticked as the card
     comes; an unticked row loses its bar and is struck through, and a tally under the
     rows counts the ticked ones as boxes change. */
  .inf-asks { list-style: none; margin: var(--space-3) 0; padding: 0; counter-reset: inf-runs inf-out inf-all; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); }
  .inf-ask { counter-increment: inf-runs inf-all; margin: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--line-1); border-left: 3px solid var(--ok); border-radius: var(--radius-m); background: var(--bg-1); transition: opacity var(--dur-med) ease, border-color var(--dur-med) ease; }
  .inf-ask:has(input:not(:checked)) { counter-increment: inf-out inf-all; border-left-color: var(--line-2); background: transparent; }
  .inf-ask-head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .inf-ask-n { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); min-width: 1.2em; }
  .inf-ask-name { font-weight: 500; color: var(--fg-1); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inf-ask-call { white-space: normal; overflow-wrap: anywhere; }
  .inf-ask-joined { font-size: var(--text-xs); color: var(--accent); background: var(--accent-dim); border-radius: var(--radius-s); padding: 0 var(--space-1); white-space: nowrap; }
  .inf-ask-out { margin-left: auto; display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--text-sm); color: var(--fg-2); white-space: nowrap; cursor: pointer; }
  .inf-ask-input { box-sizing: border-box; width: 100%; max-width: none; margin: var(--space-2) 0 0; padding: var(--space-1) var(--space-2); background: var(--bg-0); border-radius: var(--radius-s); font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-1); white-space: pre-wrap; overflow-wrap: anywhere; }
  dl.inf-ask-input { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: var(--space-3); }
  .inf-ask-input dt { color: var(--fg-3); }
  .inf-ask-input dd { margin: 0; overflow-wrap: anywhere; }
  /* A consent card's rows (ConsentDialog.prompt.md, "On a card"): what is added, a label beside
     each value; a panel's permission lines under its name; one quiet line under the rows and
     Full details folded below it, borderless. */
  dl.inf-grants { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: baseline; gap: var(--space-2) var(--space-4); margin: 0 0 var(--space-3); }
  .inf-grants dt { margin: 0; font-size: var(--text-sm); color: var(--fg-3); white-space: nowrap; }
  .inf-grants dd { grid-column: 2; margin: 0; min-width: 0; color: var(--fg-2); overflow-wrap: anywhere; }
  .inf-grants dd b { font-weight: 500; color: var(--fg-1); }
  .inf-grants-source { display: block; font-size: var(--text-sm); color: var(--fg-3); background: none; padding: 0; }
  .inf-grants dd .inf-grants-source b { font-weight: 400; }
  .inf-grants-quiet { font-size: var(--text-sm); color: var(--fg-3); }
  .inf-grants-lines { display: block; font-size: var(--text-sm); }
  .inf-grants-lines > span { display: block; }
  .inf-grants-note { margin: 0; font-size: var(--text-sm); color: var(--fg-3); }
  .inf-grants-more { border: 0; padding: 0; margin: var(--space-2) 0 0; font-size: var(--text-sm); }
  .inf-grants-more[open] > summary { margin-bottom: var(--space-2); }
  .inf-grants-more h6 { margin: var(--space-2) 0 var(--space-1); }
  .inf-grants-more dl.inf-grants { gap: var(--space-1) var(--space-4); margin: 0 0 var(--space-2); }
  .inf-grants-more dl.inf-grants:last-child { margin-bottom: 0; }
  .inf-grants-more dt { font-size: inherit; }
  .inf-grants-more code { color: var(--fg-1); }
  .inf-ask-why { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--fg-2); }
  .inf-ask:has(input:not(:checked)) :is(.inf-ask-name, .inf-ask-input, .inf-ask-why) { opacity: 0.45; text-decoration: line-through; text-decoration-color: var(--fg-3); }
  .inf-asks-tally { margin: 0; padding: 0 var(--space-1); font-size: var(--text-sm); color: var(--fg-2); }
  .inf-asks-tally::before { content: counter(inf-runs) attr(data-of) counter(inf-all) attr(data-ticked); white-space: pre; }
  /* A reader's Build row: the task it would file from an open issue, its brief whole and
     one choice of when to start it, outside the tally since it has no tick. */
  .inf-build { margin: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--line-1); border-left: 3px solid var(--accent); border-radius: var(--radius-m); background: var(--bg-1); }
  .inf-build-facts { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--fg-2); }
  .inf-build-choice { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin: var(--space-2) 0 0; }
  .inf-build-choice legend { font-size: var(--text-sm); }
  .inf-build-choice label { font-size: var(--text-sm); }
  .inf-asks-buttons { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--space-1) var(--space-3); margin: 0 0 var(--space-2); font-size: var(--text-sm); }
  .inf-asks-buttons dt { color: var(--fg-1); font-weight: 500; }
  .inf-asks-buttons dd { margin: 0; color: var(--fg-2); }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: var(--space-2); border-bottom: 1px solid var(--line-1); text-align: left; }
  th { color: var(--fg-1); font-weight: 500; }
  input, select, textarea {
    font-family: var(--font-ui); font-size: var(--text-base); color: var(--fg-1);
    background: var(--surface-input); border: 1px solid var(--line-1);
    border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--line-2); box-shadow: var(--focus-ring); }
  /* Questions in the body (inline decisions, contract 4.22): a fieldset is
     one question, its legend the ask and each option a row of its own. The
     author may present a question however it reads best; these rules only
     keep a plain form on-brand. */
  fieldset {
    min-width: 0; margin: 0 0 var(--space-2); padding: var(--space-1) var(--space-3) var(--space-3);
    border: 1px solid var(--line-1); border-radius: var(--radius-m);
  }
  legend { padding: 0 var(--space-1); color: var(--fg-1); font-weight: 500; }
  input:is([type="radio"], [type="checkbox"], [type="range"]) {
    padding: 0; border: none; background: none; accent-color: var(--accent);
  }
  input:is([type="radio"], [type="checkbox"]) { flex: none; margin: 0; }
  /* An option row is one paragraph with a hanging indent: the box sits in
     the indent, so its words, a linked task key and its tags flow as text and
     a wrapped line starts under the first word. A flex row made each of those
     pieces a column of its own. */
  label:has(> input:is([type="radio"], [type="checkbox"])) {
    display: flow-root; padding-inline-start: calc(13px + var(--space-2)); cursor: pointer;
  }
  label:has(> input:is([type="radio"], [type="checkbox"])) > input:is([type="radio"], [type="checkbox"]) {
    float: inline-start; margin-block-start: calc((1lh - 13px) / 2);
    margin-inline-start: calc(-13px - var(--space-2));
  }
  label:has(> input:is([type="radio"], [type="checkbox"])) + label { margin-top: var(--space-1); }
  /* A Build row's choices sit on one line, where the stacked rows' gap would lower all but the first. */
  .inf-build-choice label:has(> input) + label { margin-top: 0; }
  label:has(> input:is([type="radio"], [type="checkbox"]):checked) { color: var(--fg-1); }
  label > textarea, label > select, label > input:not([type="radio"], [type="checkbox"], [type="range"]) {
    display: block; margin-top: var(--space-1);
  }
  label[data-inf-recommended-label]::after, label[data-inf-default-label]::after, [data-inf-recommendation] {
    content: "Recommended"; display: inline-block; color: var(--accent);
    background: var(--accent-dim); border-radius: var(--radius-pill);
    padding: 0 var(--space-2); font-family: var(--font-mono); font-size: var(--text-xs);
  }
  [data-inf-recommendation] { margin-top: var(--space-1); }
  /* On a question the captain may skip (INF-4425), the author's pick is its
     Default: the same pill with that word, and while the question is
     untouched its radio or checkbox drawn as a hollow ring in the pill's
     color, the control's own size - a square for a checkbox. Any pick in
     the question takes the ring away. */
  label[data-inf-default-label]::after { content: "${DEFAULT_WORDS}"; }
  input[data-inf-default-ring]:is([type="radio"], [type="checkbox"]) {
    appearance: none; box-sizing: border-box; width: 13px; height: 13px;
    border: 1.5px solid var(--accent); border-radius: 50%; background: transparent;
  }
  input[data-inf-default-ring][type="checkbox"] { border-radius: 3px; }
  /* What the code does now (data-inf-current, INF-3598): the same pill in
     outline only, leading the option's words, while Recommended follows them;
     each pill stays whole on its line. */
  label[data-inf-current-label]::before, [data-inf-as-built] {
    content: "${AS_BUILT_WORDS}"; display: inline-block; color: var(--fg-2);
    border: 1px solid var(--line-2); border-radius: var(--radius-pill);
    padding: 0 var(--space-2); font-family: var(--font-mono); font-size: var(--text-xs);
  }
  label[data-inf-current-label]::before { margin-inline-end: var(--space-1); white-space: nowrap; }
  label:is([data-inf-recommended-label], [data-inf-default-label])::after {
    margin-inline-start: var(--space-2); white-space: nowrap;
  }
  [data-inf-as-built] { margin-top: var(--space-1); margin-right: var(--space-1); }
  /* The tradeoff chart (docs/card-authoring.md, "The tradeoff chart"),
     drawn from the author's table marked data-inf-tradeoff: each option one
     mark that a press picks, the question's own option picked with it. Two
     headings are one plane, the first up and the second across; three or
     more are a small radar on each option. Outward, up and right are always
     more of a heading. The recommended option's mark takes the accent, and
     the picked one its ring filled and an accent border. */
  [data-inf-tradeoff-chart] { margin: var(--space-2) 0; }
  /* A charted option shows once, on the chart: its label and control leave
     view but stay in the form, so the keyboard still reaches and picks it,
     and the chart draws the focus. */
  :is(label, input)[data-inf-tradeoff-charted] {
    position: absolute; width: 1px; height: 1px; margin: 0; padding: 0; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap; border: 0;
  }
  label[data-inf-tradeoff-charted] + br { display: none; }
  [data-inf-tradeoff-pick][data-inf-tradeoff-focused] { box-shadow: var(--focus-ring); }
  [data-inf-tradeoff-pick] {
    cursor: pointer; border: 1px solid var(--line-1); border-radius: var(--radius-m);
    background: var(--bg-1); color: var(--fg-2);
  }
  [data-inf-tradeoff-ring] {
    display: inline-block; box-sizing: border-box; width: 11px; height: 11px; margin-inline-end: var(--space-1);
    border: 1.5px solid var(--line-2); border-radius: 50%; vertical-align: -1px;
  }
  [data-inf-tradeoff-picked] [data-inf-tradeoff-ring] { border: 3.5px solid var(--accent); }
  [data-inf-tradeoff-current] [data-inf-tradeoff-words]::before {
    content: "${AS_BUILT_WORDS}"; display: inline-block; margin-inline-end: var(--space-1); white-space: nowrap;
    color: var(--fg-2); border: 1px solid var(--line-2); border-radius: var(--radius-pill);
    padding: 0 var(--space-2); font-family: var(--font-mono); font-size: var(--text-xs);
  }
  :is([data-inf-tradeoff-recommended], [data-inf-tradeoff-default]) [data-inf-tradeoff-words]::after {
    content: "Recommended"; display: inline-block; margin-inline-start: var(--space-2); white-space: nowrap;
    color: var(--accent); background: var(--accent-dim); border-radius: var(--radius-pill);
    padding: 0 var(--space-2); font-family: var(--font-mono); font-size: var(--text-xs);
  }
  [data-inf-tradeoff-default] [data-inf-tradeoff-words]::after { content: "${DEFAULT_WORDS}"; }
  [data-inf-tradeoff-chart="radar"] {
    display: grid; gap: var(--space-2);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
  }
  [data-inf-tradeoff-chart="radar"] > [data-inf-tradeoff-pick] {
    display: flex; flex-direction: column; align-items: center; gap: var(--space-1); padding: var(--space-2);
  }
  [data-inf-tradeoff-chart="radar"] svg { display: block; max-width: 100%; height: auto; overflow: visible; }
  [data-inf-tradeoff-chart="radar"] p { margin: 0; align-self: stretch; }
  [data-inf-tradeoff-chart] text {
    font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; fill: var(--fg-3);
  }
  [data-inf-tradeoff-grid] { fill: none; stroke: var(--line-1); }
  [data-inf-tradeoff-shape] {
    fill: var(--fg-3); fill-opacity: 0.2; stroke: var(--fg-1); stroke-width: 1.75; stroke-linejoin: round;
  }
  [data-inf-tradeoff-dot] { fill: var(--fg-2); }
  :is([data-inf-tradeoff-recommended], [data-inf-tradeoff-default]) [data-inf-tradeoff-shape] {
    fill: var(--accent-dim); fill-opacity: 1; stroke: var(--accent); stroke-width: 2;
  }
  :is([data-inf-tradeoff-recommended], [data-inf-tradeoff-default]) [data-inf-tradeoff-dot] { fill: var(--accent); }
  [data-inf-tradeoff-axis] {
    font-family: var(--font-mono); font-size: var(--text-xs); text-transform: uppercase; color: var(--fg-3);
  }
  [data-inf-tradeoff-axis="up"]::before { content: "\\2191\\00a0"; }
  [data-inf-tradeoff-axis="across"] { text-align: end; }
  [data-inf-tradeoff-axis="across"]::after { content: "\\00a0\\2192"; }
  [data-inf-tradeoff-plane] {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: var(--space-1) 0;
    border-inline-start: 1.5px solid var(--fg-3); border-block-end: 1.5px solid var(--fg-3);
  }
  [data-inf-tradeoff-cell] {
    display: flex; flex-direction: column; justify-content: center; gap: var(--space-1);
    min-height: calc(2lh + var(--space-3)); padding: var(--space-1);
    border-inline-end: 1px dashed var(--line-1); border-block-start: 1px dashed var(--line-1);
  }
  [data-inf-tradeoff-cell] > [data-inf-tradeoff-pick] {
    padding: var(--space-1) var(--space-2); font-size: var(--text-sm); overflow-wrap: break-word;
  }
  [data-inf-tradeoff-cell] [data-inf-tradeoff-words]::before, [data-inf-tradeoff-cell] [data-inf-tradeoff-words]::after {
    white-space: normal; max-width: 100%;
  }
  /* A narrow plane's cells are too slim for a pill or a ring: a tag becomes
     small words beside the option's, broken only between words, and a pick
     shows by its accent border alone. */
  [data-inf-tradeoff-plane] { container-type: inline-size; }
  @container (max-width: 480px) {
    [data-inf-tradeoff-cell] > [data-inf-tradeoff-pick] { padding: var(--space-1); }
    [data-inf-tradeoff-cell] [data-inf-tradeoff-words]::before, [data-inf-tradeoff-cell] [data-inf-tradeoff-words]::after {
      padding: 0; border: 0; background: none; font-size: 10px;
    }
    [data-inf-tradeoff-cell] [data-inf-tradeoff-words]::before { display: inline; white-space: nowrap; }
    [data-inf-tradeoff-cell] [data-inf-tradeoff-ring] { display: none; }
    [data-inf-tradeoff-cell] [data-inf-tradeoff-words]::after { display: block; margin: 0; }
  }
  [data-inf-tradeoff-recommended][data-inf-tradeoff-pick], [data-inf-tradeoff-default][data-inf-tradeoff-pick] { border-color: var(--accent-dim); }
  [data-inf-tradeoff-pick][data-inf-tradeoff-picked] { border-color: var(--accent); color: var(--fg-1); }
  [data-inf-tradeoff-x="1"] { grid-column: 1; } [data-inf-tradeoff-x="2"] { grid-column: 2; } [data-inf-tradeoff-x="3"] { grid-column: 3; }
  [data-inf-tradeoff-y="3"] { grid-row: 1; } [data-inf-tradeoff-y="2"] { grid-row: 2; } [data-inf-tradeoff-y="1"] { grid-row: 3; }
  details[data-inf-tradeoff-table] { margin: var(--space-1) 0 var(--space-2); }
  textarea { width: 100%; min-height: 64px; resize: vertical; }
  /* A question's Something else row (FI3-1002): the field the bridge opens
     under it while it is picked - one line, growing to three - indented to
     the row's words, or full width under a select. */
  textarea[data-inf-write-in-field] {
    display: block; min-height: 0; max-height: calc(3lh + 2 * var(--space-1) + 2px);
    margin: var(--space-1) 0 0 calc(13px + var(--space-2)); width: calc(100% - 13px - var(--space-2));
    padding: var(--space-1) var(--space-3); font-size: var(--text-sm); line-height: var(--leading-body);
    resize: none; field-sizing: content;
  }
  textarea[data-inf-write-in-field="select"] { margin-left: 0; width: 100%; }
  textarea[data-inf-write-in-field][hidden] { display: none; }
  button, [data-inf-action] {
    font-family: var(--font-ui); font-size: var(--text-sm); font-weight: 500;
    color: var(--fg-1); background: transparent; border: 1px solid var(--line-2);
    border-radius: var(--radius-m); padding: var(--space-1) var(--space-3); cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }
  button:hover, [data-inf-action]:hover { background: var(--bg-3); }
  :focus-visible { outline: none; box-shadow: var(--focus-ring); }
`;

let cached: string | undefined;

/** The whole frame stylesheet; built once, identical for every frame. */
export function frameStylesheet(): string {
  cached ??= [
    colorsCss,
    typographyCss,
    spacingCss,
    effectsCss,
    revealsCss,
    frameFontFaces(),
    FRAME_BASE_STYLE,
  ].join("\n");
  return cached;
}

/**
 * The base of a PANEL drawn in the frame realm (one plugin vehicle, Phase A
 * item 4). Not FRAME_BASE_STYLE: that one dresses the bare markup of an
 * agent's card body and a template, and would restyle the library's own
 * elements (every `<button>`, `<input>`, heading). A panel is built from the
 * library, so its document gives it exactly the context the app's window
 * gives a panel in-process - the app body's type (typography.css, carried
 * in the tokens) under the side panel body's size, leading and color
 * (SidePanelChrome's `[data-side-panel-body]`) - over a transparent page,
 * and nothing more. That is what lets one panel paint the same pixels in
 * either realm.
 */
export const PANEL_BASE_STYLE = `
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    /* The panel body in the window is a scroll container, so the margins of
       a panel's first and last element stay inside it; the frame's body
       holds them the same way, and the height the bridge reports is the
       whole panel. */
    display: flow-root;
    font-size: var(--text-sm);
    line-height: var(--leading-body);
    color: var(--fg-2);
  }
  /* The window's own focus ring (design/styles.css), for a control in the panel. */
  :where(:focus-visible) { outline: none; box-shadow: var(--focus-ring); }
`;

let cachedPanel: string | undefined;

/**
 * Auto-height panels scroll in their host, not their document. Suppressing
 * the document scrollbar before the first measurement prevents fluid content
 * from settling at a narrower width after the initially small viewport
 * overflows. Fill panels retain their document's own scrolling policy.
 */
const PANEL_AUTO_HEIGHT_STYLE = "html { overflow-y: hidden; }";

/**
 * A fill page is as tall as its frame, which its host sizes, so a panel can
 * fill it edge to edge and scroll on its own (`height: 100%` on its root): a
 * card of `fill` height keeps its own top row and foot in place that way.
 */
const PANEL_FILL_STYLE = `html, body, #${PANEL_ROOT_ID} { height: 100%; }`;

export function panelStylesheet(autoHeight = false): string {
  cachedPanel ??= [
    colorsCss,
    typographyCss,
    spacingCss,
    effectsCss,
    revealsCss,
    frameFontFaces(),
    PANEL_BASE_STYLE,
  ].join("\n");
  return `${cachedPanel}\n${autoHeight ? PANEL_AUTO_HEIGHT_STYLE : PANEL_FILL_STYLE}`;
}
