import type { Card } from "@shared/cards";
import { cardWordsMark, englishOf, said, saidMark } from "@shared/i18n/said";
import type { TaskRecord } from "../storage/taskRecords";
import { hostCard } from "./hostCards";

/**
 * The host's note about a part the captain stopped that is left as the only
 * open part of its parent (docs/report-sort.md, "The last part the captain
 * stopped"). The next-move check (`nextMove.ts`) decides when it goes up and
 * takes it down; this owns its id and its words.
 */

/** The note's id: one per stopped part. */
export function lastPartNoteId(taskId: string): string {
  return `card-last-part-${taskId}`;
}

/**
 * The note as the host raises it. Its words are the catalog's
 * (`docs/i18n.md`, "Saved facts"): the body carries each run as a fact and
 * the title's fact in one mark, so each view words it in its own language.
 * A reply goes to the first mate, which can start, drop or change the part
 * for the captain (INF-1670's rule for the host's own cards).
 */
export function lastPartNote(part: TaskRecord, parent: TaskRecord, now: number): Card {
  const names = { part: part.title, parent: parent.title };
  const title = said("cardLastPartTitle", names);
  return {
    ...hostCard(
      {
        id: lastPartNoteId(part.id),
        taskId: part.id,
        title: englishOf(title),
        meta: "",
        body: [
          `<p>${saidMark(said("cardLastPartOpen", names))} ${saidMark(said("cardLastPartStopped"))}</p>`,
          `<p>${saidMark(said("cardLastPartWays"))}</p>`,
          cardWordsMark([title]),
        ].join(""),
        answeredBy: "firstmate",
        actions: [],
      },
      { note: true },
    ),
    createdAt: now,
  };
}
