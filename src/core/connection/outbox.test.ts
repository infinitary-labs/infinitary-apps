import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Outbox } from "./outbox";

/**
 * A socket that records what the outbox writes and pings, and answers only
 * when the test says, as a device on a slow link does.
 */
class Recorded extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly pieces: { data: Buffer; fin: boolean; done?: (error?: Error) => void }[] = [];
  readonly pings: string[] = [];

  send(data: Buffer, options: { binary: boolean; fin: boolean }, done?: (error?: Error) => void) {
    expect(options.binary).toBe(false);
    this.pieces.push({ data: Buffer.from(data), fin: options.fin, ...(done ? { done } : {}) });
  }

  ping(data: string) {
    this.pings.push(data);
  }

  /** The device's pong for the ping named `name`. */
  answer(name: string) {
    this.emit("pong", Buffer.from(name));
  }

  /** Answers every ping it has seen until nothing more is written. */
  answerAll(): void {
    let answered = 0;
    while (answered < this.pings.length) this.answer(this.pings[answered++] as string);
  }

  bytes(): number {
    return this.pieces.reduce((total, piece) => total + piece.data.length, 0);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

function outbox(options: { pieceBytes: number; aheadMs: number }) {
  let now = 1_000;
  const socket = new Recorded();
  const out = new Outbox(socket as unknown as WebSocket, { ...options, now: () => now });
  return {
    socket,
    out,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the outbox that paces what the home writes to a device", () => {
  it("writes a long frame in pieces of whole characters, the last finishing it and hearing it went", () => {
    const { socket, out } = outbox({ pieceBytes: 8, aheadMs: 1_000 });
    const text = "harbour € tide 😀 pilot é ".repeat(20);
    let heard = 0;
    out.send(text, () => heard++);
    socket.answerAll();

    expect(out.waiting).toBe(0);
    expect(Buffer.concat(socket.pieces.map((piece) => piece.data)).toString("utf8")).toBe(text);
    expect(socket.pieces.length).toBeGreaterThan(text.length / 64);
    expect(socket.pieces.map((piece) => piece.fin).filter(Boolean)).toHaveLength(1);
    expect(socket.pieces.at(-1)?.fin).toBe(true);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const piece of socket.pieces) expect(() => decoder.decode(piece.data)).not.toThrow();
    expect(socket.pieces.filter((piece) => piece.done)).toHaveLength(1);
    socket.pieces.at(-1)?.done?.();
    expect(heard).toBe(1);
  });

  it("sends only one piece ahead of a device that has not answered, and the next once it does", () => {
    const { socket, out, advance } = outbox({ pieceBytes: 4, aheadMs: 1_000 });
    out.send("a".repeat(40));
    expect(socket.bytes()).toBe(4);
    expect(socket.pings).toEqual(["1"]);
    expect(out.waiting).toBe(36);
    expect(out.unanswered).toBe(4);

    // A slow device: four bytes a second is four bytes in a second's lead.
    advance(1_000);
    socket.answer("1");
    expect(socket.bytes()).toBe(8);
    expect(socket.pings).toEqual(["1", "2"]);
    expect(out.unanswered).toBe(4);
  });

  it("lets more go ahead as the answers measure a faster link, growing by at most what was answered", () => {
    const { socket, out, advance } = outbox({ pieceBytes: 4, aheadMs: 1_000 });
    out.send("a".repeat(4_000));
    const leads: number[] = [];
    for (let round = 0; round < 5; round++) {
      advance(1);
      socket.answer(socket.pings.at(-1) as string);
      leads.push(out.unanswered);
    }
    // Answered within a millisecond each time, the lead doubles from one piece.
    expect(leads).toEqual([8, 16, 32, 64, 128]);

    // Then the link slows to four bytes a second: the lead falls back to one piece.
    advance(32_000);
    socket.answer(socket.pings.at(-1) as string);
    expect(out.unanswered).toBe(4);
  });

  it("takes a pong for its ping and every one before it, and one naming no ping for the oldest", () => {
    const { socket, out, advance } = outbox({ pieceBytes: 4, aheadMs: 1_000 });
    out.send("a".repeat(400));
    advance(1);
    socket.answer("1");
    expect(socket.pings).toEqual(["1", "2", "3"]);
    expect(out.unanswered).toBe(8);

    // The device answers only the newest ping it read: both are answered for.
    advance(1);
    socket.answer("3");
    expect(out.unanswered).toBe(16);
    const before = socket.bytes();

    // A pong naming no ping, as a device answering an empty ping would send, answers the oldest.
    advance(1);
    socket.answer("");
    expect(socket.bytes()).toBeGreaterThan(before);
  });

  it("names everything written in the heartbeat's ping, so its pong answers for it", () => {
    const { socket, out, advance } = outbox({ pieceBytes: 1_000, aheadMs: 1_000 });
    out.send("small");
    expect(socket.pings).toEqual([]);
    out.mark();
    expect(socket.pings).toEqual(["1"]);
    advance(10);
    socket.answer("1");
    expect(out.unanswered).toBe(0);
  });

  it("fails what was still waiting when the connection closes, and what is sent after", async () => {
    const { socket, out } = outbox({ pieceBytes: 4, aheadMs: 1_000 });
    const failed: string[] = [];
    out.send("a".repeat(40), (error) => failed.push(error?.message ?? "sent"));
    socket.close();
    expect(failed).toEqual(["The connection closed before this was sent."]);
    expect(out.waiting).toBe(0);

    out.send("late", (error) => failed.push(error?.message ?? "sent"));
    await Promise.resolve();
    expect(failed).toEqual([
      "The connection closed before this was sent.",
      "The connection is closed.",
    ]);
    expect(socket.bytes()).toBe(4);
  });
});
