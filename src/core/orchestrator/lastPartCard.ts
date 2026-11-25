import { escapeHtml } from "@shared/cardBodyMarkup";
import type { Card } from "@shared/cards";
import { cardWordsMark, englishOf, type Said, said, saidMark } from "@shared/i18n/said";
import type { TaskRecord } from "../storage/taskRecords";
import { hostCard } from "./hostCards";

/**
 * The host's decision about a part the captain stopped that is left as the
 * only open part of its parent (docs/report-sort.md, "The last part the
 * captain stopped"). The next-move check (`nextMove.ts`) decides when it
 * goes up and takes it down; this owns its id, its words, its figure and
 * its choices.
 */

/** The card's id: one per stopped part. */
export function lastPartCardId(taskId: string): string {
  return `card-last-part-${taskId}`;
}

/** The parent's other parts, all closed, as the figure counts them. */
export type ClosedParts = { done: number; dropped: number };

const NODE =
  "display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-3);border-radius:var(--radius-s)";
const NAME = 'style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--fg-1)"';
const pill = (look: string) =>
  `style="flex:none;padding:1px var(--space-2);font-family:var(--font-mono);font-size:var(--text-xs);border-radius:var(--radius-pill);${look}"`;
const glyph = (paths: string, color: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style="flex:none;fill:none;stroke:${color};stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round">${paths}</svg>`;
const CHECK = glyph('<path d="M3.5 8.5l3 3 6-7"/>', "var(--ok)");
const CROSS = glyph('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', "var(--fg-3)");
const PAUSE = glyph('<path d="M6 4v8M10 4v8"/>', "var(--accent)");

/**
 * The tree's line from the parent down to one part. Each part's cell sits
 * `--space-2` below the one above it, so its middle, where the branch
 * meets it, is half that below the row's middle; the last part's line
 * stops there instead of running on. Its sides are logical, since a card
 * frame takes the language's direction and an Arabic tree runs from the
 * right.
 */
const branch = (last: boolean) => {
  const middle = "calc(50% + var(--space-1))";
  const reach = last ? `height:${middle}` : "bottom:0";
  return `<div aria-hidden="true" style="position:relative"><div style="position:absolute;inset-inline-start:0;top:0;${reach};border-inline-start:1px solid var(--line-2)"></div><div style="position:absolute;inset-inline:0;top:${middle};border-top:1px solid var(--line-2)"></div></div>`;
};

/**
 * The figure the captain asked for: the parent, then its parts under it -
 * the closed ones counted, and the stopped one it waits on, lit.
 */
function figure(part: TaskRecord, parent: TaskRecord, closed: ClosedParts): string {
  const rows: string[] = [];
  const count = (fact: Said, mark: string) =>
    `<div style="${NODE};border:1px solid var(--line-1);color:var(--fg-2)">${mark}${saidMark(fact, "span", 'style="flex:1 1 auto;min-width:0"')}</div>`;
  if (closed.done > 0) rows.push(count(said("cardLastPartDone", { count: closed.done }), CHECK));
  if (closed.dropped > 0) {
    rows.push(count(said("cardLastPartDropped", { count: closed.dropped }), CROSS));
  }
  rows.push(
    `<div style="${NODE};border:1px solid var(--accent);background:var(--accent-dim)">${PAUSE}<span ${NAME}>${escapeHtml(part.title)}</span>${saidMark(said("cardLastPartBacklog"), "span", pill("color:var(--fg-1);border:1px solid var(--accent)"))}</div>`,
  );
  const tree = rows
    .map(
      (row, at) =>
        `${branch(at === rows.length - 1)}<div style="padding-top:var(--space-2)">${row}</div>`,
    )
    .join("");
  return `<figure style="margin:var(--space-3) 0"><div style="${NODE};border:1px solid var(--line-1);background:var(--bg-1)"><span ${NAME}>${escapeHtml(parent.title)}</span>${saidMark(said("cardLastPartWaiting"), "span", pill("color:var(--fg-2);border:1px solid var(--line-2)"))}</div><div style="display:grid;grid-template-columns:var(--space-4) minmax(0,1fr);margin-inline-start:var(--space-4)">${tree}</div></figure>`;
}

/**
 * The card as the host raises it. Its title is the same for every part,
 * so the figure names the parent and the part. Its words are the
 * catalog's (`docs/i18n.md`, "Saved facts"): the body carries each run as a
 * fact and the title's and buttons' facts in one mark, so each view words
 * it in its own language. Start now runs the host's own start, the
 * captain's start of a task on request; Keep it waiting has no effect and
 * only closes the card, which the once-per-close rule then keeps down.
 * Dropping is not a card effect (`HOST_OPS`), so a reply goes to the first
 * mate, which can drop or change the part for the captain (INF-1670's rule
 * for the host's own cards).
 */
export function lastPartCard(
  part: TaskRecord,
  parent: TaskRecord,
  closed: ClosedParts,
  now: number,
): Card {
  const names = { part: part.title, parent: parent.title };
  const title = said("cardLastPartTitle");
  const start = said("cardLastPartStart");
  const keep = said("cardLastPartKeep");
  return {
    ...hostCard({
      id: lastPartCardId(part.id),
      taskId: part.id,
      title: englishOf(title),
      meta: "",
      body: [
        `<p>${saidMark(said("cardLastPartOpen", names))} ${saidMark(said("cardLastPartStopped"))}</p>`,
        figure(part, parent, closed),
        `<p>${saidMark(said("cardLastPartWays"))}</p>`,
        cardWordsMark([title, start, keep]),
      ].join(""),
      answeredBy: "firstmate",
      actions: [
        {
          id: "start",
          label: englishOf(start),
          variant: "primary",
          default: true,
          effect: { kind: "host", op: "start-task", arg: part.id },
        },
        { id: "keep", label: englishOf(keep), variant: "secondary" },
      ],
    }),
    createdAt: now,
  };
}
