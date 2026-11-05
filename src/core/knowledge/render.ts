import type { RevisionRow } from "../storage/knowledgeStore";
import { KNOWLEDGE_LIMITS } from "./access";
import type { EntrySummary, EntryView, FindingStatus, Neighbor } from "./entries";
import type { SourceView } from "./sources";

/**
 * Knowledge as the model reads it (docs/knowledge.md, "The tools"): one line
 * per entry, then whole entries with their evidence, every page inside the
 * byte bound its kind of read allows. The words say what an entry is and
 * how far it was checked; none of them makes it an instruction.
 */

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function clipBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let cut = text.slice(0, max);
  while (bytes(cut) > max - 3) cut = cut.slice(0, -64);
  return `${cut}…`;
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function statusWords(status: FindingStatus): string {
  const parts: string[] = [];
  switch (status.state) {
    case "checked":
      parts.push(
        `checked (${status.checks.map((check) => `${clip(check.method, 60)} by ${check.actor}`).join("; ")})`,
      );
      break;
    case "unchecked":
      parts.push(
        status.earlierChecked
          ? "not yet checked at this revision (an earlier one was)"
          : "not yet checked",
      );
      break;
    case "disputed":
      parts.push(`disputed by ${status.disputedBy.join(", ")}`);
      break;
    case "superseded":
      parts.push(`superseded by ${status.supersededBy}`);
      break;
    case "retired":
      parts.push("retired");
      break;
  }
  if (status.challenged) parts.push("challenged without evidence");
  if (status.duplicateOf) parts.push(`duplicate of ${status.duplicateOf}`);
  return parts.join("; ");
}

/** One entry on one line; a finding's statement only when `bodies`. */
export function summaryLine(entry: EntrySummary, bodies = true): string {
  const where = `[${entry.scopeName}${entry.lane === "reference" ? ", saved reference" : ""}]`;
  if (entry.kind === "concept") {
    const aliases = entry.aliases.length > 0 ? `; also called ${entry.aliases.join(", ")}` : "";
    const counts = `; ${entry.findings ?? 0} findings, ${entry.links ?? 0} read-together links`;
    return `${entry.id} concept "${clip(entry.title, 80)}" r${entry.revision} ${where}${
      entry.retired ? " (retired)" : ""
    }${aliases}${counts}`;
  }
  const about = entry.about.map((concept) => `"${clip(concept.title, 40)}"`).join(", ");
  const claim = entry.relationship
    ? `; claims "${clip(entry.relationship.from.title, 40)}" -[${entry.relationship.predicate}]-> "${clip(entry.relationship.to.title, 40)}"`
    : "";
  const status = entry.status ? statusWords(entry.status) : "";
  const said = bodies ? `: ${clip(entry.title, 200)}` : "";
  return `${entry.id} finding r${entry.revision} ${where} (${entry.basis ?? "finding"}; ${status}) about ${about}${claim}${said}`;
}

/** Lines that fit `budget` bytes, and how many did. */
function fitLines(lines: readonly string[], budget: number): { text: string; shown: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = bytes(line) + 1;
    if (used + size > budget && kept.length > 0) break;
    kept.push(clipBytes(line, budget));
    used += size;
  }
  return { text: kept.join("\n"), shown: kept.length };
}

export function renderSearch(
  query: string,
  where: string,
  result: { hits: EntrySummary[]; total: number },
  offset: number,
): string {
  if (result.total === 0) {
    return `No knowledge matched "${clip(query, 80)}" in ${where}. Try other words or an alias.`;
  }
  const header = `${result.total} match${result.total === 1 ? "" : "es"} in ${where}, best first (candidates: get one before relying on it):`;
  const page = fitLines(
    result.hits.map((hit) => `- ${summaryLine(hit)}`),
    KNOWLEDGE_LIMITS.pageBytes - bytes(header) - 40,
  );
  const next = offset + page.shown;
  return [header, page.text, ...(next < result.total ? [`next: cursor ${next}`] : [])].join("\n");
}

function sourceLine(source: SourceView): string {
  const origin = source.origin;
  const what =
    origin.kind === "file"
      ? `file ${origin.path} lines ${origin.startLine}-${origin.endLine}${
          origin.commit ? ` at commit ${origin.commit.slice(0, 10)}` : ""
        }${origin.dirty ? " (uncommitted work)" : ""}`
      : origin.kind === "report"
        ? `${origin.key}'s report (event ${origin.event})`
        : origin.kind === "article"
          ? `article "${origin.title}" ${origin.url}${origin.author ? `, ${origin.author}` : ""}${origin.published ? `, published ${origin.published}` : ""}, retrieved ${day(origin.retrieved)}`
          : `quotation from ${origin.citation}`;
  return `- ${source.id} ${what}, kept ${day(source.capturedAt)} by ${source.actor}, sha256 ${source.digest.slice(0, 12)}: ${source.check.state} - ${source.check.detail}`;
}

function revisionLine(row: RevisionRow): string {
  return `revision ${row.revision} (${row.op}) by ${row.actor}${
    row.origin && row.origin !== "crewmate" ? ` (${row.origin})` : ""
  } on ${day(row.at)}${row.reason ? `: ${clip(row.reason, 200)}` : ""}`;
}

function entryText(view: EntryView): string {
  const entry = view.summary;
  const lines: string[] = [];
  const current = entry.revision === view.shown.revision ? "" : " (an earlier revision)";
  if (entry.kind === "concept") {
    lines.push(
      `${entry.id} concept "${entry.title}" [${entry.scopeName}], ${revisionLine(view.shown)}${current}${
        entry.retired ? " - retired" : ""
      }`,
    );
    if (entry.aliases.length > 0) lines.push(`also called: ${entry.aliases.join(", ")}`);
    lines.push(`explanation: ${view.explanation ?? ""}`);
    if (view.links.length > 0) {
      lines.push("read together with:");
      for (const link of view.links) {
        lines.push(
          `- ${link.other.id} "${clip(link.other.title, 80)}"${link.other.retired ? " (retired)" : ""}: ${link.reason}${
            link.outgoing ? "" : ` (linked from ${link.other.id})`
          }`,
        );
      }
    }
    lines.push(
      `findings about it: ${entry.findings ?? 0} (knowledge neighbors with id ${entry.id} and layer about lists them)`,
    );
  } else {
    const shown = view.shown.body as { statement: string; conditions: string };
    lines.push(
      `${entry.id} finding [${entry.scopeName}], ${revisionLine(view.shown)}${current}, ${entry.basis}`,
    );
    lines.push(`statement: ${shown.statement}`);
    lines.push(`conditions: ${shown.conditions}`);
    lines.push(
      `about: ${entry.about.map((concept) => `${concept.id} "${clip(concept.title, 60)}"${concept.retired ? " (retired)" : ""}`).join("; ")}`,
    );
    if (entry.relationship) {
      lines.push(
        `relationship: "${entry.relationship.from.title}" -[${entry.relationship.predicate}]-> "${entry.relationship.to.title}" (${entry.relationship.from.id} to ${entry.relationship.to.id}; what this finding claims, read subject to object - not a verification and not causation by itself)`,
      );
    }
    if (entry.status) lines.push(`status: ${statusWords(entry.status)}`);
  }
  lines.push(view.sources.length > 0 ? "evidence:" : "evidence: none cited");
  for (const source of view.sources) {
    lines.push(sourceLine(source));
  }
  if (view.assessments.length > 0) {
    lines.push("assessments:");
    for (const assessment of view.assessments) {
      lines.push(
        `- ${assessment.verdict} on revision ${assessment.revision}${assessment.current ? "" : " (earlier)"} by ${assessment.actor} on ${day(assessment.at)}; method: ${clip(assessment.method, 300)}; conditions: ${clip(assessment.conditions, 300)}${
          assessment.sources.length === 0 ? "; no evidence cited" : ""
        }`,
      );
      for (const source of assessment.sources) lines.push(`  ${sourceLine(source)}`);
    }
  }
  if (view.relations.length > 0) {
    lines.push("disagreements and history:");
    for (const relation of view.relations) {
      lines.push(
        relation.outgoing
          ? `- this (revision ${relation.fromRevision}) ${relation.type} ${relation.other.id} (revision ${relation.toRevision}): ${clip(relation.reason, 300)}`
          : `- ${relation.other.id} (revision ${relation.fromRevision}) ${relation.type} this (revision ${relation.toRevision}): ${clip(relation.reason, 300)}`,
      );
    }
  }
  if (view.uses.count > 0) {
    const latest = view.uses.recent[0];
    lines.push(
      `declared uses: ${view.uses.count}${
        latest
          ? ` (latest: ${latest.actor} relied on revision ${latest.revision} on ${day(latest.at)} for ${clip(latest.purpose, 120)})`
          : ""
      }`,
    );
  }
  return lines.join("\n");
}

/** Lean entries with source ids and checks; kept text is read explicitly by source id. */
export function renderEntries(views: readonly EntryView[], extra: readonly string[] = []): string {
  const budget = Math.floor(KNOWLEDGE_LIMITS.readBytes / Math.max(1, views.length + extra.length));
  const parts = views.map((view) => clipBytes(entryText(view), budget));
  return [...parts, ...extra.map((text) => clipBytes(text, budget))].join("\n\n");
}

export function renderSource(source: SourceView): string {
  return [sourceLine(source).slice(2), source.text].join("\n").slice(0, KNOWLEDGE_LIMITS.readBytes);
}

export function renderNeighbors(
  entry: string,
  result: { neighbors: Neighbor[]; total: number },
  offset: number,
): string {
  if (result.total === 0) return `${entry} has no links yet.`;
  const header = `${entry}: ${result.total} neighbor${result.total === 1 ? "" : "s"} one hop away:`;
  const lines = result.neighbors.map((neighbor) => {
    const other = summaryLine(neighbor.other);
    switch (neighbor.layer) {
      case "relationship":
        return neighbor.outgoing
          ? `- claimed relationship: this -[${neighbor.label}]-> ${other} (claimed by ${neighbor.via})`
          : `- claimed relationship: ${neighbor.other.id} -[${neighbor.label}]-> this (claimed by ${neighbor.via}); ${other}`;
      case "context":
        return `- read together: ${other} - ${neighbor.label}`;
      case "about":
        return neighbor.outgoing
          ? `- about${neighbor.label ? ` (${neighbor.label})` : ""}: ${other}`
          : `- finding about this: ${other}`;
      default:
        return neighbor.outgoing
          ? `- this ${neighbor.label} ${other}`
          : `- ${neighbor.other.id} ${neighbor.label} this: ${other}`;
    }
  });
  const page = fitLines(lines, KNOWLEDGE_LIMITS.pageBytes - bytes(header) - 40);
  const next = offset + page.shown;
  return [header, page.text, ...(next < result.total ? [`next: cursor ${next}`] : [])].join("\n");
}

export function renderHistory(result: {
  entry: EntrySummary;
  revisions: RevisionRow[];
  remaining: number;
}): string {
  const lines = [`${result.entry.id} revisions, newest first:`];
  for (const row of result.revisions) {
    const body = row.body as { title?: string; statement?: string; explanation?: string };
    lines.push(
      `- ${revisionLine(row)}`,
      `  ${clip(body.statement ?? `${body.title ?? ""}: ${body.explanation ?? ""}`, 600)}`,
    );
  }
  const page = fitLines(lines, KNOWLEDGE_LIMITS.readBytes - 64);
  const shownRevisions = result.revisions.slice(0, Math.max(0, Math.floor((page.shown - 1) / 2)));
  const oldest = shownRevisions.at(-1)?.revision;
  return [
    page.text,
    ...(oldest !== undefined && oldest > 1 ? [`older: cursor ${oldest}`] : []),
  ].join("\n");
}
