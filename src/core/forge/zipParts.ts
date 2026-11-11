import { servedNumber } from "@shared/i18n/format";
import { ForgeError } from "./forge";
import type { ArchiveRanges } from "./workflows";

/**
 * A ZIP archive read in parts (docs/forge.md, "Workflow logs and
 * artifacts"): its central directory names every file and where its record
 * sits, so a listing reads only the directory and a selection only its own
 * records, which it copies unchanged into a smaller archive. Nothing is
 * inflated here, and nothing is written by an entry's own name.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const ZIP64_END_RECORD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const ZIP64_END_RECORD_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
/** The end record sits in the archive's last 22 bytes and the comment after it, 65,535 at most. */
const END_SEARCH_BYTES = END_RECORD_BYTES + 0xffff;
/** A plain end record counts this many files at most; 0xffff says to read the 64-bit record. */
export const ZIP_MAX_ENTRIES = 0xfffe;

export type ZipEntry = {
  /** Its path inside the archive, a folder's ending in `/`. */
  name: string;
  /** Its size once unpacked. */
  size: number;
  /** Where its record - local header, packed bytes and any descriptor - starts and ends. */
  start: number;
  end: number;
  compressedSize: number;
  nameBytes: Buffer;
  /** Its central directory record as the archive has it, and where the record's offset is in it. */
  central: Buffer;
  offsetAt: number;
  offsetWidth: 4 | 8;
};

/** Every entry the archive's central directory names, in its order. */
export async function zipEntries(archive: ArchiveRanges, maxBytes: number): Promise<ZipEntry[]> {
  if (archive.size < END_RECORD_BYTES) throw unreadable();
  const tailStart = Math.max(0, archive.size - END_SEARCH_BYTES);
  const tail = Buffer.from(await archive.read(tailStart, archive.size));
  const at = endRecordAt(tail);
  if (at < 0) throw unreadable();
  if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0)
    throw new ForgeError(
      "refused",
      "The artifact is a ZIP archive split in parts, which the app does not read.",
    );
  let count = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryStart = tail.readUInt32LE(at + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) {
    // 64-bit records: the locator sits just before the end record and names the 64-bit end record.
    const locatorStart = tailStart + at - ZIP64_LOCATOR_BYTES;
    if (locatorStart < 0) throw unreadable();
    const locator =
      at >= ZIP64_LOCATOR_BYTES
        ? tail.subarray(at - ZIP64_LOCATOR_BYTES, at)
        : Buffer.from(await archive.read(locatorStart, locatorStart + ZIP64_LOCATOR_BYTES));
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) throw unreadable();
    const recordStart = safe(locator.readBigUInt64LE(8));
    if (recordStart + ZIP64_END_RECORD_BYTES > locatorStart) throw unreadable();
    const record = Buffer.from(
      await archive.read(recordStart, recordStart + ZIP64_END_RECORD_BYTES),
    );
    if (record.readUInt32LE(0) !== ZIP64_END_RECORD) throw unreadable();
    count = safe(record.readBigUInt64LE(32));
    directorySize = safe(record.readBigUInt64LE(40));
    directoryStart = safe(record.readBigUInt64LE(48));
  }
  if (directoryStart + directorySize > archive.size) throw unreadable();
  if (directorySize > maxBytes)
    throw new ForgeError(
      "refused",
      `The archive's list of files exceeds the ${mib(maxBytes)} read limit.`,
    );
  // The directory is usually inside the tail already read.
  const directory =
    directoryStart >= tailStart
      ? tail.subarray(directoryStart - tailStart, directoryStart - tailStart + directorySize)
      : Buffer.from(await archive.read(directoryStart, directoryStart + directorySize));
  const entries: ZipEntry[] = [];
  let p = 0;
  while (p < directory.length) {
    const entry = centralEntry(directory, p);
    entries.push(entry);
    p += entry.central.length;
  }
  if (entries.length !== count) throw unreadable();
  // Each record runs to the next one's start, the last to the directory.
  const byStart = [...entries].sort((a, b) => a.start - b.start);
  byStart.forEach((entry, i) => {
    entry.end = byStart[i + 1]?.start ?? directoryStart;
    if (entry.end - entry.start < LOCAL_HEADER_BYTES) throw unreadable();
  });
  return entries;
}

/**
 * A ZIP archive of only `chosen`, each record copied unchanged from
 * `archive`: records that sit side by side are read together, and their
 * packed bytes together are bounded before anything is read.
 */
export async function zipOf(
  archive: ArchiveRanges,
  chosen: ZipEntry[],
  maxBytes: number,
): Promise<Buffer> {
  if (chosen.length > ZIP_MAX_ENTRIES)
    throw new ForgeError(
      "refused",
      `The selection holds ${chosen.length} files; one holds at most ${servedNumber(ZIP_MAX_ENTRIES)}, so save them in parts.`,
    );
  const ordered = [...chosen].sort((a, b) => a.start - b.start);
  const packed = packedBytes(ordered);
  if (packed > maxBytes)
    throw new ForgeError(
      "refused",
      `The selected files come to ${mib(packed)} packed, over the ${mib(maxBytes)} limit; select fewer.`,
    );
  // Records side by side make one run, read with one request.
  const runs: ZipEntry[][] = [];
  for (const entry of ordered) {
    const run = runs.at(-1);
    if (run && run.at(-1)?.end === entry.start) run.push(entry);
    else runs.push([entry]);
  }
  const records: Buffer[] = [];
  for (const run of runs) {
    const first = run[0]?.start ?? 0;
    const bytes = Buffer.from(await archive.read(first, run.at(-1)?.end ?? first));
    for (const entry of run) records.push(bytes.subarray(entry.start - first, entry.end - first));
  }
  const centrals: Buffer[] = [];
  let offset = 0;
  ordered.forEach((entry, k) => {
    const record = records[k] ?? Buffer.alloc(0);
    checkLocal(record, entry);
    const central = Buffer.from(entry.central);
    if (entry.offsetWidth === 4) central.writeUInt32LE(offset, entry.offsetAt);
    else central.writeBigUInt64LE(BigInt(offset), entry.offsetAt);
    centrals.push(central);
    offset += record.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(END_RECORD_BYTES);
  end.writeUInt32LE(END_RECORD, 0);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, directory, end]);
}

/** What saving these entries reads from the archive: their whole records. */
export function packedBytes(entries: ZipEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.end - entry.start, 0);
}

/** Whether `name` is the path a selection names, or under the folder it names. */
export function isUnder(name: string, path: string): boolean {
  return name === path || name.startsWith(path.endsWith("/") ? path : `${path}/`);
}

export function mib(bytes: number): string {
  const value = bytes / 1024 / 1024;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MiB`;
}

/** The end record, found only where its comment runs exactly to the archive's end. */
function endRecordAt(tail: Buffer): number {
  for (let at = tail.length - END_RECORD_BYTES; at >= 0; at--) {
    if (
      tail.readUInt32LE(at) === END_RECORD &&
      at + END_RECORD_BYTES + tail.readUInt16LE(at + 20) === tail.length
    )
      return at;
  }
  return -1;
}

function centralEntry(directory: Buffer, p: number): ZipEntry {
  if (p + CENTRAL_HEADER_BYTES > directory.length || directory.readUInt32LE(p) !== CENTRAL_HEADER)
    throw unreadable();
  let compressedSize = directory.readUInt32LE(p + 20);
  let size = directory.readUInt32LE(p + 24);
  const nameLength = directory.readUInt16LE(p + 28);
  const extraLength = directory.readUInt16LE(p + 30);
  const commentLength = directory.readUInt16LE(p + 32);
  let start = directory.readUInt32LE(p + 42);
  const length = CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
  if (p + length > directory.length) throw unreadable();
  const central = Buffer.from(directory.subarray(p, p + length));
  const nameBytes = central.subarray(CENTRAL_HEADER_BYTES, CENTRAL_HEADER_BYTES + nameLength);
  let offsetAt = 42;
  let offsetWidth: 4 | 8 = 4;
  // The 64-bit extra field holds, in order, each size or the offset its plain field could not.
  const extraEnd = CENTRAL_HEADER_BYTES + nameLength + extraLength;
  for (let q = CENTRAL_HEADER_BYTES + nameLength; q + 4 <= extraEnd; ) {
    const id = central.readUInt16LE(q);
    const fieldEnd = q + 4 + central.readUInt16LE(q + 2);
    if (fieldEnd > extraEnd) throw unreadable();
    if (id === 0x0001) {
      let r = q + 4;
      const next = (): number => {
        if (r + 8 > fieldEnd) throw unreadable();
        const value = safe(central.readBigUInt64LE(r));
        r += 8;
        return value;
      };
      if (size === 0xffffffff) size = next();
      if (compressedSize === 0xffffffff) compressedSize = next();
      if (start === 0xffffffff) {
        offsetAt = r;
        offsetWidth = 8;
        start = next();
      }
    }
    q = fieldEnd;
  }
  return {
    name: new TextDecoder().decode(nameBytes),
    size,
    start,
    end: start,
    compressedSize,
    nameBytes,
    central,
    offsetAt,
    offsetWidth,
  };
}

/** The record read is the entry the directory names: its local header, name and packed bytes fit. */
function checkLocal(record: Buffer, entry: ZipEntry): void {
  if (record.length < LOCAL_HEADER_BYTES || record.readUInt32LE(0) !== LOCAL_HEADER)
    throw unreadable();
  const nameLength = record.readUInt16LE(26);
  const extraLength = record.readUInt16LE(28);
  if (LOCAL_HEADER_BYTES + nameLength + extraLength + entry.compressedSize > record.length)
    throw unreadable();
  if (!record.subarray(LOCAL_HEADER_BYTES, LOCAL_HEADER_BYTES + nameLength).equals(entry.nameBytes))
    throw unreadable();
}

function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw unreadable();
  return Number(value);
}

function unreadable(): ForgeError {
  return new ForgeError("refused", "The artifact is not a ZIP archive the app can read in parts.");
}
