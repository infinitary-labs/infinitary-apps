import { BODY_LIMIT_BYTES, isSuccess, type QuotaResponse } from "./http";

/**
 * Just enough gRPC-web and protobuf wire format to read one unary answer,
 * with no schema: a bounded field scanner that keeps every field it can
 * decode and ignores the rest. The provider that consumes it names the
 * field numbers it understands; nothing here knows what any field means.
 *
 * Every malformed shape is refused as `protocol` rather than guessed at. A
 * decode failure must surface as a reason and never as an invented window.
 */

/** The canonical gRPC status codes a meter can honestly hand back. */
export const GRPC_UNAUTHENTICATED = 16;
export const GRPC_PERMISSION_DENIED = 7;
export const GRPC_RESOURCE_EXHAUSTED = 8;

const FRAME_HEADER_BYTES = 5;
const TRAILER_FLAG = 0x80;
const COMPRESSED_FLAG = 0x01;
const MAX_FIELD_NUMBER = 0x1fffffff;

export type GrpcWebRead =
  /** A 2xx answer that carried exactly one uncompressed message. */
  | { kind: "message"; message: Uint8Array }
  /** The server's own verdict, from the headers or the trailer frame. */
  | { kind: "status"; code: number; message?: string }
  /** A body this reader does not recognize as a gRPC-web answer. */
  | { kind: "protocol" };

/**
 * Read a unary gRPC-web response. A non-2xx HTTP status is the caller's to
 * classify; this reads only successful transports. The gRPC verdict may ride
 * the headers (a trailers-only response) or a trailer frame after the data
 * frame, and a body that is not framed at all is taken as the bare message -
 * the shape some successful answers to this kind of endpoint arrive in.
 */
export function readGrpcWebResponse(result: QuotaResponse): GrpcWebRead {
  if (!isSuccess(result.status)) return { kind: "protocol" };
  const headerStatus = statusFromFields(result.headers ?? {});
  if (headerStatus) return headerStatus;
  const bytes = result.bytes;
  if (!bytes || bytes.length === 0) return { kind: "protocol" };
  if (!looksFramed(bytes[0] ?? 0)) return { kind: "message", message: bytes };

  const dataFrames: Uint8Array[] = [];
  let trailer: GrpcWebRead | undefined;
  let index = 0;
  while (index < bytes.length) {
    if (index + FRAME_HEADER_BYTES > bytes.length) return { kind: "protocol" };
    const flags = bytes[index] ?? 0;
    if ((flags & COMPRESSED_FLAG) !== 0) return { kind: "protocol" };
    if (flags !== 0 && flags !== TRAILER_FLAG) return { kind: "protocol" };
    const length = new DataView(bytes.buffer, bytes.byteOffset + index + 1, 4).getUint32(0);
    if (length > BODY_LIMIT_BYTES) return { kind: "protocol" };
    const start = index + FRAME_HEADER_BYTES;
    const end = start + length;
    if (end > bytes.length) return { kind: "protocol" };
    const frame = bytes.subarray(start, end);
    if (flags === TRAILER_FLAG) {
      if (trailer) return { kind: "protocol" };
      trailer = statusFromFields(parseTrailer(frame)) ?? { kind: "status", code: 0 };
    } else {
      if (trailer || dataFrames.length > 0) return { kind: "protocol" };
      dataFrames.push(frame);
    }
    index = end;
  }
  if (trailer && trailer.kind === "status" && trailer.code !== 0) return trailer;
  const message = dataFrames[0];
  if (dataFrames.length !== 1 || !message) return { kind: "protocol" };
  return { kind: "message", message };
}

/** A framed body starts with a flags byte; a bare protobuf tag never is 0 or 1. */
function looksFramed(first: number): boolean {
  return first === 0 || first === 1 || (first & TRAILER_FLAG) !== 0;
}

function parseTrailer(frame: Uint8Array): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of new TextDecoder().decode(frame).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return fields;
}

/**
 * `grpc-status` where present. An unparseable status is a protocol error;
 * a zero one is no verdict at all. The message is percent-decoded and kept
 * only for classification - it is vendor text and never reaches a surface.
 */
function statusFromFields(fields: Record<string, string>): GrpcWebRead | undefined {
  const raw = fields["grpc-status"];
  if (raw === undefined) return undefined;
  if (!/^(?:[0-9]|1[0-6])$/.test(raw)) return { kind: "protocol" };
  const code = Number(raw);
  if (code === 0) return undefined;
  const encoded = fields["grpc-message"];
  let message: string | undefined;
  if (encoded) {
    try {
      message = decodeURIComponent(encoded);
    } catch {
      message = encoded;
    }
  }
  return { kind: "status", code, ...(message ? { message } : {}) };
}

// ---- protobuf wire format ------------------------------------------------

export type ProtoField =
  | { field: number; wire: "varint"; value: bigint }
  | { field: number; wire: "fixed32" | "fixed64" | "bytes"; value: Uint8Array };

export class ProtoDecodeError extends Error {
  constructor() {
    super("protobuf message invalid");
    this.name = "ProtoDecodeError";
  }
}

/**
 * Scan one message into its fields, in order, without a schema. Unknown
 * fields are kept as what the wire says they are; groups (deprecated wire
 * types 3 and 4) and any truncation refuse the whole message.
 */
export function scanProtobuf(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let index = 0;
  while (index < bytes.length) {
    const key = readVarint(bytes, index);
    index = key.next;
    const fieldNumber = key.value >> 3n;
    if (fieldNumber <= 0n || fieldNumber > BigInt(MAX_FIELD_NUMBER)) throw new ProtoDecodeError();
    const field = Number(fieldNumber);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const scalar = readVarint(bytes, index);
      fields.push({ field, wire: "varint", value: scalar.value });
      index = scalar.next;
      continue;
    }
    if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (index + length > bytes.length) throw new ProtoDecodeError();
      fields.push({
        field,
        wire: wire === 1 ? "fixed64" : "fixed32",
        value: bytes.subarray(index, index + length),
      });
      index += length;
      continue;
    }
    if (wire === 2) {
      const lengthValue = readVarint(bytes, index);
      index = lengthValue.next;
      if (lengthValue.value > BigInt(BODY_LIMIT_BYTES)) throw new ProtoDecodeError();
      const end = index + Number(lengthValue.value);
      if (end > bytes.length) throw new ProtoDecodeError();
      fields.push({ field, wire: "bytes", value: bytes.subarray(index, end) });
      index = end;
      continue;
    }
    throw new ProtoDecodeError();
  }
  return fields;
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; next: number } {
  let value = 0n;
  let index = start;
  for (let count = 0; count < 10 && index < bytes.length; count += 1) {
    const byte = bytes[index] ?? 0;
    index += 1;
    if (count === 9 && byte > 1) throw new ProtoDecodeError();
    value |= BigInt(byte & 0x7f) << BigInt(count * 7);
    if ((byte & 0x80) === 0) return { value, next: index };
  }
  throw new ProtoDecodeError();
}

/** Every length-delimited value of a field, as raw bytes. */
export function bytesAt(fields: ProtoField[], field: number): Uint8Array[] {
  return fields.flatMap((entry) =>
    entry.field === field && entry.wire === "bytes" ? [entry.value] : [],
  );
}

/** The first length-delimited value of a field, scanned as a message. */
export function messageAt(fields: ProtoField[], field: number): ProtoField[] | undefined {
  const first = bytesAt(fields, field)[0];
  return first ? scanProtobuf(first) : undefined;
}

export function varintAt(fields: ProtoField[], field: number): bigint | undefined {
  const found = fields.find((entry) => entry.field === field && entry.wire === "varint");
  return found?.wire === "varint" ? found.value : undefined;
}

/** A fixed32 field read as an IEEE float; a non-finite value is refused. */
export function floatAt(fields: ProtoField[], field: number): number | undefined {
  const found = fields.find((entry) => entry.field === field && entry.wire === "fixed32");
  if (found?.wire !== "fixed32") return undefined;
  const value = new DataView(found.value.buffer, found.value.byteOffset, 4).getFloat32(0, true);
  if (!Number.isFinite(value)) throw new ProtoDecodeError();
  return value;
}

/** A fixed64 field read as an IEEE double; a non-finite value is refused. */
export function doubleAt(fields: ProtoField[], field: number): number | undefined {
  const found = fields.find((entry) => entry.field === field && entry.wire === "fixed64");
  if (found?.wire !== "fixed64") return undefined;
  const value = new DataView(found.value.buffer, found.value.byteOffset, 8).getFloat64(0, true);
  if (!Number.isFinite(value)) throw new ProtoDecodeError();
  return value;
}

/** A `google.protobuf.Timestamp` submessage (field 1 = seconds), in ms. */
export function timestampAt(fields: ProtoField[], field: number): number | undefined {
  const timestamp = messageAt(fields, field);
  if (!timestamp) return undefined;
  const seconds = varintAt(timestamp, 1);
  if (seconds === undefined || seconds > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const milliseconds = Number(seconds) * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/** A varint as a plain number, when it fits one. */
export function safeNumber(value: bigint | undefined): number | undefined {
  if (value === undefined || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}
