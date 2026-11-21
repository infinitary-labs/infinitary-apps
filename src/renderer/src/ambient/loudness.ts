// Loudness as the broadcast standard measures it (ITU-R BS.1770-4, in LUFS):
// each channel K-weighted, its power read in 400 ms blocks a quarter apart,
// and the blocks below -70 LUFS and then those 10 LU under their mean left
// out. The app measures a person's own style with it (./balance.ts).

/** One biquad's coefficients, already divided by a0. */
type Biquad = [b0: number, b1: number, b2: number, a1: number, a2: number];

/**
 * The standard's two K-weighting stages at any sample rate, a high shelf and
 * then a high pass, designed as the reference meter libebur128 designs them
 * so their response at 48 kHz is the standard's own.
 */
function kWeighting(rate: number): [Biquad, Biquad] {
  const shelf = (() => {
    const f0 = 1681.974450955533;
    const gain = 3.999843853973347;
    const q = 0.7071752369554196;
    const k = Math.tan((Math.PI * f0) / rate);
    const vh = 10 ** (gain / 20);
    const vb = vh ** 0.4996667741545416;
    const a0 = 1 + k / q + k * k;
    return [
      (vh + (vb * k) / q + k * k) / a0,
      (2 * (k * k - vh)) / a0,
      (vh - (vb * k) / q + k * k) / a0,
      (2 * (k * k - 1)) / a0,
      (1 - k / q + k * k) / a0,
    ] as Biquad;
  })();
  const pass = (() => {
    const f0 = 38.13547087602444;
    const q = 0.5003270373238773;
    const k = Math.tan((Math.PI * f0) / rate);
    const a0 = 1 + k / q + k * k;
    return [1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] as Biquad;
  })();
  return [shelf, pass];
}

function filter(input: Float32Array, [b0, b1, b2, a1, a2]: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i] as number;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

const toLufs = (power: number) => -0.691 + 10 * Math.log10(power);

/**
 * The integrated loudness of left and right (or one channel) at `rate`, in
 * LUFS, from `skip` seconds in; -Infinity for silence. And the highest
 * sample's level, in dB.
 */
export function loudness(
  channels: Float32Array[],
  rate: number,
  skip = 0,
): { lufs: number; peak: number } {
  const from = Math.floor(skip * rate);
  const [shelf, pass] = kWeighting(rate);
  let peak = 0;
  const weighted = channels.map((channel) => {
    const part = channel.subarray(from);
    for (const x of part) peak = Math.max(peak, Math.abs(x));
    return filter(filter(part, shelf), pass);
  });
  const block = Math.round(0.4 * rate);
  const hop = Math.round(0.1 * rate);
  const length = weighted[0]?.length ?? 0;
  const powers: number[] = [];
  for (let start = 0; start + block <= length; start += hop) {
    let power = 0;
    for (const w of weighted) {
      let sum = 0;
      for (let i = start; i < start + block; i += 1) sum += (w[i] as number) ** 2;
      power += sum / block;
    }
    powers.push(power);
  }
  const loud = powers.filter((p) => toLufs(p) > -70);
  const peakDb = 20 * Math.log10(peak || 1e-12);
  if (loud.length === 0) return { lufs: Number.NEGATIVE_INFINITY, peak: peakDb };
  const relative = toLufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const kept = loud.filter((p) => toLufs(p) > relative);
  return { lufs: toLufs(kept.reduce((a, b) => a + b, 0) / kept.length), peak: peakDb };
}
