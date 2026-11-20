import { describe, expect, it } from "vitest";
import { localTimeZoneName, timeZoneFact } from "./timeZone";

const JULY = Date.parse("2026-07-01T19:11:00Z");
const JANUARY = Date.parse("2026-01-15T19:11:00Z");

describe("the captain's time zone as the agents read it (FI3-1006)", () => {
  it("names the zone with the offset in force at that moment, daylight saving included", () => {
    expect(timeZoneFact(JULY, "America/Los_Angeles")).toBe("America/Los_Angeles (UTC-07:00)");
    expect(timeZoneFact(JANUARY, "America/Los_Angeles")).toBe("America/Los_Angeles (UTC-08:00)");
    expect(timeZoneFact(JULY, "Europe/Berlin")).toBe("Europe/Berlin (UTC+02:00)");
  });

  it("writes a half-hour offset and the zero offset in the same form", () => {
    expect(timeZoneFact(JULY, "Asia/Kolkata")).toBe("Asia/Kolkata (UTC+05:30)");
    expect(timeZoneFact(JULY, "UTC")).toBe("UTC (UTC+00:00)");
  });

  it("keeps the name alone for a zone the runtime cannot read", () => {
    expect(timeZoneFact(JULY, "Mars/Olympus_Mons")).toBe("Mars/Olympus_Mons");
  });

  it("defaults to this Mac's own zone", () => {
    expect(timeZoneFact(JULY)).toBe(timeZoneFact(JULY, localTimeZoneName()));
    expect(timeZoneFact(JULY)).toMatch(/^\S+ \(UTC[+-]\d{2}:\d{2}\)$/);
  });
});
