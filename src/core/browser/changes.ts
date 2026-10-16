import { browserCommand } from "./commandWords";
import type { OutlineLine } from "./outline";
import { mapOf, type PageWindow, WINDOW_CHARS, WINDOW_LINES } from "./window";

/** Compare only outline text already filtered by the page's privacy rules.
 * Line numbers refer to the old outline for removals and the current one for additions.
 * Bound both comparison work and the answer, even when a page replaces everything.
 */
export function changesOf(
  before: readonly string[],
  after: readonly OutlineLine[],
): Omit<PageWindow, "found"> {
  const now = after.map((line) => line.text);
  let start = 0;
  while (start < before.length && start < now.length && before[start] === now[start]) start++;
  let oldEnd = before.length;
  let newEnd = now.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === now[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (start === oldEnd && start === newEnd) {
    return { lines: ["changed: nothing changed in the outline."], next: [] };
  }

  const oldCount = oldEnd - start;
  const newCount = newEnd - start;
  const edits: { old: number; current: number; removed: boolean }[] = [];
  if (oldCount * newCount <= 250_000) {
    const width = newCount + 1;
    const lengths = new Uint32Array((oldCount + 1) * width);
    for (let i = oldCount - 1; i >= 0; i--) {
      for (let j = newCount - 1; j >= 0; j--) {
        lengths[i * width + j] =
          before[start + i] === now[start + j]
            ? 1 + (lengths[(i + 1) * width + j + 1] ?? 0)
            : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldCount || j < newCount) {
      if (i < oldCount && j < newCount && before[start + i] === now[start + j]) {
        i++;
        j++;
      } else if (
        i < oldCount &&
        (j === newCount || (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0))
      ) {
        edits.push({ old: start + i++, current: start + j, removed: true });
      } else {
        edits.push({ old: start + i, current: start + j++, removed: false });
      }
    }
  } else {
    // A wholesale replacement: no quadratic work on an arbitrarily large page.
    for (let i = start; i < oldEnd; i++) edits.push({ old: i, current: start, removed: true });
    for (let j = start; j < newEnd; j++) edits.push({ old: oldEnd, current: j, removed: false });
  }
  const removed = edits.filter((edit) => edit.removed).length;
  const added = edits.length - removed;
  const out = [
    `changed: ${removed} old lines removed, ${added} current lines added (replacements count as both).`,
  ];
  let chars = out[0]?.length ?? 0;
  let shown = 0;
  for (const edit of edits) {
    const line = edit.removed
      ? `- old line ${edit.old + 1}: ${before[edit.old]}`
      : `+ line ${edit.current + 1}: ${now[edit.current]}`;
    if (shown >= WINDOW_LINES || chars + line.length + 1 > WINDOW_CHARS) break;
    out.push(line);
    chars += line.length + 1;
    shown++;
  }
  if (shown < edits.length) {
    out.push(`… ${edits.length - shown} changed lines not shown.`, ...mapOf(after));
    return {
      lines: out,
      next: [
        `${browserCommand("snapshot")} reads the current page; ${browserCommand("snapshot --from <line>")} reads from a current line above.`,
      ],
    };
  }
  return { lines: out, next: [] };
}
