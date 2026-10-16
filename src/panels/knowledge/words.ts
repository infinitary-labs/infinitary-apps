import type {
  PanelKnowledgeCollection,
  PanelKnowledgeConnection,
  PanelKnowledgeEntryConnection,
  PanelKnowledgeOrigin,
  PanelKnowledgeSource,
  PanelKnowledgeStanding,
} from "@infinitary/contracts";

/**
 * What the Knowledge panel and its browser say (the design skill's
 * `components/knowledge/KnowledgeBrowser`), in one place: a collection's
 * name and counts, a finding's standing, a connection as words, and where
 * a kept source came from. Plain words for someone who has never opened a
 * terminal; numbers stay numbers.
 */

/** A collection's name: the project's, or Private for the captain's own. */
export function collectionName(collection: Pick<PanelKnowledgeCollection, "name" | "private">) {
  return collection.private ? "Private" : collection.name;
}

/** What the collapsed panel says while the collection cannot be read. */
export const UNREADABLE_SUMMARY = "cannot be read";

/** "1 concept", "4 findings". */
export function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A collection's counts: "9 concepts · 4 findings". */
export function countsOf(counts: {
  concepts: number;
  findings: number;
  directions?: number;
}): string {
  return [
    counted(counts.concepts, "concept", "concepts"),
    counted(counts.findings, "finding", "findings"),
    ...(counts.directions ? [counted(counts.directions, "direction", "directions")] : []),
  ].join(" · ");
}

export function collectionSize(counts: {
  concepts: number;
  findings: number;
  directions?: number;
}): number {
  return counts.concepts + counts.findings + (counts.directions ?? 0);
}

export function directionOrigin(origin: string): string {
  if (origin === "captain-turn") return "Your words";
  if (origin.startsWith("crewmate-report:"))
    return `Crewmate report · ${origin.slice("crewmate-report:".length)}`;
  return "Agent";
}

/** A finding's standing as its chip says it. */
export const STANDING_WORDS: Record<PanelKnowledgeStanding, string> = {
  checked: "Checked",
  unchecked: "Not yet checked",
  recheck: "Needs rechecking",
  differing: "Differing evidence",
  superseded: "Superseded",
  retired: "Retired",
};

/** A standing that asks the captain to look again: drawn in the warn color. */
export function standingWarns(standing: PanelKnowledgeStanding): boolean {
  return standing === "recheck" || standing === "differing";
}

/** The line under a connection in the Connections list and the inspector's eyebrow. */
export function connectionKindLine(
  connection: Pick<PanelKnowledgeConnection, "kind"> & { standing?: PanelKnowledgeStanding },
): string {
  return connection.kind === "claim"
    ? `Recorded claim · ${STANDING_WORDS[connection.standing ?? "unchecked"]}`
    : "Read together · not a claim";
}

/**
 * A connection as one sentence: a claim reads subject, predicate, object,
 * as its finding states it; a read-together link names both ends.
 */
export function connectionSentence(
  connection:
    | PanelKnowledgeEntryConnection
    | { kind: "claim"; from: { title: string }; predicate: string; to: { title: string } }
    | { kind: "context"; from: { title: string }; to: { title: string } },
): string {
  if (connection.kind === "claim") {
    return `${connection.from.title} ${connection.predicate} ${connection.to.title}`;
  }
  return `${connection.from.title} read with ${connection.to.title}`;
}

/** Where a kept source came from, in words. */
export function originLine(origin: PanelKnowledgeOrigin): string {
  if (origin.kind === "file") {
    const lines =
      origin.startLine === origin.endLine
        ? `line ${origin.startLine}`
        : `lines ${origin.startLine}–${origin.endLine}`;
    const commit = origin.commit
      ? ` · kept at commit ${origin.commit.slice(0, 10)}${origin.dirty ? " with uncommitted changes" : ""}`
      : "";
    return `${origin.path}, ${lines}${commit}`;
  }
  if (origin.kind === "report") return `${origin.key}'s report`;
  if (origin.kind === "article") {
    const who = origin.author ? `, ${origin.author}` : "";
    const when = origin.published ? `, published ${origin.published}` : "";
    return `Saved article: ${origin.title} (${origin.url})${who}${when}`;
  }
  return `Quoted from ${origin.citation}`;
}

/** What a kept source reads like now, in words. */
export const CHECK_WORDS: Record<PanelKnowledgeSource["check"]["state"], string> = {
  unchanged: "Unchanged since it was kept",
  changed: "Changed since it was kept",
  missing: "Gone since it was kept",
  unknown: "Could not be compared",
  kept: "Kept as quoted; the app does not check it",
};

/** A verdict as a check says it. */
export const VERDICT_WORDS = {
  supports: "Supports it",
  contradicts: "Contradicts it",
  inconclusive: "Inconclusive",
} as const;

/** What a revision did. */
export const OP_WORDS = {
  publish: "Recorded",
  revise: "Revised",
  link: "Linked",
  retire: "Retired",
  restore: "Restored",
} as const;

/** A disagreement or replacement, read from this entry's side. */
export function relationLine(relation: {
  type: "contradicts" | "supersedes" | "duplicates";
  outgoing: boolean;
}): string {
  if (relation.type === "contradicts") return "Contradicts";
  if (relation.type === "supersedes") return relation.outgoing ? "Replaces" : "Replaced by";
  return relation.outgoing ? "Duplicates" : "Duplicated by";
}

/** A date and time in the captain's own words and time zone. */
export function whenOf(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "21–40 of 52": the rows a list page shows, of how many. */
export function rangeOf(page: number, size: number, shown: number, total: number): string {
  if (total === 0) return "0";
  const first = page * size + 1;
  return `${first}–${first + shown - 1} of ${total}`;
}

/** The most of an entry's own words an Ask about this question quotes. */
const QUOTED_MAX = 160;

function quoted(text: string): string {
  const trimmed = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "");
  return trimmed.length > QUOTED_MAX ? `${trimmed.slice(0, QUOTED_MAX - 1).trimEnd()}…` : trimmed;
}

/**
 * The question Ask about this starts the captain's next message with
 * (docs/knowledge.md, "Ask about this"): what the selection is, its words,
 * and the id and revision Firstmate reads it by, so the message is about
 * exactly that record. He finishes or changes it, and only sending it asks.
 */
export function askWords(
  about:
    | { kind: "concept" | "finding"; title: string; id: string; revision: number }
    | { kind: "claim"; sentence: string; finding: string; revision: number }
    | { kind: "context"; from: { title: string; id: string }; to: { title: string; id: string } }
    | { kind: "direction"; text: string; id: string },
): string {
  switch (about.kind) {
    case "concept":
    case "finding":
      return `What should I know about the ${about.kind} “${quoted(about.title)}” (${about.id}, revision ${about.revision})? `;
    case "claim":
      return `What should I know about the claim “${quoted(about.sentence)}” (${about.finding}, revision ${about.revision})? `;
    case "context":
      return `What should I know about reading “${quoted(about.from.title)}” with “${quoted(about.to.title)}” (${about.from.id}, ${about.to.id})? `;
    case "direction":
      return `What should I know about the direction “${quoted(about.text)}” (d:${about.id})? `;
  }
}
