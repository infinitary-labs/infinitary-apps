import { WebSocket } from "ws";
import { partsHeader } from "./frameParts";

/**
 * What the home writes to one device, paced by the device's own answers
 * (docs/connection.md, "Pacing and liveness"; INF-2669). Every frame is
 * written in pieces, each followed by a ping that names it, and the device's
 * pong for that ping says the piece arrived. Only so much goes ahead of the
 * newest answer - a window that follows the rate the device's answers
 * measure - and the rest waits here. So on a slow link the home hears an
 * answer every piece instead of only once the whole catch-up has arrived,
 * and a ping or pong either side sends waits behind about one window rather
 * than behind everything the home had to say. To a device that reads parts
 * (`frame-parts.md`), each piece of a longer frame goes as a whole message
 * after a header naming the frame's length, so it hears every piece too.
 */
export type OutboxOptions = {
  /** The smallest piece, and the least that may go ahead of an answer. */
  pieceBytes: number;
  /** On a faster link, how much of its measured rate may go ahead of an answer. */
  aheadMs: number;
  now?: () => number;
};

type Piece = { data: Buffer; fin: boolean; done?: (error?: Error) => void };
/** A ping the device has not answered: the bytes written before it, and since when they were going. */
type Mark = { n: number; end: number; from: number };

export class Outbox {
  private readonly queue: Piece[] = [];
  private queuedBytes = 0;
  private written = 0;
  private answered = 0;
  private marked = 0;
  private marks: Mark[] = [];
  private lastMark = 0;
  private window: number;
  private lastAnswerAt: number;
  /** When the first byte after the newest mark was written. */
  private writingFrom: number | undefined;
  private readonly now: () => number;
  /** Whether the device reads a frame longer than one piece as parts (`frame-parts.md`), from its hello. */
  parts = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: OutboxOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.window = options.pieceBytes;
    this.lastAnswerAt = this.now();
    ws.on("pong", (data: Buffer) => this.answer(data));
    ws.once("close", () => this.drop());
  }

  /** Bytes waiting here, not yet written to the socket. */
  get waiting(): number {
    return this.queuedBytes;
  }

  /** Bytes written and not yet answered for. */
  get unanswered(): number {
    return this.written - this.answered;
  }

  /**
   * Sends one text frame, in pieces if it is longer than one: the pieces of
   * one message, or, to a device that reads parts, a header and then each
   * piece as a whole message. `done` hears the last piece written, or why it
   * never will be.
   */
  send(text: string, done?: (error?: Error) => void): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      if (done) queueMicrotask(() => done(new Error("The connection is closed.")));
      return;
    }
    const data = Buffer.from(text, "utf8");
    const size = this.pieceSize();
    const parted = this.parts && data.length > size;
    if (parted) this.queuePiece({ data: partsHeader(data.length), fin: true });
    let at = 0;
    do {
      let end = Math.min(at + size, data.length);
      // A piece ends between characters, so each one is whole UTF-8 text.
      while (end < data.length && end > at + 1 && ((data[end] ?? 0) & 0xc0) === 0x80) end--;
      const last = end >= data.length;
      this.queuePiece({
        data: data.subarray(at, end),
        fin: parted || last,
        ...(last && done ? { done } : {}),
      });
      at = end;
    } while (at < data.length);
    this.pump();
  }

  private queuePiece(piece: Piece): void {
    this.queue.push(piece);
    this.queuedBytes += piece.data.length;
  }

  /** A ping naming everything written so far: the heartbeat's, and each piece's. */
  mark(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const n = ++this.lastMark;
    this.marks.push({ n, end: this.written, from: this.writingFrom ?? this.now() });
    this.marked = this.written;
    this.writingFrom = undefined;
    this.ws.ping(String(n));
  }

  private pieceSize(): number {
    return Math.max(this.options.pieceBytes, Math.floor(this.window / 4));
  }

  private pump(): void {
    while (this.queue.length && this.unanswered < this.window) {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      const piece = this.queue.shift() as Piece;
      this.queuedBytes -= piece.data.length;
      this.writingFrom ??= this.now();
      this.ws.send(piece.data, { binary: false, fin: piece.fin }, piece.done);
      this.written += piece.data.length;
      if (this.written - this.marked >= this.pieceSize()) this.mark();
    }
    // Held by the window: what went out unmarked is named, so an answer comes for it.
    if (this.queue.length && this.written > this.marked) this.mark();
  }

  /**
   * A pong answers for its ping and every one before it. A pong that names
   * no ping of this outbox answers for the oldest: a device may answer only
   * its newest ping, never a ping it has not read.
   */
  private answer(data: Buffer): void {
    if (!this.marks.length) return;
    const named = Number(data.toString("utf8"));
    const found = this.marks.findIndex((mark) => mark.n === named);
    const index = found < 0 ? 0 : found;
    const oldest = this.marks[0] as Mark;
    const mark = this.marks[index] as Mark;
    this.marks = this.marks.slice(index + 1);
    const now = this.now();
    const bytes = mark.end - this.answered;
    if (bytes > 0) {
      // The rate these bytes arrived at, from when they began going or the
      // last answer, whichever is later. The window follows it, growing by
      // at most what was answered, as a connection's start does.
      const took = Math.max(1, now - Math.max(this.lastAnswerAt, oldest.from));
      const rate = bytes / took;
      this.window = Math.max(
        this.options.pieceBytes,
        Math.min(rate * this.options.aheadMs, this.window + bytes),
      );
      this.answered = mark.end;
    }
    this.lastAnswerAt = now;
    this.pump();
  }

  private drop(): void {
    const waiting = this.queue.splice(0);
    this.queuedBytes = 0;
    for (const piece of waiting)
      piece.done?.(new Error("The connection closed before this was sent."));
  }
}
