import { CONNECTION_MAX_FRAME_BYTES } from "@shared/connection";
import { describe, expect, it } from "vitest";
import { FramePartsReader, partsHeader } from "./frameParts";

describe("a connection's frames read back from their parts", () => {
  it("joins a frame's parts once the last arrives, and passes a whole frame through", () => {
    const frame = JSON.stringify({ t: "push", seq: 3, channel: "inf:cards", payload: "é😀 tide" });
    const bytes = Buffer.from(frame, "utf8");
    const reader = new FramePartsReader();
    expect(reader.read(partsHeader(bytes.length))).toBeUndefined();
    expect(reader.read(bytes.subarray(0, 10))).toBeUndefined();
    expect(reader.read(bytes.subarray(10))).toBe(frame);
    expect(reader.joined).toBe(1);
    const welcome = JSON.stringify({ t: "welcome", note: "parts" });
    expect(reader.read(welcome)).toBe(welcome);
    expect(reader.read('{"t":"push","channel":"parts"}')).toBe('{"t":"push","channel":"parts"}');
    expect(reader.joined).toBe(1);
  });

  it("refuses parts that run past their length, and a length it could never take", () => {
    const reader = new FramePartsReader();
    reader.read(partsHeader(4));
    expect(() => reader.read("{} {}")).toThrow("ran past");
    expect(reader.read("{}")).toBe("{}");
    expect(() => reader.read(partsHeader(CONNECTION_MAX_FRAME_BYTES + 1))).toThrow("longer");
    expect(() => reader.read('{"t":"parts"}')).toThrow("no length");
  });
});
