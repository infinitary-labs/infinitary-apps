import { describe, expect, it } from "vitest";
import { box, MOVING_BOX, movingBoxBytes, mp4 } from "../../tests/helpers/mp4Fixture";
import { readDemoVideo } from "./videoFormat";

function reason(bytes: Buffer): string {
  const read = readDemoVideo(bytes);
  if (read.ok) throw new Error("expected a refusal");
  return read.reason;
}

describe("readDemoVideo", () => {
  it("reads a real recording from the pinned encoder: its size, length and frames", () => {
    expect(readDemoVideo(movingBoxBytes())).toEqual({
      ok: true,
      video: { ...MOVING_BOX, profile: "High" },
    });
  });

  it("accepts each 8-bit 4:2:0 profile within the limits", () => {
    for (const [profile, name] of [
      [66, "Baseline"],
      [77, "Main"],
      [100, "High"],
    ] as const) {
      expect(readDemoVideo(mp4({ profile }))).toEqual({
        ok: true,
        video: { width: 640, height: 360, durationMs: 2000, frames: 48, profile: name },
      });
    }
    // At the limits exactly: 30 seconds, 30 frames a second, 1920 × 1080, or portrait.
    expect(readDemoVideo(mp4({ seconds: 30, fps: 30, width: 1920, height: 1080 })).ok).toBe(true);
    expect(readDemoVideo(mp4({ width: 1080, height: 1920 })).ok).toBe(true);
  });

  it("refuses a file that is not an MP4, or is cut short", () => {
    expect(reason(Buffer.from("not a video at all"))).toMatch(/does not start with an ftyp box/);
    expect(reason(mp4({ brand: "qt  " }))).toMatch(/not a QuickTime or other movie/);
    const whole = movingBoxBytes();
    expect(reason(whole.subarray(0, whole.length - 10))).toMatch(/runs past the end of the file/);
    expect(reason(Buffer.concat([whole, Buffer.from([1, 2, 3])]))).toMatch(
      /ends inside a box header/,
    );
  });

  it("refuses sound, a second track, another codec and a fragmented file", () => {
    expect(reason(mp4({ audio: true }))).toMatch(/carries sound: a demo is silent/);
    expect(reason(mp4({ codec: "hvc1" }))).toMatch(/is not H.264 video/);
    expect(reason(mp4({ fragmented: true }))).toMatch(/fragmented MP4/);
    expect(reason(mp4({ secondVideo: true }))).toMatch(/exactly one video track/);
  });

  it("refuses pictures that are not 8-bit 4:2:0", () => {
    expect(reason(mp4({ profile: 244, chroma: 3 }))).toMatch(/High, Main or Baseline, 8-bit 4:2:0/);
    expect(reason(mp4({ chroma: 2 }))).toMatch(/not 8-bit 4:2:0 video/);
    expect(reason(mp4({ chroma: 0 }))).toMatch(/not 8-bit 4:2:0 video/);
    expect(reason(mp4({ depth: 2 }))).toMatch(/not 8-bit 4:2:0 video/);
  });

  it("refuses a recording past the limits, saying which and by how much", () => {
    expect(reason(mp4({ seconds: 31 }))).toMatch(/runs 31.0 seconds: a demo runs at most 30/);
    expect(reason(mp4({ fps: 60 }))).toMatch(/more than 30 frames a second/);
    expect(reason(mp4({ width: 2560, height: 1440 }))).toMatch(
      /is 2560 × 1440: a demo is at most 1920 × 1080/,
    );
    expect(reason(mp4({ width: 1200, height: 1200 }))).toMatch(/is 1200 × 1200/);
  });

  it("refuses samples that lie outside the media data", () => {
    expect(reason(mp4({ shiftSamples: 64 }))).toMatch(/a picture lies outside its media data/);
  });

  it("refuses a movie with no track or no media data", () => {
    const ftyp = box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom"));
    const mvhd = box("mvhd", Buffer.alloc(100));
    expect(reason(Buffer.concat([ftyp, box("moov", mvhd)]))).toMatch(/holds no media data/);
    const header = Buffer.alloc(100);
    header.writeUInt32BE(1000, 12);
    expect(
      reason(Buffer.concat([ftyp, box("moov", box("mvhd", header)), box("mdat", Buffer.alloc(8))])),
    ).toMatch(/has no track/);
  });
});
