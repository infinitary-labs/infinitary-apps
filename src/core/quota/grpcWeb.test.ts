import { describe, expect, it } from "vitest";
import {
  concatBytes,
  floatField,
  grpcFrame,
  grpcTrailer,
  messageField,
  scalarField,
} from "../../../tests/support/grpcWebEncoder";
import {
  bytesAt,
  floatAt,
  messageAt,
  ProtoDecodeError,
  readGrpcWebResponse,
  scanProtobuf,
  timestampAt,
  varintAt,
} from "./grpcWeb";
import { BODY_LIMIT_BYTES } from "./http";

const MESSAGE = messageField(1, concatBytes(floatField(1, 25), scalarField(2, 7)));

describe("readGrpcWebResponse", () => {
  it("returns the one data frame of a framed answer with an OK trailer", () => {
    const read = readGrpcWebResponse({
      status: 200,
      bytes: concatBytes(grpcFrame(MESSAGE), grpcTrailer({ "grpc-status": "0" })),
    });
    expect(read.kind).toBe("message");
    expect(read.kind === "message" && Array.from(read.message)).toEqual(Array.from(MESSAGE));
  });

  it("returns the data frame when the answer carries no trailer at all", () => {
    const read = readGrpcWebResponse({ status: 200, bytes: grpcFrame(MESSAGE) });
    expect(read.kind).toBe("message");
  });

  it("takes an unframed body as the bare message", () => {
    const read = readGrpcWebResponse({ status: 200, bytes: MESSAGE });
    expect(read).toEqual({ kind: "message", message: MESSAGE });
  });

  it("surfaces the trailer's verdict, percent-decoded, over any data frame", () => {
    const read = readGrpcWebResponse({
      status: 200,
      bytes: concatBytes(
        grpcFrame(MESSAGE),
        grpcTrailer({ "grpc-status": "16", "grpc-message": "token%20expired" }),
      ),
    });
    expect(read).toEqual({ kind: "status", code: 16, message: "token expired" });
  });

  it("honours a trailers-only verdict in the response headers before the body", () => {
    const read = readGrpcWebResponse({
      status: 200,
      headers: { "grpc-status": "13", "grpc-message": "internal" },
      bytes: grpcFrame(MESSAGE),
    });
    expect(read).toEqual({ kind: "status", code: 13, message: "internal" });
  });

  it.each([
    ["an empty body", new Uint8Array()],
    ["a truncated frame", Uint8Array.from([0, 0, 0, 0, 8, 10])],
    ["a compressed frame", grpcFrame(MESSAGE, 1)],
    ["two data frames", concatBytes(grpcFrame(MESSAGE), grpcFrame(MESSAGE))],
    ["a trailer with no data frame", grpcTrailer({ "grpc-status": "0" })],
    ["two trailers", concatBytes(grpcTrailer({ "grpc-status": "0" }), grpcTrailer({}))],
    ["a compressed trailer", grpcFrame(MESSAGE, 0x81)],
  ])("refuses %s as a protocol error rather than guessing", (_label, bytes) => {
    expect(readGrpcWebResponse({ status: 200, bytes })).toEqual({ kind: "protocol" });
  });

  it("refuses a status it cannot parse and a frame larger than the body limit", () => {
    expect(
      readGrpcWebResponse({ status: 200, headers: { "grpc-status": "ok" }, bytes: MESSAGE }),
    ).toEqual({ kind: "protocol" });
    const huge = new Uint8Array(5);
    new DataView(huge.buffer).setUint32(1, BODY_LIMIT_BYTES + 1);
    expect(readGrpcWebResponse({ status: 200, bytes: huge })).toEqual({ kind: "protocol" });
  });

  it("never reads a non-2xx transport as an answer", () => {
    expect(readGrpcWebResponse({ status: 500, bytes: grpcFrame(MESSAGE) })).toEqual({
      kind: "protocol",
    });
  });
});

describe("scanProtobuf", () => {
  it("keeps every field in wire order, typed by wire type", () => {
    const fields = scanProtobuf(
      concatBytes(
        scalarField(1, 300),
        floatField(2, 1.5),
        messageField(3, scalarField(1, 9)),
        Uint8Array.from([0x21, 1, 2, 3, 4, 5, 6, 7, 8]),
      ),
    );
    expect(fields.map((field) => [field.field, field.wire])).toEqual([
      [1, "varint"],
      [2, "fixed32"],
      [3, "bytes"],
      [4, "fixed64"],
    ]);
    expect(varintAt(fields, 1)).toBe(300n);
    expect(floatAt(fields, 2)).toBe(1.5);
    expect(varintAt(messageAt(fields, 3) ?? [], 1)).toBe(9n);
    expect(bytesAt(fields, 3)).toHaveLength(1);
  });

  it("reads a Timestamp submessage as milliseconds and ignores its nanos", () => {
    const fields = scanProtobuf(
      messageField(3, concatBytes(scalarField(1, 1_788_811_169), scalarField(2, 885_889_000))),
    );
    expect(timestampAt(fields, 3)).toBe(Date.parse("2026-09-07T19:59:29Z"));
    expect(timestampAt(fields, 4)).toBeUndefined();
  });

  it.each([
    ["a truncated varint", Uint8Array.from([0x08, 0x80])],
    ["a truncated length-delimited field", Uint8Array.from([0x0a, 0x05, 0x08])],
    ["a truncated fixed32", Uint8Array.from([0x0d, 0x00, 0x00])],
    ["a group wire type", Uint8Array.from([0x0b])],
    ["field number zero", Uint8Array.from([0x00])],
  ])("refuses %s", (_label, bytes) => {
    expect(() => scanProtobuf(bytes)).toThrow(ProtoDecodeError);
  });

  it("refuses a non-finite float instead of reading it as a number", () => {
    const nan = new Uint8Array(5);
    nan[0] = (1 << 3) | 5;
    new DataView(nan.buffer).setFloat32(1, Number.NaN, true);
    expect(() => floatAt(scanProtobuf(nan), 1)).toThrow(ProtoDecodeError);
  });
});
