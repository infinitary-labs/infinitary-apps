/**
 * The 10px state dot a fact cell carries, in StatusDot's language (design
 * skill, `components/viz/Viz.prompt.md`): ok filled `--ok` with a tick,
 * failed filled `--danger` with a cross, warn filled `--warn` with a bang,
 * running an `--accent` ring, idle an `--idle` ring - shape carrying the
 * state beside color, for readers scanning quickly. One drawing for the
 * merge card's fact strip, which the host writes as markup (`factDotSvg`),
 * and the task's own fact strip on its record and its hover preview, which
 * the window draws from the same parts.
 */
export type FactDotState = "ok" | "warn" | "failed" | "running" | "idle";

export type FactDotShape =
  | {
      /** A filled disc in this color, with its mark drawn over it in the card's color. */
      disc: string;
      mark: string;
      /** The tick is an open stroke: it says `fill="none"`. */
      open?: boolean;
    }
  | { ring: string };

export const FACT_DOT: Record<FactDotState, FactDotShape> = {
  ok: { disc: "var(--ok)", mark: "M3 5.2l1.4 1.4 2.8-2.9", open: true },
  failed: { disc: "var(--danger)", mark: "M3.4 3.4l3.2 3.2M6.6 3.4l-3.2 3.2" },
  warn: { disc: "var(--warn)", mark: "M5 2.6v3M5 7.2v.2" },
  running: { ring: "var(--accent)" },
  idle: { ring: "var(--idle)" },
};

/** The dot as markup, for a strip the host writes into a card body. */
export function factDotSvg(state: FactDotState): string {
  const shape = FACT_DOT[state];
  const drawn =
    "ring" in shape
      ? `<circle cx="5" cy="5" r="4" fill="none" stroke="${shape.ring}" stroke-width="1.5"/>`
      : `<circle cx="5" cy="5" r="4.5" fill="${shape.disc}"/><path d="${shape.mark}" stroke="var(--bg-2)" stroke-width="1.4"${shape.open ? ' fill="none"' : ""} stroke-linecap="round"/>`;
  return `<svg class="inf-fact-dot" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">${drawn}</svg>`;
}
