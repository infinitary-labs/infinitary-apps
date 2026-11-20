// The Firstmate's neon halo, composited.
//
// The wires used to glow by setting ctx.shadowColor/ctx.shadowBlur before every
// stroke and fill, which makes Canvas2D re-run a gaussian on all 72-95
// primitives of a working Firstmate, every frame. This module produces the same
// halo with ONE blur pass per character: every glow-contributing primitive is
// rasterised into a single offscreen mask with additive accumulation, that mask
// is blurred once, and the result is composited under the crisp geometry.
//
// The identity that makes it faithful is the linearity of the gaussian:
//     sum_i blur(a_i * p_i)  ==  blur( sum_i a_i * p_i )
// so blurring the summed mask reproduces the sum of the per-primitive shadows.
// Two details make it hold in an 8-bit canvas:
//  1. The mask must accumulate ADDITIVELY ("lighter"). Source-over saturates
//     before the blur and would wash the halo thin wherever primitives overlap.
//  2. Additive accumulation would clip at 1.0 on the wires, so every primitive
//     goes in at alpha/SPLIT and the blurred layer is composited SPLIT times.
//     1-(1-A*b)^SPLIT ~= SPLIT*A*b in the halo tail, and saturates towards the
//     shadow colour on the wires exactly as the per-primitive stack did.
//
// Prototype, fidelity measurements and the falloff-matching derivation:
// firstmate/data/fm3000-neon-halo-proto-s1/report.md. Measured against the old
// path: mean per-pixel difference 1.28/255 versus a 1.06/255 same-code
// rasteriser noise floor, with the inner halo a known ~12% brighter (accepted).

/**
 * The mask is drawn at alpha/SPLIT and the blurred layer composited SPLIT
 * times, so additive accumulation stays under 1.0 and 8-bit clipping does not
 * eat energy off the wires.
 */
export const FM_GLOW_SPLIT = 4;

/**
 * Glow width, in DEVICE pixels.
 *
 * Canvas2D measures shadowBlur (and shadowOffset) in device pixels and does NOT
 * scale them by the context transform - confirmed at transform scales 1, 2 and
 * 3. The old code passed `14 * neon * (size / 280)` straight to ctx.shadowBlur
 * under a dpr transform, so on a 2x display the halo came out half as wide
 * relative to the character as on 1x. Multiplying by dpr here is that fix, and
 * it is what the composited path blurs with.
 */
export function firstmateGlowBlurPx(neon: number, size: number, dpr: number): number {
  return 14 * neon * (size / 280) * dpr;
}

/** Sigma of the gaussian Canvas2D runs for a given shadowBlur, in device px. */
export function firstmateGlowSigma(blurPx: number): number {
  return blurPx / 2;
}

export type GlowBuffers = {
  /** Additive accumulation target for every glow-contributing primitive. */
  mask: HTMLCanvasElement;
  /** Twice as wide as the mask: sharp copy left, blurred copy right. */
  blur: HTMLCanvasElement;
};

/**
 * Per-instance offscreens sized to the character's backing store. They are kept
 * per Firstmate rather than shared module-wide so two characters at different
 * sizes cannot thrash one buffer between them.
 */
export function ensureGlowBuffers(
  existing: GlowBuffers | null,
  width: number,
  height: number,
): GlowBuffers {
  if (existing && existing.mask.width === width && existing.mask.height === height) {
    return existing;
  }
  const mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const blur = document.createElement("canvas");
  blur.width = width * 2;
  blur.height = height;
  return { mask, blur };
}

/**
 * Run the whole halo pipeline once with a token primitive so its one-time
 * costs - offscreen backing-store allocation, the first Skia blur, the first
 * "lighter" accumulation and the first cross-canvas composite - are paid at
 * mount instead of on the first idle -> working morph. The destination is
 * painted for real (an invisible warmup can be elided by the rasteriser), so
 * callers must run this right before a full clear of `ctx`.
 */
export function warmNeonHalo(
  ctx: CanvasRenderingContext2D,
  buffers: GlowBuffers,
  dpr: number,
  blurPx: number,
): void {
  compositeNeonHalo(ctx, buffers, { dpr, blurPx, tint: "rgb(255,236,200)", alpha: 1 }, (mask) => {
    mask.globalAlpha = 1 / FM_GLOW_SPLIT;
    mask.beginPath();
    mask.arc(4, 4, 2, 0, Math.PI * 2);
    mask.fill();
  });
}

export type HaloOptions = {
  /** Device-pixel ratio the destination context is transformed by. */
  dpr: number;
  /** Glow width in device px - see firstmateGlowBlurPx. */
  blurPx: number;
  /** Opaque `rgb(...)` tint of the halo. */
  tint: string;
  /** Alpha the assembled halo is composited at. */
  alpha: number;
};

/**
 * Blur the mask once and composite the halo into `ctx`, which is left with the
 * dpr transform and globalAlpha 1 so the crisp geometry can be drawn on top.
 *
 * `paintMask` receives the mask context already set to the dpr transform, the
 * additive composite mode and the flat tint; it only has to replay the
 * primitives at alpha/FM_GLOW_SPLIT.
 */
export function compositeNeonHalo(
  ctx: CanvasRenderingContext2D,
  buffers: GlowBuffers,
  o: HaloOptions,
  paintMask: (mask: CanvasRenderingContext2D) => void,
): void {
  const { mask, blur } = buffers;
  const mk = mask.getContext("2d");
  const bl = blur.getContext("2d");
  if (!mk || !bl) return;
  const mw = mask.width;
  const mh = mask.height;

  // 1. One shared mask: every glow-contributing primitive, one flat tint,
  //    accumulated additively.
  mk.setTransform(1, 0, 0, 1, 0, 0);
  mk.globalCompositeOperation = "source-over";
  mk.globalAlpha = 1;
  mk.clearRect(0, 0, mw, mh);
  mk.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  mk.globalCompositeOperation = "lighter";
  mk.strokeStyle = o.tint;
  mk.fillStyle = o.tint;
  paintMask(mk);
  mk.globalCompositeOperation = "source-over";
  mk.globalAlpha = 1;

  // 2. THE single blur pass. Running Canvas2D's own shadow over the assembled
  //    mask keeps the kernel identical to the old path by construction rather
  //    than by approximation - it is literally the same rasteriser at the same
  //    shadowBlur. shadowOffsetX pushes the shadow into the right half of a
  //    double-width buffer so the sharp copy never reaches the output.
  bl.setTransform(1, 0, 0, 1, 0, 0);
  bl.globalCompositeOperation = "source-over";
  bl.globalAlpha = 1;
  bl.clearRect(0, 0, blur.width, blur.height);
  bl.shadowColor = o.tint;
  bl.shadowBlur = o.blurPx;
  bl.shadowOffsetX = mw;
  bl.drawImage(mask, 0, 0);
  bl.shadowBlur = 0;
  bl.shadowOffsetX = 0;
  bl.shadowColor = "rgba(0,0,0,0)";

  // 3. Composite the halo under the crisp geometry, in device pixels.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.min(1, o.alpha);
  for (let s = 0; s < FM_GLOW_SPLIT; s++) {
    ctx.drawImage(blur, mw, 0, mw, mh, 0, 0, mw, mh);
  }
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.globalAlpha = 1;
}
