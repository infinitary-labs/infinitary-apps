/**
 * The host's fact strip on a settle card (`cards.ts` re-exports it): the
 * facts it may name, how much each needs the captain, and how a reader
 * finds and cuts the strip out of a body.
 */
import { SPELLINGS } from "./codeNames.ts";

/**
 * The facts the host writes on a settle card's fact strip (`SettleFacts.strip`);
 * each carries its fact in `data-fact`, present only when the host holds that fact.
 * The first five are the task's states, one item each on the strip's status
 * line, sorted there by what needs the captain first; the last four are its
 * reference, at the line's far end in this order.
 */
export const SETTLE_FACTS = [
  "checks",
  "run",
  "batch",
  "review",
  "override",
  "project",
  "change",
  "lines",
  "care",
] as const;
export type SettleFact = (typeof SETTLE_FACTS)[number];

/**
 * How much a state on the status line needs the captain, in the order the
 * line sorts by: failing, a warning, running or waiting, passed. Each state
 * carries its level in `data-level`.
 */
export const SETTLE_LEVELS = ["problem", "warn", "waiting", "ok"] as const;
export type SettleLevel = (typeof SETTLE_LEVELS)[number];

/**
 * The class of a settle fact's value inside its `data-fact` element, as the
 * host writes the strip: a reader takes a fact's value by it, never by the
 * label beside it. The frame stylesheet gives it its look.
 */
export const SETTLE_FACT_VALUE_CLASS = "inf-foot-v";

/** How the host opens a settle card's fact strip; its cells hold no `div`, so the next `</div>` closes it. */
export const SETTLE_FACTS_OPEN = '<div class="inf-facts" data-facts>';

/**
 * A settle card's body without the host's fact strip, and the strip itself,
 * so the stage shows the strip above the card's buttons rather than at the
 * end of a body that may scroll it out of view. The host appends its strip
 * after the author's body, so the last one is the host's. `at` is where it
 * was cut out. Undefined when the body carries no strip.
 */
export function splitSettleFacts(
  body: string,
): { body: string; facts: string; at: number } | undefined {
  // A home on the other side of the Infinitary rename writes its own spelling.
  const at = Math.max(
    ...SPELLINGS.map((spelling) => body.lastIndexOf(`<div class="${spelling}-facts" data-facts>`)),
  );
  if (at < 0) return undefined;
  const close = body.indexOf("</div>", at);
  if (close < 0) return undefined;
  const end = close + "</div>".length;
  return { body: body.slice(0, at) + body.slice(end), facts: body.slice(at, end), at };
}
