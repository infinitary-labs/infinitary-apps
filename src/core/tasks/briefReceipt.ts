import { createHash } from "node:crypto";
import { z } from "zod";
import type { BriefPart } from "../orchestrator/intentBrief";

/**
 * The `briefed` receipt (`TaskService.recordBrief`) pins the brief a
 * crewmate's first turn served. Most of a grounded builder's
 * brief is report text copied off another task's timeline, and report
 * events are kept whole and never compacted, so the receipt stores each
 * such copy as a reference to its event wherever the reference is the
 * smaller of the two, and the reader puts the text back.
 *
 * The stored text stays readable on its own: each referenced report is a
 * short stand-in naming the event and its task, so a reader that knows
 * nothing of references (an older build, an export) still reads where the
 * text is. The reference carries the text's hash, because event ids are
 * local to one database (an export reloads them renumbered): the reader
 * takes the named event when its text still hashes the same, else the one
 * report of that task that does.
 */

/** Where one referenced report sits in the stored text, and which it is. */
const receiptRefSchema = z.object({
  /** Offset of its stand-in in the stored text. */
  at: z.number().int().nonnegative(),
  /** Length of that stand-in. */
  length: z.number().int().nonnegative(),
  task: z.string(),
  event: z.number().int(),
  sha256: z.string(),
});
export type ReceiptRef = z.infer<typeof receiptRefSchema>;

const receiptDataSchema = z.object({ reports: z.array(receiptRefSchema) });

export function reportHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function standIn(taskId: string, eventId: number): string {
  return `[report event ${eventId} of task ${taskId}, kept on the record by reference]`;
}

/** What a `briefed` event stores for a brief served from these pieces. */
export function compactBrief(parts: readonly BriefPart[]): { text: string; refs: ReceiptRef[] } {
  let text = "";
  const refs: ReceiptRef[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    const stand = standIn(part.taskId, part.eventId);
    const ref: ReceiptRef = {
      at: text.length,
      length: stand.length,
      task: part.taskId,
      event: part.eventId,
      sha256: reportHash(part.text),
    };
    // A short report costs less copied than referenced.
    if (stand.length + JSON.stringify(ref).length >= part.text.length) {
      text += part.text;
      continue;
    }
    refs.push(ref);
    text += stand;
  }
  return { text, refs };
}

/**
 * The brief a receipt served, whole: each reference replaced by its
 * report's text. A report no longer on the record leaves its stand-in,
 * which names it.
 */
export function expandBrief(
  text: string,
  data: unknown,
  reportText: (ref: ReceiptRef) => string | undefined,
): string {
  const parsed = receiptDataSchema.safeParse(data);
  if (!parsed.success) return text;
  let served = text;
  for (const ref of [...parsed.data.reports].sort((a, b) => b.at - a.at)) {
    const found = reportText(ref);
    if (found !== undefined) {
      served = served.slice(0, ref.at) + found + served.slice(ref.at + ref.length);
    }
  }
  return served;
}
