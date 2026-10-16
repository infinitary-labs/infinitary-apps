import { describe, expect, it } from "vitest";
import { SENDOFF_MS, sendoffFrame } from "./cues";
import { SENDOFF_LEAD_MS } from "./orbit";

describe("sendoffFrame", () => {
  it("is nothing before it starts and after it ends", () => {
    expect(sendoffFrame(-1)).toEqual({ look: 0, glow: 0, exhale: 0 });
    expect(sendoffFrame(SENDOFF_MS)).toEqual({ look: 0, glow: 0, exhale: 0 });
    expect(sendoffFrame(Number.NaN)).toEqual({ look: 0, glow: 0, exhale: 0 });
  });

  it("has the look and the glow up by the moment the spark leaves", () => {
    const atEmission = sendoffFrame(SENDOFF_LEAD_MS);
    expect(atEmission.look).toBeGreaterThan(0.95);
    expect(atEmission.glow).toBeGreaterThan(0.9);
  });
});
