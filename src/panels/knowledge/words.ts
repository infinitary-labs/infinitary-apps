import type {
  PanelKnowledgeCollection,
  PanelKnowledgeConnection,
  PanelKnowledgeEntryConnection,
  PanelKnowledgeOrigin,
  PanelKnowledgeSource,
  PanelKnowledgeStanding,
} from "@infinitary/contracts";
import * as m from "./messages.generated";

/**
 * What the Knowledge panel and its browser say (the design skill's
 * `components/knowledge/KnowledgeBrowser`), in one place: a collection's
 * name and counts, a finding's standing, a connection as words, and where
 * a kept source came from. Plain words for someone who has never opened a
 * terminal; numbers stay numbers.
 */

/**
 * What a message is handed in place of a part the panel draws itself, such
 * as a task key it links: `aroundSlot` splits the worded sentence there.
 */
export const SLOT = "\u0000";

/** A worded sentence's words before and after its one `SLOT`. */
export function aroundSlot(worded: string): [string, string] {
  const at = worded.indexOf(SLOT);
  return at < 0 ? [worded, ""] : [worded.slice(0, at), worded.slice(at + SLOT.length)];
}

/** A collection's name: the project's, or Private for the captain's own. */
export function collectionName(collection: Pick<PanelKnowledgeCollection, "name" | "private">) {
  return collection.private ? m.knowledgePanelPrivateCollection() : collection.name;
}

/**
 * The captain scope in the Directions filter (INF-1217): it applies in
 * every project, and only the first mate reads it, never a crewmate. The
 * first mate's own list names it the same (`CAPTAIN_SCOPE_NAME`).
 */
export function directionsEverywhere(): string {
  return m.knowledgePanelDirectionsEverywhere();
}

/**
 * What the collapsed panel says while the collection cannot be read. Worded
 * once, when the module loads: the panel's frame is born in the app's
 * language and a language change mounts it anew, and a journey reads it in
 * Node, in English, as a plain value.
 */
export const UNREADABLE_SUMMARY = m.knowledgePanelUnreadableSummary();

/** "1 concept", "4 findings": a journey's own count, in English. The panel words its counts with their own messages. */
export function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A collection's counts: "9 concepts · 4 findings". */
export function countsOf(counts: {
  concepts: number;
  findings: number;
  directions?: number;
}): string {
  return counts.directions
    ? m.knowledgePanelCountsWithDirections({
        concepts: m.knowledgePanelConceptCount({ count: counts.concepts }),
        findings: m.knowledgePanelFindingCount({ count: counts.findings }),
        directions: m.knowledgePanelDirectionCount({ count: counts.directions }),
      })
    : m.knowledgePanelCounts({
        concepts: m.knowledgePanelConceptCount({ count: counts.concepts }),
        findings: m.knowledgePanelFindingCount({ count: counts.findings }),
      });
}

export function collectionSize(counts: {
  concepts: number;
  findings: number;
  directions?: number;
}): number {
  return counts.concepts + counts.findings + (counts.directions ?? 0);
}

export function directionOrigin(origin: string): string {
  if (origin === "captain-turn") return m.knowledgePanelOriginYourWords();
  if (origin.startsWith("crewmate-report:"))
    return m.knowledgePanelOriginCrewmateReport({ key: origin.slice("crewmate-report:".length) });
  return m.knowledgePanelOriginAgent();
}

/** A finding's standing as its chip says it. */
export const STANDING_WORDS: Readonly<Record<PanelKnowledgeStanding, string>> = {
  get checked() {
    return m.knowledgePanelStandingChecked();
  },
  get unchecked() {
    return m.knowledgePanelStandingUnchecked();
  },
  get recheck() {
    return m.knowledgePanelStandingRecheck();
  },
  get differing() {
    return m.knowledgePanelStandingDiffering();
  },
  get superseded() {
    return m.knowledgePanelStandingSuperseded();
  },
  get retired() {
    return m.knowledgePanelStandingRetired();
  },
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
    ? m.knowledgePanelClaimKindLine({
        standing: STANDING_WORDS[connection.standing ?? "unchecked"],
      })
    : m.knowledgePanelContextKindLine();
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
  return m.knowledgePanelReadWith({ from: connection.from.title, to: connection.to.title });
}

/** Where a kept source came from, in words. */
export function originLine(origin: PanelKnowledgeOrigin): string {
  if (origin.kind === "file") {
    const lines =
      origin.startLine === origin.endLine
        ? m.knowledgePanelOriginLine({ line: String(origin.startLine) })
        : m.knowledgePanelOriginLines({
            first: String(origin.startLine),
            last: String(origin.endLine),
          });
    const path = origin.path;
    if (!origin.commit) return m.knowledgePanelOriginFile({ path, lines });
    const commit = origin.commit.slice(0, 10);
    return origin.dirty
      ? m.knowledgePanelOriginFileKeptDirty({ path, lines, commit })
      : m.knowledgePanelOriginFileKept({ path, lines, commit });
  }
  if (origin.kind === "report") return m.knowledgePanelOriginReport({ key: origin.key });
  if (origin.kind === "article") {
    const { title, url, author, published } = origin;
    if (author && published)
      return m.knowledgePanelOriginArticleByOn({ title, url, author, published });
    if (author) return m.knowledgePanelOriginArticleBy({ title, url, author });
    if (published) return m.knowledgePanelOriginArticleOn({ title, url, published });
    return m.knowledgePanelOriginArticle({ title, url });
  }
  return m.knowledgePanelOriginQuote({ citation: origin.citation });
}

/** What a kept source reads like now, in words. */
export const CHECK_WORDS: Readonly<Record<PanelKnowledgeSource["check"]["state"], string>> = {
  get unchanged() {
    return m.knowledgePanelSourceUnchanged();
  },
  get changed() {
    return m.knowledgePanelSourceChanged();
  },
  get missing() {
    return m.knowledgePanelSourceMissing();
  },
  get unknown() {
    return m.knowledgePanelSourceUnknown();
  },
  get kept() {
    return m.knowledgePanelSourceKept();
  },
};

/** A verdict as a check says it. */
export const VERDICT_WORDS = {
  get supports() {
    return m.knowledgePanelVerdictSupports();
  },
  get contradicts() {
    return m.knowledgePanelVerdictContradicts();
  },
  get inconclusive() {
    return m.knowledgePanelVerdictInconclusive();
  },
} as const;

/** What a revision did. */
export const OP_WORDS = {
  get publish() {
    return m.knowledgePanelOpPublish();
  },
  get revise() {
    return m.knowledgePanelOpRevise();
  },
  get link() {
    return m.knowledgePanelOpLink();
  },
  get retire() {
    return m.knowledgePanelOpRetire();
  },
  get restore() {
    return m.knowledgePanelOpRestore();
  },
} as const;

/** A disagreement or replacement, read from this entry's side. */
export function relationLine(relation: {
  type: "contradicts" | "supersedes" | "duplicates";
  outgoing: boolean;
}): string {
  if (relation.type === "contradicts") return m.knowledgePanelRelationContradicts();
  if (relation.type === "supersedes")
    return relation.outgoing
      ? m.knowledgePanelRelationReplaces()
      : m.knowledgePanelRelationReplacedBy();
  return relation.outgoing
    ? m.knowledgePanelRelationDuplicates()
    : m.knowledgePanelRelationDuplicatedBy();
}

/** A date and time in the captain's own words and time zone, in the locale the frame's document names. */
export function whenOf(at: number): string {
  return new Date(at).toLocaleString(frameLocale(), {
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
  return m.knowledgePanelRange({
    first: String(first),
    last: String(first + shown - 1),
    total: String(total),
  });
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
      return m.knowledgePanelAskConcept({
        title: quoted(about.title),
        id: about.id,
        revision: String(about.revision),
      });
    case "finding":
      return m.knowledgePanelAskFinding({
        title: quoted(about.title),
        id: about.id,
        revision: String(about.revision),
      });
    case "claim":
      return m.knowledgePanelAskClaim({
        sentence: quoted(about.sentence),
        finding: about.finding,
        revision: String(about.revision),
      });
    case "context":
      return m.knowledgePanelAskContext({
        from: quoted(about.from.title),
        to: quoted(about.to.title),
        fromId: about.from.id,
        toId: about.to.id,
      });
    case "direction":
      return m.knowledgePanelAskDirection({ text: quoted(about.text), id: about.id });
  }
}

/**
 * The locale the panel's frame document names for dates and times
 * (`FRAME_LOCALE_ATTRIBUTE`, docs/i18n.md "Dates and times"), or the
 * runtime's own when it names none.
 */
function frameLocale(): string | undefined {
  return globalThis.document?.documentElement.getAttribute("data-locale") ?? undefined;
}
