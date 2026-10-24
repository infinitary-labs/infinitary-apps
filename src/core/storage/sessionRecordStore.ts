import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { sidecarPathOf } from "./sessionReader";

/**
 * A Claude-served rolling session's durable record (W1 S6): the app's own
 * copy of the client's transcript, one JSONL file per session in the spec's
 * record dir - the seat's `userData/firstmate/claude/`, a crewmate's
 * `crewmates/<task>/sessions/` - and beside each one a sidecar
 * `<sessionId>.served.jsonl` carrying what the transcript cannot: the
 * contract that served the session, when its spec stamps one, and where
 * each prompt landed.
 *
 * Why a copy at all: Claude's client keeps its own transcript under its
 * config dir and sweeps it after `cleanupPeriodDays` (30 by default), and
 * every session runs with `settingSources: []`, so no person's longer
 * setting is ever read. "Sessions are durable and nothing prunes them"
 * (AGENTS.md) therefore needs a copy the app owns. The session copies the
 * client's file here at every boundary (`mirror`): the copy is the client's
 * file, byte for byte, so it grows only by what the client appended since.
 * (The SDK's own session store is not used: resuming from it makes the SDK
 * read the person's Claude credential and copy it into a temporary config
 * dir, and the app never reads a provider token - docs/claude-client.md.)
 *
 * One writer: this class is the only code that writes these files, and
 * nothing here deletes.
 */

/** One transcript line as the client wrote it; opaque past its `type` and `uuid`. */
export type SessionRecordEntry = { type: string; uuid?: string; [key: string]: unknown };

/**
 * One served message, by the id the client acknowledged it under: its
 * transcript records a prompt as its own entry under that uuid, and a steer
 * folded into a running turn as an attachment naming it as `source_uuid`.
 */
export type SessionServedMessage = { textSha256: string; uuid: string };

/** One sidecar line. */
export type SessionSidecarRecord =
  | {
      kind: "contract";
      at: number;
      version: string;
      prompt_sha: string;
      instructions_sha?: string;
      tools_sha: string;
      /** Each tool's own sha, when the role's stamp names them (`ContractStamp.tools`). */
      tool_shas?: Record<string, string>;
    }
  | {
      kind: "served";
      /** Digests of the explicit personal instruction file and SKILL.md index. */
      personalResources?: { instructions: string | null; skills: string };
      at: number;
      /** The prompt, when the client took it in. */
      prompt: SessionServedMessage | null;
      /** Every steer the client took into the prompt's turns. */
      steers: SessionServedMessage[];
    };

/** What one mirror pass did. */
export type SessionMirrorOutcome =
  /** The copy now holds the client's file up to this many bytes. */
  | { kind: "copied"; bytes: number }
  /** The client has no file for the session (yet, or any more); the copy is untouched. */
  | { kind: "no-source" }
  /** The client's file no longer extends the copy; the copy is left as it was. */
  | { kind: "diverged" };

/** A session id is a file name here, so only the client's own id shape is accepted. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** How much of the copy's tail a mirror pass compares before it extends it. */
const PREFIX_CHECK_BYTES = 4096;

/**
 * A copy's entries, parsed once and extended as the copy grows: a rolling
 * session is never re-read or re-parsed whole at a turn's end.
 */
type ParsedCopy = {
  entries: SessionRecordEntry[];
  byUuid: Map<string, SessionRecordEntry>;
  /** Bytes of the copy read so far. */
  offset: number;
  /** The bytes after the last newline read: a line the client was still writing. */
  partial: Buffer;
  /** The file read, by its inode: a copy written again whole (`SavedOutsideData`) is read from its start. */
  ino: number;
};

/** A copy's entries and their index by uuid, as they stand. */
export type SessionRecordIndex = {
  entries: readonly SessionRecordEntry[];
  byUuid: ReadonlyMap<string, SessionRecordEntry>;
};

export class SessionRecordStore {
  /** Each sidecar's pending append, so stamps land in call order. */
  private readonly tails = new Map<string, Promise<void>>();
  private readonly parsed = new Map<string, ParsedCopy>();

  constructor(private readonly dir: string) {}

  /** The session's transcript copy. */
  transcriptPath(sessionId: string): string {
    return join(this.dir, `${checked(sessionId)}.jsonl`);
  }

  /** The sidecar beside it. */
  sidecarPath(sessionId: string): string {
    return sidecarPathOf(this.transcriptPath(sessionId));
  }

  /** Whether the app holds a copy of a session. */
  has(sessionId: string): boolean {
    const path = this.transcriptPath(sessionId);
    return existsSync(path) && statSync(path).size > 0;
  }

  /**
   * Bring the copy up to the client's file: append whatever the client
   * wrote since the last pass. The copy must be a prefix of the client's
   * file - the client only ever appends - so a file that no longer extends
   * it (rewritten, or a different session under the same id) is never
   * spliced in; the pass reports it and leaves the copy alone.
   */
  mirror(sessionId: string, source: string | null): SessionMirrorOutcome {
    if (!source || !existsSync(source)) return { kind: "no-source" };
    const target = this.transcriptPath(sessionId);
    const copied = existsSync(target) ? statSync(target).size : 0;
    const available = statSync(source).size;
    if (available < copied) return { kind: "diverged" };
    const fd = openSync(source, "r");
    try {
      if (copied > 0) {
        const span = Math.min(copied, PREFIX_CHECK_BYTES);
        if (!readAt(fd, copied - span, span).equals(readTail(target, copied, span))) {
          return { kind: "diverged" };
        }
      }
      if (available === copied) return { kind: "copied", bytes: copied };
      const fresh = Buffer.alloc(available - copied);
      readSync(fd, fresh, 0, fresh.length, copied);
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(target, fresh);
      return { kind: "copied", bytes: available };
    } finally {
      closeSync(fd);
    }
  }

  /** The copy's recorded entries, as they stand. */
  entries(sessionId: string): readonly SessionRecordEntry[] {
    return this.index(sessionId).entries;
  }

  /**
   * The copy's entries and their index by uuid, reading only what the copy
   * gained since the last call. A complete line is parsed once; a line the
   * client was still writing waits for its end.
   */
  index(sessionId: string): SessionRecordIndex {
    const path = this.transcriptPath(sessionId);
    const facts = existsSync(path) ? statSync(path) : undefined;
    const size = facts?.size ?? 0;
    const ino = facts?.ino ?? 0;
    let copy = this.parsed.get(path);
    if (!copy || (copy.offset > 0 && copy.ino !== ino)) {
      copy = { entries: [], byUuid: new Map(), offset: 0, partial: Buffer.alloc(0), ino };
      this.parsed.set(path, copy);
    }
    copy.ino = ino;
    if (size > copy.offset) {
      const fd = openSync(path, "r");
      let fresh: Buffer;
      try {
        fresh = readAt(fd, copy.offset, size - copy.offset);
      } finally {
        closeSync(fd);
      }
      copy.offset = size;
      const bytes = Buffer.concat([copy.partial, fresh]);
      const end = bytes.lastIndexOf(0x0a);
      copy.partial = end < 0 ? bytes : bytes.subarray(end + 1);
      if (end >= 0) {
        for (const entry of parseLines(bytes.subarray(0, end).toString("utf8"))) {
          copy.entries.push(entry);
          if (typeof entry.uuid === "string") copy.byUuid.set(entry.uuid, entry);
        }
      }
    }
    return copy;
  }

  /** Append one sidecar line. */
  stamp(sessionId: string, record: SessionSidecarRecord): Promise<void> {
    const path = this.sidecarPath(sessionId);
    const previous = this.tails.get(path) ?? Promise.resolve();
    const next = previous.then(async () => {
      mkdirSync(this.dir, { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    });
    // A failed write fails its own caller; the next one still runs.
    this.tails.set(
      path,
      next.catch(() => {}),
    );
    return next;
  }

  /** The sidecar's lines, oldest first. */
  sidecar(sessionId: string): SessionSidecarRecord[] {
    const path = this.sidecarPath(sessionId);
    return existsSync(path) ? (readEntries(path) as unknown as SessionSidecarRecord[]) : [];
  }

  /** Every stamp queued so far has landed. */
  async flushed(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}

function checked(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Not a session id: ${sessionId}`);
  return sessionId;
}

/** `length` bytes of an open file from `position`. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

/** The last `span` bytes of a file `size` bytes long, read in place. */
function readTail(path: string, size: number, span: number): Buffer {
  const fd = openSync(path, "r");
  try {
    return readAt(fd, size - span, span);
  } finally {
    closeSync(fd);
  }
}

/** Every complete JSON line of a file; a torn line (a crash mid-append) is skipped. */
function readEntries(path: string): SessionRecordEntry[] {
  return parseLines(readFileSync(path, "utf8"));
}

function parseLines(text: string): SessionRecordEntry[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? [parsed as SessionRecordEntry]
        : [];
    } catch {
      return [];
    }
  });
}
