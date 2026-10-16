import { afterEach, describe, expect, it } from "vitest";
import {
  compositeNeonHalo,
  ensureGlowBuffers,
  FM_GLOW_SPLIT,
  firstmateGlowBlurPx,
  type GlowBuffers,
  warmNeonHalo,
} from "./glow";

// A recording Canvas2D double. It captures the drawing state each call was made
// under, which is what these tests assert on: how many gaussians the halo runs,
// how wide they are, and what the mask and the composite are drawn with.

type Transform = [number, number, number, number, number, number];

type Call = {
  op: string;
  args: number[];
  alpha: number;
  composite: string;
  shadowBlur: number;
  shadowOffsetX: number;
  transform: Transform;
};

class FakeCtx {
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowColor = "rgba(0,0,0,0)";
  strokeStyle = "";
  fillStyle = "";
  lineWidth = 1;
  transform: Transform = [1, 0, 0, 1, 0, 0];
  calls: Call[] = [];

  private record(op: string, args: number[]): void {
    this.calls.push({
      op,
      args,
      alpha: this.globalAlpha,
      composite: this.globalCompositeOperation,
      shadowBlur: this.shadowBlur,
      shadowOffsetX: this.shadowOffsetX,
      transform: [...this.transform] as Transform,
    });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f];
  }
  clearRect(...args: number[]): void {
    this.record("clearRect", args);
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(...args: number[]): void {
    this.record("arc", args);
  }
  stroke(): void {
    this.record("stroke", []);
  }
  fill(): void {
    this.record("fill", []);
  }
  drawImage(_image: unknown, ...args: number[]): void {
    this.record("drawImage", args);
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  ctx = new FakeCtx();
  getContext(): FakeCtx {
    return this.ctx;
  }
}

const realDocument = (globalThis as { document?: unknown }).document;

function withFakeCanvases(): void {
  (globalThis as { document?: unknown }).document = {
    createElement: () => new FakeCanvas(),
  };
}

afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

function ctxOf(canvas: HTMLCanvasElement): FakeCtx {
  return (canvas as unknown as FakeCanvas).ctx;
}

describe("firstmateGlowBlurPx", () => {
  // Canvas2D measures shadowBlur in device pixels and ignores the context
  // transform, so a glow width that is not multiplied by dpr comes out half as
  // wide relative to the character on a 2x display. That was the bug.
  it("keeps the glow the same width relative to the character across dpr", () => {
    const size = 280;
    const relative = (dpr: number) => firstmateGlowBlurPx(1, size, dpr) / (size * dpr);
    expect(relative(2)).toBeCloseTo(relative(1), 12);
    expect(relative(3)).toBeCloseTo(relative(1), 12);
  });
});

describe("ensureGlowBuffers", () => {
  it("reuses buffers at the same backing size and reallocates when it changes", () => {
    withFakeCanvases();
    const first = ensureGlowBuffers(null, 560, 560);
    expect(ensureGlowBuffers(first, 560, 560)).toBe(first);
    expect(ensureGlowBuffers(first, 112, 112)).not.toBe(first);
  });
});

describe("compositeNeonHalo", () => {
  const dpr = 2;
  const size = 280;
  const px = size * dpr;
  const blurPx = firstmateGlowBlurPx(1, size, dpr);

  function run(): { dest: FakeCtx; buffers: GlowBuffers; painted: FakeCtx[] } {
    withFakeCanvases();
    const buffers = ensureGlowBuffers(null, px, px);
    const dest = new FakeCtx();
    const painted: FakeCtx[] = [];
    compositeNeonHalo(
      dest as unknown as CanvasRenderingContext2D,
      buffers,
      { dpr, blurPx, tint: "rgb(255,184,104)", alpha: 0.9 },
      (mask) => {
        const m = mask as unknown as FakeCtx;
        painted.push(m);
        m.globalAlpha = 0.5 / FM_GLOW_SPLIT;
        m.stroke();
      },
    );
    return { dest, buffers, painted };
  }

  it("runs exactly one gaussian per character, at the dpr-correct glow width", () => {
    const { buffers } = run();
    const blurred = ctxOf(buffers.blur).calls.filter((c) => c.shadowBlur > 0);
    expect(blurred).toHaveLength(1);
    expect(blurred[0]?.op).toBe("drawImage");
    expect(blurred[0]?.shadowBlur).toBe(blurPx);
  });

  it("composites the blurred half SPLIT times and hands back a clean context", () => {
    const { dest } = run();
    const composites = dest.calls.filter((c) => c.op === "drawImage");
    expect(composites).toHaveLength(FM_GLOW_SPLIT);
    for (const c of composites) {
      // Source rect starts at the mask width: the blurred half only.
      expect(c.args).toEqual([px, 0, px, px, 0, 0, px, px]);
      expect(c.alpha).toBeCloseTo(0.9, 12);
      expect(c.transform).toEqual([1, 0, 0, 1, 0, 0]);
    }
    // Crisp geometry draws next: dpr transform back, full alpha, and no shadow
    // of its own - the halo is the only gaussian in the frame.
    expect(dest.transform).toEqual([dpr, 0, 0, dpr, 0, 0]);
    expect(dest.globalAlpha).toBe(1);
    expect(dest.shadowBlur).toBe(0);
  });

  // The warmup exists so the first idle -> working morph does not pay the
  // pipeline's one-time costs (buffer allocation, first blur, first additive
  // accumulation, first cross-canvas composite). What makes it effective is
  // that every stage runs for real - an elidable no-op would warm nothing.
  it("warmNeonHalo runs every stage for real: mask paint, one gaussian, opaque composites", () => {
    withFakeCanvases();
    const buffers = ensureGlowBuffers(null, px, px);
    const dest = new FakeCtx();
    warmNeonHalo(dest as unknown as CanvasRenderingContext2D, buffers, dpr, blurPx);
    const maskFills = ctxOf(buffers.mask).calls.filter(
      (c) => c.op === "fill" && c.composite === "lighter",
    );
    expect(maskFills).toHaveLength(1);
    const blurred = ctxOf(buffers.blur).calls.filter((c) => c.shadowBlur > 0);
    expect(blurred).toHaveLength(1);
    expect(blurred[0]?.shadowBlur).toBe(blurPx);
    const composites = dest.calls.filter((c) => c.op === "drawImage");
    expect(composites).toHaveLength(FM_GLOW_SPLIT);
    for (const c of composites) {
      expect(c.alpha).toBe(1);
    }
  });
});
