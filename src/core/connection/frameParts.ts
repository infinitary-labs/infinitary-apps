import { CONNECTION_MAX_FRAME_BYTES } from "@shared/connection";
import { contractChange } from "./contractChanges";

/**
 * A device that reads a long frame as parts (`frame-parts.md`;
 * docs/connection.md, "Pacing and liveness"). The home writes every frame in
 * pieces; to a device that lists this change, a frame longer than one piece
 * goes as a `parts` header and then each piece as a whole message, so a
 * device that hears the home only once a message has arrived, as a phone
 * does, hears every piece of a long answer rather than only its end. A
 * device that does not list it gets the frame as one message, as before.
 */
export const FRAME_PARTS = contractChange("frame-parts");

/** The message that opens a frame sent in parts: the frame's length in UTF-8 bytes. */
export function partsHeader(bytes: number): Buffer {
  return Buffer.from(JSON.stringify({ t: "parts", bytes }), "utf8");
}

/** No header is longer than this, so a longer message is never read as one. */
const HEADER_BYTES = 64;

/** The length a header names, or undefined when the message is no header. */
function headerBytes(message: Buffer): number | undefined {
  if (message.length > HEADER_BYTES) return undefined;
  try {
    const said = JSON.parse(message.toString("utf8")) as { t?: unknown; bytes?: unknown };
    if (said?.t !== "parts") return undefined;
    const { bytes } = said;
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1)
      throw new Error("A frame's parts named no length.");
    if (bytes > CONNECTION_MAX_FRAME_BYTES)
      throw new Error(`A frame of ${bytes} bytes is longer than any frame the connection takes.`);
    return bytes;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * What one connection reads from the home, joined back into frames: a whole
 * frame comes back as it came, and the parts after a `parts` header come
 * back once, joined, when the last has arrived. Nothing else comes between
 * a frame's parts, so one reader per connection is enough.
 */
export class FramePartsReader {
  private owed = 0;
  private have = 0;
  private parts: Buffer[] = [];
  /** How many frames came in parts and were joined. */
  joined = 0;

  /**
   * One text message as it arrived: the frame it is or completes, or
   * undefined while a frame's parts are still arriving. Throws on a header
   * that names no length or too long a one, and on parts that run past the
   * length their header named.
   */
  read(raw: Buffer | string): string | undefined {
    const message = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    if (this.owed === 0) {
      const bytes = headerBytes(message);
      if (bytes === undefined) return message.toString("utf8");
      this.owed = bytes;
      return undefined;
    }
    this.parts.push(message);
    this.have += message.length;
    if (this.have < this.owed) return undefined;
    const over = this.have > this.owed;
    const frame = Buffer.concat(this.parts).toString("utf8");
    this.owed = 0;
    this.have = 0;
    this.parts = [];
    if (over) throw new Error("A frame's parts ran past the length their header named.");
    this.joined++;
    return frame;
  }
}
