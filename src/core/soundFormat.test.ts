import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { movingBoxBytes, mp4 } from "../../tests/helpers/mp4Fixture";
import { readSoundClip } from "./soundFormat";

/**
 * The sound clips a card may carry (docs/card-authoring.md "Sound clips"):
 * the captain's ruling on INF-4543 takes M4A, MP3 and WAV, the three a
 * local voice tool writes, held by size alone. The fixtures are real
 * two-second clips the encoder made at the voice tool's 24 kHz mono
 * (`tests/fixtures/sound/`).
 */

const clip = (name: string) => readFileSync(`tests/fixtures/sound/${name}`);

function reason(bytes: Buffer): string {
  const read = readSoundClip(bytes);
  if (read.ok) throw new Error("expected a refusal");
  return read.reason;
}

describe("readSoundClip", () => {
  it("reads each kind of real clip by its own bytes, with how long it plays", () => {
    for (const [name, kind] of [
      ["tone.m4a", "m4a"],
      ["tone.mp3", "mp3"],
      ["tone.wav", "wav"],
    ] as const) {
      const read = readSoundClip(clip(name));
      if (!read.ok) throw new Error(`${name}: ${read.reason}`);
      expect(read.clip.kind).toBe(kind);
      // Each is two seconds; an encoder's priming and last frame stay within a tenth.
      expect(Math.abs(read.clip.durationMs - 2000)).toBeLessThanOrEqual(100);
    }
  });

  it("reads the kind from the bytes, never from the name", () => {
    // The same bytes under any name are the same clip; this reader is never told a name.
    expect(readSoundClip(clip("tone.mp3"))).toMatchObject({ ok: true, clip: { kind: "mp3" } });
  });

  it("refuses a recording with pictures passed as a clip", () => {
    expect(reason(movingBoxBytes())).toMatch(/holds pictures: a sound clip is sound alone/);
    expect(reason(mp4({ audio: true }))).toMatch(/holds pictures/);
  });

  it("refuses a file whose bytes lie about what it is", () => {
    expect(reason(Buffer.from("ID3 is not enough to be an MP3 at all"))).toMatch(/tag|Layer III/);
    expect(reason(readFileSync("tests/fixtures/demo/moving-box.gif"))).toMatch(
      /is not an M4A, MP3 or WAV sound clip/,
    );
    const wav = clip("tone.wav");
    expect(reason(wav.subarray(0, wav.length - 100))).toMatch(/size does not match/);
    // A WAV that says it is something other than PCM.
    const float = Buffer.from(wav);
    float.writeUInt16LE(3, 20);
    expect(reason(float)).toMatch(/is not PCM sound/);
    const m4a = clip("tone.m4a");
    expect(reason(m4a.subarray(0, m4a.length - 10))).toMatch(/runs past the end of the file/);
    const mp3 = clip("tone.mp3");
    expect(reason(Buffer.concat([mp3, Buffer.from("not sound, but text after it")]))).toMatch(
      /something other than sound lies between its frames/,
    );
    expect(reason(mp3.subarray(0, mp3.length - 7))).toMatch(/last frame is cut short/);
  });
});
