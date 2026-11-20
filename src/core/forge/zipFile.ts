import { Readable } from "node:stream";
import { crc32, createInflateRaw } from "node:zlib";
import { ForgeError } from "./forge";
import type { ArchiveRanges } from "./workflows";
import type { ZipEntry } from "./zipParts";

/** A working buffer, not a file-size limit; each read releases it before the next. */
export const ZIP_FILE_CHUNK_BYTES = 1024 * 1024;

/** One exact member, inflated in bounded pieces and checked before its destination is published. */
export async function* zipFile(
  archive: ArchiveRanges,
  entry: ZipEntry,
): AsyncGenerator<Uint8Array> {
  const header = Buffer.from(await archive.read(entry.start, entry.start + 30));
  const flags = entry.central.readUInt16LE(8);
  const method = entry.central.readUInt16LE(10);
  if ((flags & 1) !== 0 || ![0, 8].includes(method))
    throw new ForgeError(
      "refused",
      "The selected file is encrypted or uses unsupported compression.",
    );
  const nameLength = header.readUInt16LE(26);
  const from = entry.start + 30 + nameLength + header.readUInt16LE(28);
  const end = from + entry.compressedSize;
  if (
    header.readUInt32LE(0) !== 0x04034b50 ||
    header.readUInt16LE(6) !== flags ||
    header.readUInt16LE(8) !== method ||
    !Number.isSafeInteger(end) ||
    end > entry.end ||
    nameLength !== entry.nameBytes.length ||
    !Buffer.from(await archive.read(entry.start + 30, entry.start + 30 + nameLength)).equals(
      entry.nameBytes,
    )
  )
    throw new ForgeError("refused", "The selected file's ZIP headers disagree.");

  async function* packed() {
    for (let at = from; at < end; at += ZIP_FILE_CHUNK_BYTES)
      yield await archive.read(at, Math.min(at + ZIP_FILE_CHUNK_BYTES, end));
  }
  const source = Readable.from(packed(), { objectMode: false });
  const inflater = method === 8 ? createInflateRaw() : undefined;
  // pipe alone does not forward a source error to its consumer.
  if (inflater) source.on("error", (error) => inflater.destroy(error));
  const stream = inflater ? source.pipe(inflater) : source;
  let size = 0;
  let sum = 0;
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > entry.size)
        throw new ForgeError("refused", "The selected file exceeds its declared unpacked size.");
      sum = crc32(bytes, sum);
      yield bytes;
    }
    if (
      size !== entry.size ||
      sum !== entry.central.readUInt32LE(16) ||
      (inflater && inflater.bytesWritten !== entry.compressedSize)
    )
      throw new ForgeError("refused", "The selected file failed its ZIP size or checksum check.");
  } finally {
    source.destroy();
    inflater?.destroy();
  }
}
