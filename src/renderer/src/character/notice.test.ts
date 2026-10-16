import { describe, expect, it } from "vitest";
import { noticeFrame } from "./notice";

describe("the notice pulse", () => {
  it("is nothing before it starts or when it never started", () => {
    expect(noticeFrame(-10)).toEqual({ strength: 0, spread: 0 });
    expect(noticeFrame(Number.POSITIVE_INFINITY)).toEqual({ strength: 0, spread: 0 });
    expect(noticeFrame(Number.NaN)).toEqual({ strength: 0, spread: 0 });
  });
});
