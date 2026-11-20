import { describe, expect, it } from "vitest";
import { SUMMARY_RECENT_MS, summaryNext } from "./summaryMotion";

const none = { shown: null, leaving: false };
const showing = (shown: string) => ({ shown, leaving: false });
const fading = (shown: string) => ({ shown, leaving: true });
const LONG_AGO = Number.POSITIVE_INFINITY;

describe("how a hover summary comes, moves and goes", () => {
  it("opens the first summary after the beat", () => {
    expect(summaryNext(none, "a", LONG_AGO, true)).toEqual({
      kind: "wait",
      shown: "a",
      close: false,
    });
  });

  it("moves to the next anchor at once while one shows, or while it fades", () => {
    expect(summaryNext(showing("a"), "b", LONG_AGO, true)).toEqual({ kind: "show", shown: "b" });
    expect(summaryNext(fading("a"), "b", LONG_AGO, true)).toEqual({ kind: "show", shown: "b" });
    expect(summaryNext(fading("a"), "a", LONG_AGO, true)).toEqual({ kind: "show", shown: "a" });
  });

  it("shows at once just after one went, and waits the beat again later", () => {
    expect(summaryNext(none, "b", SUMMARY_RECENT_MS - 1, true)).toEqual({
      kind: "show",
      shown: "b",
    });
    expect(summaryNext(none, "b", SUMMARY_RECENT_MS, true).kind).toBe("wait");
  });

  it("fades out when the pointer leaves, and keeps a summary that is already going", () => {
    expect(summaryNext(showing("a"), null, LONG_AGO, true)).toEqual({ kind: "fade" });
    expect(summaryNext(fading("a"), null, LONG_AGO, true)).toEqual({ kind: "keep" });
    expect(summaryNext(none, null, LONG_AGO, true)).toEqual({ kind: "keep" });
    expect(summaryNext(showing("a"), "a", LONG_AGO, true)).toEqual({ kind: "keep" });
  });

  it("under reduced motion, closes at once and waits the beat for every anchor, as before", () => {
    expect(summaryNext(showing("a"), "b", LONG_AGO, false)).toEqual({
      kind: "wait",
      shown: "b",
      close: true,
    });
    expect(summaryNext(none, "b", 0, false)).toEqual({ kind: "wait", shown: "b", close: false });
    expect(summaryNext(showing("a"), null, LONG_AGO, false)).toEqual({ kind: "gone" });
  });
});
