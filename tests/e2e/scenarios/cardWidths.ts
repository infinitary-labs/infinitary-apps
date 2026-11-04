import type { Scenario, ScriptedCall } from "../mockProvider";

/**
 * Marker prompt (card width, the captain's Q5 to Q7 A of 2026-09-28): the
 * mock crewmate emits three notes the host sizes three ways - prose alone
 * (regular), a five-column table beside a long paragraph and a 510-unit
 * figure (wide, from the body's own facts), and a plain body carrying the
 * author's full hint (`tests/e2e/card-width.spec.ts`).
 */
export const CARD_WIDTH_PROMPT_MARKER = "show the card widths";
export const WIDTH_CARD_TITLES = {
  defaultWide: "The drawing uses the wide card",
  regular: "The meter row reads on first paint",
  wide: "What each model costs per turn",
  full: "The whole settings screen at once",
} as const;
/** The regular card's one paragraph: prose alone. */
export const WIDTH_CARD_REGULAR_TEXT =
  "The meter row now reads on the first paint, all five meters in one line.";
/** The wide card's drawing: 510 units across, at width="100%". */
const WIDTH_CARD_FIGURE = "Cost grows with the turn";
const WIDTH_CARD_PARAGRAPH =
  "Each row is one model family, measured over the same forty recorded turns, and the columns read left to right from the cheapest input to the costliest output, so the row that matters most is the one whose last two columns grow fastest as the turn grows longer.";

/**
 * A clean emitted-card reproduction of the separate viewport-height
 * feedback, in a scripted body, which mounts over the shell's own frame
 * scheme (`tests/e2e/card-viewport-height.spec.ts`; the static body's twin is
 * `tests/browser/card-viewport-height.test.tsx`).
 */
export const CARD_VIEWPORT_PROMPT_MARKER = "show the viewport height reproduction";
export const CARD_VIEWPORT_TITLE = "A viewport-height card";
export const CARD_VIEWPORT_BODY =
  '<div data-viewport-content style="min-height:100vh;display:flex;flex-direction:column;justify-content:space-between"><span>Viewport-height content</span><span>Bottom of the content</span></div><script>document.documentElement.setAttribute("data-body-script", "ran");</script>';

function viewportCardToolCalls(): ScriptedCall[] {
  return [{ name: "emit_card", args: { title: CARD_VIEWPORT_TITLE, body: CARD_VIEWPORT_BODY } }];
}

function widthCardToolCalls(): ScriptedCall[] {
  const row = (cells: string[], tag: "th" | "td") =>
    `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join("")}</tr>`;
  const table =
    "<table>" +
    row(["Model", "Input", "Cached", "Output", "Per turn"], "th") +
    row(["Small", "0.10", "0.01", "0.40", "0.02"], "td") +
    row(["Large", "3.00", "0.30", "15.00", "0.61"], "td") +
    "</table>";
  const figure =
    `<figure aria-label="${WIDTH_CARD_FIGURE}"><svg viewBox="0 0 750 60" width="100%" role="img" aria-label="${WIDTH_CARD_FIGURE}">` +
    '<rect x="1" y="10" width="748" height="40" rx="6" style="fill:var(--accent-dim);stroke:var(--accent)"/>' +
    '<text x="12" y="35">Small: 0.02 per turn</text><text x="610" y="35">Large: 0.61</text></svg></figure>';
  return [
    {
      name: "emit_card",
      args: {
        title: WIDTH_CARD_TITLES.defaultWide,
        body: `<p>The drawing fills the wide card while prose keeps its line.</p>${figure}`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: WIDTH_CARD_TITLES.regular,
        body: `<p>${WIDTH_CARD_REGULAR_TEXT}</p>`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: WIDTH_CARD_TITLES.wide,
        body: `<p>The large model costs thirty times the small one per turn.</p><p>${WIDTH_CARD_PARAGRAPH}</p>${table}${figure}`,
      },
    },
    {
      name: "emit_card",
      args: {
        title: WIDTH_CARD_TITLES.full,
        body: "<p>The settings screen shows every section without scrolling.</p>",
        width: "full",
      },
    },
  ];
}

/** The crewmate shows the cards a journey sizes: the widths, or the scripted viewport-height body. */
export const cardWidths: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (latestUserTail.includes(CARD_VIEWPORT_PROMPT_MARKER))
      return { calls: viewportCardToolCalls() };
    if (latestUserTail.includes(CARD_WIDTH_PROMPT_MARKER)) return { calls: widthCardToolCalls() };
    return undefined;
  };
