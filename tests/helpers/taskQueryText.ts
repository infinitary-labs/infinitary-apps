import {
  assembleTasksReads,
  parseTasksFieldPage,
  parseTasksQueryText,
} from "../../src/core/pi/taskTools";
import type { TaskQueryRow } from "../../src/core/tasks/taskQuery";

/**
 * INF-416 piece K: a by-key read that fits is indented JSON.
 * A longer one names the fields still to page; those pages are separate reads.
 * The retired $ref / $text format is refused.
 */
export function readTaskQueryText(text: string): TaskQueryRow[] {
  return parseTasksQueryText(text).rows;
}

/** The index read plus every field page, as the complete rows. */
export function readPagedTaskQuery(reads: string[]): TaskQueryRow[] {
  return assembleTasksReads(reads);
}

export async function pageTaskField(
  run: (args: { key: string; field: string; offset: number }) => Promise<{ text: string }>,
  key: string,
  field: string,
): Promise<string[]> {
  const pages: string[] = [];
  let offset = 1;
  while (true) {
    const page = await run({ key, field, offset });
    pages.push(page.text);
    const parsed = parseTasksFieldPage(page.text);
    if (!parsed?.nextOffset) return pages;
    offset = parsed.nextOffset;
  }
}
