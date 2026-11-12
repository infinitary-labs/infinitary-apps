import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContractStamp, SessionImage } from "../session/session";

/**
 * The app's own record of an Antigravity conversation, written as it
 * happens in the Pi session dialect (a `session` header, then `message`
 * entries), so every reader of a rolling session's record - a task's
 * Activity, the replay engine, Observe - reads an Antigravity-served turn
 * as it reads a Pi-served one, through the one reader
 * (`src/core/storage/sessionReader.ts`), with nothing of its own.
 *
 * Antigravity keeps its own conversation store, which Infinitary never
 * reads; this record is built from what the program streams to the client:
 * the prompt as sent, each assistant message's words, thinking and tool
 * calls, and each call's result as a `toolResult` message. The program's
 * own models are labelled under `PROVIDER`.
 */

type Entry = Record<string, unknown>;
type Part =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

/** The Pi session format version the header names (Pi's `CURRENT_SESSION_VERSION`). */
const PI_SESSION_VERSION = 3;

/** The Pi session's contract stamp entry (`FIRSTMATE_CONTRACT_ENTRY`, src/core/pi/session.ts). */
const CONTRACT_ENTRY = "fm-contract";

export type RecordModel = { provider: string; id: string };

export class AntigravityRecord {
  private leaf: string | null = null;
  private open: { parts: Part[]; at: string } | undefined;
  /** Each call of the open message and the ones written: its name, for its result. */
  private readonly calls = new Map<string, string>();
  private stamped: string | null = null;

  constructor(
    readonly path: string,
    sessionId: string,
    cwd: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path) || statSync(path).size === 0) {
      this.append({
        type: "session",
        version: PI_SESSION_VERSION,
        id: sessionId,
        timestamp: this.iso(),
        cwd,
      });
    } else {
      this.leaf = lastEntryId(path);
    }
  }

  /** The record of `sessionId` in `dir`: `<sessionId>.jsonl`. */
  static pathIn(dir: string, sessionId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith(".")) {
      throw new Error(
        `An Antigravity conversation id this app cannot name a file by: ${sessionId}`,
      );
    }
    return join(dir, `${sessionId}.jsonl`);
  }

  /** The contract that serves the turns after it, once per change. */
  stamp(stamp: ContractStamp | undefined): void {
    if (!stamp) return;
    const key = JSON.stringify(stamp);
    if (key === this.stamped) return;
    this.stamped = key;
    this.entry({ type: "custom", customType: CONTRACT_ENTRY, data: stamp });
  }

  /** A prompt as the model received it. */
  user(text: string, images?: readonly SessionImage[]): void {
    this.flush();
    const content: Entry[] = [{ type: "text", text }];
    for (const image of images ?? []) {
      content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    this.message({ role: "user", content });
  }

  text(delta: string): void {
    const parts = this.parts();
    const last = parts.at(-1);
    if (last?.type === "text") last.text += delta;
    else parts.push({ type: "text", text: delta });
  }

  thinking(delta: string): void {
    const parts = this.parts();
    const last = parts.at(-1);
    if (last?.type === "thinking") last.thinking += delta;
    else parts.push({ type: "thinking", thinking: delta });
  }

  toolCall(id: string, name: string, args: Record<string, unknown>): void {
    this.parts().push({ type: "toolCall", id, name, arguments: args });
    this.calls.set(id, name);
  }

  /** The name a call was recorded under, for its end. */
  toolNameOf(id: string): string {
    return this.calls.get(id) ?? "";
  }

  /** A call's result: the message that asked for it is written first. */
  toolResult(id: string, text: string, isError: boolean): void {
    if (!this.calls.has(id)) return;
    if (this.open?.parts.some((part) => part.type === "toolCall" && part.id === id)) {
      this.flush({ stopReason: "toolUse" });
    }
    this.message({
      role: "toolResult",
      toolCallId: id,
      toolName: this.calls.get(id) ?? "",
      content: [{ type: "text", text }],
      isError,
    });
    this.calls.delete(id);
  }

  /** The turn's end: the open assistant message, with why it stopped. */
  end(stopReason: "stop" | "error" | "aborted" | "length", model?: RecordModel, error?: string) {
    this.flush({
      stopReason,
      ...(model ? { provider: model.provider, model: model.id } : {}),
      ...(error ? { errorMessage: error } : {}),
    });
  }

  /** The open message's words so far: its text parts, joined. */
  openText(): string {
    return (this.open?.parts ?? [])
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
  }

  private parts(): Part[] {
    this.open ??= { parts: [], at: this.iso() };
    return this.open.parts;
  }

  private flush(extra: Entry = {}): void {
    const open = this.open;
    this.open = undefined;
    if (!open || open.parts.length === 0) return;
    this.message({ role: "assistant", content: open.parts, ...extra }, open.at);
  }

  private message(body: Entry, at?: string): void {
    this.entry({ type: "message", message: { ...body, timestamp: Date.parse(at ?? this.iso()) } });
  }

  private entry(fields: Entry): void {
    const id = randomBytes(4).toString("hex");
    this.append({ ...fields, id, parentId: this.leaf, timestamp: this.iso() });
    this.leaf = id;
  }

  private append(entry: Entry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** The last entry id a record holds, so a reopened conversation keeps its chain. */
function lastEntryId(path: string): string | null {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const entry = JSON.parse(lines[index] ?? "") as Entry;
      if (typeof entry.id === "string" && entry.type !== "session") return entry.id;
    } catch {
      // A torn last line is skipped.
    }
  }
  return null;
}
