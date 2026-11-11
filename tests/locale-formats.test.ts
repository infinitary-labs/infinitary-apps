import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { FIXED_LOCALE_PLACES, fixedLocaleProblems } from "../scripts/locale-formats";

// The approved plan (INF-3674, "What done looks like"): no fixed US English
// date or number format remains, and dates, numbers and money follow the
// chosen language.
const listed = Object.fromEntries(
  Object.keys(FIXED_LOCALE_PLACES).map((path) => [path, readFileSync(path, "utf8")]),
);

it("accepts the places that write through the i18n module", () => {
  const usage = "src/renderer/src/settings/usageWords.ts";
  expect(fixedLocaleProblems({ ...listed, [usage]: readFileSync(usage, "utf8") })).toEqual([]);
});

it("refuses a fixed or missing locale, and a listed place that no longer needs its entry", () => {
  const costs = [
    'export const total = (n: number) => `$${n.toLocaleString("en-US")}`;',
    "export const when = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric' });",
    "export const day = new Intl.DateTimeFormat(undefined, { weekday: 'long' });",
  ].join("\n");
  expect(
    fixedLocaleProblems({
      ...listed,
      "src/core/prompts/timeZone.ts":
        "export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;",
      "src/shared/costs.ts": costs,
    }),
  ).toEqual([
    "src/shared/costs.ts:1: toLocaleString without the app's language; use src/shared/i18n/format.ts",
    'src/shared/costs.ts:1: a fixed "en-US"; write it through src/shared/i18n/format.ts',
    "src/shared/costs.ts:2: toLocaleTimeString without the app's language; use src/shared/i18n/format.ts",
    "src/shared/costs.ts:3: Intl.DateTimeFormat without the app's language; use src/shared/i18n/format.ts",
    "scripts/locale-formats.ts: src/core/prompts/timeZone.ts no longer writes a fixed locale; remove its entry, and the list shrinks",
  ]);
});
