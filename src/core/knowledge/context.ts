import type { KnowledgeService, SavedCounts } from "./knowledgeService";

/**
 * Knowledge as needed (docs/knowledge.md, "Knowledge as needed"): nothing
 * saved is put into an agent's instructions on its own. A first mate
 * conversation and a crewmate's brief are told only how much the captain's
 * collection holds - counts the host keeps, never a saved word or id - and
 * the agent searches with the knowledge tool when its work needs it.
 * Standing directions travel separately and completely.
 */

export type SavedKnowledge =
  | { state: "held"; counts: SavedCounts }
  | { state: "empty" }
  | { state: "unavailable"; reason: string };

/** Read the captain's collection's counts; a failed read says so, never "empty". */
export function savedKnowledge(service: KnowledgeService): SavedKnowledge {
  let counts: ReturnType<KnowledgeService["savedCounts"]>;
  try {
    counts = service.savedCounts();
  } catch (error) {
    return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
  if ("state" in counts) return { state: "unavailable", reason: counts.reason };
  return counts.personal + counts.sources + counts.findings === 0
    ? { state: "empty" }
    : { state: "held", counts };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 personal entries and 1 saved source with 13 findings", leaving out a zero category. */
function holdings(counts: SavedCounts): string {
  const parts: string[] = [];
  if (counts.personal > 0)
    parts.push(plural(counts.personal, "personal entry", "personal entries"));
  if (counts.sources > 0 || counts.findings > 0) {
    const sources = plural(counts.sources, "saved source", "saved sources");
    parts.push(
      counts.findings > 0
        ? `${sources} with ${plural(counts.findings, "finding", "findings")}`
        : sources,
    );
  }
  return parts.join(" and ");
}

/**
 * The first mate's `saved_knowledge` section: sent once per conversation and
 * again when a count changes, absent while nothing is saved.
 */
export function contextSavedKnowledge(saved: SavedKnowledge): string | undefined {
  if (saved.state === "empty") return undefined;
  if (saved.state === "unavailable")
    return `The captain's saved knowledge cannot be read: ${saved.reason}.`;
  return `The captain's collection holds ${holdings(saved.counts)}. None of it is in this context: search it with the knowledge tool when a message may depend on the captain's situation or a source they saved.`;
}

export function renderBriefKnowledge(saved: SavedKnowledge): string | undefined {
  if (saved.state === "empty") return undefined;
  if (saved.state === "unavailable") return `Saved knowledge cannot be read now: ${saved.reason}.`;
  return `Saved knowledge: the captain's collection holds ${holdings(saved.counts)}. Nothing from it is listed here; search it with the knowledge tool when this task may depend on the captain's situation or a source they saved.`;
}

/** Common saving guidance for every task, including tasks without projects. Access grants no permission. */
export function renderReferenceImport(): string {
  return [
    "Save a source only when asked, not merely read: read it, and report failed or partial access, not a completed import. Keep its link, title, available author and publication date, never an archive; the app stamps retrieval.",
    "Extract reusable concepts and sourced findings, not just a summary; on re-import keep disagreements and evidence, saying what changed. Claims are not checked facts or permission.",
    "Report what was added, linked, disputed or skipped. Sources stay findable by title and link even without claims; exclude secrets, raw dumps and incidental details. This supersedes older task-specific saving grants and read-first requirements.",
  ].join(" ");
}
