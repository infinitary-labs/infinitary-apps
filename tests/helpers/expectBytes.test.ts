import { describe, expect, it } from "vitest";
import { CARD_MEDIA_PIECE_BYTES } from "../../src/shared/cardPictures";
import { expectBytesEqual } from "./expectBytes";

describe("expectBytesEqual", () => {
  it("compares the complete multi-piece payload, including corruption at either end and the piece boundary", () => {
    const payload = Buffer.alloc(CARD_MEDIA_PIECE_BYTES + 500, 7);
    const received = new Uint8Array(payload);
    expectBytesEqual(received, payload);
    for (const offset of [
      0,
      CARD_MEDIA_PIECE_BYTES - 1,
      CARD_MEDIA_PIECE_BYTES,
      payload.length - 1,
    ]) {
      const original = received[offset] ?? 0;
      received[offset] = original ^ 1;
      expect(() => expectBytesEqual(received, payload)).toThrow("all bytes match");
      received[offset] = original;
    }
    expect(() => expectBytesEqual(received.subarray(0, -1), payload)).toThrow("byte count");
  });

  it("compares just a view's bytes, not its backing buffer", () => {
    const left = Uint8Array.from([99, 1, 2, 3, 99]);
    const right = Buffer.from([88, 88, 1, 2, 3, 88]);
    expectBytesEqual(left.subarray(1, 4), right.subarray(2, 5));
    expect(() => expectBytesEqual(left.subarray(0, 3), right.subarray(2, 5))).toThrow(
      "all bytes match",
    );
    expectBytesEqual(new Uint8Array(), Buffer.alloc(0));
  });
});
