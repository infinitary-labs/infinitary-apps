import type { Card, CardAnswer } from "@shared/cards";
import type { FrameAnswers } from "@shared/plugins/bridge";
import { describe, expect, it } from "vitest";
import { unsentAnswers } from "./unsentAnswers";

const card = { body: "<p>Choose</p>" } as Card;
const answer = (values: string[], extra: Partial<CardAnswer> = {}): CardAnswer => ({
  name: "tone",
  values,
  changed: true,
  ...extra,
});
const reading = (answers: CardAnswer[]): FrameAnswers => ({
  answered: 1,
  of: 1,
  changed: 1,
  picked: 1,
  answers,
});

describe("answers a close would discard", () => {
  it("retains the authored-proposal counts until the first send", () => {
    const form = { ...reading([]), changed: 3, picked: 2 };
    expect(unsentAnswers(card, form, undefined)).toBe(2);
    expect(
      unsentAnswers({ ...card, body: "<style></style><script></script>" }, form, undefined),
    ).toBe(3);
  });
  it("ignores value ordering, labels and proposal changes, but detects a cleared pick", () => {
    const sent = [answer(["a", "b"], { labels: ["A", "B"] })];
    expect(unsentAnswers(card, reading([answer(["b", "a"], { changed: false })]), sent)).toBe(0);
    expect(unsentAnswers(card, reading([answer([], { changed: false })]), sent)).toBe(1);
  });
  it("counts later edits even when they return to the authored default", () => {
    const sent = [answer(["plain"])];
    expect(unsentAnswers(card, reading([answer(["warm"], { changed: false })]), sent)).toBe(1);
    expect(unsentAnswers(card, reading([answer(["plain"])]), sent)).toBe(0);
  });
  it("compares write-ins and staged settings, not just option values", () => {
    expect(
      unsentAnswers(card, reading([answer(["other"], { written: "new" })]), [
        answer(["other"], { written: "old" }),
      ]),
    ).toBe(1);
    expect(
      unsentAnswers(card, reading([answer(['{"speed":2}'], { json: true })]), [
        answer(['{"speed":1}'], { json: true }),
      ]),
    ).toBe(1);
    expect(
      unsentAnswers(card, reading([answer(['{"speed":1}'], { json: true })]), [
        answer(['{"speed":1}'], { json: true }),
      ]),
    ).toBe(0);
  });
  it("does not count questions removed by a revision, or a new empty question", () => {
    expect(unsentAnswers(card, reading([]), [answer(["plain"])])).toBe(0);
    expect(unsentAnswers(card, reading([answer([], { changed: false })]), [])).toBe(0);
    expect(unsentAnswers(card, reading([answer(["plain"])]), [])).toBe(1);
  });
});
