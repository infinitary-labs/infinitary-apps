import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ToolObservation } from "@shared/toolCompletion";
import Database from "better-sqlite3";
import { completionDigest } from "../session/completionFingerprint";
import {
  bareToolName,
  CLIENT_INTERRUPT_NOTICE,
  CLIENT_NOTICE,
  readSessionDelta,
  type SessionDeltaTail,
  sessionCompleteOffset,
} from "./sessionReader";

/**
 * Work-side session record adjunct. The transcript remains the source; this
 * derived, disposable index owns its byte checkpoint, in-flight pair digests
 * and unacknowledged compact facts. No old transcript or image is retained.
 */
export class SessionCompletionStore {
  private readonly db: Database.Database;
  private tail: { path: string; state: SessionDeltaTail } | undefined;
  readonly work = { lines: 0, sourceBytes: 0, fingerprintBytes: 0, completions: 0 };

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursors (
        stream TEXT PRIMARY KEY, path TEXT NOT NULL, inode REAL NOT NULL, offset INTEGER NOT NULL, sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairs (
        stream TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL, operation TEXT NOT NULL,
        PRIMARY KEY (stream, call_id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        stream TEXT NOT NULL, sequence INTEGER NOT NULL, fact TEXT NOT NULL,
        PRIMARY KEY (stream, sequence)
      );
    `);
  }

  /** First activation observes fresh work, rather than replaying the old conversation. */
  activate(path: string, baseline?: number): void {
    const stream = basename(path);
    const firstActivation = !this.db.prepare("SELECT 1 FROM cursors LIMIT 1").get();
    const inode = existsSync(path) ? statSync(path).ino : 0;
    this.db
      .prepare("INSERT OR IGNORE INTO cursors VALUES (?, ?, ?, ?, 0)")
      .run(stream, path, inode, firstActivation ? (baseline ?? sessionCompleteOffset(path)) : 0);
    // A task-folder move changes its path, not its durable conversation.
    // Rebind the location without treating its recorded calls as new work.
    this.db
      .prepare("UPDATE cursors SET path = ?, inode = ? WHERE stream = ? AND path <> ?")
      .run(path, inode, stream, path);
  }

  /** Recover streams in their durable activation order, one checkpoint at a time. */
  recover(deliver: (fact: ToolObservation) => void, directory?: string): void {
    let after = 0;
    for (;;) {
      const row = this.db
        .prepare(
          "SELECT rowid AS id, stream, path FROM cursors WHERE rowid > ? ORDER BY rowid LIMIT 1",
        )
        .get(after) as { id: number; stream: string; path: string } | undefined;
      if (!row) return;
      this.scan(directory ? join(directory, row.stream) : row.path, deliver);
      after = row.id;
    }
  }

  /** Delivery acknowledges only after its downstream owner has kept the fact. */
  drain(path: string, deliver: (fact: ToolObservation) => void): void {
    const stream = basename(path);
    for (;;) {
      const row = this.db
        .prepare("SELECT sequence, fact FROM outbox WHERE stream = ? ORDER BY sequence LIMIT 1")
        .get(stream) as { sequence: number; fact: string } | undefined;
      if (!row) return;
      deliver(JSON.parse(row.fact) as ToolObservation);
      this.db
        .prepare("DELETE FROM outbox WHERE stream = ? AND sequence = ?")
        .run(stream, row.sequence);
    }
  }

  scan(path: string, deliver: (fact: ToolObservation) => void): void {
    this.activate(path);
    this.drain(path, deliver);
    const stream = basename(path);
    const cursor = this.db
      .prepare("SELECT offset, inode FROM cursors WHERE stream = ?")
      .get(stream) as {
      offset: number;
      inode: number;
    };
    if (existsSync(path)) {
      const source = statSync(path);
      if ((cursor.inode !== 0 && cursor.inode !== source.ino) || source.size < cursor.offset) {
        // The existing deletion/scrubbing owner may replace a transcript.
        // Its new byte layout is not an append, so observe only later work;
        // preserve delivered counts and pending compact facts, never replay it.
        this.db.transaction(() => {
          cursor.offset = sessionCompleteOffset(path);
          this.db
            .prepare("UPDATE cursors SET offset = ?, inode = ? WHERE stream = ?")
            .run(cursor.offset, source.ino, stream);
          this.db.prepare("DELETE FROM pairs WHERE stream = ?").run(stream);
        })();
        this.tail = undefined;
      } else if (cursor.inode === 0) {
        this.db.prepare("UPDATE cursors SET inode = ? WHERE stream = ?").run(source.ino, stream);
      }
    }
    if (this.tail?.path !== path || this.tail.state.offset < cursor.offset)
      this.tail = { path, state: { offset: cursor.offset, pieces: [] } };
    const work = readSessionDelta(
      path,
      cursor.offset,
      (entry, end) => {
        this.db.transaction(() => {
          const current = this.db
            .prepare("SELECT offset, sequence FROM cursors WHERE stream = ?")
            .get(stream) as { offset: number; sequence: number };
          if (end <= current.offset) return;
          let sequence = current.sequence;
          const source = `${stream}:${typeof entry.id === "string" ? entry.id : typeof entry.uuid === "string" ? entry.uuid : end}`;
          const timestamp = entry.timestamp;
          const at =
            typeof timestamp === "number"
              ? timestamp
              : typeof timestamp === "string"
                ? Date.parse(timestamp)
                : this.now();
          const emit = (fact: ToolObservation["fact"]) => {
            sequence += 1;
            const observation: ToolObservation = {
              type: "tool_observation",
              stream,
              sequence,
              source,
              at: Number.isFinite(at) ? at : this.now(),
              fact,
            };
            this.db
              .prepare("INSERT INTO outbox VALUES (?, ?, ?)")
              .run(stream, sequence, JSON.stringify(observation));
          };
          this.readEntry(stream, entry, emit);
          this.db
            .prepare("UPDATE cursors SET offset = ?, sequence = ? WHERE stream = ?")
            .run(end, sequence, stream);
        })();
        this.drain(path, deliver);
      },
      this.tail.state,
    );
    this.work.lines += work.lines;
    this.work.sourceBytes += work.bytes;
  }

  private readEntry(
    stream: string,
    entry: Record<string, unknown>,
    emit: (fact: ToolObservation["fact"]) => void,
  ): void {
    const message = record(entry.message);
    if (entry.isSidechain === true) return;
    const attachment = record(entry.attachment);
    if (attachment?.type === "queued_command" && attachment.commandMode !== CLIENT_NOTICE)
      emit({ kind: "guidance" });
    if (!message) return;
    if (entry.isCompactSummary === true) return;
    const role = message.role;
    const content = message.content;
    const blocks = Array.isArray(content)
      ? content.map(record).filter((block) => block !== undefined)
      : [];
    if (role === "assistant") {
      for (const block of blocks) {
        const pi = block.type === "toolCall";
        if (!pi && block.type !== "tool_use") continue;
        const callId = block.id;
        if (typeof callId !== "string" || typeof block.name !== "string") continue;
        if (
          this.db
            .prepare("SELECT 1 FROM pairs WHERE stream = ? AND call_id = ?")
            .get(stream, callId)
        )
          continue;
        const tool = bareToolName(block.name);
        const operation = completionDigest([tool, pi ? block.arguments : block.input], (count) => {
          this.work.fingerprintBytes += count;
        });
        this.db
          .prepare("INSERT INTO pairs VALUES (?, ?, ?, ?)")
          .run(stream, callId, tool, operation);
      }
    }
    const complete = (callId: unknown, content: unknown, isError: boolean) => {
      if (typeof callId !== "string" || content === undefined) return;
      const pair = this.db
        .prepare("SELECT tool, operation FROM pairs WHERE stream = ? AND call_id = ?")
        .get(stream, callId) as { tool: string; operation: string } | undefined;
      // No complete observed pair means no positive evidence (including an
      // operation already consumed, or one begun before first activation).
      if (!pair) return;
      const result = completionDigest([content, isError], (count) => {
        this.work.fingerprintBytes += count;
      });
      emit({ kind: "completed", callId, toolName: pair.tool, operation: pair.operation, result });
      this.work.completions += 1;
      this.db.prepare("DELETE FROM pairs WHERE stream = ? AND call_id = ?").run(stream, callId);
    };
    if (role === "toolResult") complete(message.toolCallId, content, message.isError === true);
    if (role === "user") {
      for (const block of blocks) {
        if (block.type === "tool_result")
          complete(block.tool_use_id, block.content, block.is_error === true);
      }
      const hasResults = blocks.some((block) => block.type === "tool_result");
      if (
        !hasResults &&
        entry.isMeta !== true &&
        !(typeof content === "string" && CLIENT_INTERRUPT_NOTICE.test(content)) &&
        (typeof content === "string" || blocks.some((block) => block.type === "text"))
      ) {
        emit({ kind: "guidance" });
      }
    }
  }

  get retainedSourceBytes(): number {
    return this.tail?.state.pieces.reduce((bytes, piece) => bytes + piece.length, 0) ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
