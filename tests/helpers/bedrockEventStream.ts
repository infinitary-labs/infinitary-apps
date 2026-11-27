import { crc32 } from "node:zlib";

/**
 * One frame of the AWS event-stream wire format a Bedrock converse stream
 * answers with, so stand-ins exercise the shipped SDK's own reader rather
 * than a replacement driver.
 */
export function bedrockEvent(name: string, fields: object): Buffer {
  const headers = Buffer.concat(
    Object.entries({
      ":event-type": name,
      ":message-type": "event",
      ":content-type": "application/json",
    }).map(([key, value]) =>
      Buffer.concat([
        Buffer.from([key.length]),
        Buffer.from(key),
        Buffer.from([7, 0, value.length]),
        Buffer.from(value),
      ]),
    ),
  );
  const body = Buffer.from(JSON.stringify(fields));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12);
  body.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}
