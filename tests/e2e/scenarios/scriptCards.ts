import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { CARD_FETCH_PROBE_PATH, SCRIPT_CARD_TITLES, type Scenario } from "../mockProvider";

/** Marker prompt: the mock crewmate emits three cards whose bodies carry scripts (WI-16). */
export const SCRIPT_CARDS_PROMPT_MARKER = "show scripted cards";

/** The canvas card's canvas, which its script paints edge to edge. */
export const SCRIPT_CANVAS = { width: 120, height: 40 } as const;

function scriptCardToolCalls(port: number): ScriptedCall[] {
  const note = (title: string, body: string): ScriptedCall => ({
    name: "emit_card",
    args: { title, body },
  });
  return [
    note(
      SCRIPT_CARD_TITLES.canvas,
      "<p>Drawn by the card.</p>" +
        `<canvas width="${SCRIPT_CANVAS.width}" height="${SCRIPT_CANVAS.height}"></canvas>` +
        '<script>const sample = "</body>"; const canvas = document.querySelector("canvas");' +
        'const ink = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "cyan";' +
        'const pen = canvas.getContext("2d"); pen.fillStyle = ink; ' +
        `pen.fillRect(0, 0, ${SCRIPT_CANVAS.width}, ${SCRIPT_CANVAS.height});</script>`,
    ),
    note(
      SCRIPT_CARD_TITLES.fetch,
      '<p role="status">pending</p>' +
        `<script>const out = document.querySelector("[role=status]");` +
        `fetch("http://127.0.0.1:${port}${CARD_FETCH_PROBE_PATH}").then(` +
        `() => { out.textContent = "reached"; }, () => { out.textContent = "blocked"; });</script>`,
    ),
    note(
      SCRIPT_CARD_TITLES.runaway,
      "<p>This card never yields.</p><script>while (true) {}</script>",
    ),
    note(
      SCRIPT_CARD_TITLES.figure,
      "<figure><div></div><figcaption>Drawn by the card itself.</figcaption></figure>" +
        '<script>const ns = "http://www.w3.org/2000/svg";' +
        'const svg = document.createElementNS(ns, "svg");' +
        'svg.setAttribute("viewBox", "0 0 480 40"); svg.setAttribute("width", "100%");' +
        'svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "One crewmate, running");' +
        'const dot = document.createElementNS(ns, "circle");' +
        'dot.setAttribute("cx", "12"); dot.setAttribute("cy", "20"); dot.setAttribute("r", "6");' +
        'dot.setAttribute("style", "fill:var(--ok)"); svg.append(dot);' +
        'document.querySelector("figure div").append(svg);</script>',
    ),
  ];
}

/** The model shows cards whose scripts draw, act and reach for the network. */
export const scriptCards: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults, port }) => {
    // The first mate commissions the crewmate through the shared stand-in.
    if (isFirstmate) return undefined;
    if (latestUserTail.includes(SCRIPT_CARDS_PROMPT_MARKER) && !hasToolResults && wantsStream) {
      return { calls: scriptCardToolCalls(port) };
    }
    return undefined;
  };
