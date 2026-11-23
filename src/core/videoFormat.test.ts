import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  box,
  MOVING_BOX,
  MOVING_BOX_SOUND_MP4,
  movingBoxBytes,
  mp4,
} from "../../tests/helpers/mp4Fixture";
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
      video: { ...MOVING_BOX, profile: "High", sound: false },
    });
  });

  it("reads a real recording that keeps one AAC sound track beside its pictures", () => {
    // INF-4543's ruling: a demo keeps its sound when it is about something that needs to be heard.
    const read = readDemoVideo(readFileSync(MOVING_BOX_SOUND_MP4));
    if (!read.ok) throw new Error(read.reason);
    const { durationMs, ...rest } = read.video;
    const { durationMs: pictured, ...shape } = MOVING_BOX;
    expect(rest).toEqual({ ...shape, profile: "High", sound: true });
    // The encoder's priming lets the sound run a frame past the pictures; it stays within a tenth.
    expect(Math.abs(durationMs - pictured)).toBeLessThanOrEqual(100);
  });

  it("accepts each 8-bit 4:2:0 profile within the limits", () => {
    for (const [profile, name] of [
      [66, "Baseline"],
      [77, "Main"],
      [100, "High"],
    ] as const) {
      expect(readDemoVideo(mp4({ profile }))).toEqual({
        ok: true,
        video: {
          width: 640,
          height: 360,
          durationMs: 2000,
          frames: 48,
          profile: name,
          sound: false,
        },
      });
    }
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

  it("refuses sound it cannot read, a second video track, another codec and a fragmented file", () => {
    // A sound track that describes no sound is checked as sound, not waved through.
    expect(reason(mp4({ audio: true }))).toMatch(/needs exactly one media information box/);
    // The real recording's sound described as AC-3: AAC, or no sound at all.
    const sounded = readFileSync(MOVING_BOX_SOUND_MP4);
    const entry = sounded.indexOf("mp4a", 0, "latin1");
    const ac3 = Buffer.concat([
      sounded.subarray(0, entry),
      Buffer.from("ac-3"),
      sounded.subarray(entry + 4),
    ]);
    expect(reason(ac3)).toMatch(/has sound that is not AAC: .* leave it out \(-an\) when nothing/);
    expect(reason(mp4({ codec: "hvc1" }))).toMatch(/is not H.264 video/);
    expect(reason(mp4({ fragmented: true }))).toMatch(/fragmented MP4/);
    expect(reason(mp4({ secondVideo: true }))).toMatch(
      /exactly one video track, at most one sound track/,
    );
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
