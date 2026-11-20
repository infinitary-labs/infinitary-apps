import { createHash, type Hash } from "node:crypto";
import type { SessionRecordEntry } from "../storage/sessionRecordStore";

/** A served prompt's prefix as the decision record keeps it (`ServedState`). */
export type PrefixFingerprint = { messageCount: number; sha256: string };

/**
 * The recorded chain a message was appended to, root first, as the client
 * resumes it: from `parentId` back through each entry's `parentUuid` to the
 * root, stopping at an id the copy does not hold or one already walked.
 */
export function chainTo(
  byUuid: ReadonlyMap<string, SessionRecordEntry>,
  parentId: string | null,
): SessionRecordEntry[] {
  const chain: SessionRecordEntry[] = [];
  const visited = new Set<string>();
  let id = parentId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const entry = byUuid.get(id);
    if (!entry) break;
    chain.push(entry);
    id = typeof entry.parentUuid === "string" ? entry.parentUuid : null;
  }
  return chain.reverse();
}

/**
 * The prefix fingerprint of a rolling Claude session (docs/provenance-capture.md,
 * `served.prompt.prefix`): the sha256 of `JSON.stringify(chain)`, the recorded
 * chain the prompt was appended to.
 *
 * A rolling session's chain only grows between its prompts, so the digest
 * keeps the hash of the chain it last read and serializes only the entries
 * added since. Re-serializing the whole chain at every turn's close held the
 * app's main thread 551 ms on the captain's seat (INF-2408). The bytes hashed
 * are exactly `JSON.stringify(chain)`'s - `[`, each entry's JSON with `,`
 * between, `]` - so the fingerprint is the one the record kept before.
 *
 * A chain that does not continue the last one read (a compaction's new root,
 * a renewal's new copy, an entry the copy replaced) is read whole again;
 * entries are compared by identity, the copy's own parsed objects.
 */
export class PrefixDigest {
  /** The chain read so far, in order: the hash covers exactly these. */
  private entries: SessionRecordEntry[] = [];
  private hash: Hash = opened();
  /** Moves whenever the digest starts over, so a priming pass knows it lost its place. */
  private generation = 0;

  /** The fingerprint of `chain`, reading only what the last chain read lacks. */
  of(chain: readonly SessionRecordEntry[]): PrefixFingerprint {
    if (!this.continuedBy(chain)) this.reset();
    while (this.entries.length < chain.length) {
      this.add(chain[this.entries.length] as SessionRecordEntry);
    }
    return { messageCount: chain.length, sha256: this.hash.copy().update("]").digest("hex") };
  }

  /**
   * Read `chain` ahead of the close that will ask for it, one entry per turn
   * of the event loop, so the main thread keeps answering meanwhile. A close
   * that comes first reads the rest itself (`of`), and this pass stops.
   */
  async prime(chain: readonly SessionRecordEntry[]): Promise<void> {
    if (!this.continuedBy(chain)) {
      if (this.covers(chain)) return;
      this.reset();
    }
    const generation = this.generation;
    while (this.entries.length < chain.length) {
      const at = this.entries.length;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.generation !== generation || this.entries.length !== at) return;
      this.add(chain[at] as SessionRecordEntry);
    }
  }

  /** The last chain read is the start of `chain`. */
  private continuedBy(chain: readonly SessionRecordEntry[]): boolean {
    if (this.entries.length > chain.length) return false;
    return this.entries.every((entry, at) => entry === chain[at]);
  }

  /** `chain` is the start of the last chain read: there is nothing to read ahead. */
  private covers(chain: readonly SessionRecordEntry[]): boolean {
    return (
      chain.length <= this.entries.length && chain.every((entry, at) => entry === this.entries[at])
    );
  }

  /** Let go of the chain read: its session ended or moved to a new id (INF-2392). */
  release(): void {
    this.reset();
  }

  private reset(): void {
    this.entries = [];
    this.hash = opened();
    this.generation += 1;
  }

  private add(entry: SessionRecordEntry): void {
    if (this.entries.length > 0) this.hash.update(",");
    this.hash.update(JSON.stringify(entry));
    this.entries.push(entry);
  }
}

function opened(): Hash {
  return createHash("sha256").update("[");
}
