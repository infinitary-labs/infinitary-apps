import { cardWordsMark, englishOf, type Said, said, saidMark } from "./i18n/said";

/**
 * The note when a new person's first crewmate starts (INF-5532's approved
 * plan; docs/first-launch.md "The first crewmate's note"): the moment the
 * first mate hands an ask to a crewmate is where the app differs most from
 * a chat, so it says once that the work goes on in the background and that
 * cards are the part that needs the person. App copy, never a model's.
 *
 * Every word is a saved fact (docs/i18n.md, "Saved facts"): each run of the
 * body is a `saidMark`, and the title's fact rides `cardWordsMark`, so a
 * window or the phone words the note in its own language when it draws it.
 */
const TITLE: Said = said("firstCrewmateTitle");

/** The title in English, as the record keeps it. */
export const FIRST_CREWMATE_TITLE = englishOf(TITLE);

/** A small crewmate, the tetrahedron the stage draws, as a still. */
const CREWMATE_GLYPH = `<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" style="flex:none"><path d="M16 4L5 22L19 28L27 18Z M16 4L19 28" style="fill:none;stroke:var(--hot);stroke-width:1.4;stroke-linejoin:round"/><path d="M5 22L27 18" style="fill:none;stroke:var(--hot);stroke-width:1.1;stroke-dasharray:2 3;opacity:.6"/></svg>`;

/** A card with lines on it, in the accent: what comes back. */
const CARD_GLYPH = `<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" style="flex:none"><rect x="6" y="3" width="20" height="26" rx="3" style="fill:none;stroke:var(--accent);stroke-width:1.4"/><path d="M10 11h12M10 16h12M10 21h7" style="stroke:var(--accent);stroke-width:1.4"/></svg>`;

const LABEL =
  'style="font-family:var(--font-mono);font-size:var(--text-xs);letter-spacing:1px;text-transform:uppercase;color:var(--fg-3)"';

/** One of the picture's two panels: its glyph, its label and its two lines. */
const panel = (glyph: string, label: Said, first: Said, second: Said, look: string, part: string) =>
  `<div data-part="${part}" style="flex:1 1 200px;display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3);border-radius:var(--radius-s);${look}">${glyph}<div>${saidMark(label, "div", LABEL)}${saidMark(first, "div", 'style="color:var(--fg-1)"')}${saidMark(second, "div", 'style="color:var(--fg-2)"')}</div></div>`;

/** The note's body: the handoff, a picture of now and later, then what needs the person. */
export const FIRST_CREWMATE_BODY = `${cardWordsMark([TITLE])}${saidMark(said("firstCrewmateHandoff"), "p")}
<div style="display:flex;flex-wrap:wrap;align-items:stretch;gap:var(--space-2);margin:var(--space-3) 0">${panel(
  CREWMATE_GLYPH,
  said("firstCrewmateNow"),
  said("firstCrewmateNowWorks"),
  said("firstCrewmateNowWatch"),
  "background:var(--bg-1);border:1px solid var(--line-1)",
  "now",
)}${panel(
  CARD_GLYPH,
  said("firstCrewmateLater"),
  said("firstCrewmateLaterCard"),
  said("firstCrewmateLaterWhat"),
  "background:var(--accent-dim);border:1px solid var(--accent)",
  "later",
)}</div>
${saidMark(said("firstCrewmateCards"), "p")}
${saidMark(said("firstCrewmatePutAway"), "p")}`;

/**
 * The note in words, as its record keeps it: the answer its record holds
 * and what the first mate's context carries, in English as all a model
 * reads is.
 */
export const FIRST_CREWMATE_ANSWER = [
  "firstCrewmateHandoff",
  "firstCrewmateCards",
  "firstCrewmatePutAway",
]
  .map((name) => `<p>${englishOf({ m: name })}</p>`)
  .join("\n");

/** The note the host presents: its title, its body, and the answer its record keeps. */
export const FIRST_CREWMATE_NOTE = {
  title: FIRST_CREWMATE_TITLE,
  body: FIRST_CREWMATE_BODY,
  answer: FIRST_CREWMATE_ANSWER,
};
