import type { PanelFeedLine } from "@infinitary/contracts";

/**
 * The Activity panel's row bookkeeping (Phase A item 6; the phase-2
 * streaming probe's rules, docs/ui-plugins.md). Pure, so the panel
 * (./panel.tsx) renders it and a unit test reads it.
 *
 * A line is keyed by what it says (time, kind, task, text); two lines that
 * say the same thing at the same millisecond are told apart by their order,
 * so every row has a key of its own. A push that only appends lines keeps
 * every row it had, and one that slides the full retained window forward
 * drops the oldest rows and appends the new ones - the rows in between are
 * the same nodes. `leadingDrop` is how many painted rows a push pushed out.
 */

export function feedKeyOf(line: PanelFeedLine): string {
  return `${line.at}|${line.kind}|${line.taskKey ?? ""}|${line.text}`;
}

/** One key per line, a repeated line numbered by its order among its twins. */
export function feedKeysOf(lines: readonly PanelFeedLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const key = feedKeyOf(line);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key}#${n}`;
  });
}

/**
 * How many of the painted rows lead out of the retained window: the fewest
 * whose removal leaves the rest as the start of `next`. The window only
 * grows or slides forward, so this is 0 while it grows and the number of
 * lines pushed out once it is full; `painted.length` when nothing painted
 * survives (the list is rebuilt).
 */
export function leadingDrop(painted: readonly string[], next: readonly string[]): number {
  for (let drop = 0; drop < painted.length; drop += 1) {
    const kept = painted.length - drop;
    if (kept > next.length) continue;
    let i = 0;
    while (i < kept && painted[drop + i] === next[i]) i += 1;
    if (i === kept) return drop;
  }
  return painted.length;
}

/** A line's semantic kind; rows written before the semantic trail still read. */
export function semanticKind(kind: string): string {
  if (kind === "spawn" || kind === "report") return "info";
  if (kind === "done") return "ok";
  return kind;
}
