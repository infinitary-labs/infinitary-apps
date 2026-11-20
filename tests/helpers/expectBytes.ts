import { expect } from "vitest";

/** Compare every byte without walking a large typed array's indexed properties. */
export function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength, "byte count").toBe(expected.byteLength);
  const bytes = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const wanted = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  expect(bytes.equals(wanted), "all bytes match").toBe(true);
}
