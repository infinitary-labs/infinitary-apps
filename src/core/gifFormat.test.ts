import { describe, expect, it } from "vitest";
import { gif, MOVING_BOX_GIF_SIZE, movingBoxGifBytes } from "../../tests/helpers/gifFixture";
import { isGif, readDemoGif } from "./gifFormat";

function reason(bytes: Buffer): string {
  const read = readDemoGif(bytes);
  if (read.ok) throw new Error("expected a refusal");
  return read.reason;
}

describe("readDemoGif", () => {
  it("reads a real single-play recording from the pinned encoder: its size, length and frames", () => {
    const bytes = movingBoxGifBytes();
    expect(isGif(bytes)).toBe(true);
    expect(readDemoGif(bytes)).toEqual({ ok: true, gif: MOVING_BOX_GIF_SIZE });
  });

  it("reads a built GIF within the limits, and one exactly at them", () => {
    expect(readDemoGif(gif())).toEqual({
      ok: true,
      gif: { width: 64, height: 36, durationMs: 2000, frames: 20 },
    });
    // 10 seconds at 10 frames a second, and 1280 × 720 either way round.
    expect(readDemoGif(gif({ frames: 100 })).ok).toBe(true);
    const corner = { left: 0, top: 0, width: 16, height: 16 };
    expect(readDemoGif(gif({ frames: 2, width: 1280, height: 720, frame: corner })).ok).toBe(true);
    expect(readDemoGif(gif({ frames: 2, width: 720, height: 1280, frame: corner })).ok).toBe(true);
    // A block that is not a loop instruction is walked past.
    expect(readDemoGif(gif({ xmp: true })).ok).toBe(true);
  });

  it("times frames as Chromium shows them: 10 ms or less is shown for 100 ms", () => {
    const read = readDemoGif(gif({ frames: 3, delay: [0, 1, 25] }));
    expect(read).toMatchObject({ ok: true, gif: { durationMs: 450, frames: 3 } });
  });

  it("refuses a loop instruction, whichever block carries it", () => {
    expect(reason(gif({ loop: "NETSCAPE2.0" }))).toMatch(
      /carries a loop instruction \(its NETSCAPE2.0 block\).*-loop -1/,
    );
    expect(reason(gif({ loop: "ANIMEXTS1.0" }))).toMatch(/loop instruction/);
  });

  it("refuses a GIF past the limits, saying which", () => {
    expect(reason(gif({ frames: 101 }))).toMatch(/more than 100 frames/);
    expect(reason(gif({ frames: 50, delay: 21 }))).toMatch(
      /runs 10.5 seconds: a GIF demo runs at most 10/,
    );
    expect(reason(gif({ delay: 5 }))).toMatch(
      /shows a frame for 50 ms: a GIF demo plays at most 10 frames a second/,
    );
    const corner = { left: 0, top: 0, width: 16, height: 16 };
    expect(reason(gif({ width: 1281, height: 720, frame: corner }))).toMatch(
      /is 1281 × 720: .* at most 1280 × 720/,
    );
    expect(reason(gif({ width: 800, height: 800, frame: corner }))).toMatch(/at most 1280 × 720/);
  });

  it("refuses a still, which is a picture", () => {
    expect(reason(gif({ frames: 1 }))).toMatch(/holds one picture and does not move/);
  });

  it("refuses a file that is not a GIF, is cut short, or runs on past its end", () => {
    expect(isGif(Buffer.from("not a gif"))).toBe(false);
    expect(reason(Buffer.from("not a gif at all"))).toMatch(/does not start with GIF89a/);
    expect(reason(gif({ truncate: 1 }))).toMatch(/ends before its trailer/);
    expect(reason(gif({ truncate: 400 }))).toMatch(/ends before its trailer/);
    expect(reason(gif({ trailing: true }))).toMatch(/bytes follow its trailer/);
  });

  it("refuses frames whose picture data does not decode or does not fill them", () => {
    expect(reason(gif({ garbled: true }))).toMatch(/picture data does not decode/);
    expect(reason(gif({ shortBy: 10 }))).toMatch(/picture data is cut short/);
    expect(reason(gif({ noColors: true }))).toMatch(/no colors to draw with/);
    expect(reason(gif({ frame: { left: 10, top: 0, width: 64, height: 36 } }))).toMatch(
      /lies outside its picture/,
    );
  });
});
