import { describe, expect, it } from "vitest";
import { loudness } from "./loudness";

// The approved plan for a person's own ambient styles (INF-5541): the app
// sets a style's loudness by measuring it, so the meter must read as the
// broadcast standard does. ITU-R BS.1770-4's calibration: a 997 Hz sine at
// full scale in one channel reads -3.01 LUFS.

function sine(rate: number, seconds: number, amplitude: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1)
    out[i] = amplitude * Math.sin((2 * Math.PI * 997 * i) / rate);
  return out;
}

describe("the loudness meter", () => {
  it.each([48_000, 24_000])("reads the standard's calibration tone at %i Hz", (rate) => {
    const tone = sine(rate, 5, 1);
    const read = loudness([tone, new Float32Array(tone.length)], rate);
    expect(read.lufs).toBeCloseTo(-3.01, 1);
    expect(read.peak).toBeCloseTo(0, 2);
  });

  it("reads 20 dB quieter for a tone a tenth as loud, and silence as no loudness", () => {
    const rate = 24_000;
    const loud = loudness([sine(rate, 5, 1)], rate).lufs;
    expect(loudness([sine(rate, 5, 0.1)], rate).lufs).toBeCloseTo(loud - 20, 1);
    expect(loudness([new Float32Array(rate * 5)], rate).lufs).toBe(Number.NEGATIVE_INFINITY);
  });

  it("leaves out the quiet stretches the standard's gates leave out", () => {
    const rate = 24_000;
    // Half silence would read 3 dB quieter if the gates kept it.
    const tone = sine(rate, 20, 0.5);
    const gapped = new Float32Array(tone.length * 2);
    gapped.set(tone);
    const by = loudness([gapped], rate).lufs - loudness([tone], rate).lufs;
    expect(Math.abs(by)).toBeLessThan(0.2);
  });
});
