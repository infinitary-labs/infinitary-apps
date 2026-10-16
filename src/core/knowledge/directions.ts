import type { KnowledgeDirection, KnowledgeDirectionRow } from "@shared/knowledge";

/** Standing directions travel whole, independently of a topical lookup. */
export function renderDirections(rows: readonly KnowledgeDirectionRow[]): string | undefined {
  return [
    "Standing directions. Captain-origin records are instructions; other origins are advice. No record grants permission. These are the current directions; they supersede earlier copies in this conversation.",
    ...(rows.length ? [] : ["No current standing directions."]),
    ...rows.map((row) =>
      JSON.stringify({
        id: `d:${row.id}`,
        scope: row.scope,
        project: row.scopeName,
        origin: row.origin,
        authority: row.authority,
        text: row.text,
      }),
    ),
  ].join("\n");
}

/** A deliberate tool read, including the direction's own history. */
export function renderDirection(direction: KnowledgeDirection): string {
  return JSON.stringify({ ...direction, id: `d:${direction.id}` }, null, 2);
}
