import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Reading a database's write-ahead log as plain bytes (docs/devices.md,
 * "Keeping a copy on another computer"): each committed change of a
 * database the app writes in WAL mode is a run of frames, each frame one
 * whole page with its number, the last one saying how many pages the
 * database holds once the change is committed. The home reads the frames
 * written since it last read, up to the last commit, and sends those pages;
 * a copy that writes them at their place is the database as of that commit.
 *
 * The log is opened only as a file. SQLite takes no lock on it (its locks
 * are on the database file and its shared memory), so closing the handle
 * here drops nothing SQLite holds; the database file itself is never opened
 * this way in a process that holds it.
 *
 * The format is SQLite's own (https://www.sqlite.org/fileformat2.html,
 * "Write-Ahead Log File Format").
 */

const HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 24;
const MAGIC_LITTLE = 0x377f0682;
const MAGIC_BIG = 0x377f0683;

/** Where a reading of one log stopped: the next read starts there. */
export type WalPlace = {
  salt1: number;
  salt2: number;
  pageSize: number;
  /** The byte just after the last committed frame read. */
  offset: number;
  /** The running checksum at `offset`. */
  sum: [number, number];
  /** Whether the checksum reads its words big-endian. */
  bigEndian: boolean;
};

/** What a reading found since its place. */
export type WalReading =
  | {
      kind: "frames";
      place: WalPlace;
      /** Each page written by a commit since the place, its latest image only, in page order. */
      pages: Map<number, Buffer>;
      /** The database's size in pages after the last commit read; 0 when no commit was read. */
      dbPages: number;
    }
  /** The log began again (its salts changed), or it is gone: frames since the place may be lost. */
  | { kind: "restarted"; place: WalPlace | null }
  /** There is no log, and none was read before. */
  | { kind: "none" };

/** SQLite's log checksum over `data`, continuing from `sum`. */
export function walChecksum(
  data: Buffer,
  sum: [number, number],
  bigEndian: boolean,
): [number, number] {
  let s0 = sum[0];
  let s1 = sum[1];
  for (let at = 0; at + 8 <= data.length; at += 8) {
    const x0 = bigEndian ? data.readUInt32BE(at) : data.readUInt32LE(at);
    const x1 = bigEndian ? data.readUInt32BE(at + 4) : data.readUInt32LE(at + 4);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

/** The log's header as a place at its first frame, or null when it is not a valid header. */
function headerPlace(header: Buffer): WalPlace | null {
  if (header.length < HEADER_BYTES) return null;
  const magic = header.readUInt32BE(0);
  if (magic !== MAGIC_LITTLE && magic !== MAGIC_BIG) return null;
  const bigEndian = magic === MAGIC_BIG;
  const pageSize = header.readUInt32BE(8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return null;
  const sum = walChecksum(header.subarray(0, 24), [0, 0], bigEndian);
  if (sum[0] !== header.readUInt32BE(24) || sum[1] !== header.readUInt32BE(28)) return null;
  return {
    salt1: header.readUInt32BE(16),
    salt2: header.readUInt32BE(20),
    pageSize,
    offset: HEADER_BYTES,
    sum,
    bigEndian,
  };
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, offset + done);
    if (read === 0) break;
    done += read;
  }
  return buffer.subarray(0, done);
}

/**
 * Reads the log at `walPath` from `place`: every frame up to the last valid
 * commit, checked against its salts and running checksum. With no place it
 * reads from the log's first frame.
 */
export function readWal(walPath: string, place: WalPlace | null): WalReading {
  let fd: number;
  try {
    fd = openSync(walPath, "r");
  } catch {
    return place ? { kind: "restarted", place: null } : { kind: "none" };
  }
  try {
    const size = fstatSync(fd).size;
    const header = headerPlace(readAt(fd, 0, HEADER_BYTES));
    if (!header) return place ? { kind: "restarted", place: null } : { kind: "none" };
    if (place && (header.salt1 !== place.salt1 || header.salt2 !== place.salt2))
      return { kind: "restarted", place: header };
    const from = place ?? header;
    const frameBytes = FRAME_HEADER_BYTES + from.pageSize;
    const tail = size > from.offset ? readAt(fd, from.offset, size - from.offset) : Buffer.alloc(0);
    const pending: [number, Buffer][] = [];
    const pages = new Map<number, Buffer>();
    let sum = from.sum;
    let committed = { offset: from.offset, sum: from.sum };
    let dbPages = 0;
    for (let at = 0; at + frameBytes <= tail.length; at += frameBytes) {
      const frame = tail.subarray(at, at + frameBytes);
      if (frame.readUInt32BE(8) !== from.salt1 || frame.readUInt32BE(12) !== from.salt2) break;
      sum = walChecksum(frame.subarray(0, 8), sum, from.bigEndian);
      sum = walChecksum(frame.subarray(FRAME_HEADER_BYTES), sum, from.bigEndian);
      if (sum[0] !== frame.readUInt32BE(16) || sum[1] !== frame.readUInt32BE(20)) break;
      const pgno = frame.readUInt32BE(0);
      if (pgno === 0) break;
      pending.push([pgno, Buffer.from(frame.subarray(FRAME_HEADER_BYTES))]);
      const commitPages = frame.readUInt32BE(4);
      if (commitPages > 0) {
        for (const [number, data] of pending) pages.set(number, data);
        pending.length = 0;
        dbPages = commitPages;
        committed = { offset: from.offset + at + frameBytes, sum };
      }
    }
    return {
      kind: "frames",
      place: { ...from, offset: committed.offset, sum: committed.sum },
      pages: new Map([...pages].sort(([a], [b]) => a - b)),
      dbPages,
    };
  } finally {
    closeSync(fd);
  }
}
