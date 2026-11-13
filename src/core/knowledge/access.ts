import type { EntryRow, KnowledgeLane, KnowledgeStore } from "../storage/knowledgeStore";
import type { KnowledgeOrigin } from "./origin";
import { scanKnowledgeThreat } from "./threatScan";

/**
 * Who may read and write knowledge, and how much one call may carry
 * (docs/knowledge.md, "Who may write"). The host stamps who is asking from
 * the session, never from the model's words. Every actor reads the
 * captain's factual collection; a refusal is guidance the model reads,
 * never a failed turn.
 */

export const KNOWLEDGE_LIMITS = {
  /** Search and neighbor pages: hits per page, and the bytes they may fill. */
  pageHits: 10,
  pageBytes: 4 * 1024,
  /** A whole-entry read or a history page. */
  readBytes: 32 * 1024,
  /** One write, everything it carries included. */
  writeBytes: 16 * 1024,
  /** The words a search reads. */
  queryBytes: 1024,
  /** Entries one get reads at once. */
  getIds: 5,
} as const;

/** Text field bounds, in characters. */
export const MAX = {
  title: 120,
  alias: 60,
  aliases: 8,
  explanation: 4000,
  links: 12,
  reason: 400,
  statement: 2000,
  about: 8,
  predicate: 60,
  conditions: 1000,
  sources: 6,
  quote: 6000,
  citation: 500,
  excerpt: 1500,
  url: 500,
  author: 80,
  published: 40,
  appliesTo: 8,
  method: 600,
  purpose: 600,
  requestId: 100,
} as const;

/** The collection Firstmate keeps for the captain alone, beside each project's. */
export const PRIVATE_SCOPE = "captain";

/** Who is asking: the host stamps it from the session, never from the model's words. */
export type KnowledgeActor =
  | { kind: "firstmate"; origin: KnowledgeOrigin; canCreate: boolean }
  | { kind: "crewmate"; taskId: string; repoId: string; cwd?: string };

/**
 * The captain's window, as the browser reads: what Firstmate reads - the
 * private collection and every registered project's - and nothing it could
 * write with, since the browser only ever reads.
 */
export const WINDOW: KnowledgeActor = { kind: "firstmate", origin: "agent", canCreate: false };

const ID = /^[cf]-[a-z0-9]{6}$/;

/** A write or read the host refused: its message is guidance for the model, never a failed turn. */
export class KnowledgeRefusal extends Error {}

export function refuse(message: string): never {
  throw new KnowledgeRefusal(message);
}

export function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** A value as JSON with its keys sorted, so the same write reads the same every time. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );
}

/** A text field trimmed, inside its bound and free of a threat pattern, or refused. */
export function clean(
  value: string | undefined,
  field: string,
  max: number,
  required: boolean,
): string {
  const text = value?.trim() ?? "";
  if (!text) {
    if (required) refuse(`${field} is required.`);
    return "";
  }
  if (text.length > max) refuse(`${field} is at most ${max} characters.`);
  const threat = scanKnowledgeThreat(text);
  if (threat) {
    refuse(
      `Refused: ${field} matches a ${threat.pattern} pattern. Knowledge is not a place for credentials, instruction overrides or exfiltration links.`,
    );
  }
  return text;
}

export function actorId(actor: KnowledgeActor): string {
  return actor.kind === "firstmate" ? "firstmate" : `task:${actor.taskId}`;
}

export function originOf(actor: KnowledgeActor): string {
  return actor.kind === "firstmate" ? actor.origin : "crewmate";
}

export function laneOf(actor: KnowledgeActor): KnowledgeLane {
  return actor.kind === "crewmate" ? "reference" : "personal";
}

/**
 * Every actor reads the captain's factual collection. Project applicability
 * describes relevance, not access; directions use their separate exact scopes.
 */
export function scopesFor(_actor: KnowledgeActor): string[] {
  return [PRIVATE_SCOPE];
}

export function readScopes(actor: KnowledgeActor, scope: string | undefined): string[] {
  const scopes = scopesFor(actor);
  const wanted = scope?.trim();
  if (!wanted) return scopes;
  if (!scopes.includes(wanted)) {
    refuse(
      actor.kind === "crewmate"
        ? "You read the captain's factual knowledge. Leave scope out."
        : `Unknown scope "${wanted}". Use captain or a repo_id from the context block.`,
    );
  }
  return [wanted];
}

export function writeScope(actor: KnowledgeActor, scope: string | undefined): string {
  const wanted = scope?.trim();
  if (actor.kind === "crewmate") {
    if (wanted && wanted !== PRIVATE_SCOPE) {
      refuse("A crewmate writes factual knowledge in the captain's collection. Leave scope out.");
    }
    return PRIVATE_SCOPE;
  }
  if (wanted && wanted !== PRIVATE_SCOPE) {
    refuse(
      "Knowledge keeps what the captain says about themselves, and sources they ask to save. How a project works stays in its code, documents and tests. What an investigation found stays on the task.",
    );
  }
  return PRIVATE_SCOPE;
}

/** An entry by its id, or the same refusal whether the id is malformed or absent. */
export function readable(store: KnowledgeStore, id: string | undefined): EntryRow {
  const wanted = id?.trim() ?? "";
  if (!ID.test(wanted)) refuse(`Give an entry id such as c-1a2b3c or f-1a2b3c; got "${wanted}".`);
  const entry = store.entry(wanted);
  if (!entry) refuse(`No entry ${wanted} in a collection you can read.`);
  return entry;
}

/** Who may record. A declared use is not a record, so it does not come here. */
export function assertRecorder(actor: KnowledgeActor): void {
  if (actor.kind === "firstmate" && (actor.origin !== "captain-turn" || !actor.canCreate)) {
    refuse(
      "The first mate records a personal statement or correction only on the captain's words. An import or a reconciliation is the crewmate's write. A scheduled turn records nothing.",
    );
  }
}

/** Reconciliation of a saved reference is the crewmate's, not Firstmate's. */
export function assertNotReferenceReconciliation(actor: KnowledgeActor, entry: EntryRow): void {
  if (actor.kind === "firstmate" && entry.lane === "reference") {
    refuse(
      "A saved reference is the importing crewmate's to reconcile. The first mate records personal statements and corrections, and retires an entry only on the captain's word.",
    );
  }
}

export function expectedRevision(entry: EntryRow, expected: number | undefined): number {
  if (expected === undefined) {
    refuse(`Pass expected_revision: the revision you read (${entry.id} is at ${entry.revision}).`);
  }
  if (expected !== entry.revision) {
    refuse(
      `${entry.id} is at revision ${entry.revision}, not ${expected}; read it again and decide from there.`,
    );
  }
  return expected;
}
