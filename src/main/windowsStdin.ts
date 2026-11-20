import { read as readHandle } from "node:fs";
import { Readable } from "node:stream";
import { isatty } from "node:tty";

/** Reads one piece of the input handle into `into`, answering how much came, or what stopped it. */
export type HandleRead = (
  into: Buffer,
  done: (error: NodeJS.ErrnoException | null, got: number) => void,
) => void;

/**
 * What a person types or pipes into the work mode on Windows
 * (docs/helper.md, "On Windows"). Electron's main process on Windows ends
 * `process.stdin` at once, so the typed yes of `work join` never arrived;
 * the standard input handle the process was given still reads. Each piece
 * is read off the main thread, and only when a reader asks for more, so a
 * console's read, which waits for the person's Enter, holds nothing else up
 * and none is left asking once the answer came. `read` stands in for
 * reading that handle in a test.
 */
export function windowsStdin(
  read: HandleRead = (into, done) => readHandle(0, into, 0, into.length, null, done),
  terminal: boolean = isatty(0),
): Readable & { isTTY: boolean } {
  const piece = Buffer.alloc(64 * 1024);
  // No read ahead: the stream asks the handle only while its reader wants more.
  const stream = new Readable({ highWaterMark: 0, read: () => pull() });
  const pull = (): void => {
    read(piece, (error, got) => {
      // A pipe with nothing in it yet answers EAGAIN: read again shortly.
      // Anything else, such as no handle at all, ends what came in.
      if (error?.code === "EAGAIN") setTimeout(pull, 50);
      else if (error || got <= 0) stream.push(null);
      else stream.push(Buffer.from(piece.subarray(0, got)));
    });
  };
  // A console shows what the person typed, so the ask does not repeat it.
  return Object.assign(stream, { isTTY: terminal });
}
