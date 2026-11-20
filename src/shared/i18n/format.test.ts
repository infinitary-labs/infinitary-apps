import { afterEach, describe, expect, it } from "vitest";
import { currentDirection, setCurrentLanguage } from "./current.ts";
import {
  formatDate,
  formatDateTime,
  formatLanguageDate,
  formatNumber,
  formatTime,
  formatUsd,
  pluralCategory,
  servedNumber,
} from "./format.ts";

// The approved plan (INF-3674, "What done looks like"): dates, numbers and
// money follow the chosen language, and English stays as the app wrote it.
const AT = Date.UTC(2026, 10, 11, 17, 5);

afterEach(() => setCurrentLanguage("en"));

describe("in English", () => {
  it("writes numbers and money in the US forms the app always wrote", () => {
    expect(formatNumber(1234567)).toBe((1234567).toLocaleString("en-US"));
    expect(formatUsd(50)).toBe("$50");
    expect(formatUsd(51.37)).toBe("$51.37");
    expect(formatUsd(1204)).toBe("$1,204");
    expect(formatUsd(7, 2)).toBe("$7.00");
  });

  it("writes dates and times in the computer's own forms, as a bare toLocale call does", () => {
    const options = { month: "short", day: "numeric" } as const;
    expect(formatDate(AT, options)).toBe(new Date(AT).toLocaleDateString([], options));
    expect(formatTime(AT)).toBe(new Date(AT).toLocaleTimeString());
    expect(formatDateTime(AT)).toBe(new Date(AT).toLocaleString());
    expect(formatLanguageDate(AT, options)).toBe(new Date(AT).toLocaleDateString("en-US", options));
  });
});

describe("in another language", () => {
  it("writes numbers, money and dates in that language's own forms", () => {
    setCurrentLanguage("de");
    expect(formatNumber(1234567)).toBe("1.234.567");
    expect(formatUsd(51.37)).toBe("51,37\u00a0$");
    expect(formatDate(AT, { month: "long", day: "numeric", timeZone: "UTC" })).toBe("11. November");
    setCurrentLanguage("ja");
    expect(formatDate(AT, { month: "long", day: "numeric", timeZone: "UTC" })).toBe("11月11日");
  });

  it("picks Arabic's six plural forms and runs right to left", () => {
    setCurrentLanguage("ar");
    expect([0, 1, 2, 3, 11, 100].map((count) => pluralCategory(count))).toEqual([
      "zero",
      "one",
      "two",
      "few",
      "many",
      "other",
    ]);
    expect(currentDirection()).toBe("rtl");
  });

  it("keeps a count served to a model in English", () => {
    setCurrentLanguage("de");
    expect(servedNumber(1234567)).toBe("1,234,567");
  });
});
