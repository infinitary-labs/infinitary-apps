import type { Card } from "@shared/cards";
import { cardWordsMark, englishOf, said, saidMark } from "@shared/i18n/said";
import type { TaskRecord } from "../storage/taskRecords";
import { hostCard } from "./hostCards";

/**
 * The host's decision about a part the captain stopped that is left as the
 * only open part of its parent (docs/report-sort.md, "The last part the
 * captain stopped"). The next-move check (`nextMove.ts`) decides when it
 * goes up and takes it down; this owns its id, its words and its choices.
 */

/** The card's id: one per stopped part. */
export function lastPartCardId(taskId: string): string {
  return `card-last-part-${taskId}`;
}

/**
 * The card as the host raises it. Its words are the catalog's
 * (`docs/i18n.md`, "Saved facts"): the body carries each run as a fact and
 * the title's and buttons' facts in one mark, so each view words it in its
 * own language. Start now runs the host's own start, the captain's start of
 * a task on request; Keep it waiting has no effect and only closes the card,
 * which the once-per-close rule then keeps down. Dropping is not a card
 * effect (`HOST_OPS`), so a reply goes to the first mate, which can drop or
 * change the part for the captain (INF-1670's rule for the host's own cards).
 */
export function lastPartCard(part: TaskRecord, parent: TaskRecord, now: number): Card {
  const names = { part: part.title, parent: parent.title };
  const title = said("cardLastPartTitle", names);
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
